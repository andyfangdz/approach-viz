import CoreGraphics
import SwiftUI

/// Screen-space MRMS vertical-slice panel: the native port of the web
/// `NexradCrossSection` HUD — a heatmap of the slice grid with altitude ticks,
/// a heading/range header, and an echo-tops summary footer. The in-scene
/// slice plane and ground axis line render in Metal; this panel is the 2D
/// readout.
struct CrossSectionHUDView: View {
    let crossSection: NativeCrossSection
    let headingDeg: Double
    let rangeNm: Double
    let echoTopScene: NativeEchoTopScene?

    private struct AltitudeTick: Identifiable {
        let feet: Float
        let label: String
        let topFraction: CGFloat

        var id: Float { feet }
    }

    private static let heatmapWidth: CGFloat = 240
    private static let heatmapHeight: CGFloat = 112

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("MRMS Vertical Slice")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.86))
                Spacer(minLength: 12)
                Text("\(Int(headingDeg.rounded()))° / \(Int(rangeNm.rounded())) NM")
                    .font(.caption2)
                    .foregroundStyle(.white.opacity(0.6))
            }

            HStack(alignment: .top, spacing: 6) {
                ZStack(alignment: .topTrailing) {
                    ForEach(altitudeTicks) { tick in
                        Text(tick.label)
                            .font(.system(size: 8, weight: .medium))
                            .foregroundStyle(.white.opacity(0.55))
                            .offset(y: tick.topFraction * (Self.heatmapHeight - 10))
                    }
                }
                .frame(width: 30, height: Self.heatmapHeight, alignment: .topTrailing)

                if let image = heatmapImage {
                    Image(decorative: image, scale: 1)
                        .resizable()
                        .interpolation(.none)
                        .frame(width: Self.heatmapWidth, height: Self.heatmapHeight)
                        .clipShape(RoundedRectangle(cornerRadius: 4))
                }
            }

            Text("Echo Tops 18/30/50: \(echoTopSummary)")
                .font(.caption2)
                .foregroundStyle(.white.opacity(0.6))
        }
        .padding(10)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(Color.white.opacity(0.08))
        )
        .allowsHitTesting(false)
    }

    private var echoTopSummary: String {
        guard let echoTopScene else { return "n/a / n/a / n/a" }
        let top18 = mrmsFeetLabel(echoTopScene.maxTop18Feet)
        let top30 = mrmsFeetLabel(echoTopScene.maxTop30Feet)
        let top50 = mrmsFeetLabel(echoTopScene.maxTop50Feet)
        return "\(top18) / \(top30) / \(top50)"
    }

    /// Tick steps follow the web panel: 2.5k below 15k ft, 5k below 45k ft,
    /// otherwise 10k, always including the grid ceiling.
    private var altitudeTicks: [AltitudeTick] {
        let maxFeet = crossSection.maxTopFeet
        guard maxFeet.isFinite, maxFeet > 0 else { return [] }
        let stepFeet: Float = maxFeet <= 15_000 ? 2_500 : maxFeet <= 45_000 ? 5_000 : 10_000
        var values: [Float] = []
        var feet: Float = 0
        while feet <= maxFeet {
            values.append(feet)
            feet += stepFeet
        }
        if values.last != maxFeet {
            values.append(maxFeet)
        }
        return values.reversed().map { feet in
            AltitudeTick(
                feet: feet,
                label: mrmsAltitudeTickLabel(feet),
                topFraction: CGFloat(1 - feet / maxFeet)
            )
        }
    }

    /// Build the slice heatmap exactly like the web canvas painter: dark
    /// background, per-cell phase-banded dBZ colors (row 0 is the lowest
    /// altitude, drawn at the bottom), and the white echo-top envelope line.
    private var heatmapImage: CGImage? {
        let binsX = crossSection.binsX
        let binsY = crossSection.binsY
        guard binsX > 0, binsY > 0,
              crossSection.gridDbz.count == binsX * binsY,
              crossSection.gridPhase.count == binsX * binsY,
              crossSection.topEnvelopeFeet.count == binsX else {
            return nil
        }

        let bytesPerPixel = 4
        var pixels = [UInt8](repeating: 0, count: binsX * binsY * bytesPerPixel)
        let background: (UInt8, UInt8, UInt8) = (0x08, 0x11, 0x1D)

        for row in 0..<binsY {
            for column in 0..<binsX {
                let gridIndex = row * binsX + column
                // Image rows run top-down; grid rows run bottom-up.
                let pixelIndex = ((binsY - 1 - row) * binsX + column) * bytesPerPixel
                let dbz = crossSection.gridDbz[gridIndex]
                if dbz >= 0 {
                    let rgb = MrmsVoxelPalette.color(
                        dbz: dbz,
                        phaseCode: crossSection.gridPhase[gridIndex]
                    )
                    pixels[pixelIndex] = UInt8(max(0, min(255, rgb.x * 255)))
                    pixels[pixelIndex + 1] = UInt8(max(0, min(255, rgb.y * 255)))
                    pixels[pixelIndex + 2] = UInt8(max(0, min(255, rgb.z * 255)))
                } else {
                    pixels[pixelIndex] = background.0
                    pixels[pixelIndex + 1] = background.1
                    pixels[pixelIndex + 2] = background.2
                }
                pixels[pixelIndex + 3] = 255
            }
        }

        // Echo-top envelope: one white pixel per column at the envelope row.
        let maxTopFeet = crossSection.maxTopFeet
        if maxTopFeet > 0 {
            for column in 0..<binsX {
                let topFeet = crossSection.topEnvelopeFeet[column]
                guard topFeet.isFinite, topFeet > 0 else { continue }
                let rowFromTop = Int((1 - topFeet / maxTopFeet) * Float(binsY))
                let clamped = max(0, min(binsY - 1, rowFromTop))
                let pixelIndex = (clamped * binsX + column) * bytesPerPixel
                pixels[pixelIndex] = 255
                pixels[pixelIndex + 1] = 255
                pixels[pixelIndex + 2] = 255
            }
        }

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let provider = CGDataProvider(data: Data(pixels) as CFData) else {
            return nil
        }
        return CGImage(
            width: binsX,
            height: binsY,
            bitsPerComponent: 8,
            bitsPerPixel: 32,
            bytesPerRow: binsX * bytesPerPixel,
            space: colorSpace,
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider,
            decode: nil,
            shouldInterpolate: false,
            intent: .defaultIntent
        )
    }
}
