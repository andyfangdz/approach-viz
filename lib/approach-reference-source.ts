import { isJsonObject, isString, parseJsonValue, type JsonValue } from './parse-like';
import type { ApproachMinimumsDb } from '@/app/actions-lib/types';

/** Validate the fields consumed by reference resolution before building the database. */
export function parseApproachReferenceSource(raw: string): ApproachMinimumsDb {
  const value = parseJsonValue(raw);
  validateApproachReferenceSource(value);
  const source: ApproachMinimumsDb = value;
  for (const airport of Object.values(source.airports)) {
    for (const approach of airport.approaches) approach.name = approach.name.trim();
  }
  return source;
}

function validateApproachReferenceSource(
  value: JsonValue
): asserts value is JsonValue & ApproachMinimumsDb {
  if (
    !isJsonObject(value) ||
    !isString(value.dtpp_cycle_number) ||
    !value.dtpp_cycle_number.trim() ||
    !isJsonObject(value.airports)
  ) {
    throw new Error('Invalid approach reference database: expected cycle and airports.');
  }
  for (const [airportId, airport] of Object.entries(value.airports)) {
    if (!isJsonObject(airport) || !Array.isArray(airport.approaches)) {
      throw new Error(`Invalid approach reference airport: ${airportId}`);
    }
    const names = new Set<string>();
    for (const approach of airport.approaches) {
      if (
        !isJsonObject(approach) ||
        !isString(approach.name) ||
        !approach.name.trim() ||
        !Array.isArray(approach.types) ||
        !approach.types.every(isString) ||
        !(approach.runway === null || isString(approach.runway)) ||
        !Array.isArray(approach.minimums)
      ) {
        throw new Error(`Invalid approach reference in ${airportId}`);
      }
      // This identity was previously enforced by the minima table's primary key.
      const name = approach.name.trim();
      if (names.has(name)) {
        throw new Error(`Duplicate approach reference in ${airportId}: ${approach.name}`);
      }
      names.add(name);
      for (const key of ['plate_file', 'missed_instructions']) {
        if (approach[key] != null && !isString(approach[key]))
          throw new Error(`Invalid ${key} in ${airportId} ${approach.name}`);
      }
      const profile = approach.vertical_profile;
      if (
        profile != null &&
        (!isJsonObject(profile) ||
          ['vda', 'tch'].some((key) => profile[key] != null && !isString(profile[key])))
      ) {
        throw new Error(`Invalid vertical profile in ${airportId} ${approach.name}`);
      }
      for (const minimum of approach.minimums) {
        if (!isJsonObject(minimum) || !isString(minimum.minimums_type))
          throw new Error(`Invalid minimums in ${airportId} ${approach.name}`);
        for (const key of ['cat_a', 'cat_b', 'cat_c', 'cat_d']) {
          const category = minimum[key];
          if (category === null || category === 'NA') continue;
          if (
            !isJsonObject(category) ||
            !isString(category.altitude) ||
            !(category.rvr === null || isString(category.rvr)) ||
            !(category.visibility === null || isString(category.visibility))
          ) {
            throw new Error(`Invalid ${key} minimum in ${airportId} ${approach.name}`);
          }
        }
      }
    }
  }
}
