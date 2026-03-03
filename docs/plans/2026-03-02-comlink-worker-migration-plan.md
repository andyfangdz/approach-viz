# Comlink Worker Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace custom `BaseWorkerClient` + manual `postMessage` routing with Comlink typed proxies across all 5 workers, dropping SharedArrayBuffer transport in favor of transferables.

**Architecture:** Workers become plain classes exposed via `Comlink.expose()`. A generic `ComlinkedWorkerClient<T>` wraps `Comlink.wrap()` with timeout, error codes, dispose, and `cancelAllPending()`. SAB infrastructure is deleted; WASM output arrays transfer directly to the main thread.

**Tech Stack:** comlink (npm), TypeScript, Next.js web workers, wasm-bindgen

**Design doc:** `docs/plans/2026-03-02-comlink-worker-migration-design.md`

---

## Task 1: Install comlink + create shared infrastructure

### Files

- Modify: `package.json`
- Create: `app/scene/shared/worker-errors.ts`
- Create: `app/scene/shared/comlinked-worker-client.ts`

### Step 1: Install comlink

```bash
npm install comlink
```

### Step 2: Create `app/scene/shared/worker-errors.ts`

Extract `WorkerClientError` and `WorkerErrorCode` from `base-worker-client.ts`. Drop `overflow-exhausted` code (SAB is gone).

```typescript
/**
 * Structured error type for worker client failures.
 * Callers can inspect `code` to distinguish transient from permanent errors
 * without string-matching error messages.
 */
export type WorkerErrorCode =
  | 'timeout'
  | 'worker-error'
  | 'message-error'
  | 'terminated'
  | 'cancelled'
  | 'application';

export class WorkerClientError extends Error {
  readonly code: WorkerErrorCode;
  constructor(code: WorkerErrorCode, message: string) {
    super(message);
    this.name = 'WorkerClientError';
    this.code = code;
  }
}
```

### Step 3: Create `app/scene/shared/comlinked-worker-client.ts`

```typescript
import * as Comlink from 'comlink';
import { WorkerClientError } from './worker-errors';

interface InFlightEntry {
  reject: (reason: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface ComlinkedWorkerClientOptions {
  name: string;
  defaultTimeoutMs: number;
}

/**
 * Base class for Comlink-based worker clients. Handles:
 * - Typed proxy via Comlink.wrap<T>()
 * - Per-call timeout via Promise.race
 * - Error mapping to WorkerClientError codes
 * - In-flight tracking for cancelAllPending() and dispose()
 * - Worker error/messageerror event handling
 */
export class ComlinkedWorkerClient<T extends object> {
  protected readonly proxy: Comlink.Remote<T>;
  private readonly rawWorker: Worker;
  private readonly name: string;
  private readonly defaultTimeoutMs: number;
  private nextCallId = 1;
  private readonly inFlight = new Map<number, InFlightEntry>();
  private disposed = false;

  constructor(worker: Worker, options: ComlinkedWorkerClientOptions) {
    this.rawWorker = worker;
    this.name = options.name;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.proxy = Comlink.wrap<T>(worker);
    worker.addEventListener('error', this.handleWorkerError);
    worker.addEventListener('messageerror', this.handleMessageError);
  }

  /**
   * Wrap a Comlink proxy call with timeout and error mapping.
   * Usage: `return this.withTimeout(this.proxy.someMethod(args))`.
   */
  protected withTimeout<TResult>(
    promise: Promise<TResult>,
    options?: { timeoutMs?: number }
  ): Promise<TResult> {
    if (this.disposed) {
      return Promise.reject(
        new WorkerClientError('terminated', `${this.name} worker is disposed.`)
      );
    }
    const callId = this.nextCallId++;
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<TResult>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.inFlight.delete(callId);
        reject(new WorkerClientError('timeout', `${this.name} worker request timed out.`));
      }, timeoutMs);

      this.inFlight.set(callId, { reject, timeoutId });

      promise.then(
        (result) => {
          if (!this.inFlight.has(callId)) return; // timed out already
          clearTimeout(timeoutId);
          this.inFlight.delete(callId);
          resolve(result);
        },
        (error) => {
          if (!this.inFlight.has(callId)) return;
          clearTimeout(timeoutId);
          this.inFlight.delete(callId);
          reject(this.mapError(error));
        }
      );
    });
  }

  dispose(): void {
    this.disposed = true;
    this.rawWorker.removeEventListener('error', this.handleWorkerError);
    this.rawWorker.removeEventListener('messageerror', this.handleMessageError);
    this.rawWorker.terminate();
    this.rejectAll(new WorkerClientError('terminated', `${this.name} worker terminated.`));
    this.onDispose();
  }

  cancelAllPending(): void {
    this.rejectAll(new WorkerClientError('cancelled', `${this.name} worker request cancelled.`));
  }

  /** Hook for subclass cleanup on dispose. */
  protected onDispose(): void {}

  private mapError(error: unknown): WorkerClientError {
    if (error instanceof WorkerClientError) return error;
    const message = error instanceof Error ? error.message : String(error);
    return new WorkerClientError('application', message);
  }

  private rejectAll(error: WorkerClientError): void {
    for (const entry of this.inFlight.values()) {
      clearTimeout(entry.timeoutId);
      entry.reject(error);
    }
    this.inFlight.clear();
  }

  private handleWorkerError = () => {
    this.rejectAll(new WorkerClientError('worker-error', `${this.name} worker runtime error.`));
  };

  private handleMessageError = () => {
    this.rejectAll(new WorkerClientError('message-error', `${this.name} worker message error.`));
  };
}
```

### Step 4: Verify

```bash
npm run typecheck
```

### Step 5: Commit

```bash
git add package.json package-lock.json app/scene/shared/worker-errors.ts app/scene/shared/comlinked-worker-client.ts
git commit -m "feat(worker): add comlink dependency and ComlinkedWorkerClient base class"
```

---

## Task 2: Migrate filter worker

The simplest worker — validates the Comlink pattern end-to-end.

### Files

- Rewrite: `app/app-client/filter.worker.ts`
- Rewrite: `app/app-client/filter-worker-client.ts`

### Step 1: Rewrite `filter.worker.ts`

Replace `scope.onmessage` with a class + `Comlink.expose()`. Keep all domain logic (`filterOptions`, `normalizeQuery`, `MAX_PICKER_RESULTS`).

The key change: remove `requestId` from the protocol. The class method just takes `options` and `query`, returns `SelectOption[]` directly. Comlink handles routing.

```typescript
import type { SelectOption } from '@/app/app-client-utils';
import * as Comlink from 'comlink';

const MAX_PICKER_RESULTS = 80;

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

function filterOptions(options: SelectOption[], query: string): SelectOption[] {
  const normalized = normalizeQuery(query);
  if (!normalized) {
    return options.slice(0, MAX_PICKER_RESULTS);
  }
  return options
    .filter((option) => option.searchText.includes(normalized))
    .slice(0, MAX_PICKER_RESULTS);
}

export class FilterWorkerApi {
  filter(options: SelectOption[], query: string): SelectOption[] {
    return filterOptions(options, query);
  }
}

Comlink.expose(new FilterWorkerApi());
```

### Step 2: Rewrite `filter-worker-client.ts`

Replace `BaseWorkerClient` extension with `ComlinkedWorkerClient`. Remove `requestId` allocation, `resolveResponse()`, and the internal `FilterResponseMessage` type.

```typescript
import type { SelectOption } from '@/app/app-client-utils';
import { ComlinkedWorkerClient } from '@/app/scene/shared/comlinked-worker-client';
import type { FilterWorkerApi } from './filter.worker';

class FilterWorkerClient extends ComlinkedWorkerClient<FilterWorkerApi> {
  constructor() {
    super(new Worker(new URL('./filter.worker.ts', import.meta.url), { type: 'module' }), {
      name: 'Filter',
      defaultTimeoutMs: 2000
    });
  }

  filter(options: SelectOption[], query: string): Promise<SelectOption[]> {
    return this.withTimeout(this.proxy.filter(options, query));
  }
}

let sharedClient: FilterWorkerClient | null = null;

function getClient(): FilterWorkerClient {
  if (typeof Worker === 'undefined') {
    throw new Error('Filter worker API is unavailable in this runtime.');
  }
  if (sharedClient) return sharedClient;
  sharedClient = new FilterWorkerClient();
  return sharedClient;
}

function disposeClient() {
  sharedClient?.dispose();
  sharedClient = null;
}

export async function filterOptionsWithWorker(
  options: SelectOption[],
  query: string
): Promise<SelectOption[]> {
  const client = getClient();
  try {
    return await client.filter(options, query);
  } catch (error) {
    disposeClient();
    throw error instanceof Error ? error : new Error('Filter worker failed.');
  }
}
```

### Step 3: Verify

```bash
npm run typecheck
```

### Step 4: Commit

```bash
git add app/app-client/filter.worker.ts app/app-client/filter-worker-client.ts
git commit -m "feat(worker): migrate filter worker to comlink"
```

---

## Task 3: Migrate approach worker

Introduces transferable returns via `Comlink.transfer()` for `pointsFlat`.

### Files

- Rewrite: `app/scene/approach-path/approach.worker.ts`
- Rewrite: `app/scene/approach-path/approach-worker-client.ts`
- Delete: `app/scene/approach-path/approach-worker-types.ts`

### Step 1: Rewrite `approach.worker.ts`

Convert to a class with `resolveAltitudes()` and `buildPathGeometry()` methods. Keep all domain logic (`resolveAltitudesForApproach`, `buildPathGeometry` import, point packing). Remove `WorkerEndpoint` type and `scope.onmessage` dispatch.

Key details:

- `resolveAltitudes()` is synchronous — returns directly
- `buildPathGeometry()` uses `Comlink.transfer()` to transfer `pointsFlat.buffer`
- Export the class and all param/result types so the client can import them as `import type`
- Keep imports from `./altitudes` and `./path-builder`

Types to export from the worker file (replacing approach-worker-types.ts):

```typescript
export interface ResolveAltitudesParams {
  finalLegs: ApproachLeg[];
  transitionEntries: [string, ApproachLeg[]][];
  missedLegs: ApproachLeg[];
  waypoints: [string, Waypoint][];
  refLat: number;
  refLon: number;
  airportElevation: number;
  missedApproachStartAltitudeFeet?: number;
  missedApproachClimbRequirement?: MissedApproachClimbRequirement | null;
}

export interface AltitudeResult {
  finalAltitudes: number[];
  transitionAltitudes: [string, number[]][];
  missedAltitudes: number[];
  missedPathAltitudes: number[];
}

export interface BuildPathGeometryParams {
  legs: ApproachLeg[];
  waypoints: [string, Waypoint][];
  resolvedAltitudes: number[];
  initialAltitudeFeet: number;
  verticalScale: number;
  refLat: number;
  refLon: number;
  magVar: number;
  showTurnConstraintLabels?: boolean;
}

export interface GeometryResult {
  pointsFlat: Float32Array;
  verticalLines: VerticalLineData[];
  turnConstraintLabels: TurnConstraintLabel[];
}
```

The class exposes two methods:

```typescript
export class ApproachWorkerApi {
  resolveAltitudes(params: ResolveAltitudesParams): AltitudeResult { ... }
  buildPathGeometry(params: BuildPathGeometryParams): GeometryResult { ... }
}
Comlink.expose(new ApproachWorkerApi());
```

`buildPathGeometry` wraps its return with `Comlink.transfer(result, [result.pointsFlat.buffer])`.

### Step 2: Rewrite `approach-worker-client.ts`

Replace `BaseWorkerClient` with `ComlinkedWorkerClient`. Import types from the worker file via `import type`. Remove `resolveResponse()` which manually unpacked the discriminated union.

```typescript
import type { ApproachLeg, Waypoint } from '@/lib/cifp/parser';
import type { MissedApproachClimbRequirement } from '@/lib/types';
import type { TurnConstraintLabel, VerticalLineData } from './types';
import { ComlinkedWorkerClient } from '@/app/scene/shared/comlinked-worker-client';
import type {
  ApproachWorkerApi,
  AltitudeResult,
  BuildPathGeometryParams,
  GeometryResult,
  ResolveAltitudesParams
} from './approach.worker';

class ApproachWorkerClient extends ComlinkedWorkerClient<ApproachWorkerApi> {
  constructor() {
    super(new Worker(new URL('./approach.worker.ts', import.meta.url), { type: 'module' }), {
      name: 'Approach',
      defaultTimeoutMs: 6000
    });
  }

  resolveAltitudes(params: ResolveAltitudesParams): Promise<AltitudeResult> {
    return this.withTimeout(this.proxy.resolveAltitudes(params));
  }

  buildPathGeometry(params: BuildPathGeometryParams): Promise<GeometryResult> {
    return this.withTimeout(this.proxy.buildPathGeometry(params));
  }
}
```

Keep the singleton pattern and the two exported functions (`resolveApproachAltitudesWithWorker`, `buildPathGeometryWithWorker`) with the same signatures.

### Step 3: Delete `approach-worker-types.ts`

```bash
git rm app/scene/approach-path/approach-worker-types.ts
```

### Step 4: Verify

```bash
npm run typecheck
```

### Step 5: Commit

```bash
git add app/scene/approach-path/
git commit -m "feat(worker): migrate approach worker to comlink"
```

---

## Task 4: Migrate traffic worker (SAB removal)

The largest migration — drops SAB transport entirely, moves shared types.

### Files

- Rewrite: `app/scene/traffic/traffic.worker.ts`
- Rewrite: `app/scene/traffic/traffic-worker-client.ts`
- Modify: `app/scene/LiveTrafficOverlay.tsx` (update imports)
- Delete: `app/scene/traffic/traffic-worker-types.ts`
- Delete: `app/scene/traffic/traffic-sab.ts`

### Step 1: Rewrite `traffic.worker.ts`

Convert to class. Drop all SAB handling (`sabViewsByChannel`, `handleInitSab`, `writeTrafficSabResultSoA`). WASM SoA arrays return directly via `Comlink.transfer()`.

Types to export from the worker file:

```typescript
export interface SceneAirport {
  lat: number;
  lon: number;
  elevation: number;
}

export interface TrafficProcessOptions {
  nowMs: number;
  historyMinutes: number;
  hideGroundTargets: boolean;
  showDepartedTrafficTrails: boolean;
  refLat: number;
  refLon: number;
  verticalScale: number;
  applyEarthCurvatureCompensation: boolean;
  sceneAirports: SceneAirport[];
}

export interface TrafficWorkerResult {
  trackCount: number;
  renderedTrackCount: number;
  historyPointCount: number;
  renderHash: number;
  markerPositions: Float32Array;
  headingDeg: Float32Array;
  flags: Uint8Array;
  trailOffsets: Uint32Array;
  trailCounts: Uint32Array;
  points: Float32Array;
  callsignLabels: (string | null)[];
  trackedHexes: string[];
  returnedHistoryHexes: string[];
  workerProcessingMs: number;
  fetchMs?: number;
}
```

The class:

```typescript
export class TrafficWorkerApi {
  private readonly ready = ensureWasm();
  private trafficState: WasmTrafficState | null = null;

  async reset(options: TrafficProcessOptions): Promise<TrafficWorkerResult> { ... }
  async ingestBinary(
    payloadBuffer: ArrayBuffer,
    historyPayloadBuffer: ArrayBuffer | undefined,
    options: TrafficProcessOptions
  ): Promise<TrafficWorkerResult> { ... }
  async ingestRuntime(
    primaryUrl: string,
    followupUrl: string | undefined,
    options: TrafficProcessOptions
  ): Promise<TrafficWorkerResult> { ... }
  async recompute(options: TrafficProcessOptions): Promise<TrafficWorkerResult> { ... }
  async pruneError(options: TrafficProcessOptions): Promise<TrafficWorkerResult> { ... }

  private async buildAndTransferResult(
    options: TrafficProcessOptions,
    trackedHexes: string[],
    returnedHistoryHexes: string[],
    fetchMs?: number
  ): Promise<TrafficWorkerResult> {
    // build_render_tracks → unpackWasmSoA → Comlink.transfer(result, [...buffers])
  }
}
Comlink.expose(new TrafficWorkerApi());
```

Key details:

- Each method calls `await this.ready` before WASM operations
- `reset()` frees and recreates `WasmTrafficState`
- `ingestBinary()` receives `payloadBuffer` as a transferred ArrayBuffer (Comlink handles this from the caller side)
- `ingestRuntime()` fetches in-worker (preserves current pattern from `fetchRuntimeBinaryData`)
- `buildAndTransferResult()` is a private helper that calls `build_render_tracks`, unpacks SoA, returns via `Comlink.transfer()` with all typed array buffers in the transfer list
- Keep `normalizeFetchUrl`, `fetchTrafficRuntimeRaw`, `fetchRuntimeBinaryData`, `packAirportData`, `unpackWasmSoA` as module-level helpers
- Keep `roundMs` helper

### Step 2: Rewrite `traffic-worker-client.ts`

Replace `BaseWorkerClient` extension with `ComlinkedWorkerClient`. Remove all SAB infrastructure (pool, overflow state, capacity hints, channel management). Move `TRAFFIC_FLAG_*` constants here.

```typescript
import * as Comlink from 'comlink';
import { ComlinkedWorkerClient } from '@/app/scene/shared/comlinked-worker-client';
import type {
  TrafficWorkerApi,
  TrafficProcessOptions,
  TrafficWorkerResult,
  SceneAirport
} from './traffic.worker';

export type { SceneAirport } from './traffic.worker';

export const TRAFFIC_FLAG_IS_CURRENTLY_PRESENT = 0x01;
export const TRAFFIC_FLAG_IS_ON_GROUND = 0x02;

const REQUEST_TIMEOUT_MS = 12000;
```

The `TrafficRenderBuffers` and `TrafficProcessResult` types stay (they're the client-side types consumed by `LiveTrafficOverlay.tsx`), as do `EMPTY_TRAFFIC_RENDER_BUFFERS` and `roundMs`.

The class becomes dramatically simpler — ~5 thin methods:

```typescript
export class TrafficWorkerClient extends ComlinkedWorkerClient<TrafficWorkerApi> {
  constructor() {
    super(new Worker(new URL('./traffic.worker.ts', import.meta.url), { type: 'module' }), {
      name: 'Traffic',
      defaultTimeoutMs: REQUEST_TIMEOUT_MS
    });
  }

  reset(options: TrafficProcessOptions): Promise<TrafficProcessResult> {
    return this.wrapResult(this.proxy.reset(options), 'reset');
  }

  ingestBinary(
    payloadBuffer: ArrayBuffer,
    historyPayloadBuffer: ArrayBuffer | undefined,
    options: TrafficProcessOptions
  ): Promise<TrafficProcessResult> {
    return this.wrapResult(
      this.proxy.ingestBinary(
        Comlink.transfer(payloadBuffer, [payloadBuffer]),
        historyPayloadBuffer
          ? Comlink.transfer(historyPayloadBuffer, [historyPayloadBuffer])
          : undefined,
        options
      ),
      'ingest-binary'
    );
  }

  ingestRuntime(
    primaryUrl: string,
    followupUrl: string | undefined,
    options: TrafficProcessOptions
  ): Promise<TrafficProcessResult> {
    return this.wrapResult(
      this.proxy.ingestRuntime(primaryUrl, followupUrl, options),
      'ingest-runtime'
    );
  }

  recompute(options: TrafficProcessOptions): Promise<TrafficProcessResult> {
    return this.wrapResult(this.proxy.recompute(options), 'recompute');
  }

  pruneError(options: TrafficProcessOptions): Promise<TrafficProcessResult> {
    return this.wrapResult(this.proxy.pruneError(options), 'prune-error');
  }

  /** Wrap the worker result into the client-side TrafficProcessResult shape. */
  private async wrapResult(
    promise: Promise<TrafficWorkerResult>,
    operation: TrafficProcessResult['operation']
  ): Promise<TrafficProcessResult> {
    const startedAt = performance.now();
    const result = await this.withTimeout(promise);
    const roundTripMs = roundMs(performance.now() - startedAt);
    return {
      renderBuffers: {
        renderedTrackCount: result.renderedTrackCount,
        markerPositions: result.markerPositions,
        headingDeg: result.headingDeg,
        flags: result.flags,
        trailOffsets: new Int32Array(result.trailOffsets.buffer),
        trailCounts: new Int32Array(result.trailCounts.buffer),
        points: result.points,
        callsignLabels: result.callsignLabels
      },
      trackCount: result.trackCount,
      historyPointCount: result.historyPointCount,
      renderHash: result.renderHash,
      operation,
      workerTransport: 'transfer',
      workerRoundTripMs: Number.isFinite(roundTripMs) ? roundTripMs : null,
      workerProcessingMs: result.workerProcessingMs,
      trackedHexes: result.trackedHexes,
      returnedHistoryHexes: result.returnedHistoryHexes,
      feedTransport: 'binary',
      fetchMs: result.fetchMs ?? null,
      parseMs: null
    };
  }
}
```

Note: `workerTransport` changes from `'sab'` to `'transfer'` — update the `TrafficProcessResult` type's union accordingly.

### Step 3: Update `LiveTrafficOverlay.tsx` imports

Change:

```typescript
import {
  TRAFFIC_FLAG_IS_CURRENTLY_PRESENT,
  TRAFFIC_FLAG_IS_ON_GROUND
} from './traffic/traffic-sab';
import type { SceneAirport } from './traffic/traffic-worker-types';
export type { SceneAirport } from './traffic/traffic-worker-types';
```

To:

```typescript
import {
  TRAFFIC_FLAG_IS_CURRENTLY_PRESENT,
  TRAFFIC_FLAG_IS_ON_GROUND
} from './traffic/traffic-worker-client';
export type { SceneAirport } from './traffic/traffic-worker-client';
```

### Step 4: Delete old files

```bash
git rm app/scene/traffic/traffic-worker-types.ts app/scene/traffic/traffic-sab.ts
```

### Step 5: Verify

```bash
npm run typecheck
npm run test
```

### Step 6: Commit

```bash
git add app/scene/traffic/ app/scene/LiveTrafficOverlay.tsx
git commit -m "feat(worker): migrate traffic worker to comlink, drop SAB transport"
```

---

## Task 5: Migrate nexrad/MRMS worker (SAB removal)

Similar pattern to traffic. Additional complexity: diagnostics, `activePollPromise` serialization, and `PhaseDebugHeaderValues` relocation.

### Files

- Rewrite: `app/scene/nexrad/nexrad.worker.ts`
- Rewrite: `app/scene/nexrad/nexrad-worker-client.ts`
- Modify: `app/scene/nexrad/nexrad-decode.ts` (move `PhaseDebugHeaderValues` here)
- Delete: `app/scene/nexrad/nexrad-worker-types.ts`
- Delete: `app/scene/nexrad/nexrad-sab.ts`

### Step 1: Move `PhaseDebugHeaderValues` to `nexrad-decode.ts`

Currently defined in `nexrad-worker-types.ts`, only imported by `nexrad-decode.ts`. Move the interface definition into `nexrad-decode.ts` and export it from there.

Change `nexrad-decode.ts` line 3 from:

```typescript
import type { PhaseDebugHeaderValues } from './nexrad-worker-types';
```

To defining it inline (move the interface from nexrad-worker-types.ts).

### Step 2: Rewrite `nexrad.worker.ts`

Convert to class. Drop SAB handling (`prepareSabViewsByChannel`, `handleInitSab`, `writeNexradPrepareSabResult`), SharedWorker `onconnect` handler, `scope.onmessage` dispatch.

Types to export from the worker file:

```typescript
export interface NexradPollAndPrepareOptions {
  volumeUrl?: string;
  echoTopUrl?: string;
  includeVolume: boolean;
  includeEchoTop: boolean;
  minDbz: number;
  phaseMode: NexradPhaseMode;
  declutterMode: NexradDeclutterMode;
  applyEarthCurvatureCompensation: boolean;
  refLat: number;
  includeCrossSection: boolean;
  normalizedCrossSectionRange: number;
  crossSectionHalfWidthNm: number;
  sliceAxis: { x: number; z: number };
  slicePerpAxis: { x: number; z: number };
}

export interface NexradVolumePrepareOptions {
  minDbz: number;
  phaseMode: NexradPhaseMode;
  declutterMode: NexradDeclutterMode;
  applyEarthCurvatureCompensation: boolean;
  refLat: number;
  includeCrossSection: boolean;
  normalizedCrossSectionRange: number;
  crossSectionHalfWidthNm: number;
  sliceAxis: { x: number; z: number };
  slicePerpAxis: { x: number; z: number };
}

export interface PollAndPrepareTimings { ... }       // move from nexrad-worker-types.ts
export interface PollAndPrepareEchoTopSummary { ... } // move from nexrad-worker-types.ts
```

The class:

```typescript
export class NexradWorkerApi {
  private readonly ready = ensureWasm();
  private cachedVolumeBuffer: ArrayBuffer | null = null;
  private cachedVolumeHeaders: Headers | null = null;

  async pollAndPrepare(options: NexradPollAndPrepareOptions): Promise<NexradPollAndPrepareResult> {
    // fetch volume + echo-tops, decode via WASM, return via Comlink.transfer()
    // Transfer list: volume payload buffers + echo-top SoA buffers + prepared volume buffers
  }

  async rePrepare(options: NexradVolumePrepareOptions): Promise<NexradRePrepareResult> {
    // re-decode cached volume with new params, return via Comlink.transfer()
  }
}
Comlink.expose(new NexradWorkerApi());
```

Key details:

- `cachedVolumeBuffer` and `cachedVolumeHeaders` become instance fields (were module-level)
- Each method returns prepared volume data (validIndices, yBase, heightBase, etc.) directly in the result, NOT via SAB
- `pollAndPrepare` returns `volumePayload`, `preparedVolume`, `crossSectionData`, `echoTop18/30/50`, `echoTopSummary`, `timings` — all in one object
- Transfer list includes ALL typed array buffers from: volumePayload (xNm, zNm, dbz, spanX, spanY, phaseCode), preparedVolume (validIndices, yBase, heightBase, correctedBottomFeet, correctedTopFeet, effectivePhaseCode, declutterIndices), and echoTop SoA arrays (x, z, yBase per threshold)
- Keep `normalizeFetchUrl`, `fetchArrayBuffer`, `extractEchoTopSoA`, `echoTopSoATransferables`, `volumeTransferables`, `encodePhaseMode`, `encodeDeclutterMode`, `roundMs`, `emptyPreparedVolume` helpers
- Remove `errorResponseForRequest` (Comlink catches and propagates errors automatically)

### Step 3: Rewrite `nexrad-worker-client.ts`

Replace `BaseWorkerClient` with `ComlinkedWorkerClient`. Remove all SAB infrastructure. Preserve diagnostics, singleton management, `activePollPromise`, runtime mode tracking.

The client class becomes thin:

```typescript
class NexradDecodeWorkerClient extends ComlinkedWorkerClient<NexradWorkerApi> {
  constructor() {
    super(new Worker(new URL('./nexrad.worker.ts', import.meta.url), { type: 'module' }), {
      name: 'MRMS',
      defaultTimeoutMs: REQUEST_TIMEOUT_MS
    });
  }

  async pollAndPrepare(options: NexradPollAndPrepareOptions): Promise<NexradPollAndPrepareResult> {
    return this.withTimeout(this.proxy.pollAndPrepare(options));
  }

  async rePrepare(options: NexradVolumePrepareOptions): Promise<NexradRePrepareResult> {
    return this.withTimeout(this.proxy.rePrepare(options));
  }
}
```

Preserve all module-level exports: `getNexradWorkerRuntimeMode`, `getNexradWorkerDiagnostics`, `getNexradWorkerTransportDiagnostics`, `pollNexradWithWorker`, `rePrepareNexradWithWorker`.

Simplify transport diagnostics: `decodeTransport` and `prepareTransport` change from `'sab' | 'worker-error'` to `'transfer' | 'worker-error'`. Record `'transfer'` on success instead of `'sab'`.

Remove `createDedicatedWorkerChannel()` helper — `ComlinkedWorkerClient` takes a `Worker` directly, no `WorkerLike` abstraction needed.

### Step 4: Delete old files

```bash
git rm app/scene/nexrad/nexrad-worker-types.ts app/scene/nexrad/nexrad-sab.ts
```

### Step 5: Verify

```bash
npm run typecheck
npm run test
```

### Step 6: Commit

```bash
git add app/scene/nexrad/
git commit -m "feat(worker): migrate nexrad worker to comlink, drop SAB transport"
```

---

## Task 6: Migrate chart tiles worker (streaming callback)

Replaces the streaming `addEventListener('message')` pattern with `Comlink.proxy()` callback.

### Files

- Rewrite: `app/scene/chart/chart-tiles.worker.ts`
- Modify: `app/scene/ChartMapSurface.tsx`

### Step 1: Rewrite `chart-tiles.worker.ts`

Convert to class with `streamTiles()` method that takes a callback.

```typescript
import * as Comlink from 'comlink';

const TILE_FETCH_CONCURRENCY = 60;

export interface ChartTilesParams {
  baseUrl: string;
  zoom: number;
  minTileX: number;
  maxTileX: number;
  minTileY: number;
  maxTileY: number;
}

export interface ChartTileReady {
  tileX: number;
  tileY: number;
  bitmap: ImageBitmap;
}

export interface ChartStreamSummary {
  totalTiles: number;
  failedTiles: number;
}

async function fetchTile(
  baseUrl: string,
  z: number,
  x: number,
  y: number
): Promise<ImageBitmap | null> {
  const url = `${baseUrl}/${z}/${y}/${x}`;
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const blob = await response.blob();
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

export class ChartTilesWorkerApi {
  async streamTiles(
    params: ChartTilesParams,
    onTile: (tile: ChartTileReady) => void
  ): Promise<ChartStreamSummary> {
    const specs: Array<{ x: number; y: number }> = [];
    for (let tileY = params.minTileY; tileY <= params.maxTileY; tileY += 1) {
      for (let tileX = params.minTileX; tileX <= params.maxTileX; tileX += 1) {
        specs.push({ x: tileX, y: tileY });
      }
    }

    // Radial sort from center
    const cx = (params.minTileX + params.maxTileX) / 2;
    const cy = (params.minTileY + params.maxTileY) / 2;
    specs.sort((a, b) => {
      const da = (a.x - cx) ** 2 + (a.y - cy) ** 2;
      const db = (b.x - cx) ** 2 + (b.y - cy) ** 2;
      return da - db;
    });

    let failedTiles = 0;
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < specs.length) {
        const i = nextIndex;
        nextIndex += 1;
        const s = specs[i];
        const bitmap = await fetchTile(params.baseUrl, params.zoom, s.x, s.y);
        if (bitmap) {
          onTile(Comlink.transfer({ tileX: s.x, tileY: s.y, bitmap }, [bitmap]));
        } else {
          failedTiles += 1;
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(TILE_FETCH_CONCURRENCY, specs.length) }, () => worker())
    );

    return { totalTiles: specs.length, failedTiles };
  }
}

Comlink.expose(new ChartTilesWorkerApi());
```

### Step 2: Update `ChartMapSurface.tsx`

This is the most involved consumer change. The component currently creates ad-hoc workers with `addEventListener('message')` and demultiplexes by `requestId`.

Replace with `Comlink.wrap()` + `Comlink.proxy()`. Key changes:

**For flat map mode** (the `useEffect` that creates detail/preview streams):

- Replace `new Worker(...)` + `addEventListener` with `Comlink.wrap<ChartTilesWorkerApi>(new Worker(...))`
- Replace `worker.postMessage({ type: 'stream', requestId, ... })` with `api.streamTiles(params, Comlink.proxy(onTile))`
- The `stream-complete` handling moves to the `.then()` of the `streamTiles` promise
- Remove `requestId` generation and matching
- Keep RAF batching, tile storage, preview/detail two-pass logic
- Worker termination for cleanup stays the same (`worker.terminate()`)

**For 3dmap overlay** (`buildChartTexture`):

- Same pattern: wrap worker, call `streamTiles` with proxy callback
- The callback collects pending bitmaps, the `.then()` draws them all to canvas
- Or: draw incrementally in the callback (as tiles arrive)

**Key pattern for each stream:**

```typescript
const worker = new Worker(new URL('./chart/chart-tiles.worker.ts', import.meta.url), {
  type: 'module'
});
const api = Comlink.wrap<ChartTilesWorkerApi>(worker);

const streamPromise = api.streamTiles(
  { baseUrl, zoom, minTileX, maxTileX, minTileY, maxTileY },
  Comlink.proxy((tile: ChartTileReady) => {
    // handle each tile (same logic as current tile-ready handler)
  })
);

streamPromise.then((summary) => {
  // handle stream-complete (same logic as current stream-complete handler)
  worker.terminate();
});

// cleanup:
return () => {
  worker.terminate();
};
```

Note: The old `ChartTilesRequest`, `ChartTileReadyResponse`, `ChartStreamCompleteResponse` types were defined inline in the worker file. The new `ChartTilesParams`, `ChartTileReady`, `ChartStreamSummary` are exported from the new worker file. Update imports in `ChartMapSurface.tsx`.

### Step 3: Verify

```bash
npm run typecheck
```

### Step 4: Commit

```bash
git add app/scene/chart/chart-tiles.worker.ts app/scene/ChartMapSurface.tsx
git commit -m "feat(worker): migrate chart tiles worker to comlink streaming callback"
```

---

## Task 7: Delete old infrastructure + final verification

### Files

- Delete: `app/scene/shared/base-worker-client.ts`
- Delete: `app/scene/shared/sab-channel-pool.ts`
- Delete: `app/scene/shared/growable-sab.ts`

### Step 1: Verify no remaining imports

```bash
grep -r "base-worker-client\|sab-channel-pool\|growable-sab" app/ --include="*.ts" --include="*.tsx"
```

This should return zero results (only the files being deleted, which we've already migrated away from).

### Step 2: Delete files

```bash
git rm app/scene/shared/base-worker-client.ts app/scene/shared/sab-channel-pool.ts app/scene/shared/growable-sab.ts
```

### Step 3: Full verification

```bash
npm run typecheck
npm run test
npm run lint
npm run format:check
```

All must pass.

### Step 4: Commit

```bash
git add -A
git commit -m "chore(worker): delete old BaseWorkerClient and SAB infrastructure"
```

---

## Task 8: Update AGENTS.md and docs

### Files

- Modify: `AGENTS.md`

### Step 1: Update current behavior section

Update the "Current Behavior" section in AGENTS.md:

- Change "Worker-first execution: approach geometry, MRMS decode/prepare, traffic ingest/merge/recompute, and selector filtering run in workers; no synchronous compute fallback" to note they use Comlink
- Remove any SAB-specific references
- Note that cross-origin isolation headers are no longer required for worker communication (though may still be useful for other features)

### Step 2: Commit

```bash
git add AGENTS.md
git commit -m "docs: update AGENTS.md for comlink worker migration"
```

---

## Summary of deleted code (~2000 lines)

| File                       | Lines | What it did                                                 |
| -------------------------- | ----- | ----------------------------------------------------------- |
| `base-worker-client.ts`    | 287   | BaseWorkerClient, WorkerClientError, handleSabOverflowRetry |
| `sab-channel-pool.ts`      | 236   | SharedSabChannelPool, claimBestFitSabChannelForRequest      |
| `growable-sab.ts`          | 58    | createSharedArrayBuffer, tryGrowSharedArrayBuffer           |
| `traffic-sab.ts`           | ~200  | Traffic SAB buffer schema, read/write                       |
| `nexrad-sab.ts`            | ~200  | MRMS SAB buffer schema, read/write                          |
| `approach-worker-types.ts` | 55    | Approach request/response message unions                    |
| `traffic-worker-types.ts`  | 96    | Traffic request/response message unions                     |
| `nexrad-worker-types.ts`   | 128   | MRMS request/response message unions                        |

## New code (~150 lines)

| File                         | Lines | What it does                                     |
| ---------------------------- | ----- | ------------------------------------------------ |
| `worker-errors.ts`           | ~20   | WorkerClientError + WorkerErrorCode              |
| `comlinked-worker-client.ts` | ~120  | Generic Comlink wrapper with timeout + lifecycle |
