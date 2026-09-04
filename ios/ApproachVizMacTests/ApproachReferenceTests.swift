import Foundation
import XCTest

@testable import ApproachViz

final class ApproachReferenceTests: XCTestCase {
    func testBuildTimeReferenceContract() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let data = try Data(contentsOf: root.appendingPathComponent("fixtures/approach-reference/resolved.json"))
        let reference = try JSONDecoder().decode(ApproachReference.self, from: data)
        XCTAssertEqual(reference.minimumsSummary?.sourceApproachName, "RNAV (GPS) RWY 09")
        XCTAssertEqual(reference.minimumsSummary?.da?.altitude, 350)
        XCTAssertNil(reference.minimumsSummary?.mda)
        XCTAssertEqual(reference.missedApproachClimbRequirement?.feetPerNm, 300)
        XCTAssertEqual(reference.missedApproachClimbRequirement?.targetAltitudeFeet, 4000)
    }

    func testMissingKeysFailButExplicitNoMatchIsValid() throws {
        XCTAssertThrowsError(try JSONDecoder().decode(ApproachReference.self, from: Data("{}".utf8)))
        let data = Data(#"{"minimumsSummary":null,"missedApproachClimbRequirement":null}"#.utf8)
        let reference = try JSONDecoder().decode(ApproachReference.self, from: data)
        XCTAssertNil(reference.minimumsSummary)
        XCTAssertNil(reference.missedApproachClimbRequirement)
    }
}
