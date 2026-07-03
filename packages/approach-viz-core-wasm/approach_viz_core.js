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
 * @param {any} params
 * @returns {any}
 */
export function approach_path_build_geometry(params) {
    const ret = wasm.approach_path_build_geometry(params);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {number} center_x
 * @param {number} center_z
 * @param {number} heading_deg
 * @param {number} hold_distance_nm
 * @param {number} altitude_feet
 * @param {string} turn_direction
 * @param {number} vertical_scale
 * @returns {any}
 */
export function approach_path_build_hold_points(center_x, center_z, heading_deg, hold_distance_nm, altitude_feet, turn_direction, vertical_scale) {
    const ptr0 = passStringToWasm0(turn_direction, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.approach_path_build_hold_points(center_x, center_z, heading_deg, hold_distance_nm, altitude_feet, ptr0, len0, vertical_scale);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {number} center_x
 * @param {number} center_z
 * @param {number} heading_deg
 * @param {number} leg_length_nm
 * @param {number} altitude_feet
 * @param {string} turn_direction
 * @param {number} vertical_scale
 * @returns {any}
 */
export function approach_path_build_hold_protected_area(center_x, center_z, heading_deg, leg_length_nm, altitude_feet, turn_direction, vertical_scale) {
    const ptr0 = passStringToWasm0(turn_direction, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.approach_path_build_hold_protected_area(center_x, center_z, heading_deg, leg_length_nm, altitude_feet, ptr0, len0, vertical_scale);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {any} params
 * @returns {any}
 */
export function approach_path_resolve_altitudes(params) {
    const ret = wasm.approach_path_resolve_altitudes(params);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {number | null | undefined} hold_distance_nm
 * @param {number | null | undefined} hold_time_minutes
 * @param {number} altitude_feet
 * @returns {number}
 */
export function approach_path_resolve_hold_leg_length_nm(hold_distance_nm, hold_time_minutes, altitude_feet) {
    const ret = wasm.approach_path_resolve_hold_leg_length_nm(!isLikeNone(hold_distance_nm), isLikeNone(hold_distance_nm) ? 0 : hold_distance_nm, !isLikeNone(hold_time_minutes), isLikeNone(hold_time_minutes) ? 0 : hold_time_minutes, altitude_feet);
    return ret;
}

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
 * Decode, filter, curvature-correct, declutter, and join into render-ready
 * voxel columns from a raw AVMR binary payload — all in one WASM call,
 * optionally building a cross-section grid.
 *
 * Returns a JS object with three top-level keys:
 *   `renderVolume` — flat per-rendered-voxel columns + altitude-guide
 *       extents from `build_render_volume` (the `prepare_volume` dual index
 *       space is resolved here in Rust; JS never pairs
 *       `declutterIndices`/`validIndices` with payload columns)
 *   `crossSection` — CrossSectionData | null
 *   `volumePayload` — volume metadata + full-payload phase codes (debug tally)
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
        __wbg_Error_4577686b3a6d9b3a: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_Number_e89e48a2fe1a6355: function(arg0) {
            const ret = Number(arg0);
            return ret;
        },
        __wbg_String_8564e559799eccda: function(arg0, arg1) {
            const ret = String(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_boolean_get_18c4ed9422296fff: function(arg0) {
            const v = arg0;
            const ret = typeof(v) === 'boolean' ? v : undefined;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg___wbindgen_debug_string_ddde1867f49c2442: function(arg0, arg1) {
            const ret = debugString(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_in_1064a108f4d18b9e: function(arg0, arg1) {
            const ret = arg0 in arg1;
            return ret;
        },
        __wbg___wbindgen_is_function_d633e708baf0d146: function(arg0) {
            const ret = typeof(arg0) === 'function';
            return ret;
        },
        __wbg___wbindgen_is_object_4b3de556756ee8a8: function(arg0) {
            const val = arg0;
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_undefined_c18285b9fc34cb7d: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_jsval_loose_eq_1562ceb9af84e990: function(arg0, arg1) {
            const ret = arg0 == arg1;
            return ret;
        },
        __wbg___wbindgen_number_get_5854912275df1894: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_3e5751597f39a112: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_39bc967c0e5a9b58: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_73af281463ec8b58: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.call(arg1);
            return ret;
        }, arguments); },
        __wbg_done_5aad55ec6b1954b1: function(arg0) {
            const ret = arg0.done;
            return ret;
        },
        __wbg_get_4920fefd3451364b: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_unchecked_3d0f4b91c8eca4f0: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_with_ref_key_6412cf3094599694: function(arg0, arg1) {
            const ret = arg0[arg1];
            return ret;
        },
        __wbg_instanceof_ArrayBuffer_15859862b80b732d: function(arg0) {
            let result;
            try {
                result = arg0 instanceof ArrayBuffer;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Uint8Array_2240b7046ac16f05: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_fad08a0d12828686: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_isSafeInteger_10e4151eb694e42a: function(arg0) {
            const ret = Number.isSafeInteger(arg0);
            return ret;
        },
        __wbg_iterator_fc7ad8d33bab9e26: function() {
            const ret = Symbol.iterator;
            return ret;
        },
        __wbg_length_5855c1f289dfffc1: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_a31e05262e09b7f8: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_new_09959f7b4c92c246: function(arg0) {
            const ret = new Uint8Array(arg0);
            return ret;
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
        __wbg_new_with_length_51597651c65b2f13: function(arg0) {
            const ret = new Array(arg0 >>> 0);
            return ret;
        },
        __wbg_next_a5fe6f328f7affc2: function(arg0) {
            const ret = arg0.next;
            return ret;
        },
        __wbg_next_e592122bb4ed4c67: function() { return handleError(function (arg0) {
            const ret = arg0.next();
            return ret;
        }, arguments); },
        __wbg_prototypesetcall_f034d444741426c3: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), arg2);
        },
        __wbg_push_a6f9488ffd3fae3b: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_set_4c81cfb5dc3a333c: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
        },
        __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
            arg0[arg1] = arg2;
        },
        __wbg_set_bad5c505cc70b5f8: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_value_667dcb90597486a6: function(arg0) {
            const ret = arg0.value;
            return ret;
        },
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

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayI8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
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

function isLikeNone(x) {
    return x === undefined || x === null;
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

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
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

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedInt8ArrayMemory0 = null;
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
