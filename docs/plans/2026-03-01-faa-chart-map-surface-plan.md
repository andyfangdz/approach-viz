# FAA Chart Map Surface + Plate Overlay Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add `map` and `3dmap` surface modes with FAA aeronautical chart tiles, refactor approach plates from standalone surface modes into an independent overlay toggle, and migrate old plate URLs.

**Architecture:** The existing four surface modes (`terrain | plate | 3dplate | satellite`) become four new modes (`terrain | satellite | map | 3dmap`). The approach plate becomes an independent boolean overlay available on all modes. A chart type picker (`vfr | low | high`) controls which FAA tile service feeds the map modes. A new `ChartMapSurface` component renders flat chart tiles; the existing `SatelliteSurface` shader patching is extended to support chart tile overlay for `3dmap`.

**Tech Stack:** React, TypeScript, react-three-fiber (Three.js), FAA ArcGIS tile services, service worker caching.

---

## Task 1: Update SurfaceMode Type and Add ChartType

**Files:**

- Modify: `app/app-client/types.ts:6` (SurfaceMode type)
- Modify: `app/app-client/types.ts:111-127` (HeaderControlsProps)
- Modify: `app/app-client/types.ts:129-162` (SceneCanvasProps)
- Modify: `app/app-client/types.ts:164-174` (InfoPanelProps)

**Step 1: Update the SurfaceMode type**

In `app/app-client/types.ts`, change line 6 from:

```typescript
export type SurfaceMode = 'terrain' | 'plate' | '3dplate' | 'satellite';
```

to:

```typescript
export type SurfaceMode = 'terrain' | 'satellite' | 'map' | '3dmap';
```

**Step 2: Add ChartType type**

Below the updated SurfaceMode line, add:

```typescript
export type ChartType = 'vfr' | 'low' | 'high';
```

**Step 3: Update HeaderControlsProps**

Add new props to `HeaderControlsProps` (after line 124):

```typescript
plateOverlayEnabled: boolean;
onPlateOverlayToggle: (enabled: boolean) => void;
hasApproachPlate: boolean;
chartType: ChartType;
onChartTypeSelected: (chart: ChartType) => void;
```

**Step 4: Update SceneCanvasProps**

Add to `SceneCanvasProps` (after `surfaceMode` at line 149):

```typescript
plateOverlayEnabled: boolean;
chartType: ChartType;
```

**Step 5: Update InfoPanelProps**

Change `surfaceLegendClass` at line 167 from:

```typescript
surfaceLegendClass: 'terrain' | 'plate' | 'satellite';
```

to:

```typescript
surfaceLegendClass: 'terrain' | 'plate' | 'satellite' | 'map';
```

Add `plateOverlayEnabled: boolean;` prop.

**Step 6: Run typecheck to confirm type errors propagate**

Run: `npm run typecheck`
Expected: Multiple type errors in files that reference the old SurfaceMode values — this confirms the type change propagated correctly. Do NOT fix these yet.

**Step 7: Commit**

```bash
git add app/app-client/types.ts
git commit -m "refactor: update SurfaceMode type, add ChartType and plate overlay props"
```

---

## Task 2: Update URL State Parsing with Migration

**Files:**

- Modify: `app/app-client-utils.ts:41-50` (readSurfaceModeFromSearch)

**Step 1: Rewrite readSurfaceModeFromSearch with migration**

Replace the function at lines 41-50 with:

```typescript
export type SurfaceModeUrlMigration = {
  surfaceMode: SurfaceMode;
  plateOverlay: boolean;
};

export function readSurfaceModeFromSearch(search: string): SurfaceModeUrlMigration | null {
  const params = new URLSearchParams(search);
  const value = params.get('surface');
  // Migrate legacy plate modes
  if (value === 'plate') return { surfaceMode: 'terrain', plateOverlay: true };
  if (value === '3dplate') return { surfaceMode: 'satellite', plateOverlay: true };
  if (value === 'terrain' || value === 'satellite' || value === 'map' || value === '3dmap') {
    const plateOverlay = params.get('plate') === 'on';
    return { surfaceMode: value, plateOverlay };
  }
  return null;
}
```

**Step 2: Add readChartTypeFromSearch**

Below the function above, add:

```typescript
export function readChartTypeFromSearch(search: string): ChartType | null {
  const params = new URLSearchParams(search);
  const value = params.get('chart');
  if (value === 'vfr' || value === 'low' || value === 'high') {
    return value;
  }
  return null;
}
```

Add the necessary import for `ChartType` and `SurfaceMode` from types.ts at the top of the file.

**Step 3: Commit**

```bash
git add app/app-client-utils.ts
git commit -m "feat: URL state parsing with plate/3dplate migration and chart type"
```

---

## Task 3: Update AppClient State Management

**Files:**

- Modify: `app/AppClient.tsx`

**Step 1: Add new state variables**

After `surfaceMode` state at line 297, add:

```typescript
const [plateOverlayEnabled, setPlateOverlayEnabled] = useState(false);
const [chartType, setChartType] = useState<ChartType>('vfr');
```

Import `ChartType` from types.

**Step 2: Update URL initialization**

At lines 385-388, the current code reads:

```typescript
const modeFromQuery = readSurfaceModeFromSearch(window.location.search);
if (modeFromQuery) {
  setSurfaceMode(modeFromQuery);
}
```

Replace with:

```typescript
const modeFromQuery = readSurfaceModeFromSearch(window.location.search);
if (modeFromQuery) {
  setSurfaceMode(modeFromQuery.surfaceMode);
  setPlateOverlayEnabled(modeFromQuery.plateOverlay);
}
const chartFromQuery = readChartTypeFromSearch(window.location.search);
if (chartFromQuery) {
  setChartType(chartFromQuery);
}
```

Import `readChartTypeFromSearch` at top.

**Step 3: Update URL sync effect**

At line 642, `params.set('surface', surfaceMode)` — after that line, add:

```typescript
if (plateOverlayEnabled) {
  params.set('plate', 'on');
} else {
  params.delete('plate');
}
if ((surfaceMode === 'map' || surfaceMode === '3dmap') && chartType !== 'vfr') {
  params.set('chart', chartType);
} else {
  params.delete('chart');
}
```

Add `plateOverlayEnabled` and `chartType` to the effect's dependency array (at lines 682-691).

**Step 4: Update legend logic**

Replace the `surfaceLegendClass` and `surfaceLegendLabel` computation (lines 816-839) with:

```typescript
const surfaceLegendClass: 'plate' | 'satellite' | 'terrain' | 'map' =
  plateOverlayEnabled && hasApproachPlate
    ? 'plate'
    : surfaceMode === 'satellite' || surfaceMode === '3dmap'
      ? 'satellite'
      : surfaceMode === 'map'
        ? 'map'
        : 'terrain';

const SURFACE_LEGEND_LABELS: Record<SurfaceMode, string> = {
  terrain: 'Terrain Wireframe',
  satellite: 'Satellite Surface',
  map: 'FAA Chart Map',
  '3dmap': '3D Chart Map'
};
const surfaceLegendLabel =
  plateOverlayEnabled && hasApproachPlate
    ? `FAA Plate + ${SURFACE_LEGEND_LABELS[surfaceMode]}`
    : SURFACE_LEGEND_LABELS[surfaceMode];
```

**Step 5: Update handleSurfaceModeSelected**

No change needed — the handler at lines 841-846 already clears errors and sets mode. The type change will flow through automatically.

**Step 6: Add chart type and plate overlay handlers**

After `handleSurfaceModeSelected`:

```typescript
const handleChartTypeSelected = (chart: ChartType) => {
  setChartType(chart);
};

const handlePlateOverlayToggle = (enabled: boolean) => {
  setPlateOverlayEnabled(enabled);
};
```

**Step 7: Update prop passing to HeaderControls**

At lines 928-929, add the new props:

```typescript
plateOverlayEnabled = { plateOverlayEnabled };
onPlateOverlayToggle = { handlePlateOverlayToggle };
hasApproachPlate = { hasApproachPlate };
chartType = { chartType };
onChartTypeSelected = { handleChartTypeSelected };
```

**Step 8: Update prop passing to SceneCanvas**

After `surfaceMode` at line 960, add:

```typescript
plateOverlayEnabled = { plateOverlayEnabled };
chartType = { chartType };
```

**Step 9: Update prop passing to InfoPanel**

Add `plateOverlayEnabled={plateOverlayEnabled}` alongside existing surface props.

**Step 10: Commit**

```bash
git add app/AppClient.tsx
git commit -m "feat: add plate overlay + chart type state management with URL sync"
```

---

## Task 4: Update HeaderControls UI

**Files:**

- Modify: `app/app-client/HeaderControls.tsx:186-218`

**Step 1: Replace surface toggle buttons**

Replace the surface toggle section (lines 186-218) with four new buttons and a plate overlay toggle + chart picker:

```tsx
<div className="control-group">
  <label>Surface</label>
  <div className="surface-toggle" role="group" aria-label="Surface mode">
    <button
      type="button"
      className={`surface-toggle-button ${surfaceMode === 'terrain' ? 'active' : ''}`}
      onClick={() => onSurfaceModeSelected('terrain')}
    >
      Terrain
    </button>
    <button
      type="button"
      className={`surface-toggle-button ${surfaceMode === 'satellite' ? 'active' : ''}`}
      onClick={() => onSurfaceModeSelected('satellite')}
    >
      Satellite
    </button>
    <button
      type="button"
      className={`surface-toggle-button ${surfaceMode === 'map' ? 'active' : ''}`}
      onClick={() => onSurfaceModeSelected('map')}
    >
      Map
    </button>
    <button
      type="button"
      className={`surface-toggle-button ${surfaceMode === '3dmap' ? 'active' : ''}`}
      onClick={() => onSurfaceModeSelected('3dmap')}
    >
      3D Map
    </button>
  </div>
</div>;

{
  (surfaceMode === 'map' || surfaceMode === '3dmap') && (
    <div className="control-group">
      <label>Chart</label>
      <div className="surface-toggle" role="group" aria-label="Chart type">
        <button
          type="button"
          className={`surface-toggle-button ${chartType === 'vfr' ? 'active' : ''}`}
          onClick={() => onChartTypeSelected('vfr')}
        >
          VFR
        </button>
        <button
          type="button"
          className={`surface-toggle-button ${chartType === 'low' ? 'active' : ''}`}
          onClick={() => onChartTypeSelected('low')}
        >
          IFR Low
        </button>
        <button
          type="button"
          className={`surface-toggle-button ${chartType === 'high' ? 'active' : ''}`}
          onClick={() => onChartTypeSelected('high')}
        >
          IFR High
        </button>
      </div>
    </div>
  );
}

{
  hasApproachPlate && (
    <div className="control-group">
      <label className="plate-overlay-label">
        <input
          type="checkbox"
          checked={plateOverlayEnabled}
          onChange={(e) => onPlateOverlayToggle(e.target.checked)}
        />
        FAA Plate Overlay
      </label>
    </div>
  );
}
```

Destructure the new props from the component's props object.

**Step 2: Commit**

```bash
git add app/app-client/HeaderControls.tsx
git commit -m "feat: update header controls with new surface modes, chart picker, plate toggle"
```

---

## Task 5: Update InfoPanel

**Files:**

- Modify: `app/app-client/InfoPanel.tsx:108-110`

**Step 1: Update the plate warning note**

Replace the plate warning conditional at lines 108-110:

```tsx
{
  (surfaceMode === 'plate' || surfaceMode === '3dplate') && !hasApproachPlate && (
    <div className="legend-note">No FAA plate matched this approach.</div>
  );
}
```

with:

```tsx
{
  plateOverlayEnabled && !hasApproachPlate && (
    <div className="legend-note">No FAA plate matched this approach.</div>
  );
}
```

Destructure `plateOverlayEnabled` from props.

**Step 2: Add legend color class for map**

The CSS will need a `.legend-color.map` class (added in Task 8). No code change needed here — the `surfaceLegendClass` already supports `'map'`.

**Step 3: Commit**

```bash
git add app/app-client/InfoPanel.tsx
git commit -m "feat: update InfoPanel for plate overlay toggle"
```

---

## Task 6: Create ChartMapSurface Component

**Files:**

- Create: `app/scene/ChartMapSurface.tsx`

**Step 1: Create the flat chart tile surface component**

This component fetches FAA chart tiles for the viewport, composites them onto a canvas, and renders a textured plane at airport elevation. Model it after `TerrainWireframe.tsx` for tile fetching patterns and coordinate conversion.

```typescript
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { ChartType } from '@/app/app-client/types';

const CHART_TILE_URLS: Record<ChartType, string> = {
  vfr: 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile',
  low: 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_AreaLow/MapServer/tile',
  high: 'https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_High/MapServer/tile',
};

const CHART_ZOOM_RANGES: Record<ChartType, { min: number; max: number }> = {
  vfr: { min: 8, max: 12 },
  low: { min: 7, max: 12 },
  high: { min: 5, max: 9 },
};

const TILE_SIZE = 256;
const DEFAULT_RADIUS_NM = 50;

// Tile coordinate helpers (same as TerrainWireframe)
function lonToTileX(lon: number, zoom: number): number {
  return Math.floor(((lon + 180) / 360) * Math.pow(2, zoom));
}

function latToTileY(lat: number, zoom: number): number {
  const latRad = (lat * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * Math.pow(2, zoom)
  );
}

// Inverse: tile coords back to lat/lon (for tile bounds)
function tileXToLon(x: number, zoom: number): number {
  return (x / Math.pow(2, zoom)) * 360 - 180;
}

function tileYToLat(y: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, zoom);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

interface ChartMapSurfaceProps {
  refLat: number;
  refLon: number;
  radiusNm: number;
  verticalScale: number;
  chartType: ChartType;
  airportElevationFeet: number;
}

// WGS-84 lat/lon offset to local NM using ellipsoid radii
const WGS84_A = 6378137.0;
const WGS84_B = 6356752.314245;
const METERS_TO_NM = 1 / 1852;

function latLonToLocalNm(
  lat: number,
  lon: number,
  refLat: number,
  refLon: number
): [number, number] {
  const refLatRad = (refLat * Math.PI) / 180;
  const sinLat = Math.sin(refLatRad);
  const cosLat = Math.cos(refLatRad);
  const a2 = WGS84_A * WGS84_A;
  const b2 = WGS84_B * WGS84_B;
  const denom = a2 * cosLat * cosLat + b2 * sinLat * sinLat;
  const denomSqrt = Math.sqrt(denom);
  const rn = a2 / denomSqrt;
  const rm = (a2 * b2) / (denom * denomSqrt);
  const dLat = ((lat - refLat) * Math.PI) / 180;
  const dLon = ((lon - refLon) * Math.PI) / 180;
  const eastNm = rn * cosLat * dLon * METERS_TO_NM;
  const northNm = rm * dLat * METERS_TO_NM;
  return [eastNm, northNm];
}

export default function ChartMapSurface({
  refLat,
  refLon,
  radiusNm,
  verticalScale,
  chartType,
  airportElevationFeet,
}: ChartMapSurfaceProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const [texture, setTexture] = useState<THREE.CanvasTexture | null>(null);
  const [planeSize, setPlaneSize] = useState<{ width: number; height: number } | null>(null);

  // Pick zoom level based on radius and chart type
  const zoom = useMemo(() => {
    const range = CHART_ZOOM_RANGES[chartType];
    // Larger radius → lower zoom. Heuristic: 50 NM ≈ zoom 10 for VFR
    const targetZoom = Math.round(14 - Math.log2(radiusNm));
    return Math.max(range.min, Math.min(range.max, targetZoom));
  }, [chartType, radiusNm]);

  useEffect(() => {
    let cancelled = false;

    async function loadTiles() {
      const baseUrl = CHART_TILE_URLS[chartType];
      const centerTileX = lonToTileX(refLon, zoom);
      const centerTileY = latToTileY(refLat, zoom);

      // Calculate how many tiles we need to cover the radius
      // At the equator at zoom z, one tile covers 360/2^z degrees of longitude
      const degreesPerTile = 360 / Math.pow(2, zoom);
      const nmPerDegreeLon = 60 * Math.cos((refLat * Math.PI) / 180);
      const nmPerTileLon = degreesPerTile * nmPerDegreeLon;
      const tilesNeeded = Math.ceil((radiusNm * 2) / nmPerTileLon);
      const halfTiles = Math.ceil(tilesNeeded / 2);

      const minTileX = centerTileX - halfTiles;
      const maxTileX = centerTileX + halfTiles;
      const minTileY = centerTileY - halfTiles;
      const maxTileY = centerTileY + halfTiles;

      const cols = maxTileX - minTileX + 1;
      const rows = maxTileY - minTileY + 1;

      const canvas = document.createElement('canvas');
      canvas.width = cols * TILE_SIZE;
      canvas.height = rows * TILE_SIZE;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      // Fill with transparent black so missing tiles show as dark
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const tilePromises: Promise<void>[] = [];

      for (let ty = minTileY; ty <= maxTileY; ty++) {
        for (let tx = minTileX; tx <= maxTileX; tx++) {
          const url = `${baseUrl}/${zoom}/${ty}/${tx}`;
          const col = tx - minTileX;
          const row = ty - minTileY;
          tilePromises.push(
            fetch(url)
              .then((res) => {
                if (!res.ok) return;
                return res.blob();
              })
              .then((blob) => {
                if (!blob || cancelled) return;
                return createImageBitmap(blob);
              })
              .then((bmp) => {
                if (!bmp || cancelled) return;
                ctx.drawImage(bmp, col * TILE_SIZE, row * TILE_SIZE);
                bmp.close();
              })
              .catch(() => {
                // Missing tile — leave dark fill
              })
          );
        }
      }

      await Promise.all(tilePromises);
      if (cancelled) return;

      // Compute plane bounds in local NM coordinates
      const westLon = tileXToLon(minTileX, zoom);
      const eastLon = tileXToLon(maxTileX + 1, zoom);
      const northLat = tileYToLat(minTileY, zoom);
      const southLat = tileYToLat(maxTileY + 1, zoom);

      const [westNm] = latLonToLocalNm(refLat, westLon, refLat, refLon);
      const [eastNm] = latLonToLocalNm(refLat, eastLon, refLat, refLon);
      const [, northNm] = latLonToLocalNm(northLat, refLon, refLat, refLon);
      const [, southNm] = latLonToLocalNm(southLat, refLon, refLat, refLon);

      const widthNm = eastNm - westNm;
      const heightNm = northNm - southNm; // north is positive

      const tex = new THREE.CanvasTexture(canvas);
      tex.minFilter = THREE.LinearFilter;
      tex.magFilter = THREE.LinearFilter;
      tex.colorSpace = THREE.SRGBColorSpace;

      setTexture((prev) => {
        prev?.dispose();
        return tex;
      });

      // Center offset: how far the tile grid center is from refLat/refLon
      const centerLon = (westLon + eastLon) / 2;
      const centerLat = (northLat + southLat) / 2;
      const [offsetX, offsetZ] = latLonToLocalNm(centerLat, centerLon, refLat, refLon);

      setPlaneSize({ width: widthNm, height: heightNm });

      // Position the mesh
      if (meshRef.current) {
        const elevationNm = (airportElevationFeet / 6076.12);
        meshRef.current.position.set(offsetX, elevationNm * verticalScale - 0.002, -offsetZ);
      }
    }

    loadTiles();
    return () => {
      cancelled = true;
    };
  }, [refLat, refLon, radiusNm, zoom, chartType, airportElevationFeet, verticalScale]);

  // Cleanup texture on unmount
  useEffect(() => {
    return () => {
      setTexture((prev) => {
        prev?.dispose();
        return null;
      });
    };
  }, []);

  if (!texture || !planeSize) return null;

  return (
    <mesh ref={meshRef} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[planeSize.width, planeSize.height]} />
      <meshBasicMaterial map={texture} transparent opacity={0.92} />
    </mesh>
  );
}
```

**Step 2: Commit**

```bash
git add app/scene/ChartMapSurface.tsx
git commit -m "feat: add ChartMapSurface component for flat FAA chart tile rendering"
```

---

## Task 7: Update SceneCanvas Rendering Logic

**Files:**

- Modify: `app/app-client/SceneCanvas.tsx:387-462`

**Step 1: Import ChartMapSurface**

Add at the top of the file:

```typescript
import ChartMapSurface from '@/app/scene/ChartMapSurface';
```

**Step 2: Destructure new props**

Destructure `plateOverlayEnabled` and `chartType` from props.

**Step 3: Update computed surface booleans**

Replace lines 388-391:

```typescript
const showFlatPlateSurface = surfaceMode === 'plate' && hasApproachPlate;
const showTerrainSurface =
  surfaceMode === 'terrain' || (surfaceMode === 'plate' && !hasApproachPlate);
const showTiledSurface = surfaceMode === 'satellite' || surfaceMode === '3dplate';
```

with:

```typescript
const showTerrainSurface = surfaceMode === 'terrain';
const showChartMapSurface = surfaceMode === 'map';
const showTiledSurface = surfaceMode === 'satellite' || surfaceMode === '3dmap';
const showFlatPlateOverlay =
  plateOverlayEnabled && hasApproachPlate && (surfaceMode === 'terrain' || surfaceMode === 'map');
const showTiledPlateOverlay = plateOverlayEnabled && hasApproachPlate && showTiledSurface;
```

**Step 4: Add ChartMapSurface rendering**

After the terrain section (line 423), add:

```tsx
{
  showChartMapSurface && (
    <ChartMapSurface
      refLat={airport.lat}
      refLon={airport.lon}
      radiusNm={terrainRadiusNm}
      verticalScale={verticalScale}
      chartType={chartType}
      airportElevationFeet={airport.elevation}
    />
  );
}
```

**Step 5: Update flat plate rendering condition**

Replace the existing flat plate block (lines 425-433):

```tsx
{showFlatPlateSurface && sceneData.approachPlate && (
  <ApproachPlateSurface ... />
)}
```

with:

```tsx
{
  showFlatPlateOverlay && sceneData.approachPlate && (
    <ApproachPlateSurface
      plate={sceneData.approachPlate}
      refLat={airport.lat}
      refLon={airport.lon}
      airportElevationFeet={airport.elevation}
      verticalScale={verticalScale}
    />
  );
}
```

**Step 6: Update tiled surface plate overlay**

In the SatelliteSurface section, change the `plateOverlay` prop at line 457 from:

```typescript
plateOverlay={surfaceMode === '3dplate' ? sceneData.approachPlate : null}
```

to:

```typescript
plateOverlay={showTiledPlateOverlay ? sceneData.approachPlate : null}
```

For `3dmap` mode, the SatelliteSurface will also need chart tile overlay — but this is the shader patching for the chart texture, which is a separate concern. For v1, `3dmap` will render Google 3D Tiles as the base (same as satellite) with chart overlay handled separately in a future iteration if needed. The plate overlay already works through the existing homography shader.

**Step 7: Update earth curvature compensation checks**

All occurrences of `surfaceMode === 'satellite' || surfaceMode === '3dplate'` need updating. Replace every instance with `surfaceMode === 'satellite' || surfaceMode === '3dmap'`. There are multiple locations:

- Line 473: AirportMarker `applyEarthCurvatureCompensation`
- Lines 487-488: Nearby AirportMarker
- Lines 526-528: LiveTrafficOverlay
- Lines 549-550: NexradVolumeOverlay
- Lines 562-563: ProbSevereOverlay

**Step 8: Commit**

```bash
git add app/app-client/SceneCanvas.tsx
git commit -m "feat: update SceneCanvas with chart map surface and plate overlay logic"
```

---

## Task 8: Add CSS for Map Legend and Plate Overlay Toggle

**Files:**

- Modify: `app/App.css`

**Step 1: Add map legend color**

After the existing `.legend-color.satellite` rule (around line 797), add:

```css
.legend-color.map {
  background-color: #e8a838;
}
```

**Step 2: Add plate overlay label style**

After the surface toggle styles (around line 158), add:

```css
.plate-overlay-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-secondary);
  cursor: pointer;
}

.plate-overlay-label input[type='checkbox'] {
  accent-color: rgba(0, 255, 204, 0.7);
}
```

**Step 3: Commit**

```bash
git add app/App.css
git commit -m "feat: add CSS for map legend color and plate overlay toggle"
```

---

## Task 9: Update Service Worker for Chart Tile Caching

**Files:**

- Modify: `public/service-worker.js`

**Step 1: Add chart tile cache and detection**

After the constants at the top (line 8), add:

```javascript
const CHART_TILES_CACHE = `approach-viz-chart-tiles-${SW_VERSION}`;
const CHART_TILES_MAX_ENTRIES = 1200;
```

After `isElevationTilesRequest` (line 32), add:

```javascript
function isChartTileRequest(url) {
  return url.hostname === 'tiles.arcgis.com' && url.pathname.includes('/MapServer/tile/');
}
```

**Step 2: Add fetch handler for chart tiles**

In the fetch event listener (after the elevation tiles handler at line 182), add:

```javascript
if (isChartTileRequest(url)) {
  event.respondWith(
    cacheFirstTileRequest(event, request, CHART_TILES_CACHE, CHART_TILES_MAX_ENTRIES)
  );
}
```

**Step 3: Commit**

```bash
git add public/service-worker.js
git commit -m "feat: add service worker caching for FAA chart tiles"
```

---

## Task 10: Update Documentation

**Files:**

- Modify: `docs/rendering-surface-modes.md`
- Modify: `AGENTS.md`

**Step 1: Update rendering-surface-modes.md**

Update the supported modes section to reflect the new four modes plus plate overlay. Add descriptions for `map` and `3dmap` modes, chart type picker, and plate overlay behavior.

**Step 2: Update AGENTS.md**

In the "Current Behavior" section, update:

- Surface modes from `terrain | plate | 3dplate | satellite` to `terrain | satellite | map | 3dmap`
- Add: plate overlay is an independent toggle, not a surface mode
- Add: chart type picker (`vfr | low | high`) for map/3dmap modes
- Add: FAA ArcGIS tile source URLs
- Update URL state format
- Note the legacy URL migration for `plate` → `terrain&plate=on`, `3dplate` → `satellite&plate=on`

**Step 3: Commit**

```bash
git add docs/rendering-surface-modes.md AGENTS.md
git commit -m "docs: update surface modes docs and AGENTS.md for chart map + plate overlay"
```

---

## Task 11: Typecheck, Lint, Format, Test

**Step 1: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (all type errors resolved)

**Step 2: Run lint**

Run: `npm run lint`
Expected: PASS

**Step 3: Run format check**

Run: `npm run format:check`
If failures: `npx prettier --write .` then re-check.

**Step 4: Run tests**

Run: `npm run test`
Expected: PASS

**Step 5: Fix any issues found and commit**

```bash
git add -A
git commit -m "chore: fix lint/format/test issues"
```

---

## Task 12: Manual Smoke Test

**Step 1: Start dev server**

Run: `npm run dev`

**Step 2: Verify surface mode buttons**

- Terrain, Satellite, Map, 3D Map buttons appear
- Old "FAA Plate" and "3D Plate" buttons are gone
- Plate overlay checkbox appears when approach plate is available

**Step 3: Verify chart map rendering**

- Select "Map" mode → flat chart tiles render under the 3D scene
- Chart picker (VFR / IFR Low / IFR High) appears and switches tile source
- Tiles load and composite correctly centered on the airport

**Step 4: Verify plate overlay**

- Toggle plate overlay checkbox → plate renders on top of each surface mode
- Works on terrain, satellite, map modes

**Step 5: Verify URL migration**

- Navigate to `?surface=plate` → redirects to terrain + plate overlay on
- Navigate to `?surface=3dplate` → redirects to satellite + plate overlay on
- URL shows `?surface=map&chart=low` when IFR Low selected

**Step 6: Commit any fixes**

---

## Task 13: Push to Branch

**Step 1: Create and push feature branch**

```bash
git checkout -b feat/faa-chart-map-surface
git push -u origin feat/faa-chart-map-surface
```
