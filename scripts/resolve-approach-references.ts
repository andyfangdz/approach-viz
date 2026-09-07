import type Database from 'better-sqlite3';
import {
  findSelectedExternalApproach,
  resolveApproachOptions
} from '../app/actions-lib/approach-matching';
import { deriveMinimumsSummary } from '../app/actions-lib/approach-minimums';
import { deriveApproachPlate } from '../app/actions-lib/approach-db';
import { applyExternalVerticalAngleToApproach } from '../app/actions-lib/approach-vertical-profile';
import { extractMissedApproachClimbRequirement } from '../app/actions-lib/missed-approach-climb';
import type { ApproachMinimumsDb, ApproachRow } from '../app/actions-lib/types';
import type { ApproachReference } from '../lib/types';

export function resolveApproachReferences(db: Database.Database, source: ApproachMinimumsDb): void {
  db.exec(`CREATE TABLE approach_options (
    airport_id TEXT NOT NULL,
    procedure_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    option_json TEXT NOT NULL,
    reference_json TEXT NOT NULL,
    PRIMARY KEY (airport_id, procedure_id)
  )`);
  const insert = db.prepare('INSERT INTO approach_options VALUES (?, ?, ?, ?, ?)');
  const update = db.prepare(
    'UPDATE approaches SET data_json = ? WHERE airport_id = ? AND procedure_id = ?'
  );
  const selectApproaches = db.prepare(
    'SELECT * FROM approaches WHERE airport_id = ? ORDER BY type, runway, procedure_id'
  );
  // Include reference-only airports even when CIFP contains no procedures there.
  const airports = new Set([
    ...db
      .prepare('SELECT DISTINCT airport_id FROM approaches')
      .all()
      .map((row) => {
        // SAFETY: approaches has a required airport_id text column.
        return (row as { airport_id: string }).airport_id;
      }),
    ...Object.keys(source.airports)
  ]);
  db.transaction(() => {
    for (const id of airports) {
      // SAFETY: these column sets match the build-db ApproachRow schema.
      const rows = selectApproaches.all(id) as ApproachRow[];
      const options = resolveApproachOptions(
        rows,
        source.airports[id]?.approaches ?? [],
        source.dtpp_cycle_number
      );
      for (const [ordinal, { option, approach, minimumsApproach }] of options.entries()) {
        // Preserve the existing source-order tie-break for plates and profiles.
        // Minimums/selector ties historically used SQLite name order instead.
        const external = findSelectedExternalApproach(
          source.airports[id]?.approaches ?? [],
          option,
          approach
        );
        const resolved = applyExternalVerticalAngleToApproach(approach, external);
        const reference: ApproachReference = {
          minimumsSummary: deriveMinimumsSummary(minimumsApproach, source.dtpp_cycle_number),
          missedApproachClimbRequirement: extractMissedApproachClimbRequirement(external),
          approachPlate: deriveApproachPlate(id, option, external, source.dtpp_cycle_number)
        };
        if (resolved) update.run(JSON.stringify(resolved), id, option.procedureId);
        insert.run(
          id,
          option.procedureId,
          ordinal,
          JSON.stringify(option),
          JSON.stringify(reference)
        );
      }
    }
  })();
}
