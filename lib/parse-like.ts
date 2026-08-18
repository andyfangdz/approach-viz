export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export function isString(value: JsonValue): value is string {
  return typeof value === 'string';
}

export function isNonEmptyString(value: JsonValue): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isBoolean(value: JsonValue): value is boolean {
  return typeof value === 'boolean';
}

export function isFiniteNumber(value: JsonValue): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isJsonArray(value: JsonValue): value is JsonValue[] {
  return Array.isArray(value);
}

export function isPresentFiniteNumber(value: number | null | undefined): value is number {
  return value !== undefined && value !== null && Number.isFinite(value);
}

export function isMemberOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  for (const candidate of allowed) {
    if (candidate === value) return true;
  }
  return false;
}

export function parseJsonValue(text: string): JsonValue {
  // SAFETY: RFC 8259 — JSON.parse of a JSON document yields a JSON value.
  return JSON.parse(text) as JsonValue;
}

export function parseNumberLike(value: JsonValue): number | null {
  if (isFiniteNumber(value)) return value;
  if (isString(value)) {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function parseStringLike(value: JsonValue): string | null {
  if (isString(value)) {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (isFiniteNumber(value)) return String(value);
  return null;
}
