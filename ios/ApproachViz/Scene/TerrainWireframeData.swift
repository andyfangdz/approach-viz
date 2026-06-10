import Foundation
import CoreGraphics
import Nuke

struct TerrainWireframeData: Sendable, Hashable {
    struct Vertex: Sendable, Hashable {
        let eastNm: Double
        let northNm: Double
        let elevationFeet: Double
    }

    let rows: Int
    let columns: Int
    let vertices: [Vertex]
}

actor TerrainWireframeLoader {
    static let shared = TerrainWireframeLoader()

    private struct TileKey: Hashable, Sendable {
        let z: Int
        let x: Int
        let y: Int
    }

    private struct TileImage: Sendable {
        let width: Int
        let height: Int
        let pixels: [UInt8]
    }

    private let tileSize = 256
    private let zoom = 10
    private let gridSegments = 140
    private let radiusNm = 50.0
    private let tileBaseURL = URL(string: "https://elevation-tiles-prod.s3.amazonaws.com/terrarium")!
    private let imagePipeline = ImagePipeline.shared
    // Decoded tiles are ~256 KB each; the LRU cap bounds the cache at ~32 MB
    // instead of growing without limit as airports are switched.
    private let maxCachedTiles = 128
    private var cache: [TileKey: TileImage] = [:]
    private var cacheAccessOrder: [TileKey] = []

    private func storeCachedTile(_ tile: TileImage, for key: TileKey) {
        cache[key] = tile
        if let index = cacheAccessOrder.firstIndex(of: key) {
            cacheAccessOrder.remove(at: index)
        }
        cacheAccessOrder.append(key)
        while cache.count > maxCachedTiles, let oldest = cacheAccessOrder.first {
            cacheAccessOrder.removeFirst()
            cache.removeValue(forKey: oldest)
        }
    }

    func load(refLat: Double, refLon: Double) async throws -> TerrainWireframeData {
        let latRadius = radiusNm / 60.0
        let lonRadius = radiusNm / (60.0 * max(0.2, cos(refLat * .pi / 180.0)))
        let minLat = refLat - latRadius
        let maxLat = refLat + latRadius
        let minLon = refLon - lonRadius
        let maxLon = refLon + lonRadius

        let minTileX = lonToTileX(minLon)
        let maxTileX = lonToTileX(maxLon)
        let minTileY = latToTileY(maxLat)
        let maxTileY = latToTileY(minLat)

        var tiles: [TileKey: TileImage] = [:]
        await withTaskGroup(of: (TileKey, TileImage?).self) { group in
            for tileY in minTileY...maxTileY {
                for tileX in minTileX...maxTileX {
                    let key = TileKey(z: zoom, x: tileX, y: tileY)
                    group.addTask { [cache, imagePipeline, tileBaseURL] in
                        if let cached = cache[key] {
                            return (key, cached)
                        }
                        let url = tileBaseURL.appending(path: "\(key.z)/\(key.x)/\(key.y).png")
                        do {
                            let image = try await imagePipeline.image(for: url)
                            guard let tileImage = TerrainWireframeLoader.decodeTile(image: image) else {
                                return (key, nil)
                            }
                            return (key, tileImage)
                        } catch {
                            return (key, nil)
                        }
                    }
                }
            }

            for await (key, tileImage) in group {
                if let tileImage {
                    storeCachedTile(tileImage, for: key)
                    tiles[key] = tileImage
                }
            }
        }
        let pointsPerAxis = gridSegments + 1
        var vertices: [TerrainWireframeData.Vertex] = []
        vertices.reserveCapacity(pointsPerAxis * pointsPerAxis)

        for row in 0...gridSegments {
            let v = Double(row) / Double(gridSegments)
            let lat = maxLat - v * (maxLat - minLat)
            let tileYFloat = latToTileYFloat(lat)
            for column in 0...gridSegments {
                let u = Double(column) / Double(gridSegments)
                let lon = minLon + u * (maxLon - minLon)
                let tileXFloat = lonToTileXFloat(lon)
                let tileX = Int(floor(tileXFloat))
                let tileY = Int(floor(tileYFloat))
                let key = TileKey(z: zoom, x: tileX, y: tileY)
                let px = clamp(Int(floor((tileXFloat - Double(tileX)) * Double(tileSize))), min: 0, max: tileSize - 1)
                let py = clamp(Int(floor((tileYFloat - Double(tileY)) * Double(tileSize))), min: 0, max: tileSize - 1)
                let elevationFeet = decodeElevationFeet(tile: tiles[key], x: px, y: py)
                let eastNm = (lon - refLon) * 60.0 * cos(refLat * .pi / 180.0)
                let northNm = (lat - refLat) * 60.0
                vertices.append(.init(eastNm: eastNm, northNm: northNm, elevationFeet: elevationFeet))
            }
        }

        return TerrainWireframeData(rows: pointsPerAxis, columns: pointsPerAxis, vertices: vertices)
    }

    private func decodeElevationFeet(tile: TileImage?, x: Int, y: Int) -> Double {
        guard let tile else { return 0 }
        let index = (y * tile.width + x) * 4
        guard index + 3 < tile.pixels.count else { return 0 }
        let alpha = tile.pixels[index + 3]
        if alpha == 0 { return 0 }
        let r = Double(tile.pixels[index])
        let g = Double(tile.pixels[index + 1])
        let b = Double(tile.pixels[index + 2])
        let elevationMeters = r * 256.0 + g + b / 256.0 - 32768.0
        return elevationMeters * 3.28084
    }

    private func lonToTileX(_ lon: Double) -> Int {
        Int(floor(((lon + 180.0) / 360.0) * Double(1 << zoom)))
    }

    private func latToTileY(_ lat: Double) -> Int {
        Int(floor(latToTileYFloat(lat)))
    }

    private func lonToTileXFloat(_ lon: Double) -> Double {
        ((lon + 180.0) / 360.0) * Double(1 << zoom)
    }

    private func latToTileYFloat(_ lat: Double) -> Double {
        let latRadians = lat * .pi / 180.0
        let mercator = log(tan(.pi / 4.0 + latRadians / 2.0))
        return (1.0 - mercator / .pi) * 0.5 * Double(1 << zoom)
    }

    private func clamp(_ value: Int, min: Int, max: Int) -> Int {
        Swift.max(min, Swift.min(max, value))
    }

    private static func decodeTile(image: PlatformImage) -> TileImage? {
        guard let image = platformCGImage(from: image) else {
            return nil
        }
        let width = image.width
        let height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: &pixels,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return nil
        }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return TileImage(width: width, height: height, pixels: pixels)
    }
}
