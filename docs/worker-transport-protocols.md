# Worker Transport Protocols

## Scope

This document defines client <-> worker communication for:

- Picker filtering (`app/app-client/filter.worker.ts`)
- Approach-path compute (`app/scene/approach-path/approach.worker.ts`)
- MRMS decode/prepare (`app/scene/nexrad/nexrad.worker.ts`)
- Traffic merge/render (`app/scene/traffic/traffic.worker.ts`)

## Common Protocol Shape

Across all workers:

- Requests include a numeric `requestId`.
- Responses echo the same `requestId`.
- Errors are returned as `error` strings in response payloads.
- Clients maintain per-request timeout maps and reject timed-out requests.
- `messageerror` invalidates in-flight requests and rejects all pending promises.

## Transport Matrix

| Pipeline                                             | Primary Transport                   | Binary/SAB | Fallback Policy                                               |
| ---------------------------------------------------- | ----------------------------------- | ---------- | ------------------------------------------------------------- |
| Filter                                               | `postMessage`                       | No         | No sync fallback; worker error surfaces                       |
| Approach altitude/path                               | `postMessage`                       | No         | No sync fallback; worker error surfaces                       |
| MRMS decode (`decode-volume`, `decode-echo-top`)     | `postMessage` (+ transferables)     | No SAB     | No sync fallback; worker error surfaces                       |
| MRMS prepare-volume                                  | `postMessage` control + SAB payload | Yes        | No non-SAB payload fallback; overflow retries with SAB growth |
| MRMS prepare-echo-top                                | `postMessage`                       | No         | No sync fallback; worker error surfaces                       |
| Traffic (`reset`/`ingest`/`recompute`/`prune-error`) | `postMessage` control + SAB payload | Yes        | No non-SAB/sync fallback; worker error surfaces               |

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

## Traffic Worker Protocol

### Files

- Client: `app/scene/traffic/traffic-worker-client.ts`
- Worker: `app/scene/traffic/traffic.worker.ts`
- Types: `app/scene/traffic/traffic-worker-types.ts`
- SAB layout/read-write: `app/scene/traffic/traffic-sab.ts`

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
- `recompute`
- `prune-error`

### Response Contract

`TrafficWorkerResponseMessage`:

- Success: `usedSab: true` (payload is read from SAB)
- Capacity miss: `sabOverflow` with required capacities (`trackCapacity`, `pointCapacity`, `stringCapacity`)
- Failure: `error`

Worker does not return object payload track arrays anymore; SAB is authoritative.

### Overflow and Retry

- Worker writes `Overflow` control state and required capacities.
- Client merges required-capacity hints and retries up to `MAX_SAB_OVERFLOW_RETRIES`.
- Retry chooses/reassigns a SAB channel that fits (or can be grown).
- Growth uses in-place growable SAB (no buffer replacement transport).

### Render Semantics

- Client reads flat render buffers from SAB and updates line/instance geometry directly.

## MRMS Worker Protocol

### Files

- Client: `app/scene/nexrad/nexrad-worker-client.ts`
- Worker: `app/scene/nexrad/nexrad.worker.ts`
- Types: `app/scene/nexrad/nexrad-worker-types.ts`
- SAB layout/read-write: `app/scene/nexrad/nexrad-sab.ts`

### Decode (`postMessage` + transferables)

Operations:

- `decode-volume`
- `decode-echo-top`

Decode requests transfer the fetched binary `ArrayBuffer` from main thread to worker (ownership move, no clone).
Worker returns decoded payloads via transferable typed-array buffers (no SAB transport for decode).
Echo-top decode payloads are flattened typed arrays (`xNm`/`zNm`/`top*Feet`) so response transfer is buffer-based instead of tuple-array clone.

### Prepare-Volume (SAB-only payload)

Handshake:

- `init-sab` with `channelId` and MRMS prepare SAB buffer set.

Request:

- `prepare-volume` with `preferSab: true`, `sabChannelId`, and preprocess options.

Response:

- Success: `usedSab: true` (client reads prepared volume/cross-section arrays from SAB)
- Overflow: `sabOverflow.voxelCapacity`
- Failure: `error`

Worker does not return transferable `payload`/`crossSectionData` fallback for prepare-volume.

Retry:

- Client tracks required voxel capacity hint and retries up to `MAX_PREPARE_SAB_OVERFLOW_RETRIES`.
- Channel is re-claimed with best-fit capacity; SAB buffers grow in place when needed.

### Prepare-Echo-Top

- `prepare-echo-top` remains `postMessage` response payload (JSON + arrays).

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

- If worker unavailable or errors, client disables the worker path and surfaces explicit worker errors (no synchronous compute fallback).

## Filter Worker Protocol

### Files

- Client: `app/app-client/filter-worker-client.ts`
- Worker: `app/app-client/filter.worker.ts`

### Operation

- Request: `{ requestId, options, query }`
- Response: `{ requestId, filteredOptions }` or `{ requestId, error }`

Failure policy:

- On worker init/message failure, client disables worker filtering and surfaces worker errors (no synchronous in-thread filter fallback).

## Runtime and Debug Telemetry

Runtime debug panel fields currently expose:

- Capability flags: `Worker`, `SharedArrayBuffer`, `Atomics`, `crossOriginIsolated`
- MRMS: offload mode, decode transport (`post-message` / `worker-error`), prepare transport (`sab` / `worker-error`), worker failure diagnostics
- Traffic: offload mode, transport (`sab`), worker error reason, stage timings

These fields are intended to explain whether the active worker protocol is healthy and which transport path is in use.
