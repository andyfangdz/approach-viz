# AGENTS.md

## Project

- Name: `approach-viz`
- Stack: Next.js 16 (App Router) + React + TypeScript + react-three-fiber + SQLite
- Purpose: visualize instrument approaches and related airspace/terrain in 3D

## Agent Maintenance Rule

- Keep this file up to date at all times.
- Any change to behavior, architecture, rendering, data sources, commands, validation, or dependencies must include the corresponding `AGENTS.md` update in the same work item/PR.
- Rendering changes must also update the relevant `docs/rendering-*.md` topic file(s).
- Before finishing, agents should quickly verify this file still matches the current codebase and workflows.

## Core Commands

- Install deps: `npm install`
- Download FAA/CIFP + airspace + approach minimums data: `npm run download-data`
- Build local SQLite DB from downloaded sources: `npm run build-db`
- Full data refresh (download + SQLite rebuild): `npm run prepare-data`
- Run full automated tests (parser + geometry): `npm run test`
- Run CIFP parser fixture tests: `npm run test:parser`
- Run geometry unit tests (path/curve/runway math): `npm run test:geometry`
- Format codebase with Prettier: `npm run format`
- Verify Prettier formatting: `npm run format:check`
- Dev server: `npm run dev`
- Production build (also refreshes data): `npm run build`
- Run production server: `npm run start`

## Data Sources

- CIFP: FAA digital products download page (scraped latest archive URL)
- Airspace overlays: `drnic/faa-airspace-data` (`class_b`, `class_c`, `class_d`)
- Approach minimums (MDA/DA): `ammaraskar/faa-instrument-approach-db` release asset `approaches.json`
- FAA approach plates (PDF): `aeronav.faa.gov/d-tpp/<cycle>/<plate_file>` (fetched server-side via proxy route)
- Terrain wireframe: Terrarium elevation tiles from `https://elevation-tiles-prod.s3.amazonaws.com/terrarium`
- Live aircraft traffic: ADSB Exchange tar1090 `binCraft+zstd` feed (`/re-api/?binCraft&zstd&box=...`) via same-origin proxy route with server-side zstd/binCraft decoding; optional initial trail backfill comes from tar1090 trace files (`/data/traces/<suffix>/trace_recent_<hex>.json`) when `historyMinutes` is requested (primary override: `ADSBX_TAR1090_BASE_URL`, optional comma-separated fallback hosts: `ADSBX_TAR1090_FALLBACK_BASE_URLS`)

## Airport Coverage

- Selector supports all airports present in parsed FAA CIFP data (not a fixed curated list).
- Airport/approach selectors use `react-select` searchable comboboxes.

## Rendering Notes

Rendering guidance is split into topic docs under `docs/`:

- `docs/rendering-coordinate-system.md`
- `docs/rendering-surface-modes.md`
- `docs/rendering-approach-geometry.md`
- `docs/rendering-performance.md`
- Satellite/3D Plate mode exposes a gear/options-panel `Flatten Bathymetry` toggle (enabled by default) that clamps bathymetry with curvature-compensated, vertical-scale-neutral local altitude (`worldY / verticalScale + curvatureDrop`) to avoid over-flattening distant above-sea terrain.
- Options panel exposes `Live ADS-B Traffic`, `Show Traffic Callsigns`, and `Traffic History` (`1..15 min`) controls; live traffic is enabled by default, and aircraft markers/trails are polled from the ADSB proxy and rendered as an overlay in scene local-NM coordinates, with one-time initial backfill using the selected history window (default `3 min`). Callsign labels render as text-only overlays above traffic markers (no label box).
- Airspace sectors with floors at/near sea level (`<= 100 ft MSL`) omit bottom caps and bottom edge segments to prevent z-fighting shimmer against sea-level-aligned surfaces.
- Missed direct fix-join legs (`CF`/`DF`/`TF`) with explicit downstream turn direction (`L`/`R`) render curved climbing-turn joins (not hard corners), and downstream `CF` legs with published course/radial intercept that course before the fix.

## URL State

- Selection is encoded in path format:
  - `/<AIRPORT>`
  - `/<AIRPORT>/<PROCEDURE_ID>`
- Surface mode is encoded in query params:
  - `?surface=terrain`, `?surface=plate`, `?surface=3dplate`, or `?surface=satellite`

## Mobile UI Defaults

- On small screens (`<=900px`), selectors are collapsed by default.
- On small screens (`<=900px`), legend content is collapsed by default.
- Bottom-right help panel is error-only; static drag/scroll interaction hints are not shown.
- Touch/drag interactions in the 3D scene should suppress iOS text selection/callout overlays (`user-select: none`, `touch-action: none` on scene surface), while selector text inputs remain editable.

## App Icons And PWA

- Browser/app metadata includes a web manifest at `/manifest.webmanifest` via `app/manifest.ts`.
- App icon assets live at `app/favicon.ico`, `app/icon.png`, and `app/apple-icon.png` (Next.js metadata file conventions).
- PWA install thumbnails are served from `public/icon-192.png` and `public/icon-512.png`.
- Theme color for browser chrome/PWA install surfaces is configured in `app/layout.tsx` viewport metadata.

## Architecture Notes

- Server-side data is backed by `data/approach-viz.sqlite`, with scene payloads assembled through Next.js server actions.
- `app/actions.ts` is a thin wrapper; server logic lives in `app/actions-lib/*` and feeds App Router page loaders plus client refresh actions.
- The client runtime is coordinated in `app/AppClient.tsx`, with UI sections in `app/app-client/*` and scene/math primitives in `src/components/*` and `src/components/approach-path/*`.
- FAA plate PDFs are fetched through `app/api/faa-plate/route.ts`; plate metadata and minima matching are resolved server-side before payload delivery.
- Live ADS-B traffic is fetched through `app/api/traffic/adsbx/route.ts` and rendered client-side by `src/components/LiveTrafficOverlay.tsx`.
- Build-time geometry remains CIFP-only; selector data may include minima/plate-only procedures with explicit geometry-unavailable status.
- CI parser coverage runs in `.github/workflows/parser-tests.yml`; Vercel Analytics is enabled in `app/layout.tsx`.

ASCII data flow:

```text
Browser
  |
  v
App Router pages (app/page.tsx, app/[airportId]/*)
  |
  v
Route loader (app/route-page.tsx)
  |
  v
Server actions (app/actions.ts)
  |
  v
Actions lib (app/actions-lib/*) ---> SQLite (data/approach-viz.sqlite)
  |                                  External metadata (CIFP/minima/plates)
  v
Scene payload
  |
  v
AppClient (app/AppClient.tsx)
  |
  +--> UI sections (app/app-client/*)
  +--> Scene components (src/components/*, src/components/approach-path/*)
  +--> FAA plate proxy (app/api/faa-plate/route.ts)
  +--> ADS-B traffic proxy (app/api/traffic/adsbx/route.ts)
```

Architecture details are split into topic docs under `docs/`:

- `docs/architecture-overview.md` (includes Mermaid system diagram)
- `docs/architecture-data-and-actions.md`
- `docs/architecture-client-and-scene.md`

## Validation Expectations

When changing parser/render/data logic, run:

1. `npm run prepare-data`
2. `npm run test`
3. `npm run test:parser` (especially for `src/cifp/parser.ts` changes)
4. `npm run test:geometry` (for path/curve/runway/coordinate geometry changes)
5. `npm run build`
6. Spot-check at least one procedure with:

- RF leg(s)
- AF/DME arc leg(s)
- hold leg(s)
- missed approach with CA/DF/HM
- glidepath inside FAF
- Verify at least one minima/plate-only procedure (for example `KPOU VOR-A`) appears in selector list, shows minimums + plate, and indicates geometry is unavailable from CIFP.
- Verify legend remains concise for minima/plate-only procedures (geometry-unavailable status shown in minimums section, not as long legend copy).
