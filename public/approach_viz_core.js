/* @ts-self-types="./approach_viz_core.d.ts" */

/**
 * Stateful traffic merge state held in WASM memory.
 *
 * JS creates one instance and calls methods on it. The inner `TrafficState`
 * maintains the track map across calls.
 */
export class WasmTrafficState {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmTrafficStateFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmtrafficstate_free(ptr, 0);
    }
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
     * @param {number} ref_lat
     * @param {number} ref_lon
     * @param {Float64Array} airport_data
     * @param {number} vertical_scale
     * @param {boolean} apply_earth_curvature
     * @param {boolean} show_departed_trails
     * @returns {any}
     */
    build_render_tracks(ref_lat, ref_lon, airport_data, vertical_scale, apply_earth_curvature, show_departed_trails) {
        const ptr0 = passArrayF64ToWasm0(airport_data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmtrafficstate_build_render_tracks(this.__wbg_ptr, ref_lat, ref_lon, ptr0, len0, vertical_scale, apply_earth_curvature, show_departed_trails);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
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
     * @param {Uint8Array} data
     * @param {number} now_ms
     * @param {number} history_minutes
     * @param {boolean} hide_ground
     * @param {Uint8Array} backfill_data
     * @returns {any}
     */
    merge(data, now_ms, history_minutes, hide_ground, backfill_data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(backfill_data, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.wasmtrafficstate_merge(this.__wbg_ptr, ptr0, len0, now_ms, history_minutes, hide_ground, ptr1, len1);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Create a new empty traffic state.
     */
    constructor() {
        const ret = wasm.wasmtrafficstate_new();
        this.__wbg_ptr = ret >>> 0;
        WasmTrafficStateFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Prune tracks after a fetch error.
     * @param {number} now_ms
     * @param {number} history_minutes
     */
    prune_for_error(now_ms, history_minutes) {
        wasm.wasmtrafficstate_prune_for_error(this.__wbg_ptr, now_ms, history_minutes);
    }
    /**
     * Recompute tracks (trim history, hide ground, refresh timestamps).
     *
     * Returns `{ trackCount: number }`.
     * @param {number} now_ms
     * @param {number} history_minutes
     * @param {boolean} hide_ground
     * @returns {any}
     */
    recompute(now_ms, history_minutes, hide_ground) {
        const ret = wasm.wasmtrafficstate_recompute(this.__wbg_ptr, now_ms, history_minutes, hide_ground);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Number of active tracks.
     * @returns {number}
     */
    get track_count() {
        const ret = wasm.wasmtrafficstate_track_count(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) WasmTrafficState.prototype[Symbol.dispose] = WasmTrafficState.prototype.free;

/**
 * Decode an AVET binary echo-top payload and build prepared surfaces in one WASM call.
 *
 * Returns `{ top18, top30, top50, summary }` where each top is an SoA object
 * with Float32Array x/z/yBase columns and scalar footprint values.
 * @param {Uint8Array} data
 * @param {boolean} apply_earth_curvature
 * @param {number} ref_lat
 * @returns {any}
 */
export function decode_and_prepare_echo_top(data, apply_earth_curvature, ref_lat) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.decode_and_prepare_echo_top(ptr0, len0, apply_earth_curvature, ref_lat);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

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
 * @param {Uint8Array} data
 * @param {number} min_dbz_tenths
 * @param {number} phase_mode
 * @param {number} declutter_mode
 * @param {boolean} apply_earth_curvature
 * @param {number} ref_lat
 * @param {boolean} include_cross_section
 * @param {number} slice_axis_x
 * @param {number} slice_axis_z
 * @param {number} slice_perp_x
 * @param {number} slice_perp_z
 * @param {number} normalized_range
 * @param {number} half_width_nm
 * @returns {any}
 */
export function decode_and_prepare_mrms(data, min_dbz_tenths, phase_mode, declutter_mode, apply_earth_curvature, ref_lat, include_cross_section, slice_axis_x, slice_axis_z, slice_perp_x, slice_perp_z, normalized_range, half_width_nm) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.decode_and_prepare_mrms(ptr0, len0, min_dbz_tenths, phase_mode, declutter_mode, apply_earth_curvature, ref_lat, include_cross_section, slice_axis_x, slice_axis_z, slice_perp_x, slice_perp_z, normalized_range, half_width_nm);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Scale an altitude in feet to scene Y units.
 * @param {number} alt_feet
 * @param {number} vertical_scale
 * @returns {number}
 */
export function wasm_alt_to_y(alt_feet, vertical_scale) {
    const ret = wasm.wasm_alt_to_y(alt_feet, vertical_scale);
    return ret;
}

/**
 * Approximate earth-curvature sag at a horizontal range, in nautical miles.
 * @param {number} x_nm
 * @param {number} z_nm
 * @param {number} ref_lat
 * @returns {number}
 */
export function wasm_earth_curvature_drop_nm(x_nm, z_nm, ref_lat) {
    const ret = wasm.wasm_earth_curvature_drop_nm(x_nm, z_nm, ref_lat);
    return ret;
}

/**
 * WGS84 geocentric radius at the given latitude, in nautical miles.
 * @param {number} latitude_deg
 * @returns {number}
 */
export function wasm_geocentric_radius_nm(latitude_deg) {
    const ret = wasm.wasm_geocentric_radius_nm(latitude_deg);
    return ret;
}

/**
 * Convert (lat, lon) to local scene coordinates relative to a reference point.
 *
 * Returns a Float64Array of `[x, z]` where x = east (NM), z = -north (NM).
 * @param {number} lat
 * @param {number} lon
 * @param {number} ref_lat
 * @param {number} ref_lon
 * @returns {Float64Array}
 */
export function wasm_lat_lon_to_local(lat, lon, ref_lat, ref_lon) {
    const ret = wasm.wasm_lat_lon_to_local(lat, lon, ref_lat, ref_lon);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

/**
 * Projection scale factors at a given latitude, in NM per degree.
 *
 * Returns a Float64Array of `[east_nm_per_lon_deg, north_nm_per_lat_deg]`.
 * @param {number} lat_deg
 * @returns {Float64Array}
 */
export function wasm_projection_scales(lat_deg) {
    const ret = wasm.wasm_projection_scales(lat_deg);
    var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
    return v1;
}

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_39bc967c0e5a9b58: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_new_cbee8c0d5c479eac: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_ed69e637b553a997: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_from_slice_98ba05e7059309c1: function(arg0, arg1) {
            const ret = new Uint32Array(getArrayU32FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_from_slice_c81beab68071e722: function(arg0, arg1) {
            const ret = new Int32Array(getArrayI32FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_from_slice_d188c5ad4ed77989: function(arg0, arg1) {
            const ret = new Int8Array(getArrayI8FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_from_slice_d7e202fdbee3c396: function(arg0, arg1) {
            const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_from_slice_e21686f285806d67: function(arg0, arg1) {
            const ret = new Float32Array(getArrayF32FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_from_slice_eb70a1c6dfa6f7a2: function(arg0, arg1) {
            const ret = new Uint16Array(getArrayU16FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_with_length_51597651c65b2f13: function(arg0) {
            const ret = new Array(arg0 >>> 0);
            return ret;
        },
        __wbg_push_a6f9488ffd3fae3b: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_set_4c81cfb5dc3a333c: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
        },
        __wbg_set_bad5c505cc70b5f8: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbindgen_cast_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./approach_viz_core_bg.js": import0,
    };
}

const WasmTrafficStateFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmtrafficstate_free(ptr >>> 0, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayI8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getArrayU16FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint16ArrayMemory0().subarray(ptr / 2, ptr / 2 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

let cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
    if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) {
        cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32ArrayMemory0;
}

let cachedInt8ArrayMemory0 = null;
function getInt8ArrayMemory0() {
    if (cachedInt8ArrayMemory0 === null || cachedInt8ArrayMemory0.byteLength === 0) {
        cachedInt8ArrayMemory0 = new Int8Array(wasm.memory.buffer);
    }
    return cachedInt8ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint16ArrayMemory0 = null;
function getUint16ArrayMemory0() {
    if (cachedUint16ArrayMemory0 === null || cachedUint16ArrayMemory0.byteLength === 0) {
        cachedUint16ArrayMemory0 = new Uint16Array(wasm.memory.buffer);
    }
    return cachedUint16ArrayMemory0;
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedInt32ArrayMemory0 = null;
    cachedInt8ArrayMemory0 = null;
    cachedUint16ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('approach_viz_core_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
