import Foundation

private struct ApproachReferenceDb: Decodable {
    struct AirportEntry: Decodable {
        let approaches: [ExternalApproach]
    }

    let dtpp_cycle_number: String
    let airports: [String: AirportEntry]
}

struct ExternalVerticalProfile: Decodable {
    let vda: String?
    let tch: String?
}

struct MinimumsValue: Decodable {
    let altitude: String
    let rvr: String?
    let visibility: String?
}

struct ApproachMinimums: Decodable {
    let minimums_type: String
    let cat_a: MinimumsValue?
    let cat_b: MinimumsValue?
    let cat_c: MinimumsValue?
    let cat_d: MinimumsValue?

    private enum CodingKeys: String, CodingKey {
        case minimums_type
        case cat_a
        case cat_b
        case cat_c
        case cat_d
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        minimums_type = try container.decode(String.self, forKey: .minimums_type)
        cat_a = try ApproachMinimums.decodeValue(container, key: .cat_a)
        cat_b = try ApproachMinimums.decodeValue(container, key: .cat_b)
        cat_c = try ApproachMinimums.decodeValue(container, key: .cat_c)
        cat_d = try ApproachMinimums.decodeValue(container, key: .cat_d)
    }

    private static func decodeValue(
        _ container: KeyedDecodingContainer<CodingKeys>,
        key: CodingKeys
    ) throws -> MinimumsValue? {
        if try container.decodeNil(forKey: key) {
            return nil
        }
        if let value = try? container.decode(MinimumsValue.self, forKey: key) {
            return value
        }
        _ = try? container.decode(String.self, forKey: key)
        return nil
    }
}

struct ExternalApproach: Decodable {
    let name: String
    let plate_file: String?
    let types: [String]
    let runway: String?
    let missed_instructions: String?
    let minimums: [ApproachMinimums]
    let vertical_profile: ExternalVerticalProfile?
}

struct MinimaReferenceRow {
    let approachName: String
    let runway: String?
    let typesJSON: String
    let minimumsJSON: String
    let cycle: String
}

enum ApproachReferenceData {
    private static let climbRequirementPattern =
        #"minimum\s+climb\s+of\s+(\d+(?:\.\d+)?)\s*(?:feet\s+per\s*nm|ft\s*\/\s*nm|ft\s+per\s*nm)\s*(?:to\s+(\d[\d,\s]{2,7}))?"#

    static func loadExternalApproaches(airportID: String) -> [ExternalApproach] {
        ApproachReferenceStore.shared.approaches(for: airportID)
    }

    static func minimaApproaches(from rows: [MinimaReferenceRow]) -> [ExternalApproach] {
        rows.compactMap { row in
            guard let typesData = row.typesJSON.data(using: .utf8),
                  let minimumsData = row.minimumsJSON.data(using: .utf8),
                  let types = try? JSONDecoder().decode([String].self, from: typesData),
                  let minimums = try? JSONDecoder().decode([ApproachMinimums].self, from: minimumsData) else {
                return nil
            }
            return ExternalApproach(
                name: row.approachName,
                plate_file: nil,
                types: types,
                runway: row.runway,
                missed_instructions: nil,
                minimums: minimums,
                vertical_profile: nil
            )
        }
    }

    static func findSelectedExternalApproach(
        airportApproaches: [ExternalApproach],
        currentApproach: SerializedApproach?
    ) -> ExternalApproach? {
        guard !airportApproaches.isEmpty, let currentApproach else {
            return nil
        }
        return resolveExternalApproach(airportApproaches: airportApproaches, approach: currentApproach)
    }

    static func applyExternalVerticalAngle(
        to currentApproach: SerializedApproach?,
        externalApproach: ExternalApproach?
    ) -> SerializedApproach? {
        guard let currentApproach else { return nil }
        guard let raw = externalApproach?.vertical_profile?.vda,
              let verticalAngleDeg = parsePositiveDouble(raw),
              verticalAngleDeg <= 9,
              let fafIndex = currentApproach.finalLegs.firstIndex(where: { $0.isFinalApproachFix }) else {
            return currentApproach
        }

        let fafLeg = currentApproach.finalLegs[fafIndex]
        if let existing = fafLeg.verticalAngleDeg, abs(existing - verticalAngleDeg) < 1e-6 {
            return currentApproach
        }

        var finalLegs = currentApproach.finalLegs
        finalLegs[fafIndex] = ApproachLeg(
            sequence: fafLeg.sequence,
            waypointId: fafLeg.waypointId,
            waypointName: fafLeg.waypointName,
            pathTerminator: fafLeg.pathTerminator,
            altitude: fafLeg.altitude,
            altitudeConstraint: fafLeg.altitudeConstraint,
            course: fafLeg.course,
            distance: fafLeg.distance,
            holdCourse: fafLeg.holdCourse,
            holdDistance: fafLeg.holdDistance,
            turnDirection: fafLeg.turnDirection,
            holdTurnDirection: fafLeg.holdTurnDirection,
            rfCenterWaypointId: fafLeg.rfCenterWaypointId,
            rfTurnDirection: fafLeg.rfTurnDirection,
            verticalAngleDeg: verticalAngleDeg,
            rnpServiceLevels: fafLeg.rnpServiceLevels,
            isFinalApproachFix: fafLeg.isFinalApproachFix,
            isInitialFix: fafLeg.isInitialFix,
            isFinalFix: fafLeg.isFinalFix,
            isMissedApproach: fafLeg.isMissedApproach
        )
        return SerializedApproach(
            airportId: currentApproach.airportId,
            procedureId: currentApproach.procedureId,
            type: currentApproach.type,
            runway: currentApproach.runway,
            transitions: currentApproach.transitions,
            finalLegs: finalLegs,
            missedLegs: currentApproach.missedLegs
        )
    }

    static func deriveMinimumsSummary(
        minimaApproaches: [ExternalApproach],
        selectedExternalApproach: ExternalApproach?,
        cycle: String
    ) -> MinimumsSummary? {
        guard let selectedExternalApproach else { return nil }

        func parseAltitude(_ value: MinimumsValue?) -> Double? {
            guard let value else { return nil }
            let digits = value.altitude.firstMatch(of: /\d+/)
            guard let digits, let parsed = Double(digits.0) else { return nil }
            return parsed
        }

        func categoryCandidate(
            for minimums: ApproachMinimums
        ) -> MinimumsValueSummary? {
            let ordered: [(String, MinimumsValue?)] = [
                ("A", minimums.cat_a),
                ("B", minimums.cat_b),
                ("C", minimums.cat_c),
                ("D", minimums.cat_d)
            ]
            for (category, value) in ordered {
                if let altitude = parseAltitude(value) {
                    return MinimumsValueSummary(altitude: altitude, type: minimums.minimums_type, category: category)
                }
            }
            return nil
        }

        func selectLower(_ current: MinimumsValueSummary?, _ candidate: MinimumsValueSummary?) -> MinimumsValueSummary? {
            guard let candidate else { return current }
            guard let current else { return candidate }
            return candidate.altitude < current.altitude ? candidate : current
        }

        func isDecisionAltitudeType(_ type: String) -> Bool {
            type.range(of: "(LPV|VNAV|RNP|ILS|GLS|LP\\+V|GBAS|PAR)", options: [.regularExpression, .caseInsensitive]) != nil
        }

        let source = minimaApproaches.first(where: { $0.name == selectedExternalApproach.name }) ?? selectedExternalApproach
        var bestDaCatA: MinimumsValueSummary?
        var bestDaFallback: MinimumsValueSummary?
        var bestMdaCatA: MinimumsValueSummary?
        var bestMdaFallback: MinimumsValueSummary?

        for minimums in source.minimums {
            let catA = parseAltitude(minimums.cat_a).map {
                MinimumsValueSummary(altitude: $0, type: minimums.minimums_type, category: "A")
            }
            let fallback = catA == nil ? categoryCandidate(for: minimums) : nil

            if isDecisionAltitudeType(minimums.minimums_type) {
                if catA != nil {
                    bestDaCatA = selectLower(bestDaCatA, catA)
                } else {
                    bestDaFallback = selectLower(bestDaFallback, fallback)
                }
            } else if catA != nil {
                bestMdaCatA = selectLower(bestMdaCatA, catA)
            } else {
                bestMdaFallback = selectLower(bestMdaFallback, fallback)
            }
        }

        return MinimumsSummary(
            sourceApproachName: source.name,
            cycle: cycle,
            da: bestDaCatA ?? bestDaFallback,
            mda: bestMdaCatA ?? bestMdaFallback
        )
    }

    static func extractMissedApproachClimbRequirement(
        externalApproach: ExternalApproach?
    ) -> MissedApproachClimbRequirement? {
        guard let instructions = externalApproach?.missed_instructions,
              let regex = try? NSRegularExpression(pattern: climbRequirementPattern, options: [.caseInsensitive]) else {
            return nil
        }

        let range = NSRange(location: 0, length: instructions.utf16.count)
        var selected: MissedApproachClimbRequirement?
        regex.enumerateMatches(in: instructions, options: [], range: range) { match, _, _ in
            guard let match,
                  let gradientRange = Range(match.range(at: 1), in: instructions),
                  let feetPerNm = Double(instructions[gradientRange]),
                  feetPerNm > 0 else {
                return
            }

            var targetAltitudeFeet: Double?
            if let targetRange = Range(match.range(at: 2), in: instructions) {
                targetAltitudeFeet = parseAltitudeDigits(String(instructions[targetRange]))
            }

            let candidate = MissedApproachClimbRequirement(
                feetPerNm: feetPerNm,
                targetAltitudeFeet: targetAltitudeFeet
            )
            if shouldReplace(current: selected, candidate: candidate) {
                selected = candidate
            }
        }

        return selected
    }

    private static func shouldReplace(
        current: MissedApproachClimbRequirement?,
        candidate: MissedApproachClimbRequirement
    ) -> Bool {
        guard let current else { return true }
        if candidate.feetPerNm > current.feetPerNm + 1e-6 { return true }
        if abs(candidate.feetPerNm - current.feetPerNm) > 1e-6 { return false }
        return (candidate.targetAltitudeFeet ?? 0) > (current.targetAltitudeFeet ?? 0)
    }

    private static func resolveExternalApproach(
        airportApproaches: [ExternalApproach],
        approach: SerializedApproach
    ) -> ExternalApproach? {
        let procedure = parseProcedureRunway(approach.runway)

        if procedure.runwayKey == nil {
            let circlingSuffix = parseApproachCirclingSuffix("\(approach.procedureId) \(approach.runway)")
            let candidates = airportApproaches.filter { normalizeRunwayKey($0.runway ?? $0.name) == nil }
            return candidates
                .map { candidate in
                    let candidateSuffix = parseApproachCirclingSuffix(candidate.name)
                    let suffixScore: Double
                    if !circlingSuffix.isEmpty {
                        suffixScore = candidateSuffix == circlingSuffix ? 5 : 0
                    } else {
                        suffixScore = candidateSuffix.isEmpty ? 1 : 0
                    }
                    let score = suffixScore + typeMatchScore(currentApproachType: approach.type, externalApproach: candidate) + catPenalty(candidate.name) + saPenalty(candidate.name)
                    return (candidate, score)
                }
                .sorted(by: { $0.1 > $1.1 })
                .first(where: { $0.1 > 0 })?
                .0
        }

        return airportApproaches
            .filter { normalizeRunwayKey($0.runway ?? $0.name) == procedure.runwayKey }
            .map { candidate in
                let candidateVariant = parseApproachNameVariant(candidate.name)
                let variantScore: Double
                if !procedure.variant.isEmpty {
                    variantScore = candidateVariant == procedure.variant ? 4 : 0
                } else {
                    variantScore = candidateVariant.isEmpty ? 1 : 0
                }
                let score = variantScore + typeMatchScore(currentApproachType: approach.type, externalApproach: candidate) + catPenalty(candidate.name) + saPenalty(candidate.name)
                return (candidate, score)
            }
            .sorted(by: { $0.1 > $1.1 })
            .first?
            .0
    }

    private static func typeMatchScore(currentApproachType: String, externalApproach: ExternalApproach) -> Double {
        let current = currentApproachType.uppercased()
        let external = "\(externalApproach.name) \(externalApproach.types.joined(separator: " "))".uppercased()
        func has(_ tokens: String...) -> Bool {
            tokens.contains(where: { external.contains($0) })
        }

        if current.contains("RNAV/RNP") || current.contains("RNP") {
            if has("RNAV/RNP", "RNP") { return 5 }
            if has("RNAV", "GPS") { return 3 }
            return 0
        }
        if current == "RNAV" || current == "GPS" { return has("RNAV", "GPS") ? 4 : 0 }
        if current == "ILS" { return has("ILS") ? 4 : 0 }
        if current == "LOC/BC" {
            if has("LOC/BC", "LOCALIZER BACK COURSE", "BACK COURSE") { return 5 }
            if has("LOC", "LOCALIZER") { return 2 }
            return 0
        }
        if current == "LOC" { return has("LOC", "LOCALIZER") ? 4 : 0 }
        if current == "LDA/DME" {
            if has("LDA") && has("DME") { return 5 }
            if has("LDA") { return 4 }
            return 0
        }
        if current == "LDA" { return has("LDA") ? 4 : 0 }
        if current == "VOR/DME" {
            if has("VOR/DME", "VORDME", "TACAN") { return 5 }
            if has("VOR") { return 3 }
            return 0
        }
        if current == "VOR" { return has("VOR") ? 4 : 0 }
        if current == "NDB/DME" {
            if has("NDB") && has("DME") { return 5 }
            if has("NDB") { return 3 }
            return 0
        }
        if current == "NDB" { return has("NDB") ? 4 : 0 }
        if current == "SDF" { return has("SDF") ? 4 : 0 }
        return external.contains(current) ? 2 : 0
    }

    private static func parseProcedureRunway(_ runway: String) -> (runwayKey: String?, variant: String) {
        let cleaned = runway.uppercased().replacingOccurrences(of: "\\s+", with: "", options: .regularExpression)
        if let match = cleaned.firstMatch(of: /^(\d{1,2}[LRC]?)(?:-?([A-Z]))?$/) {
            return (normalizeRunwayKey(String(match.output.1)), match.output.2.map(String.init) ?? "")
        }
        return (normalizeRunwayKey(cleaned), "")
    }

    private static func normalizeRunwayKey(_ raw: String?) -> String? {
        guard let raw else { return nil }
        guard let match = raw.uppercased().firstMatch(of: /(\d{1,2})([LRC]?)/) else {
            return nil
        }
        guard let number = Int(String(match.output.1)) else { return nil }
        return String(format: "%02d%@", number, String(match.output.2))
    }

    private static func parseApproachNameVariant(_ name: String) -> String {
        guard let match = name.uppercased().firstMatch(of: /\b([XYZ])\s+RWY\b/) else {
            return ""
        }
        return String(match.output.1)
    }

    private static func parseApproachCirclingSuffix(_ raw: String) -> String {
        let upper = raw.uppercased().trimmingCharacters(in: .whitespacesAndNewlines)
        if let dashed = upper.firstMatch(of: /-([A-Z])\s*$/) {
            return String(dashed.output.1)
        }
        if upper.rangeOfCharacter(from: .decimalDigits) == nil,
           let standalone = upper.firstMatch(of: /\b([A-Z])\s*$/) {
            return String(standalone.output.1)
        }
        return ""
    }

    private static func catPenalty(_ name: String) -> Double {
        let upper = name.uppercased()
        guard upper.contains("CAT") else { return 0 }
        return upper.range(of: #"\bCAT\s+I(?!I)\b"#, options: .regularExpression) == nil ? -0.5 : 0
    }

    private static func saPenalty(_ name: String) -> Double {
        name.uppercased().contains("(SA") ? -0.5 : 0
    }

    private static func parsePositiveDouble(_ raw: String) -> Double? {
        guard let value = Double(raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              value.isFinite,
              value > 0 else {
            return nil
        }
        return value
    }

    private static func parseAltitudeDigits(_ raw: String) -> Double? {
        let digits = raw.replacingOccurrences(of: "[^0-9]", with: "", options: .regularExpression)
        guard let value = Double(digits), value > 0 else { return nil }
        return value
    }
}

private struct ApproachReferenceStore {
    static let shared = ApproachReferenceStore()

    private let db: ApproachReferenceDb?

    private init() {
        guard let url = Bundle.main.url(forResource: "approaches", withExtension: "json"),
              let data = try? Data(contentsOf: url) else {
            db = nil
            return
        }
        db = try? JSONDecoder().decode(ApproachReferenceDb.self, from: data)
    }

    func approaches(for airportID: String) -> [ExternalApproach] {
        db?.airports[airportID]?.approaches ?? []
    }
}
