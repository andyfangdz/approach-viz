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
    // Weather layer defaults match the web `DEFAULT_LAYER_STATE`:
    // guides on; mrms/echotops/slice off.
    var mrms = false
    var echotops = false
    var slice = false
    var guides = true
}

enum NativeWeatherPhaseMode: String, CaseIterable, Hashable {
    case thermo
    case surface

    /// Wire value for the Rust prepare pass (0 = altitude/thermo, 1 = surface).
    var rustCode: UInt8 { self == .surface ? 1 : 0 }

    var label: String {
        switch self {
        case .thermo: return "Thermodynamic"
        case .surface: return "Surface Precip Type"
        }
    }
}

enum NativeWeatherDeclutterMode: String, CaseIterable, Hashable {
    case all
    case low
    case mid
    case high

    /// Wire value for the Rust prepare pass (0 = all, 1 = low, 2 = mid, 3 = high).
    var rustCode: UInt8 {
        switch self {
        case .all: return 0
        case .low: return 1
        case .mid: return 2
        case .high: return 3
        }
    }

    var label: String {
        switch self {
        case .all: return "All Layers"
        case .low: return "Low (SFC-10k)"
        case .mid: return "Mid (10k-25k)"
        case .high: return "High (25k+)"
        }
    }
}

/// MRMS display options mirroring the web client's persisted defaults
/// (`DEFAULT_NEXRAD_*` in `app/app-client/constants.ts`).
struct NativeWeatherDisplayOptions: Hashable {
    var minDbz = 5.0
    var opacity = 0.35
    var phaseMode = NativeWeatherPhaseMode.surface
    var declutterMode = NativeWeatherDeclutterMode.all
    var crossSectionHeadingDeg = 90.0
    var crossSectionRangeNm = 80.0
}

/// Cross-section slice grid from the shared Rust engine (web
/// `CrossSectionData`): row-major `binsX * binsY` max-dBZ grid (-1 = empty),
/// winning phase per cell, per-column top envelope, and the grid's altitude
/// ceiling in feet.
struct NativeCrossSection: Hashable {
    let binsX: Int
    let binsY: Int
    let gridDbz: [Float]
    let gridPhase: [UInt8]
    let topEnvelopeFeet: [Float]
    let maxTopFeet: Float
}

/// Echo-top threshold surfaces from the shared Rust engine. Reference type
/// with identity equality for the same reason as `NativeMrmsScene`.
final class NativeEchoTopScene: Equatable, Hashable, Sendable {
    struct Surface: Hashable {
        let xNm: [Float]
        let zNm: [Float]
        let yNm: [Float]
    }

    let sourceCellCount: Int
    let generatedAtMs: Int64
    let scanTimeMs: Int64
    let footprintXNm: Float
    let footprintYNm: Float
    let maxTop18Feet: Float
    let maxTop30Feet: Float
    let maxTop50Feet: Float
    let maxTop60Feet: Float
    let top18: Surface
    let top30: Surface
    let top50: Surface

    init(
        sourceCellCount: Int,
        generatedAtMs: Int64,
        scanTimeMs: Int64,
        footprintXNm: Float,
        footprintYNm: Float,
        maxTop18Feet: Float,
        maxTop30Feet: Float,
        maxTop50Feet: Float,
        maxTop60Feet: Float,
        top18: Surface,
        top30: Surface,
        top50: Surface
    ) {
        self.sourceCellCount = sourceCellCount
        self.generatedAtMs = generatedAtMs
        self.scanTimeMs = scanTimeMs
        self.footprintXNm = footprintXNm
        self.footprintYNm = footprintYNm
        self.maxTop18Feet = maxTop18Feet
        self.maxTop30Feet = maxTop30Feet
        self.maxTop50Feet = maxTop50Feet
        self.maxTop60Feet = maxTop60Feet
        self.top18 = top18
        self.top30 = top30
        self.top50 = top50
    }

    static func == (lhs: NativeEchoTopScene, rhs: NativeEchoTopScene) -> Bool {
        lhs === rhs
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(ObjectIdentifier(self))
    }
}

/// Render-ready MRMS voxel columns from the shared Rust engine. Positions and
/// sizes are local-frame nautical miles without vertical exaggeration; the
/// renderer applies the current vertical scale when building instances.
///
/// Reference type with identity equality on purpose: volumes can run to
/// hundreds of thousands of voxels, and every poll produces a brand-new
/// payload object, so identity comparison is both cheap and a correct
/// change signal for TCA state diffing and renderer rebuilds.
final class NativeMrmsScene: Equatable, Hashable, Sendable {
    let voxelCount: Int
    let sourceVoxelCount: Int
    let validVoxelCount: Int
    let generatedAtMs: Int64
    let scanTimeMs: Int64
    let centerXNm: [Float]
    let centerYNm: [Float]
    let centerZNm: [Float]
    let sizeXNm: [Float]
    let sizeYNm: [Float]
    let sizeZNm: [Float]
    let dbz: [Float]
    let phaseCode: [UInt8]
    let maxAbsXNm: Float
    let maxAbsZNm: Float
    let maxCorrectedTopFeet: Float
    let crossSection: NativeCrossSection?

    init(
        voxelCount: Int,
        sourceVoxelCount: Int,
        validVoxelCount: Int,
        generatedAtMs: Int64,
        scanTimeMs: Int64,
        centerXNm: [Float],
        centerYNm: [Float],
        centerZNm: [Float],
        sizeXNm: [Float],
        sizeYNm: [Float],
        sizeZNm: [Float],
        dbz: [Float],
        phaseCode: [UInt8],
        maxAbsXNm: Float = 0,
        maxAbsZNm: Float = 0,
        maxCorrectedTopFeet: Float = 0,
        crossSection: NativeCrossSection? = nil
    ) {
        self.voxelCount = voxelCount
        self.sourceVoxelCount = sourceVoxelCount
        self.validVoxelCount = validVoxelCount
        self.generatedAtMs = generatedAtMs
        self.scanTimeMs = scanTimeMs
        self.centerXNm = centerXNm
        self.centerYNm = centerYNm
        self.centerZNm = centerZNm
        self.sizeXNm = sizeXNm
        self.sizeYNm = sizeYNm
        self.sizeZNm = sizeZNm
        self.dbz = dbz
        self.phaseCode = phaseCode
        self.maxAbsXNm = maxAbsXNm
        self.maxAbsZNm = maxAbsZNm
        self.maxCorrectedTopFeet = maxCorrectedTopFeet
        self.crossSection = crossSection
    }

    static func == (lhs: NativeMrmsScene, rhs: NativeMrmsScene) -> Bool {
        lhs === rhs
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(ObjectIdentifier(self))
    }
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
    // Holding time in minutes when the CIFP publishes a time instead of a leg
    // distance ("T"-coded route distance field, e.g. 1.0-minute holds).
    let holdTime: Double?
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
