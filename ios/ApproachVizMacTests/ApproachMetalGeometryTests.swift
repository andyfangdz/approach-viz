import XCTest
import simd

@testable import ApproachViz

final class ApproachMetalGeometryTests: XCTestCase {
    // MARK: - metalReciprocalRunwayID

    func testReciprocalRunwayFlipsHeadingAndSide() {
        XCTAssertEqual(metalReciprocalRunwayID("RW06"), "RW24")
        XCTAssertEqual(metalReciprocalRunwayID("RW24"), "RW06")
        XCTAssertEqual(metalReciprocalRunwayID("RW06L"), "RW24R")
        XCTAssertEqual(metalReciprocalRunwayID("RW24R"), "RW06L")
        XCTAssertEqual(metalReciprocalRunwayID("RW18C"), "RW36C")
    }

    func testReciprocalRunwayWrapsAroundNorth() {
        XCTAssertEqual(metalReciprocalRunwayID("RW36"), "RW18")
        XCTAssertEqual(metalReciprocalRunwayID("RW01"), "RW19")
        XCTAssertEqual(metalReciprocalRunwayID("RW19"), "RW01")
    }

    func testReciprocalRunwayRejectsMalformedIdentifiers() {
        XCTAssertNil(metalReciprocalRunwayID("RWAB"))
        XCTAssertNil(metalReciprocalRunwayID("RW123"))
        XCTAssertNil(metalReciprocalRunwayID(""))
        XCTAssertNil(metalReciprocalRunwayID("RW06X"))
    }

    // MARK: - sanitizedAirspaceRing

    func testSanitizedRingDropsConsecutiveDuplicatesAndClosingPoint() {
        let ring: [SIMD3<Float>] = [
            SIMD3(0, 0, 0),
            SIMD3(0, 0, 0),
            SIMD3(1, 0, 0),
            SIMD3(1, 0, 1),
            SIMD3(0, 0, 0)
        ]
        let sanitized = sanitizedAirspaceRing(ring)
        XCTAssertEqual(sanitized.count, 3)
        XCTAssertEqual(sanitized.first, SIMD3(0, 0, 0))
        XCTAssertEqual(sanitized.last, SIMD3(1, 0, 1))
    }

    func testSanitizedRingHandlesEmptyInput() {
        XCTAssertTrue(sanitizedAirspaceRing([]).isEmpty)
    }

    // MARK: - triangulateAirspaceRing

    func testTriangulationOfConvexQuadProducesTwoTriangles() {
        let quad: [SIMD3<Float>] = [
            SIMD3(0, 0, 0),
            SIMD3(1, 0, 0),
            SIMD3(1, 0, 1),
            SIMD3(0, 0, 1)
        ]
        let triangles = triangulateAirspaceRing(quad)
        XCTAssertEqual(triangles.count, 2)
        assertTrianglesCoverArea(of: quad, triangles: triangles, expectedArea: 1.0)
    }

    func testTriangulationOfConcavePolygonCoversCorrectArea() {
        // L-shaped (concave) hexagon with area 3.
        let lShape: [SIMD3<Float>] = [
            SIMD3(0, 0, 0),
            SIMD3(2, 0, 0),
            SIMD3(2, 0, 1),
            SIMD3(1, 0, 1),
            SIMD3(1, 0, 2),
            SIMD3(0, 0, 2)
        ]
        let triangles = triangulateAirspaceRing(lShape)
        XCTAssertEqual(triangles.count, lShape.count - 2)
        assertTrianglesCoverArea(of: lShape, triangles: triangles, expectedArea: 3.0)
    }

    func testTriangulationRejectsDegenerateInput() {
        XCTAssertTrue(triangulateAirspaceRing([]).isEmpty)
        XCTAssertTrue(triangulateAirspaceRing([SIMD3(0, 0, 0), SIMD3(1, 0, 0)]).isEmpty)
    }

    func testTriangulationIndicesAreInBounds() {
        let pentagon: [SIMD3<Float>] = (0..<5).map { i in
            let angle = Float(i) / 5 * 2 * .pi
            return SIMD3(cos(angle), 0, sin(angle))
        }
        let triangles = triangulateAirspaceRing(pentagon)
        for (a, b, c) in triangles {
            for index in [a, b, c] {
                XCTAssertTrue(pentagon.indices.contains(index))
            }
            XCTAssertNotEqual(a, b)
            XCTAssertNotEqual(b, c)
            XCTAssertNotEqual(a, c)
        }
    }

    // MARK: - Helpers

    private func assertTrianglesCoverArea(
        of points: [SIMD3<Float>],
        triangles: [(Int, Int, Int)],
        expectedArea: Float,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        var total: Float = 0
        for (a, b, c) in triangles {
            let ab = points[b] - points[a]
            let ac = points[c] - points[a]
            total += simd_length(simd_cross(ab, ac)) / 2
        }
        XCTAssertEqual(total, expectedArea, accuracy: 1e-4, file: file, line: line)
    }
}
