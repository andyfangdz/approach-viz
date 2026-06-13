import Foundation

struct MrmsPollingContext: Hashable {
    let refLat: Double
    let refLon: Double
    /// Server-side fetch threshold (matches the web client's
    /// `MIN_NEXRAD_MIN_DBZ`); the display threshold is applied in prepare.
    let fetchMinDbz: Int
    let maxRangeNm: Int
    let includeVolume: Bool
    let includeEchoTops: Bool
    let includeCrossSection: Bool
    /// Display threshold in tenths of dBZ for the shared Rust prepare pass.
    let minDbzTenths: Int16
    /// 0 = altitude/thermodynamic, 1 = surface (web default is surface).
    let phaseMode: UInt8
    /// 0 = all, 1 = low, 2 = mid, 3 = high.
    let declutterMode: UInt8
    let crossSectionHeadingDeg: Double
    let crossSectionRangeNm: Double
    let applyEarthCurvatureCompensation: Bool

    /// Web slice normalization: rounded heading wrapped to [0, 360).
    var normalizedCrossSectionHeading: Double {
        let wrapped = crossSectionHeadingDeg.rounded().truncatingRemainder(dividingBy: 360)
        return wrapped < 0 ? wrapped + 360 : wrapped
    }

    /// Web slice normalization: rounded range clamped to [30, 140] NM.
    var normalizedCrossSectionRange: Double {
        max(30, min(140, crossSectionRangeNm.rounded()))
    }

    /// Web slice half-width: lerp(0.8, 1.8) across the normalized range span.
    var crossSectionHalfWidthNm: Double {
        let t = max(0, min(1, (normalizedCrossSectionRange - 30) / (140 - 30)))
        return 0.8 + (1.8 - 0.8) * t
    }

    /// Slice direction in scene axes: x = sin(heading), z = -cos(heading).
    var sliceAxis: (x: Double, z: Double) {
        let radians = normalizedCrossSectionHeading * .pi / 180
        return (sin(radians), -cos(radians))
    }

    var slicePerpAxis: (x: Double, z: Double) {
        let axis = sliceAxis
        return (-axis.z, axis.x)
    }
}

/// One poll cycle's outcome. Scenes are nil when not requested or when that
/// payload failed; failures are reported per payload so one feed going down
/// does not block the other (web overlay parity).
struct NativeWeatherPollResult {
    let mrmsScene: NativeMrmsScene?
    let echoTopScene: NativeEchoTopScene?
    let volumeError: String?
    let echoTopsError: String?

    var firstError: String? { volumeError ?? echoTopsError }
}

enum MrmsServiceError: LocalizedError {
    case requestFailed(String)
    case payloadInvalid(String)

    var errorDescription: String? {
        switch self {
        case let .requestFailed(message), let .payloadInvalid(message):
            return message
        }
    }
}

/// Fetches the AVMR v5 volume and AVET v3 echo-tops payloads from the runtime
/// and assembles render-ready columns through the shared Rust engine. The
/// last fetched binaries are cached so prepare-only option changes (threshold,
/// phase, declutter, slice geometry) re-run the Rust prepare pass without a
/// network round trip — the web worker's re-prepare path.
actor MrmsService {
    private let session: URLSession
    private let runtimeBaseURL: URL

    private var cachedVolumeData: Data?
    private var cachedVolumeKey: String?

    init(
        session: URLSession = .shared,
        runtimeBaseURL: URL = URL(string: "https://approach-runtime.andyfang.app")!
    ) {
        self.session = session
        self.runtimeBaseURL = runtimeBaseURL
    }

    func poll(context: MrmsPollingContext) async -> NativeWeatherPollResult {
        var mrmsScene: NativeMrmsScene?
        var echoTopScene: NativeEchoTopScene?
        var volumeError: String?
        var echoTopsError: String?

        if context.includeVolume {
            do {
                let data = try await fetchPayload(url: makeVolumeURL(context: context), accept: nil)
                cachedVolumeData = data
                cachedVolumeKey = cacheKey(context: context)
                mrmsScene = try prepareVolumeScene(data: data, context: context)
            } catch {
                volumeError = error.localizedDescription
            }
        } else {
            cachedVolumeData = nil
            cachedVolumeKey = nil
        }

        if context.includeEchoTops {
            do {
                let data = try await fetchPayload(
                    url: makeEchoTopsURL(context: context),
                    accept: "application/vnd.approach-viz.echo-tops.v3"
                )
                echoTopScene = try prepareEchoTopScene(data: data, context: context)
            } catch {
                echoTopsError = error.localizedDescription
            }
        }

        return NativeWeatherPollResult(
            mrmsScene: mrmsScene,
            echoTopScene: echoTopScene,
            volumeError: volumeError,
            echoTopsError: echoTopsError
        )
    }

    /// Re-run the Rust prepare pass on the cached volume binary with new
    /// prepare-only options. Returns nil when there is no cached payload for
    /// this airport (the caller should fall back to a full poll).
    func reprepare(context: MrmsPollingContext) throws -> NativeMrmsScene? {
        guard context.includeVolume,
              let cachedVolumeData,
              cachedVolumeKey == cacheKey(context: context) else {
            return nil
        }
        return try prepareVolumeScene(data: cachedVolumeData, context: context)
    }

    private func cacheKey(context: MrmsPollingContext) -> String {
        String(format: "%.6f,%.6f,%d", context.refLat, context.refLon, context.maxRangeNm)
    }

    private func prepareVolumeScene(
        data: Data,
        context: MrmsPollingContext
    ) throws -> NativeMrmsScene {
        let volume = decodeAndPrepareMrmsVolume(
            data: data,
            minDbzTenths: context.minDbzTenths,
            phaseMode: context.phaseMode,
            declutterMode: context.declutterMode,
            applyEarthCurvature: context.applyEarthCurvatureCompensation,
            refLat: context.refLat,
            includeCrossSection: context.includeCrossSection,
            sliceAxisX: context.sliceAxis.x,
            sliceAxisZ: context.sliceAxis.z,
            slicePerpX: context.slicePerpAxis.x,
            slicePerpZ: context.slicePerpAxis.z,
            normalizedRange: context.normalizedCrossSectionRange,
            halfWidthNm: context.crossSectionHalfWidthNm
        )
        if let error = volume.error?.trimmingCharacters(in: .whitespacesAndNewlines),
           !error.isEmpty {
            throw MrmsServiceError.payloadInvalid(error)
        }

        return NativeMrmsScene(
            voxelCount: Int(volume.voxelCount),
            sourceVoxelCount: Int(volume.sourceVoxelCount),
            validVoxelCount: Int(volume.validCount),
            generatedAtMs: volume.generatedAtMs,
            scanTimeMs: volume.scanTimeMs,
            centerXNm: volume.centerXNm,
            centerYNm: volume.centerYNm,
            centerZNm: volume.centerZNm,
            sizeXNm: volume.sizeXNm,
            sizeYNm: volume.sizeYNm,
            sizeZNm: volume.sizeZNm,
            dbz: volume.dbz,
            phaseCode: [UInt8](volume.phaseCode),
            maxAbsXNm: volume.maxAbsXNm,
            maxAbsZNm: volume.maxAbsZNm,
            maxCorrectedTopFeet: volume.maxCorrectedTopFeet,
            crossSection: volume.crossSection.map { section in
                NativeCrossSection(
                    binsX: Int(section.binsX),
                    binsY: Int(section.binsY),
                    gridDbz: section.gridDbz,
                    gridPhase: [UInt8](section.gridPhase),
                    topEnvelopeFeet: section.topEnvelopeFeet,
                    maxTopFeet: section.maxTopFeet
                )
            }
        )
    }

    private func prepareEchoTopScene(
        data: Data,
        context: MrmsPollingContext
    ) throws -> NativeEchoTopScene {
        let result = decodeAndPrepareEchoTops(
            data: data,
            applyEarthCurvature: context.applyEarthCurvatureCompensation,
            refLat: context.refLat
        )
        if let error = result.error?.trimmingCharacters(in: .whitespacesAndNewlines),
           !error.isEmpty {
            throw MrmsServiceError.payloadInvalid(error)
        }

        func surface(_ value: EchoTopSurface) -> NativeEchoTopScene.Surface {
            NativeEchoTopScene.Surface(xNm: value.xNm, zNm: value.zNm, yNm: value.yNm)
        }

        return NativeEchoTopScene(
            sourceCellCount: Int(result.sourceCellCount),
            generatedAtMs: result.generatedAtMs,
            scanTimeMs: result.scanTimeMs,
            footprintXNm: result.footprintXNm,
            footprintYNm: result.footprintYNm,
            maxTop18Feet: result.maxTop18Feet,
            maxTop30Feet: result.maxTop30Feet,
            maxTop50Feet: result.maxTop50Feet,
            maxTop60Feet: result.maxTop60Feet,
            top18: surface(result.top18),
            top30: surface(result.top30),
            top50: surface(result.top50)
        )
    }

    private func makeVolumeURL(context: MrmsPollingContext) throws -> URL {
        try makeWeatherURL(path: "/v1/weather/volume", context: context, includeMinDbz: true)
    }

    private func makeEchoTopsURL(context: MrmsPollingContext) throws -> URL {
        try makeWeatherURL(path: "/v1/weather/echo-tops", context: context, includeMinDbz: false)
    }

    private func makeWeatherURL(
        path: String,
        context: MrmsPollingContext,
        includeMinDbz: Bool
    ) throws -> URL {
        guard var components = URLComponents(
            url: runtimeBaseURL.appending(path: path),
            resolvingAgainstBaseURL: false
        ) else {
            throw MrmsServiceError.requestFailed("Unable to construct weather request URL.")
        }

        var queryItems = [
            URLQueryItem(name: "lat", value: String(format: "%.6f", context.refLat)),
            URLQueryItem(name: "lon", value: String(format: "%.6f", context.refLon)),
        ]
        if includeMinDbz {
            queryItems.append(URLQueryItem(name: "minDbz", value: String(context.fetchMinDbz)))
        }
        queryItems.append(URLQueryItem(name: "maxRangeNm", value: String(context.maxRangeNm)))
        components.queryItems = queryItems

        guard let url = components.url else {
            throw MrmsServiceError.requestFailed("Unable to encode weather request query parameters.")
        }
        return url
    }

    private func fetchPayload(url: URL, accept: String?) async throws -> Data {
        var request = URLRequest(url: url)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        if let accept {
            request.setValue(accept, forHTTPHeaderField: "Accept")
        }
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw MrmsServiceError.requestFailed("Weather feed returned an invalid response.")
        }
        guard 200..<300 ~= httpResponse.statusCode else {
            throw MrmsServiceError.requestFailed("Weather request failed (\(httpResponse.statusCode)).")
        }
        return data
    }
}
