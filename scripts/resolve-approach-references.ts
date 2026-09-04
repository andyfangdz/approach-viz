import type Database from 'better-sqlite3';
import {
  buildApproachOptions,
  findSelectedExternalApproach
} from '../app/actions-lib/approach-matching';
import { deserializeApproach } from '../app/actions-lib/approach-serialization';
import { deriveMinimumsSummary } from '../app/actions-lib/approach-minimums';
import { deriveApproachPlate } from '../app/actions-lib/approach-db';
import { applyExternalVerticalAngleToApproach } from '../app/actions-lib/approach-vertical-profile';
import { extractMissedApproachClimbRequirement } from '../app/actions-lib/missed-approach-climb';
import type { ApproachMinimumsDb, ApproachRow, MinimaRow } from '../app/actions-lib/types';
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
  const selectMinima = db.prepare(
    'SELECT * FROM minima WHERE airport_id = ? ORDER BY approach_name'
  );
  // SAFETY: both build-db tables have a required airport_id column.
  const airports = db
    .prepare(
      'SELECT airport_id AS id FROM approaches UNION SELECT airport_id AS id FROM minima ORDER BY id'
    )
    .all() as { id: string }[];
  db.transaction(() => {
    for (const { id } of airports) {
      // SAFETY: these column sets match the build-db ApproachRow and MinimaRow schemas.
      const rows = selectApproaches.all(id) as ApproachRow[];
      // SAFETY: minima is created and populated by build-db with the MinimaRow fields.
      const minima = selectMinima.all(id) as MinimaRow[];
      const options = buildApproachOptions(rows, minima);
      const byId = new Map(rows.map((row) => [row.procedure_id, row]));
      for (const [ordinal, option] of options.entries()) {
        const row = byId.get(option.procedureId);
        const approach = row ? deserializeApproach(row) : null;
        const external = findSelectedExternalApproach(
          source.airports[id]?.approaches ?? [],
          option,
          approach
        );
        const resolved = applyExternalVerticalAngleToApproach(approach, external);
        const reference: ApproachReference = {
          minimumsSummary: deriveMinimumsSummary(minima, option, resolved),
          missedApproachClimbRequirement: extractMissedApproachClimbRequirement(external),
          approachPlate: deriveApproachPlate(id, option, resolved, source)
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
