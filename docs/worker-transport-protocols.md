# Worker Transport Protocols

## Scope

This document defines client <-> worker communication for:

- Picker filtering (`app/app-client/filter.worker.ts`)
- Approach-path compute (`app/scene/approach-path/approach.worker.ts`)
- MRMS poll/decode/prepare (`app/scene/nexrad/nexrad.worker.ts`)
- Traffic merge/render (`app/scene/traffic/traffic.worker.ts`)

## Common Protocol Shape

Across all workers:

- Requests include a numeric `requestId`.
- Responses echo the same `requestId`.
- Errors are returned as `error` strings in response payloads.
- Clients maintain per-request timeout maps and reject timed-out requests.
- `messageerror` and `error` events invalidate in-flight requests and reject all pending promises.

## Transport Matrix

| Pipeline                                                                              | Primary Transport                   | Binary/SAB | Fallback Policy                                                                                                      |
| ------------------------------------------------------------------------------------- | ----------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| Filter                                                                                | `postMessage`                       | No         | Dispose + recreate worker on failure; no sync fallback                                                               |
| Approach altitude/path                                                                | `postMessage`                       | No         | Dispose + recreate worker on failure; no sync fallback                                                               |
| MRMS `poll-and-prepare` (worker fetch + decode + prepare)                             | `postMessage` control + SAB payload | Yes        | Dispose + recreate on failure; overflow retries with SAB growth                                                      |
| Traffic (`reset`/`ingest`/`ingest-binary`/`ingest-runtime`/`recompute`/`prune-error`) | `postMessage` control + SAB payload | Yes        | Transient errors surface without permanent disable; debounced recompute/poll restart prevents SAB channel exhaustion |

## Shared SAB Utilities

### `app/scene/shared/growable-sab.ts`

- Creates growable `SharedArrayBuffer` instances with `maxByteLength`.
- `tryGrowSharedArrayBuffer(buffer, nextByteLength)` attempts in-place growth via `buffer.grow(...)`.
- Growth failure returns `false` (no throw propagation).

### `app/scene/shared/sab-channel-pool.ts`

- Manages multiple SAB channels (`id`, `buffers`, `views`, `inFlightRequestId`).
- Supports initial channel bootstrap and bounded channel count growth.
- `claimBestFitSabChannelForRequest(...)` chooses a free channel that fits requested capacity, or:
  1. grows the best candidate channel,
  2. creates a new channel if under cap,
  3. falls back to claiming any free channel that can be grown.

This allows concurrent requests while minimizing over-allocation.

## Traffic Runtime Wire Format

- Runtime endpoint `/v1/traffic/adsbx` accepts `format=binary` and emits `application/vnd.approach-viz.traffic.v1`.
- Payload layout: fixed 64-byte header (`AVTR` magic + version + section offsets/counts), fixed-width aircraft records, fixed-width history-group records, fixed-width history-point records, and a trailing UTF-8 string table.
- Worker uses `decodeTrafficBinaryPayload(...)` to deserialize full aircraft/history payloads before merge/prune/projection.
- Main thread now only constructs URLs/backfill policy; worker performs network fetch + decode for `ingest-runtime`.

## Traffic Worker Protocol

### Files

- Client: `app/scene/traffic/traffic-worker-client.ts`
- Worker: `app/scene/traffic/traffic.worker.ts`
- Types: `app/scene/traffic/traffic-worker-types.ts`
- SAB layout/read-write: `app/scene/traffic/traffic-sab.ts`
- Binary payload codec: `app/scene/traffic/traffic-binary-protocol.ts`

### Handshake

1. Client creates SAB channel pool.
2. For each channel, client sends:
   - `type: 'init-sab'`
   - `channelId`
   - SAB buffer set (`control`, marker arrays, trail arrays, string arrays)
3. Worker stores views in `sabViewsByChannel` keyed by `channelId`.

### Request Contract

`TrafficBaseRequest` requires:

- `preferSab: true`
- `sabChannelId: number`

Operations:

- `reset`
- `ingest` (`aircraftList`, optional `historyByHex`)
- `ingest-binary` (`payloadBuffer`, optional `historyPayloadBuffer`; request buffers are transferable)
- `ingest-runtime` (`primaryUrl`, optional `followupUrl`; worker fetches/parses runtime payloads directly)
- `recompute`
- `prune-error`

### Response Contract

`TrafficWorkerResponseMessage`:

- Success: `usedSab: true` (payload is read from SAB)
- Capacity miss: `sabOverflow` with required capacities (`trackCapacity`, `pointCapacity`, `stringCapacity`)
- Runtime-ingest metadata: `feedTransport` (`binary`/`json`), `fetchMs`, `parseMs`, `trackedHexes`, `returnedHistoryHexes`
- Failure: `error`

Worker does not return object payload track arrays anymore; SAB is authoritative.

### Overflow and Retry

- Worker writes `Overflow` control state and required capacities.
- Client merges required-capacity hints and retries up to `MAX_SAB_OVERFLOW_RETRIES`.
- Retry chooses/reassigns a SAB channel that fits (or can be grown).
- Growth uses in-place growable SAB (no buffer replacement transport).
- For transferable `ingest-binary` requests, overflow updates capacity hints but the specific request cannot be replayed from detached buffers; client surfaces an explicit fresh-request error and retries on the next poll.

### Render Semantics

- Client reads flat render buffers from SAB and updates line/instance geometry directly.

## MRMS Worker Protocol

### Files

- Client: `app/scene/nexrad/nexrad-worker-client.ts`
- Worker: `app/scene/nexrad/nexrad.worker.ts`
- Types: `app/scene/nexrad/nexrad-worker-types.ts`
- SAB layout/read-write: `app/scene/nexrad/nexrad-sab.ts`

### Poll-And-Prepare (single-flight worker request)

Handshake:

- `init-sab` with `channelId` and MRMS prepare SAB buffer set.

Request:

- `poll-and-prepare` with `preferSab: true`, `sabChannelId`, runtime URLs (`volumeUrl`, `echoTopUrl`), and preprocess options (`minDbz`, `phaseMode`, `declutterMode`, cross-section settings, curvature settings).
- Worker fetches MRMS volume/echo-top endpoints directly, decodes payloads, then runs volume/echo-top prepare in the same request.

Response:

- Success: `usedSab: true`
- Prepared volume/cross-section arrays are read from SAB
- Decoded volume payload typed arrays are returned as transferables (`volumePayload`) for final mesh upload inputs
- Prepared echo-top surfaces (`echoTop18/30/50Cells`) and echo-top summary metadata are returned in the response object
- Overflow: `sabOverflow.voxelCapacity`
- Failure: `error`

Worker does not return non-SAB fallback payload for prepared volume/cross-section.

Retry:

- Client tracks required voxel capacity hint and retries up to `MAX_PREPARE_SAB_OVERFLOW_RETRIES`.
- Channel is re-claimed with best-fit capacity; SAB buffers grow in place when needed.
- Poll-and-prepare retries replay the full poll request after capacity growth (same request options, larger SAB channel).

### Legacy Decode/Prepare Operations

- `decode-volume`, `decode-echo-top`, `prepare-volume`, and `prepare-echo-top` remain in the worker contract for test coverage/compatibility paths.
- Active overlay runtime path uses `poll-and-prepare`.

## Approach Worker Protocol

### Files

- Client: `app/scene/approach-path/approach-worker-client.ts`
- Worker: `app/scene/approach-path/approach.worker.ts`
- Types: `app/scene/approach-path/approach-worker-types.ts`

### Operations

- `resolve-altitudes`
- `build-path-geometry`

Transport is plain `postMessage` (no SAB). `build-path-geometry` returns `pointsFlat: Float32Array` and transfers its buffer back to main thread.

Failure policy:

- If a request fails, client disposes the current worker and recreates a fresh one on the next attempt, allowing recovery from transient errors without permanent disable (no synchronous compute fallback).

## Filter Worker Protocol

### Files

- Client: `app/app-client/filter-worker-client.ts`
- Worker: `app/app-client/filter.worker.ts`

### Operation

- Request: `{ requestId, options, query }`
- Response: `{ requestId, filteredOptions }` or `{ requestId, error }`

Failure policy:

- On request failure, client disposes the current worker and recreates a fresh one on the next attempt, allowing recovery from transient errors (no synchronous in-thread filter fallback).

## Runtime and Debug Telemetry

Runtime debug panel fields currently expose:

- Capability flags: `Worker`, `SharedArrayBuffer`, `Atomics`, `crossOriginIsolated`
- MRMS: offload mode, decode transport (`sab` / `worker-error`), prepare transport (`sab` / `worker-error`), worker failure diagnostics
- Traffic: offload mode, feed transport (`binary` / `json`), worker transport (`sab`), worker error reason, stage timings

These fields are intended to explain whether the active worker protocol is healthy and which transport path is in use.
