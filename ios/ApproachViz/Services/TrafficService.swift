import Foundation
import os

struct TrafficPollingContext: Hashable {
    let refLat: Double
    let refLon: Double
    let airportElevationFeet: Double
    let elevationAirports: [ElevationAirportRecord]
    let verticalScale: Double
    let radiusNm: Int
    let limit: Int
    let historyMinutes: Double
    let hideGroundTargets: Bool
    let showDepartedTrafficTrails: Bool
    let applyEarthCurvatureCompensation: Bool
}

enum TrafficServiceError: LocalizedError {
    case requestFailed(String)
    case feedError(String)

    var errorDescription: String? {
        switch self {
        case let .requestFailed(message), let .feedError(message):
            return message
        }
    }
}

actor TrafficService {
    private static let logger = Logger(subsystem: "app.approach-viz", category: "TrafficService")
    private static let maxHistoryBackfillHexes = 80
    private static let minFullBackfillIntervalMs: Int64 = 60_000
    private static let maxFullBackfillIntervalMs: Int64 = 5 * 60_000

    private let session: URLSession
    private let runtimeBaseURL: URL
    private let state: TrafficStateHandle

    private var backfilledHexes: [String: Int64] = [:]
    private var pendingBackfillHexes = Set<String>()
    private var needsHistoryBackfill = true
    private var lastFullBackfillAtMs: Int64?

    init(
        session: URLSession = .shared,
        runtimeBaseURL: URL = URL(string: "https://approach-runtime.andyfang.app")!
    ) {
        self.session = session
        self.runtimeBaseURL = runtimeBaseURL
        self.state = TrafficStateHandle()
    }

    func poll(context: TrafficPollingContext) async throws -> NativeTrafficScene {
        let nowMs = currentTimeMillis()
        let historyWindowMs = Int64(context.historyMinutes * 60_000.0)
        let fullBackfillIntervalMs = min(
            Self.maxFullBackfillIntervalMs,
            max(Self.minFullBackfillIntervalMs, historyWindowMs / 2)
        )

        var shouldRequestHistoryBackfill = context.showDepartedTrafficTrails && needsHistoryBackfill
        if context.showDepartedTrafficTrails,
           !shouldRequestHistoryBackfill,
           let lastFullBackfillAtMs,
           nowMs - lastFullBackfillAtMs >= fullBackfillIntervalMs {
            shouldRequestHistoryBackfill = true
        }

        var requestedHistoryHexes: [String] = []
        var primaryURL = try makeTrafficURL(context: context, historyMinutes: nil, historyHexes: nil)
        if context.showDepartedTrafficTrails, shouldRequestHistoryBackfill {
            primaryURL = try makeTrafficURL(
                context: context,
                historyMinutes: context.historyMinutes,
                historyHexes: nil
            )
        } else if context.showDepartedTrafficTrails, !pendingBackfillHexes.isEmpty {
            requestedHistoryHexes = Array(pendingBackfillHexes.prefix(Self.maxHistoryBackfillHexes))
        }

        let primaryData = try await fetchTrafficPayload(url: primaryURL)
        let followupData: Data?
        if context.showDepartedTrafficTrails,
           !shouldRequestHistoryBackfill,
           !requestedHistoryHexes.isEmpty {
            do {
                let followupURL = try makeTrafficURL(
                    context: context,
                    historyMinutes: context.historyMinutes,
                    historyHexes: requestedHistoryHexes
                )
                followupData = try await fetchTrafficPayload(url: followupURL)
            } catch {
                // The primary poll still succeeded; log the backfill failure
                // and keep the hexes pending so the next poll retries them.
                Self.logger.warning(
                    "Traffic history backfill follow-up failed: \(error.localizedDescription, privacy: .public)"
                )
                followupData = nil
                requestedHistoryHexes = []
            }
        } else {
            followupData = nil
        }

        let mergeResult = state.merge(
            data: primaryData,
            nowMs: nowMs,
            historyMinutes: context.historyMinutes,
            hideGround: context.hideGroundTargets,
            backfillData: followupData ?? Data()
        )

        if let error = mergeResult.error?.trimmingCharacters(in: .whitespacesAndNewlines),
           !error.isEmpty {
            throw TrafficServiceError.feedError(error)
        }

        if context.showDepartedTrafficTrails {
            for (hex, backfillAtMs) in backfilledHexes where nowMs - backfillAtMs > historyWindowMs * 2 {
                backfilledHexes.removeValue(forKey: hex)
            }

            let returnedHistoryHexes = Set(mergeResult.returnedHistoryHexes)
            for hex in mergeResult.trackedHexes where !hex.isEmpty {
                if let lastBackfillAtMs = backfilledHexes[hex], nowMs - lastBackfillAtMs <= historyWindowMs {
                    pendingBackfillHexes.remove(hex)
                } else {
                    pendingBackfillHexes.insert(hex)
                }
            }

            for hex in requestedHistoryHexes {
                pendingBackfillHexes.remove(hex)
                backfilledHexes[hex] = nowMs
            }
            for hex in returnedHistoryHexes {
                pendingBackfillHexes.remove(hex)
                backfilledHexes[hex] = nowMs
            }

            if shouldRequestHistoryBackfill {
                lastFullBackfillAtMs = nowMs
            }
            needsHistoryBackfill = false
        } else {
            backfilledHexes.removeAll()
            pendingBackfillHexes.removeAll()
            needsHistoryBackfill = false
        }

        return buildTrafficScene(context: context)
    }

    func recompute(context: TrafficPollingContext) -> NativeTrafficScene {
        _ = state.recompute(
            nowMs: currentTimeMillis(),
            historyMinutes: context.historyMinutes,
            hideGround: context.hideGroundTargets
        )
        return buildTrafficScene(context: context)
    }

    func pruneAfterError(context: TrafficPollingContext) -> NativeTrafficScene {
        _ = state.pruneForError(nowMs: currentTimeMillis(), historyMinutes: context.historyMinutes)
        return buildTrafficScene(context: context)
    }

    private func buildTrafficScene(context: TrafficPollingContext) -> NativeTrafficScene {
        let airports = buildTrafficAirports(context: context)
        let renderResult = state.buildRenderTracks(
            refLat: context.refLat,
            refLon: context.refLon,
            airports: airports,
            verticalScale: context.verticalScale,
            applyEarthCurvature: context.applyEarthCurvatureCompensation,
            showDepartedTrails: context.showDepartedTrafficTrails
        )

        return NativeTrafficScene(
            trackCount: Int(renderResult.trackCount),
            renderedTrackCount: Int(renderResult.renderedTrackCount),
            historyPointCount: Int(renderResult.historyPointCount),
            renderHash: renderResult.renderHash,
            tracks: renderResult.tracks.map { track in
                TrafficTrackRecord(
                    hex: track.hex,
                    isCurrentlyPresent: track.isCurrentlyPresent,
                    callsignLabel: track.callsignLabel,
                    isOnGround: track.isOnGround,
                    headingDegrees: track.headingDeg,
                    markerPosition: TrafficScenePoint(
                        x: track.markerPosition.x,
                        y: track.markerPosition.y,
                        z: track.markerPosition.z
                    ),
                    trailPoints: track.trailPoints.map { point in
                        TrafficScenePoint(x: point.x, y: point.y, z: point.z)
                    }
                )
            }
        )
    }

    private func buildTrafficAirports(context: TrafficPollingContext) -> [TrafficSceneAirport] {
        var airports = [TrafficSceneAirport(
            lat: context.refLat,
            lon: context.refLon,
            elevationFeet: context.airportElevationFeet
        )]
        airports.append(contentsOf: context.elevationAirports.map { airport in
            TrafficSceneAirport(
                lat: airport.lat,
                lon: airport.lon,
                elevationFeet: airport.elevation
            )
        })
        return airports
    }

    private func makeTrafficURL(
        context: TrafficPollingContext,
        historyMinutes: Double?,
        historyHexes: [String]?
    ) throws -> URL {
        guard var components = URLComponents(
            url: runtimeBaseURL.appending(path: "/v1/traffic/adsbx"),
            resolvingAgainstBaseURL: false
        ) else {
            throw TrafficServiceError.requestFailed("Unable to construct traffic request URL.")
        }

        var queryItems = [
            URLQueryItem(name: "lat", value: String(format: "%.6f", context.refLat)),
            URLQueryItem(name: "lon", value: String(format: "%.6f", context.refLon)),
            URLQueryItem(name: "radiusNm", value: String(context.radiusNm)),
            URLQueryItem(name: "limit", value: String(context.limit)),
            URLQueryItem(name: "hideGround", value: context.hideGroundTargets ? "1" : "0"),
            URLQueryItem(name: "format", value: "binary"),
        ]
        if let historyMinutes {
            queryItems.append(URLQueryItem(name: "historyMinutes", value: String(Int(historyMinutes.rounded()))))
        }
        if let historyHexes, !historyHexes.isEmpty {
            queryItems.append(URLQueryItem(name: "historyHexes", value: historyHexes.joined(separator: ",")))
        }
        components.queryItems = queryItems

        guard let url = components.url else {
            throw TrafficServiceError.requestFailed("Unable to encode traffic request query parameters.")
        }
        return url
    }

    private func fetchTrafficPayload(url: URL) async throws -> Data {
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw TrafficServiceError.requestFailed("Traffic feed returned an invalid response.")
        }
        guard 200..<300 ~= httpResponse.statusCode else {
            throw TrafficServiceError.requestFailed("Traffic feed request failed (\(httpResponse.statusCode)).")
        }
        return data
    }
}

private func currentTimeMillis() -> Int64 {
    Int64(Date().timeIntervalSince1970 * 1_000.0)
}
