import MetalKit
import XCTest

@testable import ApproachViz

@MainActor
final class MrmsRenderTests: XCTestCase {
    /// Pipeline creation compiles every shader function pair, so a missing or
    /// signature-mismatched Metal function (e.g. the voxel base/glow or
    /// flat-shaded echo-top fragments) fails here instead of as a silently
    /// blank renderer at app launch.
    func testRenderEngineBuildsAllPipelines() throws {
        guard let device = MTLCreateSystemDefaultDevice() else {
            throw XCTSkip("No Metal device available on this test host")
        }
        guard device.makeDefaultLibrary() != nil else {
            throw XCTSkip("Test host has no default Metal library")
        }
        let view = MTKView(frame: CGRect(x: 0, y: 0, width: 64, height: 64), device: device)
        view.colorPixelFormat = .bgra8Unorm
        view.depthStencilPixelFormat = .depth32Float
        let engine = ApproachMetalRenderEngine(view: view, onStatsChanged: { _ in })
        XCTAssertNotNil(engine)
    }

    func testBuildMrmsRenderSceneAssemblesAllWeatherLayers() {
        let mrmsScene = NativeMrmsScene(
            voxelCount: 1,
            sourceVoxelCount: 1,
            validVoxelCount: 1,
            generatedAtMs: 0,
            scanTimeMs: 0,
            centerXNm: [4],
            centerYNm: [1],
            centerZNm: [-3],
            sizeXNm: [0.5],
            sizeYNm: [0.3],
            sizeZNm: [0.6],
            dbz: [42],
            phaseCode: [0],
            maxAbsXNm: 4,
            maxAbsZNm: 3,
            maxCorrectedTopFeet: 9_000,
            crossSection: NativeCrossSection(
                binsX: 2,
                binsY: 2,
                gridDbz: [10, -1, -1, 30],
                gridPhase: [0, 0, 0, 2],
                topEnvelopeFeet: [8_000, 9_000],
                maxTopFeet: 10_000
            )
        )
        let echoTopScene = NativeEchoTopScene(
            sourceCellCount: 2,
            generatedAtMs: 0,
            scanTimeMs: 0,
            footprintXNm: 0.5,
            footprintYNm: 0.6,
            maxTop18Feet: 9_500,
            maxTop30Feet: 8_000,
            maxTop50Feet: 0,
            maxTop60Feet: 0,
            top18: .init(xNm: [1, 2], zNm: [0, 0], yNm: [1.5, 1.4]),
            top30: .init(xNm: [1], zNm: [0], yNm: [1.2]),
            top50: .init(xNm: [], zNm: [], yNm: [])
        )
        var layerState = NativeLayerState()
        layerState.mrms = true
        layerState.echotops = true
        layerState.slice = true
        layerState.guides = true

        let scene = buildMrmsRenderScene(
            mrmsScene,
            echoTopScene: echoTopScene,
            layerState: layerState,
            weatherOptions: NativeWeatherDisplayOptions(),
            verticalScale: 3.0
        )

        XCTAssertEqual(scene.voxelInstances.count, 1)
        // Vertical scale applies to altitude centers and heights only.
        XCTAssertEqual(scene.voxelInstances[0].center.y, 3.0, accuracy: 1e-5)
        XCTAssertEqual(scene.voxelInstances[0].halfExtent.y, 0.45, accuracy: 1e-5)
        XCTAssertEqual(scene.voxelInstances[0].halfExtent.x, 0.25, accuracy: 1e-5)

        // 18 dBZ surface has 2 cells, 30 dBZ has 1, 50 dBZ none.
        XCTAssertEqual(scene.echoTopInstances.count, 3)

        // Guides: ceiling rounds up to 10k ft -> rings at 5k and 10k
        // (4 segments x 2 vertices each), plus the slice ground axis line.
        XCTAssertEqual(scene.lineVertices.count, 2 * 8 + 2)
        XCTAssertEqual(scene.labels.map(\.text).sorted(), ["10k", "5k"])

        // Slice plane is two triangles.
        XCTAssertEqual(scene.triangleVertices.count, 6)

        // Disabling layers empties their geometry without touching others.
        var guidesOnly = layerState
        guidesOnly.mrms = false
        guidesOnly.echotops = false
        guidesOnly.slice = false
        let reduced = buildMrmsRenderScene(
            mrmsScene,
            echoTopScene: echoTopScene,
            layerState: guidesOnly,
            weatherOptions: NativeWeatherDisplayOptions(),
            verticalScale: 3.0
        )
        XCTAssertTrue(reduced.voxelInstances.isEmpty)
        XCTAssertTrue(reduced.echoTopInstances.isEmpty)
        XCTAssertTrue(reduced.triangleVertices.isEmpty)
        // Guides require rendered volume voxels (web parity), so the mrms-off
        // state leaves the guide lines empty as well.
        XCTAssertTrue(reduced.lineVertices.isEmpty)
    }

    func testCrossSectionLabelHelpersMatchWebFormatting() {
        XCTAssertEqual(mrmsFeetLabel(0), "n/a")
        XCTAssertEqual(mrmsFeetLabel(12_340), "12.3 kft")
        XCTAssertEqual(mrmsAltitudeTickLabel(0), "SFC")
        XCTAssertEqual(mrmsAltitudeTickLabel(5_000), "5k")
        XCTAssertEqual(mrmsAltitudeTickLabel(12_500), "12.5k")
    }
}
