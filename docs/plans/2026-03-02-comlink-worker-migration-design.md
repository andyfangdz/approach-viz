# Comlink Worker Migration Design

## Summary

Migrate all 5 web workers from the custom `BaseWorkerClient` + manual `postMessage`/`onmessage` message routing to [Comlink](https://github.com/GoogleChromeLabs/comlink). Simultaneously drop SharedArrayBuffer (SAB) transport in favor of transferable-only returns, eliminating ~2000 lines of SAB infrastructure.

## Motivation

The current worker setup has significant ceremony:

- Manual `requestId` allocation and pending-map routing (`BaseWorkerClient`)
- Discriminated union message types with `scope.onmessage` switch statements
- Separate `*-worker-types.ts` files defining request/response unions
- SAB channel pooling, overflow retry, and growable buffer management for traffic + MRMS

Comlink replaces all of this with typed async method calls. Workers become plain classes; clients call methods on a `Remote<T>` proxy.

## Decisions

### Comlink + lightweight lifecycle wrapper (Approach 1)

Workers expose classes via `Comlink.expose()`. A generic `ComlinkedWorkerClient<T>` wraps `Comlink.wrap()` to add per-call timeout, structured error codes (`WorkerClientError`), dispose, and `cancelAllPending()`.

Rejected alternatives:

- **Pure Comlink, no wrapper** — timeout/error handling duplicated per consumer
- **Proxy interceptor** — metaprogramming is hard to debug, fragile type inference

### Drop SharedArrayBuffer transport

Current SAB flow for traffic/MRMS: WASM produces fresh typed arrays, then **copies** them into SharedArrayBuffer, then main thread reads SAB views. Transferables skip the copy entirely — WASM output arrays transfer directly to the main thread (zero-copy pointer move).

SAB overhead eliminated:

- `sab-channel-pool.ts` (236 lines)
- `growable-sab.ts` (~80 lines)
- `traffic-sab.ts` (~200 lines)
- `nexrad-sab.ts` (~200 lines)
- `handleSabOverflowRetry` (~60 lines)
- Per-client overflow retry logic (~200 lines)

At 5s (traffic) and 30s (MRMS) polling intervals, GC pressure from fresh ArrayBuffer allocations is negligible.

### Drop nexrad SharedWorker onconnect handler

The `onconnect` handler in `nexrad.worker.ts` is dead code — `nexrad-worker-client.ts` always instantiates via `new Worker(...)`. Comlink's `expose()` binds to the dedicated worker global scope. SharedWorker support can be added back cleanly if needed.

### Keep ensureWasm() unchanged

`wasm-loader.ts` stays as-is. Worker classes call `ensureWasm()` eagerly in the constructor (starts WASM loading when worker spawns, usually warm by first request).

## Architecture

### Base infrastructure

**`app/scene/shared/worker-errors.ts`** — extracted from `base-worker-client.ts`:

```typescript
export type WorkerErrorCode =
  | 'timeout'
  | 'worker-error'
  | 'message-error'
  | 'terminated'
  | 'cancelled'
  | 'application';

export class WorkerClientError extends Error {
  readonly code: WorkerErrorCode;
}
```

**`app/scene/shared/comlinked-worker-client.ts`**:

```typescript
export class ComlinkedWorkerClient<T extends object> {
  protected readonly proxy: Comlink.Remote<T>;

  constructor(worker: Worker, opts: { name: string; defaultTimeoutMs: number });

  protected withTimeout<R>(promise: Promise<R>, opts?: { timeoutMs?: number }): Promise<R>;
  dispose(): void;
  cancelAllPending(): void;
  protected onDispose(): void;
}
```

Responsibilities:

- Wraps `Comlink.wrap<T>(worker)` to create typed proxy
- `withTimeout()` races any proxy call against a timeout, maps errors to `WorkerClientError`
- Tracks in-flight calls in a `Map<callId, { reject, timeoutId }>` for cancellation
- Listens for worker `error`/`messageerror` events, rejects all in-flight
- `dispose()` terminates worker, rejects all as `'terminated'`
- `cancelAllPending()` rejects all as `'cancelled'`

### Worker designs

#### Filter (simplest)

Worker class exposes `filter(options, query) → SelectOption[]`. Client extends `ComlinkedWorkerClient`, wraps with `withTimeout`. Singleton pattern preserved.

#### Approach

Worker class exposes:

- `resolveAltitudes(params) → AltitudeResult` (synchronous)
- `buildPathGeometry(params) → GeometryResult` (returns `Comlink.transfer()` with `pointsFlat.buffer`)

Client wraps both with `withTimeout`. Singleton pattern preserved.

#### Traffic (was SAB)

Worker class exposes:

- `reset(options) → TrafficWorkerResult`
- `ingestBinary(payload, historyPayload, options) → TrafficWorkerResult`
- `ingestRuntime(url, followupUrl, options) → TrafficWorkerResult`
- `recompute(options) → TrafficWorkerResult`
- `pruneError(options) → TrafficWorkerResult`

All methods return `Comlink.transfer(result, [...buffers])` with WASM SoA typed arrays as transferables. No SAB init, no channel claiming, no overflow retry.

Client transfers `payloadBuffer`/`historyPayloadBuffer` to worker via `Comlink.transfer()` on the call site. Singleton pattern preserved.

WASM loading kicked off eagerly in constructor: `private readonly ready = ensureWasm()`.

#### MRMS / Nexrad (was SAB)

Worker class exposes:

- `pollAndPrepare(options) → PollAndPrepareResult`
- `rePrepare(options) → RePrepareResult`

Both return `Comlink.transfer()` with volume payload arrays, prepared volume arrays, and echo-top SoA arrays as transferables. No SAB init, no channel claiming, no overflow retry.

SharedWorker `onconnect` handler removed.

Client preserves existing module-level diagnostics, singleton management, and `activePollPromise` serialization.

#### Chart Tiles (streaming)

Worker class exposes:

- `streamTiles(params, onTile) → { totalTiles, failedTiles }`

The `onTile` callback receives `{ tileX, tileY, bitmap }` with ImageBitmap transferred via `Comlink.transfer()` on the worker side. Radial sort and concurrent fetch pool (60) preserved.

Consumer in `ChartMapSurface.tsx` uses `Comlink.wrap()` + `Comlink.proxy(onTile)`. The `stream-complete` event becomes implicit (the `await` resolves). Two-pass preview/detail pattern uses separate workers as before. No `requestId` demultiplexing needed.

## File changes

| Action  | File                                                |
| ------- | --------------------------------------------------- |
| New     | `app/scene/shared/worker-errors.ts`                 |
| New     | `app/scene/shared/comlinked-worker-client.ts`       |
| Rewrite | `app/app-client/filter.worker.ts`                   |
| Rewrite | `app/app-client/filter-worker-client.ts`            |
| Rewrite | `app/scene/approach-path/approach.worker.ts`        |
| Rewrite | `app/scene/approach-path/approach-worker-client.ts` |
| Rewrite | `app/scene/traffic/traffic.worker.ts`               |
| Rewrite | `app/scene/traffic/traffic-worker-client.ts`        |
| Rewrite | `app/scene/nexrad/nexrad.worker.ts`                 |
| Rewrite | `app/scene/nexrad/nexrad-worker-client.ts`          |
| Rewrite | `app/scene/chart/chart-tiles.worker.ts`             |
| Modify  | `app/scene/ChartMapSurface.tsx`                     |
| Delete  | `app/scene/shared/base-worker-client.ts`            |
| Delete  | `app/scene/shared/sab-channel-pool.ts`              |
| Delete  | `app/scene/shared/growable-sab.ts`                  |
| Delete  | `app/scene/traffic/traffic-sab.ts`                  |
| Delete  | `app/scene/nexrad/nexrad-sab.ts`                    |
| Delete  | `app/scene/approach-path/approach-worker-types.ts`  |
| Delete  | `app/scene/traffic/traffic-worker-types.ts`         |
| Delete  | `app/scene/nexrad/nexrad-worker-types.ts`           |

## Dependencies

- **Add**: `comlink` (npm)
- **Remove**: none (SAB utilities are project code, not external deps)

## Risks

- **Comlink proxy overhead**: Each method call adds a small serialization envelope. Negligible for 5s/30s poll intervals and sub-ms overhead per call.
- **Callback transfer for chart tiles**: `Comlink.transfer()` inside worker-to-main proxy callbacks. Supported by Comlink's wire protocol but less common usage. Needs testing.
- **GC pressure from transferables**: Fresh ArrayBuffer allocations replace pre-allocated SAB reuse. At current poll rates, impact is negligible.

## Out of scope

- Cross-origin isolation header changes (SAB was the primary driver but other features may still benefit)
- Service worker changes (uses Workbox, unrelated to Comlink)
- WASM loader changes (`wasm-loader.ts` stays as-is)
