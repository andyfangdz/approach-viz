# Layers Panel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extract visibility toggles from the settings panel into a dedicated layers panel with URL-encoded delta-from-defaults layer state.

**Architecture:** Add a `LayerState` type and layer URL parsing/serialization utilities in `app/app-client-utils.ts`. Replace 5 individual boolean `useState` calls in `AppClient.tsx` with a single `LayerState` object plus 2 new booleans (`approachVisible`, `airspaceVisible`). Create a new `LayersPanel.tsx` component with toggle switches. Reorganize `OptionsPanel.tsx` into layer-relevant sections. Update CSS for the new FAB button and panel. Wire layer booleans through to `SceneCanvas` and its children.

**Tech Stack:** React, TypeScript, Next.js App Router, CSS

**Design doc:** `docs/plans/2026-02-14-layers-panel-design.md`

---

### Task 1: Add layer types, defaults, and URL parse/serialize utilities

**Files:**

- Modify: `app/app-client/types.ts`
- Modify: `app/app-client/constants.ts`
- Modify: `app/app-client-utils.ts`
- Create: `app/app-client/__tests__/layers-url.test.ts`

**Step 1: Write failing tests for layer URL parsing and serialization**

Create `app/app-client/__tests__/layers-url.test.ts`:

```typescript
import {
  parseLayersParam,
  serializeLayersParam,
  DEFAULT_LAYER_STATE
} from '@/app/app-client-utils';
import type { LayerState } from '@/app/app-client/types';

describe('parseLayersParam', () => {
  it('returns defaults when param is null', () => {
    expect(parseLayersParam(null)).toEqual(DEFAULT_LAYER_STATE);
  });

  it('returns defaults when param is empty string', () => {
    expect(parseLayersParam('')).toEqual(DEFAULT_LAYER_STATE);
  });

  it('turns off a default-on layer with -', () => {
    const result = parseLayersParam('-mrms');
    expect(result.mrms).toBe(false);
    // others unchanged
    expect(result.approach).toBe(true);
    expect(result.airspace).toBe(true);
  });

  it('turns on a default-off layer with +', () => {
    const result = parseLayersParam('+echotops');
    expect(result.echotops).toBe(true);
  });

  it('handles multiple deltas', () => {
    const result = parseLayersParam('-airspace,+slice,+echotops');
    expect(result.airspace).toBe(false);
    expect(result.slice).toBe(true);
    expect(result.echotops).toBe(true);
    expect(result.approach).toBe(true); // unchanged
  });

  it('ignores invalid layer IDs', () => {
    const result = parseLayersParam('+bogus,-fake');
    expect(result).toEqual(DEFAULT_LAYER_STATE);
  });

  it('handles redundant entries as no-ops', () => {
    const result = parseLayersParam('+approach,-slice');
    expect(result).toEqual(DEFAULT_LAYER_STATE);
  });

  it('trims whitespace', () => {
    const result = parseLayersParam(' -mrms , +slice ');
    expect(result.mrms).toBe(false);
    expect(result.slice).toBe(true);
  });
});

describe('serializeLayersParam', () => {
  it('returns null when state matches defaults', () => {
    expect(serializeLayersParam(DEFAULT_LAYER_STATE)).toBeNull();
  });

  it('serializes turned-off default-on layers with -', () => {
    const state: LayerState = { ...DEFAULT_LAYER_STATE, mrms: false };
    expect(serializeLayersParam(state)).toBe('-mrms');
  });

  it('serializes turned-on default-off layers with +', () => {
    const state: LayerState = { ...DEFAULT_LAYER_STATE, echotops: true };
    expect(serializeLayersParam(state)).toBe('+echotops');
  });

  it('serializes multiple deltas sorted by layer ID', () => {
    const state: LayerState = { ...DEFAULT_LAYER_STATE, airspace: false, slice: true };
    expect(serializeLayersParam(state)).toBe('-airspace,+slice');
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npm test -- --testPathPattern layers-url`
Expected: FAIL — modules don't exist yet.

**Step 3: Add `LayerState` type and `LAYER_IDS`**

In `app/app-client/types.ts`, add at the end:

```typescript
export type LayerId = 'approach' | 'airspace' | 'adsb' | 'mrms' | 'echotops' | 'slice' | 'guides';

export interface LayerState {
  approach: boolean;
  airspace: boolean;
  adsb: boolean;
  mrms: boolean;
  echotops: boolean;
  slice: boolean;
  guides: boolean;
}
```

**Step 4: Add default layer state constant**

In `app/app-client/constants.ts`, add at the end:

```typescript
import type { LayerState, LayerId } from './types';

export const LAYER_IDS: LayerId[] = [
  'approach',
  'airspace',
  'adsb',
  'mrms',
  'echotops',
  'slice',
  'guides'
];

export const DEFAULT_LAYER_STATE: LayerState = {
  approach: true,
  airspace: true,
  adsb: true,
  mrms: true,
  echotops: false,
  slice: false,
  guides: true
};
```

**Step 5: Add `parseLayersParam` and `serializeLayersParam` in `app/app-client-utils.ts`**

Add these functions and re-export `DEFAULT_LAYER_STATE`:

```typescript
import { DEFAULT_LAYER_STATE, LAYER_IDS } from '@/app/app-client/constants';
import type { LayerId, LayerState } from '@/app/app-client/types';

export { DEFAULT_LAYER_STATE };

export function parseLayersParam(param: string | null): LayerState {
  const state = { ...DEFAULT_LAYER_STATE };
  if (!param) return state;

  for (const token of param.split(',')) {
    const trimmed = token.trim();
    if (trimmed.length < 2) continue;
    const sign = trimmed[0];
    const id = trimmed.slice(1) as LayerId;
    if (!LAYER_IDS.includes(id)) continue;
    if (sign === '+') state[id] = true;
    else if (sign === '-') state[id] = false;
  }
  return state;
}

export function serializeLayersParam(state: LayerState): string | null {
  const deltas: string[] = [];
  for (const id of LAYER_IDS) {
    if (state[id] !== DEFAULT_LAYER_STATE[id]) {
      deltas.push(`${state[id] ? '+' : '-'}${id}`);
    }
  }
  return deltas.length > 0 ? deltas.join(',') : null;
}
```

**Step 6: Run tests to verify they pass**

Run: `npm test -- --testPathPattern layers-url`
Expected: All 9 tests PASS.

**Step 7: Commit**

```bash
git add -A && git commit -m "feat: add layer types, defaults, and URL parse/serialize utilities"
```

---

### Task 2: Wire layer state into AppClient (replace individual booleans)

**Files:**

- Modify: `app/AppClient.tsx`

This task replaces the five individual `useState` booleans (`nexradVolumeEnabled`, `nexradShowEchoTops`, `nexradShowAltitudeGuides`, `nexradCrossSectionEnabled`, `liveTrafficEnabled`) with a single `LayerState` object and adds two new booleans (`approachVisible`, `airspaceVisible`). It also adds `layersCollapsed` state and mutually-exclusive panel logic.

**Step 1: Add layer state imports and state variable**

At the top of `AppClient.tsx`, add to the imports from `app/app-client-utils`:

```typescript
import {
  parseLayersParam,
  serializeLayersParam,
  DEFAULT_LAYER_STATE
} from '@/app/app-client-utils';
```

Add to imports from `app/app-client/types`:

```typescript
import type { LayerState } from '@/app/app-client/types';
```

**Step 2: Replace individual layer booleans with `LayerState`**

Remove these `useState` calls:

- `liveTrafficEnabled` / `setLiveTrafficEnabled`
- `nexradVolumeEnabled` / `setNexradVolumeEnabled`
- `nexradShowEchoTops` / `setNexradShowEchoTops`
- `nexradShowAltitudeGuides` / `setNexradShowAltitudeGuides`
- `nexradCrossSectionEnabled` / `setNexradCrossSectionEnabled`

Replace with:

```typescript
const [layers, setLayers] = useState<LayerState>(DEFAULT_LAYER_STATE);
```

Add a `layersCollapsed` state:

```typescript
const [layersCollapsed, setLayersCollapsed] = useState(true);
```

Derive the old variable names from `layers` for minimal downstream churn:

```typescript
const liveTrafficEnabled = layers.adsb;
const nexradVolumeEnabled = layers.mrms;
const nexradShowEchoTops = layers.echotops;
const nexradShowAltitudeGuides = layers.guides;
const nexradCrossSectionEnabled = layers.slice;
const approachVisible = layers.approach;
const airspaceVisible = layers.airspace;
```

Add a layer toggle helper:

```typescript
const setLayerEnabled = (id: keyof LayerState, enabled: boolean) => {
  setLayers((prev) => ({ ...prev, [id]: enabled }));
};
```

**Step 3: Update localStorage read/write to include layer state**

In the `PersistedOptionsState` interface, add:

```typescript
layers?: LayerState;
```

In the localStorage-read `useEffect`, after the existing field restores add:

```typescript
if (persisted.layers) {
  const restored = { ...DEFAULT_LAYER_STATE };
  for (const key of Object.keys(DEFAULT_LAYER_STATE) as (keyof LayerState)[]) {
    if (typeof persisted.layers[key] === 'boolean') {
      restored[key] = persisted.layers[key];
    }
  }
  setLayers(restored);
}
// Legacy migration: if no layers key but old booleans exist, migrate them
else {
  const migrated = { ...DEFAULT_LAYER_STATE };
  if (typeof persisted.nexradVolumeEnabled === 'boolean')
    migrated.mrms = persisted.nexradVolumeEnabled;
  if (typeof persisted.liveTrafficEnabled === 'boolean')
    migrated.adsb = persisted.liveTrafficEnabled;
  if (typeof persisted.nexradShowEchoTops === 'boolean')
    migrated.echotops = persisted.nexradShowEchoTops;
  if (typeof persisted.nexradShowAltitudeGuides === 'boolean')
    migrated.guides = persisted.nexradShowAltitudeGuides;
  if (typeof persisted.nexradCrossSectionEnabled === 'boolean')
    migrated.slice = persisted.nexradCrossSectionEnabled;
  setLayers(migrated);
}
```

In the localStorage-write `useEffect`, add `layers` to the persisted object and remove the five old boolean fields:

```typescript
const persisted: PersistedOptionsState = {
  verticalScale,
  terrainRadiusNm,
  flattenBathymetry,
  useParsedMissedClimbGradient,
  hideGroundTraffic,
  showTrafficCallsigns,
  trafficHistoryMinutes,
  nexradMinDbz,
  nexradOpacity,
  nexradDeclutterMode,
  nexradCrossSectionHeadingDeg,
  nexradCrossSectionRangeNm,
  layers
};
```

Update the dependency array of the write effect to include `layers` and remove the five old booleans.

**Step 4: Add `?layers=` URL reading and writing**

In the mount `useEffect` (where `readSurfaceModeFromSearch` is called), add after it:

```typescript
const layersFromUrl = parseLayersParam(new URLSearchParams(window.location.search).get('layers'));
// URL takes precedence — will be merged after localStorage restore
```

The URL should override localStorage. The simplest approach: after the localStorage init block, check if there's a `?layers=` param and apply it:

```typescript
const urlParams = new URLSearchParams(window.location.search);
const layersParam = urlParams.get('layers');
if (layersParam) {
  setLayers(parseLayersParam(layersParam));
}
```

In the URL-sync `useEffect`, update to include layers:

```typescript
const layersSerialized = serializeLayersParam(layers);
if (layersSerialized) {
  params.set('layers', layersSerialized);
} else {
  params.delete('layers');
}
```

Add `layers` to that effect's dependency array.

**Step 5: Add mutually-exclusive panel logic**

Update the toggle handlers so opening one panel closes the other:

```typescript
const toggleOptions = () => {
  setOptionsCollapsed((prev) => {
    if (prev) setLayersCollapsed(true); // close layers when opening options
    return !prev;
  });
};
const toggleLayers = () => {
  setLayersCollapsed((prev) => {
    if (prev) setOptionsCollapsed(true); // close options when opening layers
    return !prev;
  });
};
```

Pass `toggleOptions` instead of the inline `() => setOptionsCollapsed(...)` to `OptionsPanel`.

**Step 6: Guard scene children with layer visibility**

In the JSX, wrap `ApproachPath` with `approachVisible`:

```tsx
{approachVisible && contextApproach && (
  <ApproachPath ... />
)}
```

Wrap `AirspaceVolumes` with `airspaceVisible`:

```tsx
{airspaceVisible && sceneData.airspace.length > 0 && (
  <AirspaceVolumes ... />
)}
```

The existing `liveTrafficEnabled`, `nexradVolumeEnabled`, `nexradShowEchoTops`, etc. guards already work since those are now derived from `layers`.

**Step 7: Remove old layer-toggle props from OptionsPanel usage**

Remove these props from the `<OptionsPanel>` JSX:

- `liveTrafficEnabled` / `onLiveTrafficEnabledChange`
- `nexradVolumeEnabled` / `onNexradVolumeEnabledChange`
- `nexradShowEchoTops` / `onNexradShowEchoTopsChange`
- `nexradShowAltitudeGuides` / `onNexradShowAltitudeGuidesChange`
- `nexradCrossSectionEnabled` / `onNexradCrossSectionEnabledChange`

But keep passing the _read-only_ layer booleans so OptionsPanel can disable sub-controls (e.g., `nexradVolumeEnabled` to disable threshold/opacity sliders). Add a `layers` prop to OptionsPanel for this purpose.

**Step 8: Verify typecheck passes**

Run: `npm run typecheck`
Expected: PASS (may have errors in OptionsPanel — those will be fixed in Task 4).

**Step 9: Commit**

```bash
git add -A && git commit -m "feat: replace individual layer booleans with LayerState in AppClient"
```

---

### Task 3: Create LayersPanel component

**Files:**

- Create: `app/app-client/LayersPanel.tsx`
- Modify: `app/App.css`

**Step 1: Create `LayersPanel.tsx`**

```typescript
import type { LayerState, LayerId } from './types';

interface LayersPanelProps {
  layersCollapsed: boolean;
  onToggleLayers: () => void;
  layers: LayerState;
  onLayerChange: (id: LayerId, enabled: boolean) => void;
}

interface LayerDef {
  id: LayerId;
  label: string;
}

const UNGROUPED_LAYERS: LayerDef[] = [
  { id: 'approach', label: 'Approach' },
  { id: 'airspace', label: 'Airspace' },
  { id: 'adsb', label: 'ADS-B Traffic' },
];

const WEATHER_LAYERS: LayerDef[] = [
  { id: 'mrms', label: 'MRMS 3D Precip' },
  { id: 'echotops', label: 'Echo Tops' },
  { id: 'slice', label: 'Vertical Slice' },
  { id: 'guides', label: 'Altitude Guides' },
];

export function LayersPanel({
  layersCollapsed,
  onToggleLayers,
  layers,
  onLayerChange,
}: LayersPanelProps) {
  if (layersCollapsed) {
    return (
      <button
        type="button"
        className="layers-panel-fab"
        onClick={onToggleLayers}
        title="Show layers"
        aria-label="Show layers"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 2L2 7l10 5 10-5-10-5Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
          <path d="M2 12l10 5 10-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M2 17l10 5 10-5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    );
  }

  return (
    <div className="layers-panel compact">
      <div className="section-header">
        <h3>Layers</h3>
        <button
          type="button"
          className="info-panel-close"
          onClick={onToggleLayers}
          title="Hide layers"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {UNGROUPED_LAYERS.map(({ id, label }) => (
        <label key={id} className="options-toggle-row">
          <span className="options-toggle-copy">
            <span className="options-toggle-title">{label}</span>
          </span>
          <input
            type="checkbox"
            checked={layers[id]}
            onChange={(e) => onLayerChange(id, e.target.checked)}
            aria-label={`Toggle ${label} layer`}
          />
        </label>
      ))}

      <div className="layers-group-divider">
        <span className="layers-group-label">Weather</span>
      </div>

      {WEATHER_LAYERS.map(({ id, label }) => (
        <label key={id} className="options-toggle-row">
          <span className="options-toggle-copy">
            <span className="options-toggle-title">{label}</span>
          </span>
          <input
            type="checkbox"
            checked={layers[id]}
            onChange={(e) => onLayerChange(id, e.target.checked)}
            aria-label={`Toggle ${label} layer`}
          />
        </label>
      ))}
    </div>
  );
}
```

**Step 2: Add CSS for layers panel FAB and panel**

In `app/App.css`, add the layers FAB positioned between gear and recenter:

```css
.layers-panel-fab {
  position: absolute;
  bottom: calc(var(--floating-control-bottom) + 48px);
  right: 24px;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(18, 18, 31, 0.9);
  backdrop-filter: blur(8px);
  border: 1px solid var(--border);
  border-radius: 10px;
  color: var(--text-secondary);
  cursor: pointer;
  z-index: 10;
  transition:
    border-color 0.2s,
    color 0.2s,
    background 0.2s;
}

.layers-panel-fab:hover {
  border-color: var(--accent-cyan);
  color: var(--text-primary);
  background: rgba(0, 255, 204, 0.08);
}

.layers-panel {
  position: absolute;
  right: 24px;
  bottom: 24px;
  background: rgba(18, 18, 31, 0.9);
  backdrop-filter: blur(8px);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 10px 14px;
  min-width: 0;
  z-index: 10;
}

.layers-group-divider {
  margin-top: 10px;
  padding-top: 6px;
  border-top: 1px solid var(--border);
}

.layers-group-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
```

Update the recenter FAB to shift up by another 48px (now `+ 96px` instead of `+ 48px`):

```css
.recenter-fab {
  bottom: calc(var(--floating-control-bottom) + 96px);
}
```

Add mobile overrides for the new `.layers-panel-fab`:

```css
@media (max-width: 900px) {
  .layers-panel-fab {
    right: 12px;
    bottom: calc(var(--floating-control-bottom) + 48px);
  }

  .recenter-fab {
    bottom: calc(var(--floating-control-bottom) + 96px);
  }

  .layers-panel {
    left: 12px;
    right: 12px;
    bottom: var(--floating-control-bottom);
  }
}
```

**Step 3: Render LayersPanel in AppClient**

In `AppClient.tsx`, import `LayersPanel` and render it between recenter FAB and OptionsPanel:

```tsx
<LayersPanel
  layersCollapsed={layersCollapsed}
  onToggleLayers={toggleLayers}
  layers={layers}
  onLayerChange={setLayerEnabled}
/>
```

**Step 4: Verify typecheck and dev server render**

Run: `npm run typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: add LayersPanel component with toggle switches and FAB button"
```

---

### Task 4: Reorganize OptionsPanel into layer-relevant sections

**Files:**

- Modify: `app/app-client/OptionsPanel.tsx`
- Modify: `app/app-client/types.ts` (update `OptionsPanelProps`)

**Step 1: Update `OptionsPanelProps` in `types.ts`**

Remove these props from `OptionsPanelProps`:

- `liveTrafficEnabled` / `onLiveTrafficEnabledChange`
- `nexradVolumeEnabled` / `onNexradVolumeEnabledChange`
- `nexradShowEchoTops` / `onNexradShowEchoTopsChange`
- `nexradShowAltitudeGuides` / `onNexradShowAltitudeGuidesChange`
- `nexradCrossSectionEnabled` / `onNexradCrossSectionEnabledChange`

Add a read-only `layers` prop:

```typescript
layers: LayerState;
```

**Step 2: Rewrite `OptionsPanel.tsx` with sectioned layout**

Reorganize the panel into these sections with heading dividers:

1. **General**: Vertical Scale, Terrain Radius, Flatten Bathymetry
2. **Approach**: Climb Gradient (disabled when `layers.approach` is off)
3. **ADS-B Traffic**: Hide Ground, Show Callsigns, Traffic History (disabled when `layers.adsb` is off)
4. **MRMS Weather**: Threshold, Opacity, Declutter (disabled when `layers.mrms` is off)
5. **Vertical Slice**: Slice Heading, Slice Range (disabled when `layers.slice` is off)

Add section headings using the same `.layers-group-divider` / `.layers-group-label` CSS pattern from the layers panel.

Remove the master on/off checkboxes (Live ADS-B Traffic, MRMS 3D Precip, MRMS Echo Tops, MRMS Altitude Guides, MRMS Vertical Cross-Section) — they are now in the layers panel.

**Step 3: Update AppClient's OptionsPanel props**

Update the `<OptionsPanel>` usage in `AppClient.tsx` to pass `layers` and remove the deleted on/off callback props.

**Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: reorganize OptionsPanel into layer-relevant sections"
```

---

### Task 5: Update InfoPanel legend for layer visibility

**Files:**

- Modify: `app/app-client/InfoPanel.tsx`
- Modify: `app/app-client/types.ts` (update `InfoPanelProps`)

**Step 1: Replace individual boolean props with `layers`**

In `InfoPanelProps`, replace `liveTrafficEnabled`, `nexradVolumeEnabled`, `nexradShowEchoTops` with:

```typescript
layers: LayerState;
```

**Step 2: Update InfoPanel to read from `layers`**

Replace references to old props:

- `liveTrafficEnabled` → `layers.adsb`
- `nexradVolumeEnabled` → `layers.mrms`
- `nexradShowEchoTops` → `layers.echotops`

**Step 3: Update AppClient's InfoPanel props**

Pass `layers={layers}` instead of the three individual booleans.

**Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: update InfoPanel to use LayerState"
```

---

### Task 6: Update SceneCanvasProps and wiring

**Files:**

- Modify: `app/app-client/types.ts` (update `SceneCanvasProps`)
- Modify: `app/app-client/SceneCanvas.tsx`
- Modify: `app/AppClient.tsx`

**Step 1: Replace individual layer booleans in `SceneCanvasProps`**

Remove `liveTrafficEnabled`, `nexradVolumeEnabled`, `nexradShowEchoTops`, `nexradShowAltitudeGuides`, `nexradCrossSectionEnabled` from `SceneCanvasProps`. Add:

```typescript
layers: LayerState;
```

**Step 2: Update SceneCanvas to destructure `layers`**

In `SceneCanvas.tsx`, destructure `layers` from props and derive the old variable names:

```typescript
const liveTrafficEnabled = layers.adsb;
const nexradVolumeEnabled = layers.mrms;
const nexradShowEchoTops = layers.echotops;
const nexradShowAltitudeGuides = layers.guides;
const nexradCrossSectionEnabled = layers.slice;
const approachVisible = layers.approach;
const airspaceVisible = layers.airspace;
```

Add `approachVisible` guard around `<ApproachPath>` and `airspaceVisible` guard around `<AirspaceVolumes>`.

**Step 3: Update AppClient's SceneCanvas props**

Replace the five individual boolean props with `layers={layers}`.

**Step 4: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: pass LayerState through SceneCanvas"
```

---

### Task 7: Update MRMS loading indicator and default changes

**Files:**

- Modify: `app/AppClient.tsx`
- Modify: `app/app-client/constants.ts`

**Step 1: Update default constants**

In `constants.ts`, update the old constants to match the new defaults (for any remaining consumers):

```typescript
export const DEFAULT_NEXRAD_SHOW_ECHO_TOPS = false; // was true, now default-off as a layer
```

Remove `DEFAULT_NEXRAD_VOLUME_ENABLED`, `DEFAULT_NEXRAD_SHOW_ALTITUDE_GUIDES`, `DEFAULT_NEXRAD_CROSS_SECTION_ENABLED` — these are now in `DEFAULT_LAYER_STATE`. Keep them if they're still imported elsewhere; if so, point them to the layer defaults. Search for all imports and update/remove accordingly.

**Step 2: Clean up unused constant imports**

Search all files importing the removed constants and update them.

**Step 3: Verify MRMS loading indicator still uses correct layer flags**

In `AppClient.tsx`, the `showMrmsLoadingIndicator` should still reference the derived `nexradVolumeEnabled || nexradShowEchoTops` or equivalently `layers.mrms || layers.echotops`.

**Step 4: Verify typecheck and tests**

Run: `npm run typecheck && npm run test`
Expected: PASS.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: update defaults and clean up old layer constants"
```

---

### Task 8: Final CI verification and documentation update

**Files:**

- Modify: `docs/ui-url-state-and-mobile.md`
- Modify: `AGENTS.md`

**Step 1: Run full CI check**

Run: `npm run format:check && npm run typecheck && npm run lint && npm run test`

If format fails, run `npm run format` first, then re-check.

Expected: All PASS.

**Step 2: Update `docs/ui-url-state-and-mobile.md`**

Add a section documenting the `?layers=` URL parameter format with examples, the layers panel, and the layer defaults.

**Step 3: Update `AGENTS.md`**

Update the UI section to mention the layers panel and `?layers=` URL encoding.

**Step 4: Commit**

```bash
git add -A && git commit -m "docs: update documentation for layers panel and URL state"
```

---

### Task 9: Manual verification

Not a code task — verify visually:

1. Dev server: each layer toggle works (approach, airspace, adsb, mrms, echotops, slice, guides)
2. URL updates when toggling layers; copying URL and pasting preserves layer state
3. Gear panel shows correct sections with proper disable states
4. Layers and gear panels are mutually exclusive
5. FAB button stack order: gear → layers → recenter (bottom to top)
6. Mobile layout: panels and FABs position correctly
7. `V` keyboard shortcut still cycles declutter mode
8. localStorage persistence: toggle a layer, reload, verify it's remembered
9. URL overrides localStorage: set `?layers=-adsb`, verify ADS-B is off even if localStorage says on
