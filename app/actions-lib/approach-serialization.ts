import type { ApproachOption, SerializedApproach } from '@/lib/types';
import type { Approach } from '@/lib/cifp/parser';
import type { ApproachRow } from './types';

export function rowToApproachOption(row: ApproachRow): ApproachOption {
  return {
    procedureId: row.procedure_id,
    type: row.type,
    runway: row.runway,
    source: 'cifp'
  };
}

export function deserializeApproach(row: ApproachRow): SerializedApproach {
  const parsed = JSON.parse(row.data_json) as SerializedApproach;
  return {
    ...parsed,
    transitions: Array.isArray(parsed.transitions) ? parsed.transitions : []
  };
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
