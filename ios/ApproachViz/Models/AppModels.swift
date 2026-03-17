import Foundation

struct AirportOption: Identifiable, Hashable {
    let id: String
    let label: String
}

struct ApproachOption: Identifiable, Hashable {
    let procedureID: String
    let type: String
    let runway: String

    var id: String { procedureID }
}

struct AirportRecord: Hashable {
    let id: String
    let name: String
    let lat: Double
    let lon: Double
    let elevation: Double
    let magneticVariation: Double
}

struct RunwayRecord: Hashable {
    let airportID: String
    let id: String
    let lat: Double
    let lon: Double
}

struct WaypointRecord: Hashable {
    let id: String
    let name: String
    let lat: Double
    let lon: Double
    let type: String
}

struct CycleInfo: Hashable {
    let cifpCycle: String
    let dtppCycle: String
}

struct MinimumsValueSummary: Hashable {
    let altitude: Double
    let type: String
    let category: String
}

struct MinimumsSummary: Hashable {
    let sourceApproachName: String
    let cycle: String
    let da: MinimumsValueSummary?
    let mda: MinimumsValueSummary?
}

struct MissedApproachClimbRequirement: Hashable {
    let feetPerNm: Double
    let targetAltitudeFeet: Double?
}

struct NativeSceneData: Hashable {
    let airport: AirportRecord
    let approaches: [ApproachOption]
    let selectedApproachID: String
    let currentApproach: SerializedApproach?
    let runways: [RunwayRecord]
    let waypoints: [WaypointRecord]
    let minimumsSummary: MinimumsSummary?
    let missedApproachClimbRequirement: MissedApproachClimbRequirement?
    let cycleInfo: CycleInfo?
}

struct SerializedApproach: Codable, Hashable {
    let airportId: String
    let procedureId: String
    let type: String
    let runway: String
    let transitions: [ApproachTransition]
    let finalLegs: [ApproachLeg]
    let missedLegs: [ApproachLeg]
}

struct ApproachTransition: Codable, Hashable {
    let name: String
    let legs: [ApproachLeg]

    init(name: String, legs: [ApproachLeg]) {
        self.name = name
        self.legs = legs
    }

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        self.name = try container.decode(String.self)
        self.legs = try container.decode([ApproachLeg].self)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.unkeyedContainer()
        try container.encode(name)
        try container.encode(legs)
    }
}

struct ApproachLeg: Codable, Hashable {
    let sequence: Int
    let waypointId: String
    let waypointName: String
    let pathTerminator: String
    let altitude: Double?
    let altitudeConstraint: String?
    let course: Double?
    let distance: Double?
    let holdCourse: Double?
    let holdDistance: Double?
    let turnDirection: String?
    let holdTurnDirection: String?
    let rfCenterWaypointId: String?
    let rfTurnDirection: String?
    let verticalAngleDeg: Double?
    let rnpServiceLevels: [Double]?
    let isFinalApproachFix: Bool
    let isInitialFix: Bool
    let isFinalFix: Bool
    let isMissedApproach: Bool
}
