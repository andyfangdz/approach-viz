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

struct AirspaceFeatureRecord: Hashable {
    let type: String
    let airspaceClass: String
    let name: String
    let lowerAlt: Double
    let upperAlt: Double
    let coordinates: [[AirspaceCoordinate]]
}

struct AirspaceCoordinate: Hashable, Codable {
    let lon: Double
    let lat: Double

    init(lon: Double, lat: Double) {
        self.lon = lon
        self.lat = lat
    }

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        self.lon = try container.decode(Double.self)
        self.lat = try container.decode(Double.self)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.unkeyedContainer()
        try container.encode(lon)
        try container.encode(lat)
    }
}

struct CycleInfo: Hashable {
    let cifpCycle: String
    let dtppCycle: String
}

struct ElevationAirportRecord: Hashable {
    let lat: Double
    let lon: Double
    let elevation: Double
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
    let elevationAirports: [ElevationAirportRecord]
    let airspace: [AirspaceFeatureRecord]
    let minimumsSummary: MinimumsSummary?
    let missedApproachClimbRequirement: MissedApproachClimbRequirement?
    let cycleInfo: CycleInfo?
}

struct TrafficScenePoint: Hashable {
    let x: Double
    let y: Double
    let z: Double
}

struct TrafficTrackRecord: Identifiable, Hashable {
    let hex: String
    let isCurrentlyPresent: Bool
    let callsignLabel: String?
    let isOnGround: Bool
    let headingDegrees: Double
    let markerPosition: TrafficScenePoint
    let trailPoints: [TrafficScenePoint]

    var id: String { hex }
}

struct NativeTrafficScene: Hashable {
    let trackCount: Int
    let renderedTrackCount: Int
    let historyPointCount: Int
    let renderHash: UInt64
    let tracks: [TrafficTrackRecord]

    static let empty = NativeTrafficScene(
        trackCount: 0,
        renderedTrackCount: 0,
        historyPointCount: 0,
        renderHash: 0,
        tracks: []
    )
}

struct NativeLayerState: Hashable {
    var approach = true
    var airspace = true
    var adsb = true
}

struct NativeTrafficDisplayOptions: Hashable {
    var hideGroundTargets = false
    var showCallsignLabels = false
    var hideGroundCallsignLabels = true
    var showDepartedTrafficTrails = true
    var historyMinutes = 3.0
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
