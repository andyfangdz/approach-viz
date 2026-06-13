import Foundation
import simd

/// Phase-aware dBZ color bands ported from the web client
/// (`app/scene/nexrad/nexrad-types.ts` + `nexrad-render.ts`). Band hex values
/// run through the same visibility gain and minimum-luminance lift, then land
/// in flat per-phase LUTs indexed by `floor(dbz / 5)`.
enum MrmsVoxelPalette {
    static let phaseRain: UInt8 = 0
    static let phaseMixed: UInt8 = 1
    static let phaseSnow: UInt8 = 2

    private static let colorGain = 1.28
    private static let minVisibleLuminance = 58.0
    private static let bandStep = 5.0
    private static let lutMaxIndex = 19

    /// `(minDbz, hex)` pairs ordered from highest to lowest threshold,
    /// matching the web band tables exactly.
    private static let rainBands: [(Double, UInt32)] = [
        (95, 0xEBEBEB), (90, 0xD9D9D9), (85, 0xC6C6C6), (80, 0xB1B1B1),
        (75, 0x9A9A9A), (70, 0x7B00BB), (65, 0x9A00D5), (60, 0xBA00E8),
        (55, 0xD500F5), (50, 0xE90000), (45, 0xF92D00), (40, 0xFF5A00),
        (35, 0xFF8600), (30, 0xFFB000), (25, 0xFFD700), (20, 0x23BC34),
        (15, 0x2ED643), (10, 0x39EB53), (5, 0x49FF64),
    ]

    private static let mixedBands: [(Double, UInt32)] = [
        (75, 0x6B006B), (70, 0x7D0072), (65, 0x8F0079), (60, 0xA10080),
        (55, 0xB30086), (50, 0xC30D8D), (45, 0xC92096), (40, 0xD0339F),
        (35, 0xD746A7), (30, 0xDD59B0), (25, 0xE46DB9), (20, 0xEA80C2),
        (15, 0xF093CB), (10, 0xF5A6D3), (5, 0xFAB8DC),
    ]

    private static let snowBands: [(Double, UInt32)] = [
        (75, 0x031763), (70, 0x041F82), (65, 0x062AA3), (60, 0x0837C4),
        (55, 0x0A46E6), (50, 0x0F5AFF), (45, 0x146EFF), (40, 0x1A82FF),
        (35, 0x2196FF), (30, 0x27A7FF), (25, 0x31B8FF), (20, 0x43C4FF),
        (15, 0x56D0FF), (10, 0x69DCFF), (5, 0x7DE8FF),
    ]

    private static let rainLut = buildLut(bands: rainBands)
    private static let mixedLut = buildLut(bands: mixedBands)
    private static let snowLut = buildLut(bands: snowBands)

    static func color(dbz: Float, phaseCode: UInt8) -> SIMD3<Float> {
        let lut = switch phaseCode {
        case phaseSnow: snowLut
        case phaseMixed: mixedLut
        default: rainLut
        }
        return lut[lutIndex(dbz: dbz)]
    }

    /// dBZ → per-voxel alpha ramp (web `dbzToAlpha`): low-intensity echoes are
    /// nearly transparent, high-intensity cores stay prominent.
    static func alpha(dbz: Float) -> Float {
        let t = max(0, min(1, (dbz - 5) / 60))
        return 0.1 + 0.9 * pow(t, 1.5)
    }

    private static func lutIndex(dbz: Float) -> Int {
        guard dbz.isFinite else { return 0 }
        return min(lutMaxIndex, max(0, Int(floor(Double(dbz) / bandStep))))
    }

    private static func buildLut(bands: [(Double, UInt32)]) -> [SIMD3<Float>] {
        (0...lutMaxIndex).map { index in
            let dbz = Double(index) * bandStep
            let band = bands.first { dbz >= $0.0 } ?? bands[bands.count - 1]
            return applyVisibilityGain(hex: band.1)
        }
    }

    /// Web `applyVisibilityGain`: boost brightness while preserving hue
    /// (gain capped at the channel clip point), then lift very dark colors to
    /// a minimum luminance so they stay visible against the dark scene.
    private static func applyVisibilityGain(hex: UInt32) -> SIMD3<Float> {
        let red = Double((hex >> 16) & 0xFF)
        let green = Double((hex >> 8) & 0xFF)
        let blue = Double(hex & 0xFF)

        let peakChannel = max(red, green, blue, 1)
        let safeGainScale = min(colorGain, 255.0 / peakChannel)
        var boostedRed = min(255, max(0, (red * safeGainScale).rounded()))
        var boostedGreen = min(255, max(0, (green * safeGainScale).rounded()))
        var boostedBlue = min(255, max(0, (blue * safeGainScale).rounded()))

        let luminance = 0.2126 * boostedRed + 0.7152 * boostedGreen + 0.0722 * boostedBlue
        if luminance > 0, luminance < minVisibleLuminance {
            let lift = minVisibleLuminance / luminance
            boostedRed = min(255, max(0, (boostedRed * lift).rounded()))
            boostedGreen = min(255, max(0, (boostedGreen * lift).rounded()))
            boostedBlue = min(255, max(0, (boostedBlue * lift).rounded()))
        }
        return SIMD3<Float>(
            Float(boostedRed / 255.0),
            Float(boostedGreen / 255.0),
            Float(boostedBlue / 255.0)
        )
    }
}

/// Format an echo-top altitude like the web `feetLabel` helper.
func mrmsFeetLabel(_ feet: Float) -> String {
    guard feet.isFinite, feet > 0 else { return "n/a" }
    return String(format: "%.1f kft", feet / 1000)
}

/// Cross-section altitude tick label like the web `altitudeTickLabel` helper.
func mrmsAltitudeTickLabel(_ feet: Float) -> String {
    if feet <= 0 { return "SFC" }
    let kft = feet / 1000
    let rounded = (kft * 10).rounded() / 10
    let asInt = rounded.rounded()
    return abs(rounded - asInt) < 0.05
        ? "\(Int(asInt))k"
        : String(format: "%.1fk", rounded)
}

private let feetPerNm: Float = 6076.12
private let altitudeGuideStepFeet: Float = 5_000
private let weatherMaxRangeNm: Float = 120

private func lerp(_ a: Float, _ b: Float, _ t: Float) -> Float {
    a + (b - a) * max(0, min(1, t))
}

private func colorFromHex(_ hex: UInt32, alpha: Float) -> SIMD4<Float> {
    SIMD4<Float>(
        Float((hex >> 16) & 0xFF) / 255,
        Float((hex >> 8) & 0xFF) / 255,
        Float(hex & 0xFF) / 255,
        alpha
    )
}

/// Build the dynamic MRMS weather render layers from the Rust render columns:
/// voxel instances (base + glow passes share the buffer), echo-top threshold
/// surfaces, altitude-guide rings/labels, and the cross-section slice plane.
/// The Rust engine already resolved the prepare-pass index spaces, so voxel
/// assembly is a straight per-voxel mapping with vertical scale applied to
/// altitude centers and heights.
func buildMrmsRenderScene(
    _ mrmsScene: NativeMrmsScene?,
    echoTopScene: NativeEchoTopScene?,
    layerState: NativeLayerState,
    weatherOptions: NativeWeatherDisplayOptions,
    verticalScale: Double
) -> MrmsRenderScene {
    var scene = MrmsRenderScene()
    let scale = Float(verticalScale)
    let opacity = Float(min(1, max(0, weatherOptions.opacity)))

    // Master opacity maps per pass exactly like the web overlay's material
    // opacity effect.
    scene.baseShade = MetalVoxelShadeParams(
        densityScale: 1.12,
        softCap: 2.5,
        materialOpacity: lerp(0.12, 0.66, opacity)
    )
    scene.glowShade = MetalVoxelShadeParams(
        densityScale: 0.62,
        softCap: 1.6,
        materialOpacity: lerp(0.01, 0.08, opacity)
    )

    if layerState.mrms, let mrmsScene, mrmsScene.voxelCount > 0 {
        scene.voxelInstances.reserveCapacity(mrmsScene.voxelCount)
        for index in 0..<mrmsScene.voxelCount {
            let dbz = mrmsScene.dbz[index]
            let rgb = MrmsVoxelPalette.color(dbz: dbz, phaseCode: mrmsScene.phaseCode[index])
            scene.voxelInstances.append(MetalVoxelInstance(
                center: SIMD3<Float>(
                    mrmsScene.centerXNm[index],
                    mrmsScene.centerYNm[index] * scale,
                    mrmsScene.centerZNm[index]
                ),
                halfExtent: SIMD3<Float>(
                    mrmsScene.sizeXNm[index] * 0.5,
                    mrmsScene.sizeYNm[index] * scale * 0.5,
                    mrmsScene.sizeZNm[index] * 0.5
                ),
                color: SIMD4<Float>(rgb.x, rgb.y, rgb.z, MrmsVoxelPalette.alpha(dbz: dbz))
            ))
        }
    }

    if layerState.echotops, let echoTopScene {
        appendEchoTopSurface(
            echoTopScene.top18,
            color: colorFromHex(0x72F1FF, alpha: lerp(0.08, 0.24, opacity)),
            footprintXNm: echoTopScene.footprintXNm,
            footprintYNm: echoTopScene.footprintYNm,
            verticalScale: scale,
            into: &scene.echoTopInstances
        )
        appendEchoTopSurface(
            echoTopScene.top30,
            color: colorFromHex(0xFFC44A, alpha: lerp(0.11, 0.29, opacity)),
            footprintXNm: echoTopScene.footprintXNm,
            footprintYNm: echoTopScene.footprintYNm,
            verticalScale: scale,
            into: &scene.echoTopInstances
        )
        appendEchoTopSurface(
            echoTopScene.top50,
            color: colorFromHex(0xFF5A63, alpha: lerp(0.14, 0.34, opacity)),
            footprintXNm: echoTopScene.footprintXNm,
            footprintYNm: echoTopScene.footprintYNm,
            verticalScale: scale,
            into: &scene.echoTopInstances
        )
    }

    if layerState.guides {
        appendAltitudeGuides(
            mrmsScene: layerState.mrms ? mrmsScene : nil,
            echoTopScene: layerState.echotops ? echoTopScene : nil,
            verticalScale: scale,
            into: &scene
        )
    }

    if layerState.slice, let crossSection = mrmsScene?.crossSection {
        appendCrossSectionGeometry(
            crossSection,
            weatherOptions: weatherOptions,
            verticalScale: scale,
            into: &scene
        )
    }

    return scene
}

/// Echo-top cells render as thin instanced tiles at the threshold altitude,
/// matching the web's constant-color instanced meshes (Y scale
/// `MIN_VOXEL_HEIGHT_NM` = 0.04 NM inside the vertically scaled group).
private func appendEchoTopSurface(
    _ surface: NativeEchoTopScene.Surface,
    color: SIMD4<Float>,
    footprintXNm: Float,
    footprintYNm: Float,
    verticalScale: Float,
    into instances: inout [MetalVoxelInstance]
) {
    let halfExtent = SIMD3<Float>(
        footprintXNm * 0.5,
        0.04 * verticalScale * 0.5,
        footprintYNm * 0.5
    )
    instances.reserveCapacity(instances.count + surface.xNm.count)
    for index in 0..<surface.xNm.count {
        instances.append(MetalVoxelInstance(
            center: SIMD3<Float>(
                surface.xNm[index],
                surface.yNm[index] * verticalScale,
                surface.zNm[index]
            ),
            halfExtent: halfExtent,
            color: color
        ))
    }
}

/// Altitude-guide rings every 5,000 ft sized to the rendered weather extents,
/// with corner labels — the web overlay's `guideData` geometry.
private func appendAltitudeGuides(
    mrmsScene: NativeMrmsScene?,
    echoTopScene: NativeEchoTopScene?,
    verticalScale: Float,
    into scene: inout MrmsRenderScene
) {
    guard let mrmsScene, mrmsScene.voxelCount > 0 else { return }

    var extentNm = max(mrmsScene.maxAbsXNm, mrmsScene.maxAbsZNm)
    var maxFeet = mrmsScene.maxCorrectedTopFeet
    if let echoTopScene {
        maxFeet = max(
            maxFeet,
            echoTopScene.maxTop18Feet,
            echoTopScene.maxTop30Feet,
            echoTopScene.maxTop50Feet,
            echoTopScene.maxTop60Feet
        )
    }
    extentNm = min(weatherMaxRangeNm, max(6, extentNm + 2))
    maxFeet = max(10_000, (maxFeet / altitudeGuideStepFeet).rounded(.up) * altitudeGuideStepFeet)

    let guideColor = SIMD4<Float>(184.0 / 255.0, 210.0 / 255.0, 1.0, 0.25)
    var feet = altitudeGuideStepFeet
    while feet <= maxFeet {
        let y = feet / feetPerNm * verticalScale
        let e = extentNm
        let corners = [
            SIMD3<Float>(-e, y, -e),
            SIMD3<Float>(e, y, -e),
            SIMD3<Float>(e, y, e),
            SIMD3<Float>(-e, y, e),
        ]
        for index in 0..<4 {
            scene.lineVertices.append(MetalVertex(position: corners[index], color: guideColor))
            scene.lineVertices.append(MetalVertex(position: corners[(index + 1) % 4], color: guideColor))
        }
        scene.labels.append(LabelAnchor(
            id: "mrms-alt-guide-\(Int(feet))",
            text: "\(Int(feet / 1000))k",
            position: SIMD3<Float>(-e, y, -e),
            color: platformColor(red: 184.0 / 255.0, green: 210.0 / 255.0, blue: 1.0, alpha: 1.0),
            fontSize: 9,
            declutterable: false
        ))
        feet += altitudeGuideStepFeet
    }
}

/// Cross-section world geometry: a translucent slice plane through the scene
/// origin along the slice heading, plus a bright ground axis line — the
/// in-scene half of the web `NexradCrossSection` (the heatmap panel itself is
/// a SwiftUI overlay).
private func appendCrossSectionGeometry(
    _ crossSection: NativeCrossSection,
    weatherOptions: NativeWeatherDisplayOptions,
    verticalScale: Float,
    into scene: inout MrmsRenderScene
) {
    let headingRadians = Float(weatherOptions.crossSectionHeadingDeg.rounded()) * .pi / 180
    let axis = SIMD3<Float>(sin(headingRadians), 0, -cos(headingRadians))
    let range = Float(max(30, min(140, weatherOptions.crossSectionRangeNm.rounded())))
    let heightNm = max(crossSection.maxTopFeet, 12_000) / feetPerNm * verticalScale

    let nearBottom = axis * -range
    let farBottom = axis * range
    let nearTop = nearBottom + SIMD3<Float>(0, heightNm, 0)
    let farTop = farBottom + SIMD3<Float>(0, heightNm, 0)

    let planeColor = colorFromHex(0x99E9FF, alpha: 0.06)
    for vertex in [nearBottom, farBottom, farTop, nearBottom, farTop, nearTop] {
        scene.triangleVertices.append(MetalVertex(position: vertex, color: planeColor))
    }

    let axisColor = colorFromHex(0x7DE8FF, alpha: 0.9)
    let lift = SIMD3<Float>(0, 0.01, 0)
    scene.lineVertices.append(MetalVertex(position: nearBottom + lift, color: axisColor))
    scene.lineVertices.append(MetalVertex(position: farBottom + lift, color: axisColor))
}
