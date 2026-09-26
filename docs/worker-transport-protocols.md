# Worker Transport Protocols

## Scope

This document defines client <-> worker communication for:

- Picker filtering (`app/app-client/filter.worker.ts`)
- Approach-path compute (`app/scene/approach-path/approach.worker.ts`)
- MRMS poll/decode/prepare (`app/scene/nexrad/nexrad.worker.ts`)
- Traffic merge/render (`app/scene/traffic/traffic.worker.ts`)
- Chart tile streaming and 3D-map compositing (`app/scene/chart/chart-tiles.worker.ts`)
- Terrain, elevation sampling, and airspace geometry (`app/scene/geometry/scene-geometry.worker.ts`)
- Scene label atlases (`app/scene/labels/label-atlas.worker.ts`)
- HDR environment decode (`app/scene/environment/hdr.worker.ts`)

## Comlink Worker Client

All workers expose a typed class via `Comlink.expose()` on the worker side. Clients use `Comlink.wrap<T>()` to obtain a typed async proxy.

Most worker clients extend `ComlinkedWorkerClient<T>` (`app/scene/shared/comlinked-worker-client.ts`), which handles:

- Typed proxy via `Comlink.wrap<T>()`
- Per-call timeout with in-flight tracking
- Error mapping to `WorkerClientError` codes (`timeout`, `worker-error`, `message-error`, `terminated`, `cancelled`, `application`)
- In-flight tracking for `cancelAllPending()` and `dispose()`
- Worker `error`/`messageerror` event handling

The chart tiles worker uses `Comlink.wrap()` directly (no `ComlinkedWorkerClient`) since it creates per-use workers and doesn't need timeout/cancel/error-code tracking.

## Transport

All workers use `Comlink.transfer()` to zero-copy transfer typed arrays (`ArrayBuffer`, `ImageBitmap`) from worker to main thread. No SharedArrayBuffer or cross-origin isolation is required.

## Transport Matrix

| Pipeline                                                                  | Transport                | Transferables                                                                    | Failure Policy                                     |
| ------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------- |
| Filter                                                                    | Comlink proxy            | No                                                                               | Dispose + recreate worker on failure               |
| Approach altitude/path/hold                                               | Comlink proxy + transfer | Path tube (positions/normals/uvs/index), dashed polyline; structured hold points | Dispose + recreate worker on failure               |
| MRMS `pollAndPrepare`                                                     | Comlink proxy + transfer | Volume payload, prepared volume, cross-section, echo-top SoA buffers             | Dispose + recreate worker on failure               |
| MRMS `rePrepare`                                                          | Comlink proxy + transfer | Prepared volume, cross-section buffers                                           | Dispose + recreate worker on failure               |
| Traffic (`reset`/`ingestBinary`/`ingestRuntime`/`recompute`/`pruneError`) | Comlink proxy + transfer | Marker positions, flags, trail segments, marker matrices, heading segments       | Transient errors surface without permanent disable |
| Chart tiles `streamTiles`                                                 | Comlink proxy + callback | Raw RGBA tile batches (`ChartTileBatch`) via `Comlink.transfer()` in callback    | Worker terminated on cleanup/cancel                |
| Chart tiles `composeChartTexture`                                         | Comlink proxy + transfer | One composited `ImageBitmap`                                                     | Worker terminated on cleanup/cancel                |
| Scene geometry (terrain, elevation, airspace)                             | Comlink proxy + transfer | Mesh/index buffers, heightfield + page max, drape mesh, airspace buffers         | Dispose + recreate worker on failure               |
| Label atlas `rasterize`                                                   | Comlink proxy + transfer | Premultiplied RGBA atlas + entry table                                           | Dispose + recreate worker on failure               |
| HDR environment `decode`                                                  | Comlink proxy + transfer | Half-float texels                                                                | One-shot worker; failure retried on remount        |

## Traffic Runtime Wire Format

- Runtime endpoint `/v1/traffic/adsbx` accepts `format=binary` and emits `application/vnd.approach-viz.traffic.v4`.
- Payload layout (AVTR v4, SoA, FlatBuffers).
- Worker uses WASM to deserialize and merge/prune/project.
- Main thread only constructs URLs/backfill policy; worker performs network fetch + decode for `ingestRuntime`.

## Traffic Worker Protocol

### Files

- Client: `app/scene/traffic/traffic-worker-client.ts`
- Worker: `app/scene/traffic/traffic.worker.ts`
- Binary payload decode: handled by WASM (`FbAircraftView` + `collect_fb_history` in `crates/approach-viz-core/src/traffic_merge.rs`)

### Operations

- `reset()` — clear state
- `ingestBinary(payloadBuffer, historyPayloadBuffer, options)` — decode + merge binary payloads
- `ingestRuntime(primaryUrl, followupUrl, options)` — worker fetches + decodes runtime payloads
- `recompute(options)` — recompute render buffers from current state
- `pruneError(options)` — mark errored aircraft for pruning

All methods return `TrafficWorkerResult` with render buffers transferred via `Comlink.transfer()`. The worker expands the WASM render SoA into upload-ready draw buffers (`buildTrafficDrawBuffers` in `app/scene/traffic/traffic-draw-buffers.ts`): trail line segments, one translation matrix per current aircraft in `InstancedMesh` layout, heading-tick segments, and the active track indices callsign labels read. Client wraps result into `TrafficProcessResult` with typed array views.

## MRMS Worker Protocol

### Files

- Client: `app/scene/nexrad/nexrad-worker-client.ts`
- Worker: `app/scene/nexrad/nexrad.worker.ts`

### Operations

- `pollAndPrepare(options)` — fetch volume + echo-tops from runtime, decode via WASM, prepare volume/cross-section, return all data via `Comlink.transfer()`
- `rePrepare(options)` — re-decode cached volume buffer with new parameters (minDbz, phaseMode, declutterMode, cross-section settings)

Transfer lists include all typed array buffers from: volume payload (`xNm`, `zNm`, `dbz`, `spanX`, `spanY`, `phaseCode`), prepared volume (`validIndices`, `yBase`, `heightBase`, `correctedBottomFeet`, `correctedTopFeet`, `effectivePhaseCode`, `declutterIndices`), cross-section (`grid`, `phaseGrid`, `topEnvelopeFeet`), and echo-top SoA (`x`, `z`, `yBase` per threshold).

Singleton management: module-level `sharedClient` with `activePollPromise` guard to serialize concurrent polls.

## Approach Worker Protocol

### Files

- Client: `app/scene/approach-path/approach-worker-client.ts`
- Worker: `app/scene/approach-path/approach.worker.ts`

### Operations

- `resolveAltitudes(params)` — invokes the shared Rust WASM engine for altitude resolution, then `compose_approach_scene` for FAF-append / MAP-extension / hold listing
- `buildPathGeometry(params)` — invokes the shared Rust WASM engine for path geometry, splits the path at `dashedBelowY` (the minimums), sweeps the solid part into a `TubeGeometry`, and transfers the indexed tube buffers plus the dashed below-minimums polyline

- `buildHoldGeometry(params)` — resolves hold length, racetrack points, and optional protected rings in the worker and returns render-ready tuples. `HoldPattern.tsx` only renders that result; it does not initialize WASM on the main thread.

Failure policy: client disposes the current worker and recreates on next attempt.

## Filter Worker Protocol

### Files

- Client: `app/app-client/filter-worker-client.ts`
- Worker: `app/app-client/filter.worker.ts`

### Operation

- `filter(options, query)` — returns filtered `SelectOption[]`

Failure policy: client disposes the current worker and recreates on next attempt.

## Chart Tiles Worker Protocol

### Files

- Worker: `app/scene/chart/chart-tiles.worker.ts`
- Consumer: `app/scene/ChartMapSurface.tsx`

### Operations

- `streamTiles(params, onBatch)` — fetches tiles with a concurrency pool, decodes each to raw 256x256 straight-alpha RGBA on an `OffscreenCanvas`, and delivers `ChartTileBatch` (tile coordinates plus the tiles' pixels back to back) through a Comlink callback in batches of 8, or after 40 ms for a partial batch. Batches are delivered in order and awaited before the callback is released and `ChartStreamSummary` returned. The callback uses Comlink's remote type; checking `releaseProxy` with `in` is invalid because Comlink supplies it through a proxy getter.
- `composeChartTexture({ base, overlay })` — fetches the base range and optional TAC overlay and composites them on one `OffscreenCanvas`, drawn south-up so the returned `ImageBitmap` uploads with `flipY = false`.

Consumer creates per-use workers (not singleton). Two-pass preview+detail streaming for flat map mode. Workers are terminated on effect cleanup.

## Scene Geometry Worker Protocol

### Files

- Client: `app/scene/geometry/scene-geometry-client.ts`
- Worker: `app/scene/geometry/scene-geometry.worker.ts`
- Builders: `app/scene/terrain/terrain-mesh.ts`, `app/scene/terrain/terrarium.ts`, `app/scene/nexrad/nexrad-ground.ts`, `app/scene/nexrad/nexrad-drape.ts`, `app/scene/airspace/airspace-geometry.ts`

### Operations

- `buildTerrainMesh({ refLat, refLon, radiusNm })` — z10 Terrarium raster to positions, normals, triangle index, and a wireframe edge index over the same vertices; `null` when every tile failed.
- `loadElevation(raster)` — loads (or reuses) an elevation raster and reports `ready` / `unavailable`. The raster stays in the worker (LRU of 4; failed or empty loads are not cached); `useElevationRaster` holds the request as a handle.
- `buildGroundHeightfield(raster, grid, applyEarthCurvature, refLat)` — the volume's ground heightfield and per-page maximum.
- `buildMosaicDrape(raster, params)` — the surface mosaic's terrain-draped mesh.
- `buildAirspace(features, refLat, refLon, airportElevationFeet)` — extruded sector triangles and edge segments per feature, `null` for sectors without volume.

## Label Atlas Worker Protocol

- Client: `app/scene/labels/label-atlas-client.ts`; worker: `app/scene/labels/label-atlas.worker.ts`; layout math: `app/scene/labels/label-atlas.ts`.
- `rasterize(entries, pixelRatio)` — measures and draws every `(text, style)` entry (font, text-shadow glow, optional chip box) into one shelf-packed `OffscreenCanvas`, premultiplies it, and returns the pixels with a per-entry table of UVs and CSS size. `SceneLabels` requests a new atlas only when a label's text or style is missing from the current one.

## HDR Environment Worker Protocol

- `app/scene/environment/hdr.worker.ts` `decode(url)` fetches drei's `night` preset HDR and parses it with the same `RGBELoader`, returning half-float texels. `SceneEnvironment` suspends on it exactly as `<Environment preset="night">` did.

## Runtime and Debug Telemetry

Runtime debug panel fields currently expose:

- Worker availability: `Worker`
- MRMS: offload mode, decode transport (`transfer` / `worker-error`), prepare transport (`transfer` / `worker-error`), worker failure diagnostics
- Traffic: offload mode, feed transport (`binary` / `json`), worker transport (`transfer`), worker error reason, stage timings

These fields explain whether the active worker protocol is healthy and which transport path is in use.
