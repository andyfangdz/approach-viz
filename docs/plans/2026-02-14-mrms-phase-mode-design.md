# MRMS Phase Detection Mode Design

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a user-selectable phase detection mode for MRMS weather, with both thermo-derived and surface precip type phases pre-computed at ingest time and carried in the wire format, so the client can switch instantly.

**Architecture:** Both phase values are computed at ingest time and stored per-voxel. The wire format bumps to v3 (same 20-byte record size) with the surface phase in the formerly-reserved byte at offset 11. The client decodes both, and a UI toggle + URL state controls which is used for coloring. No server round-trips needed to switch modes.

**Tech Stack:** Rust (ingest + wire format), TypeScript/React (decode, render, UI state)

---

## Problem

The current thermodynamic phase detection algorithm resolves precip type per-voxel per-altitude using freezing level, wet-bulb temperature, surface temperature, bright band, PrecipFlag, and dual-pol radar data. While physically accurate, this produces surprising results in thunderstorms: CB clouds extending to 40,000+ feet are classified as ice/snow for significant portions of their vertical extent, which doesn't match the "single precip type" presentation used by official NWS radar products.

## Solution

Two phase detection modes, both pre-computed at ingest time:

- **Thermodynamic** (default, `thermo`): The current per-voxel per-altitude algorithm -- unchanged.
- **Surface Precip Type** (`surface`): Uses the MRMS `PrecipFlag_00.00` surface product to assign a single phase to the entire vertical column at each grid cell. When PrecipFlag is missing/unavailable (codes -3, 0, or absent), falls back to rain (phase 0).

Both phases are embedded in each wire record. The client picks which to use for coloring based on a UI toggle. Switching is instant -- no re-fetch needed.

## Wire Format: v2 -> v3

Same 20-byte record. Same header. Only difference:

| Offset | v2               | v3                            |
| ------ | ---------------- | ----------------------------- |
| 10     | `phase` (thermo) | `phase` (thermo) -- unchanged |
| 11     | `level_start`    | `level_start` -- unchanged    |
| 18     | reserved (0)     | `surface_phase` (u8: 0/1/2)   |
| 19     | reserved (0)     | reserved (0)                  |

Version field at header offset 4-5 becomes `3`. Client decoder accepts both v2 and v3 -- v2 payloads have no surface_phase (treat as 0/rain).

Constants: `WIRE_V3_VERSION = 3`, reuse all other v2 constants (record bytes, quant step, max spans).

---

## Task 1: Rust -- store surface phase in StoredVoxel and compute at ingest

**Files:**

- Modify: `services/runtime-rs/src/types.rs:31-36` (StoredVoxel)
- Modify: `services/runtime-rs/src/ingest.rs` (voxel construction loop, ~line 630-650)

**Step 1: Add `surface_phase` field to `StoredVoxel`**

In `types.rs`, add `surface_phase: u8` after `phase`:

```rust
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct StoredVoxel {
    pub row: u16,
    pub col: u16,
    pub level_idx: u8,
    pub phase: u8,
    pub surface_phase: u8,
    pub dbz_tenths: i16,
}
```

**Step 2: Compute surface_phase during ingest**

In `ingest.rs`, in the per-voxel loop where `StoredVoxel` is constructed, compute `surface_phase` from PrecipFlag. The `precip_field` variable is already in scope. Use `sample_aux_field` + `phase_from_precip_flag` (both already exist), falling back to `PHASE_RAIN`:

```rust
let surface_phase = precip_field
    .and_then(|field| sample_aux_field(field, lat_deg, lon_deg360))
    .and_then(phase_from_precip_flag)
    .unwrap_or(PHASE_RAIN);
```

Add `surface_phase` to the `StoredVoxel` construction.

**Step 3: Run `cargo check`**

Run: `cargo check --manifest-path services/runtime-rs/Cargo.toml`
Expected: compiles cleanly

**Step 4: Commit**

```
git add services/runtime-rs/src/types.rs services/runtime-rs/src/ingest.rs
git commit -m "feat(runtime): compute and store surface_phase per voxel at ingest"
```

---

## Task 2: Rust -- bump wire format to v3, emit surface_phase

**Files:**

- Modify: `services/runtime-rs/src/constants.rs:78` (add WIRE_V3_VERSION)
- Modify: `services/runtime-rs/src/api.rs:~245-280` (VolumeQuery, build_volume_wire, build_volume_wire_v2)

**Step 1: Add v3 constant**

In `constants.rs`, add after `WIRE_V2_VERSION`:

```rust
pub const WIRE_V3_VERSION: u16 = 3;
```

**Step 2: Update `build_volume_wire` to use v3**

In `api.rs`, update `build_volume_wire_v2` (rename optional -- can keep name):

- Change the version written in `build_wire_header` call from `WIRE_V2_VERSION` to `WIRE_V3_VERSION`
- In the brick serialization loop (around line 860), where `body.extend_from_slice(&0_u16.to_le_bytes())` writes the reserved 2 bytes at offsets 18-19: instead write `surface_phase` at offset 18 and `0u8` at offset 19.

The brick's surface_phase comes from its `MergeKey`. Update `MergeKey` to NOT include surface_phase (bricks should still merge by thermo phase + dbz only). Instead, carry `surface_phase` separately on the brick. The simplest approach: since all voxels in a brick share the same (row-range, col-range, thermo-phase, dbz), pick the surface_phase from any constituent voxel (they may differ across the brick's grid cells). Use the most common value or just the first one.

Actually, the cleanest approach: add `surface_phase: u8` to `BrickCandidate`. When building `MergeCell`, carry `surface_phase`. When merging cells into bricks, use the surface_phase from the first cell. When extending bricks vertically, keep existing surface_phase (it's column-uniform by definition -- surface precip type doesn't vary with altitude, only with grid cell).

```rust
// In MergeCell:
struct MergeCell {
    row: u32,
    col: u32,
    key: MergeKey,
    surface_phase: u8,
}

// In BrickCandidate:
struct BrickCandidate {
    // ... existing fields ...
    surface_phase: u8,
}
```

In the brick record serialization, replace:

```rust
body.extend_from_slice(&0_u16.to_le_bytes()); // reserved
```

with:

```rust
body.push(brick.surface_phase);  // offset 18: surface_phase
body.push(0);                     // offset 19: reserved
```

**Step 3: Update imports**

Add `WIRE_V3_VERSION` to the import in `api.rs`.

**Step 4: Run `cargo check`**

Run: `cargo check --manifest-path services/runtime-rs/Cargo.toml`
Expected: compiles cleanly

**Step 5: Commit**

```
git add services/runtime-rs/src/constants.rs services/runtime-rs/src/api.rs
git commit -m "feat(runtime): bump wire format to v3, emit surface_phase at offset 18"
```

---

## Task 3: Client -- decode v3 wire format with surface_phase

**Files:**

- Modify: `app/scene/nexrad/nexrad-types.ts` (version const, tuple type, RenderVoxel)
- Modify: `app/scene/nexrad/nexrad-decode.ts` (decoder)

**Step 1: Add v3 constants and update types**

In `nexrad-types.ts`:

- Add `MRMS_BINARY_V3_VERSION = 3` constant
- Add `surfacePhaseCode` to `NexradVoxelTuple` at index 8 (after phaseCode at index 7)
- Add `surfacePhaseCode: number` to `RenderVoxel`

```typescript
export type NexradVoxelTuple = [
  xNm: number,
  zNm: number,
  bottomFeet: number,
  topFeet: number,
  dbz: number,
  footprintXNm: number,
  footprintYNm?: number,
  phaseCode?: number,
  surfacePhaseCode?: number
];
```

**Step 2: Update decoder to accept v2 and v3**

In `nexrad-decode.ts`:

- Change version check from `version !== MRMS_BINARY_V2_VERSION` to `version !== MRMS_BINARY_V2_VERSION && version !== MRMS_BINARY_V3_VERSION`
- When `version >= 3`, read `surfacePhaseCode` from offset 18 in the record loop
- When v2, default `surfacePhaseCode` to `phaseCode` (same as thermo -- backward compat means no visual change)

```typescript
const surfacePhaseCode = version >= MRMS_BINARY_V3_VERSION ? view.getUint8(offset + 18) : phaseCode;
```

Push `surfacePhaseCode` as the 9th element of the tuple.

**Step 3: Update RenderVoxel construction in NexradVolumeOverlay.tsx**

In `NexradVolumeOverlay.tsx`, destructure `surfacePhaseCode` from the tuple (index 8) and add to RenderVoxel:

```typescript
const [
  offsetXNm,
  offsetZNm,
  bottomFeet,
  topFeet,
  dbz,
  footprintXNm,
  footprintYNm,
  phaseCode,
  surfacePhaseCode
] = voxel;
```

And in the push:

```typescript
surfacePhaseCode: typeof surfacePhaseCode === 'number' && Number.isFinite(surfacePhaseCode)
  ? Math.round(surfacePhaseCode)
  : PHASE_RAIN;
```

**Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: passes

**Step 5: Commit**

```
git add app/scene/nexrad/nexrad-types.ts app/scene/nexrad/nexrad-decode.ts app/scene/NexradVolumeOverlay.tsx
git commit -m "feat(client): decode v3 wire format with surface_phase"
```

---

## Task 4: Client types, constants, and URL state helpers

**Files:**

- Modify: `app/app-client/types.ts` (NexradPhaseMode type)
- Modify: `app/app-client/constants.ts` (defaults)
- Modify: `app/app-client-utils.ts` (URL parse helpers)

**Step 1: Add NexradPhaseMode type**

In `types.ts`:

```typescript
export type NexradPhaseMode = 'thermo' | 'surface';
```

**Step 2: Add constants**

In `constants.ts`:

```typescript
export const DEFAULT_NEXRAD_PHASE_MODE = 'thermo';
```

**Step 3: Add URL parse helpers**

In `app-client-utils.ts`, add two functions:

```typescript
export function readPhaseModeFromSearch(search: string): 'thermo' | 'surface' | null {
  const params = new URLSearchParams(search);
  const value = params.get('phaseMode');
  if (value === 'thermo' || value === 'surface') return value;
  return null;
}

export function readDeclutterModeFromSearch(search: string): 'all' | 'low' | 'mid' | 'high' | null {
  const params = new URLSearchParams(search);
  const value = params.get('declutter');
  if (value === 'all' || value === 'low' || value === 'mid' || value === 'high') return value;
  return null;
}
```

**Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: passes

**Step 5: Commit**

```
git add app/app-client/types.ts app/app-client/constants.ts app/app-client-utils.ts
git commit -m "feat: add NexradPhaseMode type, constants, and URL parse helpers"
```

---

## Task 5: Wire phaseMode state through AppClient

**Files:**

- Modify: `app/AppClient.tsx` (state, localStorage, URL read/write, prop threading)
- Modify: `app/app-client/types.ts` (SceneCanvasProps, OptionsPanelProps)

**Step 1: Add phaseMode to PersistedOptionsState**

```typescript
nexradPhaseMode?: NexradPhaseMode;
```

**Step 2: Add state and normalizer**

```typescript
const NEXRAD_PHASE_MODES: NexradPhaseMode[] = ['thermo', 'surface'];

function normalizeNexradPhaseMode(mode: unknown): NexradPhaseMode {
  return NEXRAD_PHASE_MODES.includes(mode as NexradPhaseMode)
    ? (mode as NexradPhaseMode)
    : DEFAULT_NEXRAD_PHASE_MODE;
}
```

State:

```typescript
const [nexradPhaseMode, setNexradPhaseMode] = useState<NexradPhaseMode>(DEFAULT_NEXRAD_PHASE_MODE);
```

**Step 3: Add localStorage read/write**

In the init effect, after `nexradDeclutterMode` restore:

```typescript
if (persisted.nexradPhaseMode) {
  setNexradPhaseMode(normalizeNexradPhaseMode(persisted.nexradPhaseMode));
}
```

In the persist effect, add `nexradPhaseMode` to the persisted object and dep array.

**Step 4: Add URL read (init effect)**

After the `?layers=` read block, also read `?phaseMode` and `?declutter`:

```typescript
const phaseModeFromUrl = readPhaseModeFromSearch(window.location.search);
if (phaseModeFromUrl) {
  setNexradPhaseMode(normalizeNexradPhaseMode(phaseModeFromUrl));
}
const declutterFromUrl = readDeclutterModeFromSearch(window.location.search);
if (declutterFromUrl) {
  setNexradDeclutterMode(normalizeNexradDeclutterMode(declutterFromUrl));
}
```

**Step 5: Add URL write (replaceState effect)**

In the URL sync effect, after the `layers` serialization:

```typescript
if (nexradPhaseMode !== DEFAULT_NEXRAD_PHASE_MODE) {
  params.set('phaseMode', nexradPhaseMode);
} else {
  params.delete('phaseMode');
}
if (nexradDeclutterMode !== DEFAULT_NEXRAD_DECLUTTER_MODE) {
  params.set('declutter', nexradDeclutterMode);
} else {
  params.delete('declutter');
}
```

Add `nexradPhaseMode` and `nexradDeclutterMode` to the effect's dependency array.

**Step 6: Update prop interfaces**

In `types.ts`, add to `SceneCanvasProps`:

```typescript
nexradPhaseMode: NexradPhaseMode;
```

Add to `OptionsPanelProps`:

```typescript
nexradPhaseMode: NexradPhaseMode;
onNexradPhaseModeChange: (mode: NexradPhaseMode) => void;
```

**Step 7: Thread props**

Pass `nexradPhaseMode` to `<SceneCanvas>` and `<OptionsPanel>` in the JSX.
Pass `onNexradPhaseModeChange={setNexradPhaseMode}` to `<OptionsPanel>`.

**Step 8: Import new symbols**

Add imports for `readPhaseModeFromSearch`, `readDeclutterModeFromSearch`, `DEFAULT_NEXRAD_PHASE_MODE`, `NexradPhaseMode`.

**Step 9: Run typecheck**

Run: `npm run typecheck`
Expected: will fail until Tasks 6 and 7 are done (OptionsPanel and SceneCanvas don't accept the new props yet). Proceed to next tasks.

**Step 10: Commit**

```
git add app/AppClient.tsx app/app-client/types.ts
git commit -m "feat: wire phaseMode state, localStorage, and URL encoding through AppClient"
```

---

## Task 6: OptionsPanel -- add phase mode dropdown

**Files:**

- Modify: `app/app-client/OptionsPanel.tsx`

**Step 1: Add phase mode labels and imports**

```typescript
import type { NexradDeclutterMode, NexradPhaseMode } from './types';

const PHASE_MODE_LABELS: Record<NexradPhaseMode, string> = {
  thermo: 'Thermodynamic',
  surface: 'Surface Precip Type'
};
```

**Step 2: Destructure new props**

Add `nexradPhaseMode` and `onNexradPhaseModeChange` to the destructured props.

**Step 3: Add dropdown in MRMS Weather section**

Insert before the existing declutter dropdown:

```tsx
<label className="options-toggle-row">
  <span className="options-toggle-copy">
    <span className="options-toggle-title">MRMS Phase Detection</span>
  </span>
  <select
    className="options-inline-select"
    value={nexradPhaseMode}
    disabled={!layers.mrms}
    onChange={(event) => onNexradPhaseModeChange(event.target.value as NexradPhaseMode)}
    aria-label="MRMS phase detection mode"
  >
    {(Object.keys(PHASE_MODE_LABELS) as NexradPhaseMode[]).map((mode) => (
      <option key={mode} value={mode}>
        {PHASE_MODE_LABELS[mode]}
      </option>
    ))}
  </select>
</label>
```

**Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: may still fail if SceneCanvas not updated yet

**Step 5: Commit**

```
git add app/app-client/OptionsPanel.tsx
git commit -m "feat: add MRMS phase detection mode dropdown to OptionsPanel"
```

---

## Task 7: SceneCanvas + NexradVolumeOverlay -- use phaseMode for coloring

**Files:**

- Modify: `app/app-client/SceneCanvas.tsx` (pass phaseMode through)
- Modify: `app/scene/nexrad/nexrad-types.ts` (NexradVolumeOverlayProps)
- Modify: `app/scene/NexradVolumeOverlay.tsx` (select phase for RenderVoxel)
- Modify: `app/scene/nexrad/NexradCrossSection.tsx` (if it uses phaseCode directly)

**Step 1: Add phaseMode to NexradVolumeOverlayProps**

In `nexrad-types.ts`:

```typescript
import type { NexradDeclutterMode, NexradPhaseMode } from '@/app/app-client/types';

// In NexradVolumeOverlayProps:
phaseMode?: NexradPhaseMode;
```

**Step 2: Thread through SceneCanvas**

In `SceneCanvas.tsx`, destructure `nexradPhaseMode` from props and pass to `<NexradVolumeOverlay>`:

```tsx
phaseMode = { nexradPhaseMode };
```

**Step 3: Apply phaseMode in NexradVolumeOverlay**

In the `rawRenderVoxels` memo, select the effective phase based on mode:

```typescript
const effectivePhaseCode =
  phaseMode === 'surface'
    ? typeof surfacePhaseCode === 'number' && Number.isFinite(surfacePhaseCode)
      ? Math.round(surfacePhaseCode)
      : PHASE_RAIN
    : typeof phaseCode === 'number' && Number.isFinite(phaseCode)
      ? Math.round(phaseCode)
      : PHASE_RAIN;
```

Use `effectivePhaseCode` for the `phaseCode` field in the RenderVoxel push. Add `phaseMode` to the memo's dependency array.

**Step 4: Run full checks**

Run: `npm run format:check && npm run typecheck && npm run lint && npm run test`
Expected: all pass

**Step 5: Commit**

```
git add app/app-client/SceneCanvas.tsx app/scene/nexrad/nexrad-types.ts app/scene/NexradVolumeOverlay.tsx
git commit -m "feat: apply phaseMode selection in volume overlay and cross section rendering"
```

---

## Task 8: Update docs and AGENTS.md

**Files:**

- Modify: `AGENTS.md` (mention phase mode in UI/URL section)
- Modify: `docs/ui-url-state-and-mobile.md` (add phaseMode and declutter URL params)
- Modify: `docs/rendering-weather-volume.md` (mention dual phase modes)
- Modify: `docs/mrms-phase-methodology.md` (add surface precip type mode section)

**Step 1: Update each doc**

Add brief mentions of the new phase mode option, URL params `?phaseMode=` and `?declutter=`, and the v3 wire format.

**Step 2: Run format check**

Run: `npm run format:check`
Fix if needed with `npm run format`.

**Step 3: Commit**

```
git add AGENTS.md docs/
git commit -m "docs: document phase detection mode, URL state, and v3 wire format"
```

---

## Summary of changes by file

| File                                   | Change                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| `services/runtime-rs/src/types.rs`     | Add `surface_phase: u8` to `StoredVoxel`                                                |
| `services/runtime-rs/src/ingest.rs`    | Compute `surface_phase` from PrecipFlag at ingest                                       |
| `services/runtime-rs/src/constants.rs` | Add `WIRE_V3_VERSION = 3`                                                               |
| `services/runtime-rs/src/api.rs`       | Emit v3 header, write `surface_phase` at record offset 18, carry through merge pipeline |
| `app/scene/nexrad/nexrad-types.ts`     | v3 const, `surfacePhaseCode` in tuple + RenderVoxel + props                             |
| `app/scene/nexrad/nexrad-decode.ts`    | Accept v2+v3, read surface_phase at offset 18                                           |
| `app/scene/NexradVolumeOverlay.tsx`    | Destructure surfacePhaseCode, select by phaseMode                                       |
| `app/app-client/types.ts`              | `NexradPhaseMode` type, prop additions                                                  |
| `app/app-client/constants.ts`          | `DEFAULT_NEXRAD_PHASE_MODE`                                                             |
| `app/app-client-utils.ts`              | `readPhaseModeFromSearch`, `readDeclutterModeFromSearch`                                |
| `app/AppClient.tsx`                    | State, localStorage, URL read/write, prop threading                                     |
| `app/app-client/OptionsPanel.tsx`      | Phase mode dropdown                                                                     |
| `app/app-client/SceneCanvas.tsx`       | Pass phaseMode to overlay                                                               |
| `AGENTS.md` + `docs/*.md`              | Documentation updates                                                                   |

## Not in scope

- No Next.js proxy changes (phase mode is now client-side only)
- No echo top changes (don't use phase)
- No new MRMS products to ingest (PrecipFlag already ingested)
