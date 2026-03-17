import Foundation
import SQLite3

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

enum SQLiteDatabaseError: Error, LocalizedError {
    case missingDatabase(String)
    case openFailed(String)
    case prepareFailed(String)
    case queryFailed(String)
    case invalidData(String)

    var errorDescription: String? {
        switch self {
        case let .missingDatabase(message),
             let .openFailed(message),
             let .prepareFailed(message),
             let .queryFailed(message),
             let .invalidData(message):
            return message
        }
    }
}

final class SQLiteDatabase {
    private var handle: OpaquePointer?

    init() throws {
        guard let databaseURL = Bundle.main.url(forResource: "approach-viz", withExtension: "sqlite") else {
            throw SQLiteDatabaseError.missingDatabase("Bundled approach-viz.sqlite not found. Run npm run prepare-data and rebuild the iOS app.")
        }

        if sqlite3_open_v2(databaseURL.path, &handle, SQLITE_OPEN_READONLY, nil) != SQLITE_OK {
            defer { sqlite3_close(handle) }
            throw SQLiteDatabaseError.openFailed(lastErrorMessage(defaultMessage: "Unable to open \(databaseURL.path)"))
        }
    }

    deinit {
        sqlite3_close(handle)
    }

    func query<T>(
        sql: String,
        bindings: [String] = [],
        rowMap: (OpaquePointer) throws -> T
    ) throws -> [T] {
        guard let handle else {
            throw SQLiteDatabaseError.openFailed("SQLite handle is not available.")
        }

        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw SQLiteDatabaseError.prepareFailed(lastErrorMessage(defaultMessage: "Failed to prepare query."))
        }
        defer { sqlite3_finalize(statement) }

        for (index, value) in bindings.enumerated() {
            let position = Int32(index + 1)
            guard sqlite3_bind_text(statement, position, value, -1, SQLITE_TRANSIENT) == SQLITE_OK else {
                throw SQLiteDatabaseError.queryFailed(lastErrorMessage(defaultMessage: "Failed to bind query value at position \(position)."))
            }
        }

        var rows: [T] = []
        while true {
            let result = sqlite3_step(statement)
            if result == SQLITE_ROW {
                rows.append(try rowMap(statement))
                continue
            }
            if result == SQLITE_DONE {
                break
            }
            throw SQLiteDatabaseError.queryFailed(lastErrorMessage(defaultMessage: "Query execution failed."))
        }

        return rows
    }

    func scalar(sql: String, bindings: [String] = []) throws -> String? {
        try query(sql: sql, bindings: bindings) { statement in
            statement.string(at: 0)
        }.first ?? nil
    }

    private func lastErrorMessage(defaultMessage: String) -> String {
        guard let handle, let cString = sqlite3_errmsg(handle) else {
            return defaultMessage
        }
        return String(cString: cString)
    }
}

extension OpaquePointer {
    func string(at column: Int32) -> String {
        guard let raw = sqlite3_column_text(self, column) else {
            return ""
        }
        return String(cString: raw)
    }

    func optionalString(at column: Int32) -> String? {
        guard sqlite3_column_type(self, column) != SQLITE_NULL,
              let raw = sqlite3_column_text(self, column) else {
            return nil
        }
        return String(cString: raw)
    }

    func double(at column: Int32) -> Double {
        sqlite3_column_double(self, column)
    }
}
