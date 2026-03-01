/* tslint:disable */
/* eslint-disable */

/**
 * Stateful traffic merge state held in WASM memory.
 *
 * JS creates one instance and calls methods on it. The inner `TrafficState`
 * maintains the track map across calls.
 */
export class WasmTrafficState {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Build render-ready tracks projected to scene coordinates (SoA return).
     *
     * `airport_data`: flat Float64Array of `[lat, lon, elevation, ...]` triples.
     *
     * Returns a flat JS object with parallel typed arrays (SoA layout):
     * `{ trackCount, markerPositions: Float32Array, headingDeg: Float32Array,
     *    flags: Uint8Array, trailPointsFlat: Float32Array, trailOffsets: Uint32Array,
     *    trailCounts: Uint32Array, hexes: string[], callsignLabels: (string|null)[],
     *    hash: number }`
     *
     * `flags` bit layout: bit 0 = isCurrentlyPresent, bit 1 = isOnGround.
     */
    build_render_tracks(ref_lat: number, ref_lon: number, airport_data: Float64Array, vertical_scale: number, apply_earth_curvature: boolean, show_departed_trails: boolean): any;
    /**
     * Merge incoming traffic binary data + optional backfill history into the state.
     *
     * `data`: raw AVTR binary payload (current poll).
     * `backfill_data`: raw AVTR binary payload (backfill history), or empty slice if none.
     * `now_ms`: current timestamp in milliseconds.
     * `history_minutes`: how many minutes of history to keep.
     * `hide_ground`: whether to exclude ground aircraft.
     *
     * Returns a JS object with `{ trackCount, fetchedAtMs, source, error, trackedHexes, returnedHistoryHexes }`.
     */
    merge(data: Uint8Array, now_ms: number, history_minutes: number, hide_ground: boolean, backfill_data: Uint8Array): any;
    /**
     * Create a new empty traffic state.
     */
    constructor();
    /**
     * Prune tracks after a fetch error.
     */
    prune_for_error(now_ms: number, history_minutes: number): void;
    /**
     * Recompute tracks (trim history, hide ground, refresh timestamps).
     *
     * Returns `{ trackCount: number }`.
     */
    recompute(now_ms: number, history_minutes: number, hide_ground: boolean): any;
    /**
     * Number of active tracks.
     */
    readonly track_count: number;
}

/**
 * Decode an AVET binary echo-top payload and build prepared surfaces in one WASM call.
 *
 * Returns `{ top18, top30, top50, summary }` where each top is an SoA object
 * with Float32Array x/z/yBase columns and scalar footprint values.
 */
export function decode_and_prepare_echo_top(data: Uint8Array, apply_earth_curvature: boolean, ref_lat: number): any;

/**
 * Decode, filter, curvature-correct, declutter, and optionally build a
 * cross-section from a raw AVMR binary payload — all in one WASM call.
 *
 * Returns a JS object with three top-level keys:
 *   `prepared`  — NexradPreparedVolumeData (for SAB write)
 *   `crossSection` — CrossSectionData | null
 *   `volumePayload` — NexradVolumePayload fields (for transferable arrays)
 *
 * This eliminates all intermediate JS<->WASM boundary crossings for the
 * `poll-and-prepare` hot path.
 */
export function decode_and_prepare_mrms(data: Uint8Array, min_dbz_tenths: number, phase_mode: number, declutter_mode: number, apply_earth_curvature: boolean, ref_lat: number, include_cross_section: boolean, slice_axis_x: number, slice_axis_z: number, slice_perp_x: number, slice_perp_z: number, normalized_range: number, half_width_nm: number): any;

/**
 * Scale an altitude in feet to scene Y units.
 */
export function wasm_alt_to_y(alt_feet: number, vertical_scale: number): number;

/**
 * Approximate earth-curvature sag at a horizontal range, in nautical miles.
 */
export function wasm_earth_curvature_drop_nm(x_nm: number, z_nm: number, ref_lat: number): number;

/**
 * WGS84 geocentric radius at the given latitude, in nautical miles.
 */
export function wasm_geocentric_radius_nm(latitude_deg: number): number;

/**
 * Convert (lat, lon) to local scene coordinates relative to a reference point.
 *
 * Returns a Float64Array of `[x, z]` where x = east (NM), z = -north (NM).
 */
export function wasm_lat_lon_to_local(lat: number, lon: number, ref_lat: number, ref_lon: number): Float64Array;

/**
 * Projection scale factors at a given latitude, in NM per degree.
 *
 * Returns a Float64Array of `[east_nm_per_lon_deg, north_nm_per_lat_deg]`.
 */
export function wasm_projection_scales(lat_deg: number): Float64Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmtrafficstate_free: (a: number, b: number) => void;
    readonly decode_and_prepare_echo_top: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly decode_and_prepare_mrms: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => [number, number, number];
    readonly wasm_alt_to_y: (a: number, b: number) => number;
    readonly wasm_earth_curvature_drop_nm: (a: number, b: number, c: number) => number;
    readonly wasm_geocentric_radius_nm: (a: number) => number;
    readonly wasm_lat_lon_to_local: (a: number, b: number, c: number, d: number) => [number, number];
    readonly wasm_projection_scales: (a: number) => [number, number];
    readonly wasmtrafficstate_build_render_tracks: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly wasmtrafficstate_merge: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
    readonly wasmtrafficstate_new: () => number;
    readonly wasmtrafficstate_prune_for_error: (a: number, b: number, c: number) => void;
    readonly wasmtrafficstate_recompute: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly wasmtrafficstate_track_count: (a: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
