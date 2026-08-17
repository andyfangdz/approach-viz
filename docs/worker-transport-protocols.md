# Worker Transport Protocols

## Scope

This document defines client <-> worker communication for:

- Picker filtering (`app/app-client/filter.worker.ts`)
- Approach-path compute (`app/scene/approach-path/approach.worker.ts`)
- MRMS poll/decode/prepare (`app/scene/nexrad/nexrad.worker.ts`)
- Traffic merge/render (`app/scene/traffic/traffic.worker.ts`)
- Chart tile streaming (`app/scene/chart/chart-tiles.worker.ts`)

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

All workers use `Comlink.transfer()` to zero-copy transfer typed arrays (`ArrayBuffer`, `ImageBitmap`) from worker to main thread. No SharedArrayBuffer is used.

## Transport Matrix

| Pipeline                                                                  | Transport                | Transferables                                                        | Failure Policy                                     |
| ------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------- | -------------------------------------------------- |
| Filter                                                                    | Comlink proxy            | No                                                                   | Dispose + recreate worker on failure               |
| Approach altitude/path                                                    | Comlink proxy + transfer | `pointsFlat.buffer`                                                  | Dispose + recreate worker on failure               |
| MRMS `pollAndPrepare`                                                     | Comlink proxy + transfer | Volume payload, prepared volume, cross-section, echo-top SoA buffers | Dispose + recreate worker on failure               |
| MRMS `rePrepare`                                                          | Comlink proxy + transfer | Prepared volume, cross-section buffers                               | Dispose + recreate worker on failure               |
| Traffic (`reset`/`ingestBinary`/`ingestRuntime`/`recompute`/`pruneError`) | Comlink proxy + transfer | Render buffers (markers, trails, strings)                            | Transient errors surface without permanent disable |
| Chart tiles `streamTiles`                                                 | Comlink proxy + callback | `ImageBitmap` per tile via `Comlink.transfer()` in callback          | Worker terminated on cleanup/cancel                |

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

All methods return `TrafficWorkerResult` with render buffers transferred via `Comlink.transfer()`. Client wraps result into `TrafficProcessResult` with typed array views.

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
- `buildPathGeometry(params)` — invokes the shared Rust WASM engine for path geometry and transfers `pointsFlat.buffer`

The worker also uses the same Rust engine for hold geometry via direct WASM calls from `HoldPattern.tsx`, so there is no separate TypeScript geometry implementation left in the web app.

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

### Operation

- `streamTiles(params, onTile)` — fetches tiles with concurrency pool, streams each `ImageBitmap` back via `Comlink.proxy()` callback with `Comlink.transfer()`, returns `ChartStreamSummary` on completion

Consumer creates per-use workers (not singleton). Two-pass preview+detail streaming for flat map mode. Workers are terminated on effect cleanup.

## Runtime and Debug Telemetry

Runtime debug panel fields currently expose:

- Capability flags: `Worker`, `crossOriginIsolated`
- MRMS: offload mode, decode transport (`transfer` / `worker-error`), prepare transport (`transfer` / `worker-error`), worker failure diagnostics
- Traffic: offload mode, feed transport (`binary` / `json`), worker transport (`transfer`), worker error reason, stage timings

These fields explain whether the active worker protocol is healthy and which transport path is in use.
