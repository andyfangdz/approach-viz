import Foundation
import GRDB

enum SQLiteDatabaseError: Error, LocalizedError {
    case missingDatabase(String)
    case openFailed(String)
    case queryFailed(String)
    case invalidData(String)

    var errorDescription: String? {
        switch self {
        case let .missingDatabase(message),
             let .openFailed(message),
             let .queryFailed(message),
             let .invalidData(message):
            return message
        }
    }
}

final class SQLiteDatabase {
    private let dbQueue: DatabaseQueue

    init() throws {
        guard let databaseURL = Bundle.main.url(forResource: "approach-viz", withExtension: "sqlite") else {
            throw SQLiteDatabaseError.missingDatabase("Bundled approach-viz.sqlite not found. Run npm run prepare-data and rebuild the iOS app.")
        }

        var configuration = Configuration()
        configuration.readonly = true

        do {
            dbQueue = try DatabaseQueue(path: databaseURL.path, configuration: configuration)
        } catch {
            throw SQLiteDatabaseError.openFailed("Unable to open \(databaseURL.path): \(error.localizedDescription)")
        }
    }

    func query<T>(
        sql: String,
        bindings: [String] = [],
        rowMap: (Row) throws -> T
    ) throws -> [T] {
        do {
            return try dbQueue.read { db in
                let rows = try Row.fetchAll(db, sql: sql, arguments: StatementArguments(bindings))
                return try rows.map(rowMap)
            }
        } catch let error as SQLiteDatabaseError {
            throw error
        } catch {
            throw SQLiteDatabaseError.queryFailed(error.localizedDescription)
        }
    }

    func scalar(sql: String, bindings: [String] = []) throws -> String? {
        try query(sql: sql, bindings: bindings) { row in
            let value: String? = row[0]
            return value
        }.first ?? nil
    }
}
