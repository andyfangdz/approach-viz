import type { ApproachOption, SerializedApproach } from '@/lib/types';
import type { Approach } from '@/lib/cifp/parser';
import type { ApproachRow, WaypointRow } from './types';

export function rowToApproachOption(row: ApproachRow): ApproachOption {
  if (row.source !== 'cifp' && row.source !== 'historical') {
    throw new Error(
      `Unsupported approach source for ${row.airport_id} ${row.procedure_id}: ${row.source}`
    );
  }
  return {
    procedureId: row.procedure_id,
    type: row.type,
    runway: row.runway,
    source: row.source,
    sourceCycle: row.source_cycle || undefined
  };
}

export function deserializeApproach(row: ApproachRow): SerializedApproach {
  // SAFETY: build-db writes approaches.data_json as the serializable Approach object (transitions as entries).
  const parsed = JSON.parse(row.data_json) as SerializedApproach;
  return {
    ...parsed,
    transitions: Array.isArray(parsed.transitions) ? parsed.transitions : []
  };
}

export function deserializeHistoricalWaypoints(row: ApproachRow): WaypointRow[] {
  if (row.source !== 'historical') return [];
  if (!row.historical_waypoints_json) {
    throw new Error(
      `Historical approach ${row.airport_id} ${row.procedure_id} has no preserved waypoints`
    );
  }

  // SAFETY: build-db writes this column only from the hash-validated historical fixture; the
  // array shape, required strings, finite coordinates, and waypoint type are rechecked below.
  const parsed = JSON.parse(row.historical_waypoints_json) as WaypointRow[];
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Historical approach ${row.airport_id} ${row.procedure_id} has invalid preserved waypoints`
    );
  }

  return parsed.map((value, index) => {
    if (
      !value ||
      !value.id ||
      !value.name ||
      !Number.isFinite(value.lat) ||
      !Number.isFinite(value.lon) ||
      (value.type !== 'terminal' && value.type !== 'enroute' && value.type !== 'runway')
    ) {
      throw new Error(
        `Historical approach ${row.airport_id} ${row.procedure_id} has invalid waypoint ${index}`
      );
    }
    return {
      id: value.id,
      name: value.name,
      lat: value.lat,
      lon: value.lon,
      type: value.type
    };
  });
}

export function serializedApproachToRuntime(approach: SerializedApproach): Approach {
  return {
    airportId: approach.airportId,
    procedureId: approach.procedureId,
    type: approach.type,
    runway: approach.runway,
    transitions: new Map(approach.transitions),
    finalLegs: approach.finalLegs,
    missedLegs: approach.missedLegs
  };
}

export function collectWaypointIds(approach: SerializedApproach): string[] {
  const ids = new Set<string>();
  const pushId = (value: string | undefined) => {
    if (!value) return;
    ids.add(value);
    const fallback = value.includes('_') ? value.split('_').pop() : value;
    if (fallback && fallback !== value) ids.add(fallback);
  };

  const addLegs = (legs: typeof approach.finalLegs) => {
    for (const leg of legs) {
      pushId(leg.waypointId);
      pushId(leg.rfCenterWaypointId);
    }
  };

  addLegs(approach.finalLegs);
  addLegs(approach.missedLegs);
  for (const [, legs] of approach.transitions) {
    addLegs(legs);
  }

  return Array.from(ids);
}
