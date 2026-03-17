import Foundation

struct SceneRepository {
    private let database: SQLiteDatabase
    private let decoder = JSONDecoder()

    init(database: SQLiteDatabase = try! SQLiteDatabase()) {
        self.database = database
    }

    func listAirports() throws -> [AirportOption] {
        let sql = """
            SELECT a.id, a.name
            FROM airports a
            WHERE EXISTS (
              SELECT 1
              FROM approaches ap
              WHERE ap.airport_id = a.id
            )
            ORDER BY a.id
            """
        return try database.query(sql: sql) { statement in
            let id = statement.string(at: 0)
            let name = statement.string(at: 1)
            return AirportOption(id: id, label: "\(id) - \(name)")
        }
    }

    func loadSceneData(airportID: String, requestedApproachID: String?) throws -> NativeSceneData? {
        guard let airport = try loadAirport(id: airportID) else {
            return nil
        }

        let approaches = try loadApproaches(airportID: airportID)
        let selectedApproachID = requestedApproachID.flatMap { requested in
            approaches.contains(where: { $0.procedureID == requested }) ? requested : nil
        } ?? approaches.first?.procedureID ?? ""

        let rawApproach = try loadApproachPayload(airportID: airportID, approachID: selectedApproachID)
        let minimaRows = try loadMinimaRows(airportID: airportID)
        let minimaApproaches = ApproachReferenceData.minimaApproaches(from: minimaRows)
        let externalApproaches = ApproachReferenceData.loadExternalApproaches(airportID: airportID)
        let selectedExternalApproach = ApproachReferenceData.findSelectedExternalApproach(
            airportApproaches: externalApproaches,
            currentApproach: rawApproach
        )
        let currentApproach = ApproachReferenceData.applyExternalVerticalAngle(
            to: rawApproach,
            externalApproach: selectedExternalApproach
        )
        let runways = try loadRunways(airportID: airportID)
        let waypoints = try loadWaypoints(for: currentApproach)
        let minimumsSummary = ApproachReferenceData.deriveMinimumsSummary(
            minimaApproaches: minimaApproaches,
            selectedExternalApproach: selectedExternalApproach,
            cycle: minimaRows.first?.cycle ?? ""
        )
        let missedApproachClimbRequirement = ApproachReferenceData.extractMissedApproachClimbRequirement(
            externalApproach: selectedExternalApproach
        )
        let cycleInfo = try loadCycleInfo()

        return NativeSceneData(
            airport: airport,
            approaches: approaches,
            selectedApproachID: selectedApproachID,
            currentApproach: currentApproach,
            runways: runways,
            waypoints: waypoints,
            minimumsSummary: minimumsSummary,
            missedApproachClimbRequirement: missedApproachClimbRequirement,
            cycleInfo: cycleInfo
        )
    }

    private func loadAirport(id: String) throws -> AirportRecord? {
        let sql = """
            SELECT id, name, lat, lon, elevation, mag_var
            FROM airports
            WHERE id = ?
            """
        return try database.query(sql: sql, bindings: [id.uppercased()]) { statement in
            AirportRecord(
                id: statement.string(at: 0),
                name: statement.string(at: 1),
                lat: statement.double(at: 2),
                lon: statement.double(at: 3),
                elevation: statement.double(at: 4),
                magneticVariation: statement.double(at: 5)
            )
        }.first
    }

    private func loadApproaches(airportID: String) throws -> [ApproachOption] {
        let sql = """
            SELECT procedure_id, type, runway
            FROM approaches
            WHERE airport_id = ?
            ORDER BY type, runway, procedure_id
            """
        return try database.query(sql: sql, bindings: [airportID]) { statement in
            ApproachOption(
                procedureID: statement.string(at: 0),
                type: statement.string(at: 1),
                runway: statement.string(at: 2)
            )
        }
    }

    private func loadApproachPayload(airportID: String, approachID: String) throws -> SerializedApproach? {
        guard !approachID.isEmpty else {
            return nil
        }
        let sql = """
            SELECT data_json
            FROM approaches
            WHERE airport_id = ? AND procedure_id = ?
            """
        guard let rawJSON = try database.scalar(sql: sql, bindings: [airportID, approachID]) else {
            return nil
        }
        guard let data = rawJSON.data(using: .utf8) else {
            throw SQLiteDatabaseError.invalidData("Approach payload for \(airportID) \(approachID) is not valid UTF-8.")
        }
        return try decoder.decode(SerializedApproach.self, from: data)
    }

    private func loadRunways(airportID: String) throws -> [RunwayRecord] {
        let sql = """
            SELECT airport_id, id, lat, lon
            FROM runways
            WHERE airport_id = ?
            ORDER BY id
            """
        return try database.query(sql: sql, bindings: [airportID]) { statement in
            RunwayRecord(
                airportID: statement.string(at: 0),
                id: statement.string(at: 1),
                lat: statement.double(at: 2),
                lon: statement.double(at: 3)
            )
        }
    }

    private func loadMinimaRows(airportID: String) throws -> [MinimaReferenceRow] {
        let sql = """
            SELECT approach_name, runway, types_json, minimums_json, cycle
            FROM minima
            WHERE airport_id = ?
            """
        return try database.query(sql: sql, bindings: [airportID]) { statement in
            MinimaReferenceRow(
                approachName: statement.string(at: 0),
                runway: statement.optionalString(at: 1),
                typesJSON: statement.string(at: 2),
                minimumsJSON: statement.string(at: 3),
                cycle: statement.string(at: 4)
            )
        }
    }

    private func loadWaypoints(for approach: SerializedApproach?) throws -> [WaypointRecord] {
        guard let approach else {
            return []
        }

        let waypointIDs = Array(Set(collectWaypointIDs(from: approach))).sorted()
        guard !waypointIDs.isEmpty else {
            return []
        }

        let placeholders = Array(repeating: "?", count: waypointIDs.count).joined(separator: ",")
        let sql = """
            SELECT id, name, lat, lon, type
            FROM waypoints
            WHERE id IN (\(placeholders))
            """
        return try database.query(sql: sql, bindings: waypointIDs) { statement in
            WaypointRecord(
                id: statement.string(at: 0),
                name: statement.string(at: 1),
                lat: statement.double(at: 2),
                lon: statement.double(at: 3),
                type: statement.string(at: 4)
            )
        }
    }

    private func loadCycleInfo() throws -> CycleInfo? {
        let cifpCycle = try database.scalar(sql: "SELECT value FROM metadata WHERE key = 'cifp_cycle'")
        let dtppCycle = try database.scalar(sql: "SELECT value FROM metadata WHERE key = 'dtpp_cycle_number'")
        guard cifpCycle != nil || dtppCycle != nil else {
            return nil
        }
        return CycleInfo(cifpCycle: cifpCycle ?? "", dtppCycle: dtppCycle ?? "")
    }

    private func collectWaypointIDs(from approach: SerializedApproach) -> [String] {
        var ids = Set<String>()

        func append(_ value: String?) {
            guard let value, !value.isEmpty else { return }
            ids.insert(value)
            if let fallback = value.split(separator: "_").last, fallback != Substring(value) {
                ids.insert(String(fallback))
            }
        }

        func collect(from legs: [ApproachLeg]) {
            for leg in legs {
                append(leg.waypointId)
                append(leg.rfCenterWaypointId)
            }
        }

        collect(from: approach.finalLegs)
        collect(from: approach.missedLegs)
        for transition in approach.transitions {
            collect(from: transition.legs)
        }
        return Array(ids)
    }
}
