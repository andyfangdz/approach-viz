/* tslint:disable */
/* eslint-disable */

/**
 * A normalized weather query. Construction fails with the 400 message.
 */
export class Query {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    static echoTops(lat: number, lon: number, max_range_nm?: number | null): Query;
    static volume(lat: number, lon: number, min_dbz?: number | null, max_range_nm?: number | null): Query;
}

/**
 * A parsed scan pack header.
 */
export class ScanPack {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * AVET v3 payload from the bytes of `echoTopRanges`.
     */
    buildEchoTops(query: Query, data: Uint8Array): Uint8Array;
    /**
     * AVMR v5 payload from the concatenated bytes of `volumeRanges`.
     */
    buildVolume(query: Query, data: Uint8Array): Uint8Array;
    /**
     * `[name0, value0, name1, value1, ...]`
     */
    echoTopHeaders(): string[];
    /**
     * Pack ranges an echo-top query reads, as `[offset0, length0, ...]`.
     */
    echoTopRanges(query: Query): Float64Array;
    constructor(header: Uint8Array);
    /**
     * `[name0, value0, name1, value1, ...]`
     */
    volumeHeaders(): string[];
    /**
     * Pack ranges a volume query reads, as `[offset0, length0, ...]`.
     */
    volumeRanges(query: Query): Float64Array;
    readonly timestamp: string;
    readonly totalLength: number;
}

/**
 * A parsed `/v1/traffic/adsbx` query. Construction fails with the 400 message.
 */
export class TrafficQuery {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * The tar1090 `/re-api/?binCraft&zstd&box=` value covering this query.
     */
    boxParam(): string;
    /**
     * AVTR v4 payload answering this query from one zstd-decompressed
     * binCraft snapshot polled at `polled_at_ms` (current aircraft only).
     */
    buildDirectPayload(decoded_bincraft: Uint8Array, polled_at_ms: number, source: string): Uint8Array;
    constructor(lat?: string | null, lon?: string | null, radius_nm?: string | null, limit?: string | null, history_minutes?: string | null, hide_ground?: string | null, history_hexes?: string | null);
}

/**
 * Header length of a scan pack, from its first 12 bytes.
 */
export function readHeaderLength(prefix: Uint8Array): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_query_free: (a: number, b: number) => void;
    readonly __wbg_scanpack_free: (a: number, b: number) => void;
    readonly __wbg_trafficquery_free: (a: number, b: number) => void;
    readonly query_echoTops: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly query_volume: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly readHeaderLength: (a: number, b: number) => [number, number, number];
    readonly scanpack_buildEchoTops: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly scanpack_buildVolume: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly scanpack_echoTopHeaders: (a: number) => [number, number];
    readonly scanpack_echoTopRanges: (a: number, b: number) => [number, number];
    readonly scanpack_new: (a: number, b: number) => [number, number, number];
    readonly scanpack_timestamp: (a: number) => [number, number];
    readonly scanpack_totalLength: (a: number) => number;
    readonly scanpack_volumeHeaders: (a: number) => [number, number];
    readonly scanpack_volumeRanges: (a: number, b: number) => [number, number];
    readonly trafficquery_boxParam: (a: number) => [number, number];
    readonly trafficquery_buildDirectPayload: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly trafficquery_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number, n: number) => [number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
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
