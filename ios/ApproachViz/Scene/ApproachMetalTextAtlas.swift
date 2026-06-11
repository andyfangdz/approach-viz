import MetalKit
import os

@MainActor
final class ApproachMetalTextAtlas {
    private static let logger = Logger(
        subsystem: "app.approach-viz",
        category: "ApproachMetalTextAtlas"
    )

    struct Key: Hashable {
        let text: String
        let fontSize: CGFloat
    }

    struct Entry {
        let key: Key
        let renderSize: CGSize
        let atlasPixelSize: CGSize
        let uvMin: SIMD2<Float>
        let uvMax: SIMD2<Float>
    }

    private struct RasterizedLabel {
        let bytes: [UInt8]
        let pixelWidth: Int
        let pixelHeight: Int
        let displaySize: CGSize
    }

    private let device: MTLDevice
    private(set) var texture: MTLTexture?
    private var entries: [Key: Entry] = [:]
    private let textureWidth = 4096
    private let textureHeight = 4096
    private let padding = 12
    private let sdfScale: CGFloat = 2.0
    private let sdfSpread: Int = 12
    private var cursorX = 12
    private var cursorY = 12
    private var rowHeight = 0

    init(device: MTLDevice) {
        self.device = device
        texture = makeTexture()
    }

    func entry(for key: Key) -> Entry? {
        entries[key]
    }

    func ensureEntries(for keys: some Sequence<Key>) {
        ensureEntries(for: Array(keys), allowReset: true)
    }

    private func ensureEntries(for keyList: [Key], allowReset: Bool) {
        for key in keyList where entries[key] == nil {
            guard let raster = rasterize(key: key) else { continue }
            if let entry = place(raster: raster, for: key) {
                entries[key] = entry
                continue
            }
            guard allowReset else {
                // Even a freshly reset atlas cannot fit the current label set.
                // Fail loudly instead of letting labels vanish without a trace.
                Self.logger.error(
                    "Text atlas overflow even after reset; dropping label \(key.text, privacy: .public)"
                )
                assertionFailure("Text atlas cannot fit label set even after reset")
                continue
            }
            // Atlas texture is full: evict all entries, reset packing, and
            // re-place the full current key set so labels keep rendering
            // instead of silently disappearing once the texture fills up.
            resetPacking()
            ensureEntries(for: keyList, allowReset: false)
            return
        }
    }

    private func resetPacking() {
        entries.removeAll(keepingCapacity: true)
        cursorX = padding
        cursorY = padding
        rowHeight = 0
    }

    private func makeTexture() -> MTLTexture? {
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .bgra8Unorm,
            width: textureWidth,
            height: textureHeight,
            mipmapped: false
        )
        descriptor.usage = [.shaderRead]
        descriptor.storageMode = .shared
        return device.makeTexture(descriptor: descriptor)
    }

    private func rasterize(key: Key) -> RasterizedLabel? {
        let font = platformMonospacedFont(ofSize: key.fontSize, weight: .semibold)
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: platformWhiteColor(),
        ]
        let attributed = NSAttributedString(string: key.text, attributes: attributes)
        let measuredBounds = attributed.boundingRect(
            with: CGSize(width: 4096, height: 4096),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            context: nil
        )

        let displayWidth = max(2, Int(ceil(measuredBounds.width + 10)))
        let displayHeight = max(2, Int(ceil(measuredBounds.height + 6)))
        let pixelWidth = max(2, Int(ceil(CGFloat(displayWidth) * sdfScale)) + sdfSpread * 2)
        let pixelHeight = max(2, Int(ceil(CGFloat(displayHeight) * sdfScale)) + sdfSpread * 2)

        let colorSpace = CGColorSpaceCreateDeviceGray()
        let bytesPerRow = pixelWidth
        guard let context = CGContext(
            data: nil,
            width: pixelWidth,
            height: pixelHeight,
            bitsPerComponent: 8,
            bytesPerRow: bytesPerRow,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else {
            return nil
        }

        context.setFillColor(gray: 0, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: pixelWidth, height: pixelHeight))
        context.translateBy(x: 0, y: CGFloat(pixelHeight))
        context.scaleBy(x: sdfScale, y: -sdfScale)

        withPlatformGraphicsContext(context) {
            attributed.draw(
                in: CGRect(
                    x: CGFloat(sdfSpread) / sdfScale,
                    y: CGFloat(sdfSpread) / sdfScale,
                    width: CGFloat(displayWidth),
                    height: CGFloat(displayHeight)
                )
            )
        }

        guard let data = context.data else { return nil }
        let alphaBytes = Array(
            UnsafeBufferPointer(
                start: data.assumingMemoryBound(to: UInt8.self),
                count: pixelWidth * pixelHeight
            )
        )
        let sdfBytes = generateSignedDistanceField(
            alphaMask: alphaBytes,
            width: pixelWidth,
            height: pixelHeight,
            spread: sdfSpread
        )

        return RasterizedLabel(
            bytes: sdfBytes,
            pixelWidth: pixelWidth,
            pixelHeight: pixelHeight,
            displaySize: CGSize(width: displayWidth, height: displayHeight)
        )
    }

    private func place(raster: RasterizedLabel, for key: Key) -> Entry? {
        guard let texture else { return nil }
        if cursorX + raster.pixelWidth + padding > textureWidth {
            cursorX = padding
            cursorY += rowHeight + padding
            rowHeight = 0
        }
        guard cursorY + raster.pixelHeight + padding <= textureHeight else {
            return nil
        }

        let region = MTLRegionMake2D(cursorX, cursorY, raster.pixelWidth, raster.pixelHeight)
        raster.bytes.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { return }
            texture.replace(
                region: region,
                mipmapLevel: 0,
                withBytes: base,
                bytesPerRow: raster.pixelWidth * 4
            )
        }

        let entry = Entry(
            key: key,
            renderSize: CGSize(width: CGFloat(raster.pixelWidth) / sdfScale, height: CGFloat(raster.pixelHeight) / sdfScale),
            atlasPixelSize: CGSize(width: raster.pixelWidth, height: raster.pixelHeight),
            uvMin: SIMD2<Float>(Float(cursorX) / Float(textureWidth), Float(cursorY) / Float(textureHeight)),
            uvMax: SIMD2<Float>(
                Float(cursorX + raster.pixelWidth) / Float(textureWidth),
                Float(cursorY + raster.pixelHeight) / Float(textureHeight)
            )
        )

        cursorX += raster.pixelWidth + padding
        rowHeight = max(rowHeight, raster.pixelHeight)
        return entry
    }
}

private func generateSignedDistanceField(alphaMask: [UInt8], width: Int, height: Int, spread: Int) -> [UInt8] {
    let maxDistance = max(1, spread)
    let foreground = alphaMask.map { $0 >= 128 }
    let distToForeground = squaredDistanceTransform(
        featureMap: foreground.map { $0 ? 0 : squaredDistanceTransformInfinity },
        width: width,
        height: height
    )
    let distToBackground = squaredDistanceTransform(
        featureMap: foreground.map { $0 ? squaredDistanceTransformInfinity : 0 },
        width: width,
        height: height
    )
    var output = [UInt8](repeating: 0, count: width * height * 4)

    for y in 0..<height {
        for x in 0..<width {
            let index = y * width + x
            let isInside = foreground[index]
            let insideDistance = sqrt(distToBackground[index])
            let outsideDistance = sqrt(distToForeground[index])
            let signed = isInside ? insideDistance : -outsideDistance
            let normalized = max(0, min(1, 0.5 + signed / CGFloat(maxDistance) * 0.5))
            let byte = UInt8((normalized * 255).rounded())
            let outIndex = index * 4
            output[outIndex] = byte
            output[outIndex + 1] = byte
            output[outIndex + 2] = byte
            output[outIndex + 3] = byte
        }
    }

    return output
}

private let squaredDistanceTransformInfinity = CGFloat(1_000_000)

private func squaredDistanceTransform(featureMap: [CGFloat], width: Int, height: Int) -> [CGFloat] {
    var intermediate = [CGFloat](repeating: 0, count: width * height)
    var output = [CGFloat](repeating: 0, count: width * height)

    var column = [CGFloat](repeating: 0, count: height)
    for x in 0..<width {
        for y in 0..<height {
            column[y] = featureMap[y * width + x]
        }
        let transformed = squaredDistanceTransform1D(column)
        for y in 0..<height {
            intermediate[y * width + x] = transformed[y]
        }
    }

    var row = [CGFloat](repeating: 0, count: width)
    for y in 0..<height {
        for x in 0..<width {
            row[x] = intermediate[y * width + x]
        }
        let transformed = squaredDistanceTransform1D(row)
        for x in 0..<width {
            output[y * width + x] = transformed[x]
        }
    }

    return output
}

private func squaredDistanceTransform1D(_ values: [CGFloat]) -> [CGFloat] {
    let count = values.count
    guard count > 0 else { return [] }

    var locations = [Int](repeating: 0, count: count)
    var boundaries = [CGFloat](repeating: 0, count: count + 1)
    var result = [CGFloat](repeating: 0, count: count)
    var k = 0
    locations[0] = 0
    boundaries[0] = -.greatestFiniteMagnitude
    boundaries[1] = .greatestFiniteMagnitude

    for q in 1..<count {
        var intersection = CGFloat.zero
        while true {
            let p = locations[k]
            let numerator = (values[q] + CGFloat(q * q)) - (values[p] + CGFloat(p * p))
            intersection = numerator / CGFloat(2 * (q - p))
            if intersection > boundaries[k] || k == 0 {
                break
            }
            k -= 1
        }
        k += 1
        locations[k] = q
        boundaries[k] = intersection
        boundaries[k + 1] = .greatestFiniteMagnitude
    }

    k = 0
    for q in 0..<count {
        while boundaries[k + 1] < CGFloat(q) {
            k += 1
        }
        let p = locations[k]
        let delta = CGFloat(q - p)
        result[q] = delta * delta + values[p]
    }

    return result
}
