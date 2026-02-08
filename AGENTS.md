# AGENTS.md

## Project
- Name: `approach-viz`
- Stack: Next.js 16 (App Router) + React + TypeScript + react-three-fiber + SQLite
- Purpose: visualize instrument approaches and related airspace/terrain in 3D

## Agent Maintenance Rule
- Keep this file up to date at all times.
- Any change to behavior, architecture, rendering, data sources, commands, validation, dependencies, or frequently touched files must include the corresponding `AGENTS.md` update in the same work item/PR.
- Before finishing, agents should quickly verify this file still matches the current codebase and workflows.

## Core Commands
- Install deps: `npm install`
- Download FAA/CIFP + airspace + approach minimums data: `npm run download-data`
- Build local SQLite DB from downloaded sources: `npm run build-db`
- Full data refresh (download + SQLite rebuild): `npm run prepare-data`
- Run CIFP parser fixture tests: `npm run test:parser`
- Dev server: `npm run dev`
- Production build (also refreshes data): `npm run build`
- Run production server: `npm run start`

## Data Sources
- CIFP: FAA digital products download page (scraped latest archive URL)
- Airspace overlays: `drnic/faa-airspace-data` (`class_b`, `class_c`, `class_d`)
- Approach minimums (MDA/DA): `ammaraskar/faa-instrument-approach-db` release asset `approaches.json`
- FAA approach plates (PDF): `aeronav.faa.gov/d-tpp/<cycle>/<plate_file>` (fetched server-side via proxy route)
- Terrain wireframe: Terrarium elevation tiles from `https://elevation-tiles-prod.s3.amazonaws.com/terrarium`

## Airport Coverage
- Selector supports all airports present in parsed FAA CIFP data (not a fixed curated list).
- Airport/approach selectors use `react-select` searchable comboboxes.

## Rendering Notes
- Coordinates are local NM relative to selected airport reference point.
- Published CIFP leg/hold courses are magnetic; when synthesizing geometry from course values (for example holds or `CA` legs), convert to true heading using airport magnetic variation.
- Vertical scale is user-adjustable from the header slider and is applied consistently to:
  - approach paths/waypoints/holds
  - terrain wireframe
  - Class B/C/D airspace volumes
- Terrain wireframe elevation samples are fetched/decoded per-airport reference and reused across vertical-scale changes; vertical exaggeration updates are applied via Y-scale transform (no tile refetch/rebuild on slider changes).
- FAA plate surface texture/geometry is fetched and rasterized per selected plate/airport reference; vertical-scale changes apply via mesh Y-scale transform (no plate re-fetch/re-render on slider changes).
- Surface mode supports:
  - `Terrain` (existing Terrarium-based wireframe terrain grid)
  - `FAA Plate` (geo-located FAA approach plate mesh replacing terrain at selected approach)
  - `Satellite` (Google Earth Photorealistic 3D Tiles rendered via `3d-tiles-renderer`, transformed into the app's local frame using `@takram/three-geospatial`)
- FAA plate mesh is rendered at the selected airport elevation (scaled by vertical scale), not fixed at sea-level.
- Satellite mode loads Google tiles directly on the client (no server-side imagery proxy).
- Satellite mode requires `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` and does not provide a runtime key-entry fallback UI.
- Satellite mode should retry renderer initialization up to 3 times on runtime failures; after retries are exhausted, show an in-app error message and keep current surface mode (no automatic terrain fallback).
- Satellite mode terrain is vertically aligned to the app's MSL altitude frame by offsetting tiles to the selected airport elevation.
- Satellite mode applies EGM96 geoid separation per airport when converting MSL airport elevation to WGS84 ellipsoid height for the tile anchor transform.
- Satellite mode uses a tighter tile error target (`~12`) to keep nearby airport surfaces readable.
- FAA plate mode falls back to terrain when no matching plate metadata is found for the selected approach.
- Final approach glidepath is derived from VDA/TCH behavior and extended to MAP/threshold depiction when available.
- Missed-approach path rendering starts at the MAP using selected minimums DA (or MDA fallback), and the missed profile climbs immediately from MAP by interpolating toward the next higher published missed-leg altitude targets (non-descending); this does not change final-approach glidepath-to-runway depiction.
- Missed-profile distance interpolation treats no-fix `CA` legs as short climb segments (distance estimated from climb requirement), preventing exaggerated straight-out segments before turns when a CA leg precedes turn-to-fix legs.
- For missed segments with `CA` followed by `DF`, geometry is conditional:
- non-climbing (or near-level) `CA` uses a local course-to-fix turn join from MAP for immediate turn behavior;
- climbing `CA` renders a straight climb-out segment first, then turns toward the `DF` fix.
- The `CA->DF` change of course is rendered with a curved course-to-fix join (not a hard corner), including cases with large heading reversal after climb-out.
- `CA->DF` turn joins use a radius-constrained arc+tangent model with a minimum turn radius to avoid snap/instant-reversal geometry.
- `CA->DF` turn direction is chosen from heading-to-fix bearing delta (preferred side), with opposite-side fallback only when the preferred geometry is infeasible.
- When available, explicit turn direction published on the procedure leg descriptor (`L`/`R`, e.g. on `DF` legs) overrides geometric inference for `CA->DF` turn joins.
- Curved `CA->DF` turn joins are applied only when `DF` leg turn direction is explicitly published; otherwise missed geometry remains straight/linear to avoid synthetic loops.
- Missed `CA->DF` turn initiation points display altitude callouts (using resolved CA altitude) so turn altitude restrictions are visible in-scene.
- Missed `CA->DF` turn initiation points display altitude callouts only for meaningful published CA climb constraints (not derived/interpolated profile altitudes).
- Minimums selection prefers Cat A values when available; if Cat A is unavailable for a minima line, the app falls back to the lowest available category (B/C/D), displays that category in the minimums panel, and uses it for missed-approach start altitude.
- RF and AF (DME arc) legs are rendered as arcs using published center fixes and turn direction.
- CA legs without fix geometry are synthesized along published course, with length constrained by climb and capped relative to the next known-fix leg to avoid exaggerated runway-heading extensions before turns; non-climbing (or lower-altitude) CA legs use a very short stub so missed approaches can turn immediately.
- Missed-approach interpolation handles legs without direct fix geometry using neighbor-leg distance fallback.
- Airport/runway context markers (selected airport + nearby airports/runways) should render even when the selected procedure has no CIFP geometry.
- Vertical reference lines for path points are batched into a single `lineSegments` geometry per path segment (final/transition/missed) to reduce draw-call count.
- Heavy scene primitives (`ApproachPath`, `AirspaceVolumes`, `TerrainWireframe`, `ApproachPlateSurface`, `SatelliteSurface`) are memoized; the canvas uses capped DPR (`1..1.5`) and high-performance WebGL context hints.

## URL State
- Selection is encoded in path format:
  - `/<AIRPORT>/<PROCEDURE_ID>`
- Surface mode is encoded in query params:
  - `?surface=terrain`, `?surface=plate`, or `?surface=satellite`

## Mobile UI Defaults
- On small screens (`<=900px`), selectors are collapsed by default.
- On small screens (`<=900px`), legend content is collapsed by default.
- Touch/drag interactions in the 3D scene should suppress iOS text selection/callout overlays (`user-select: none`, `touch-action: none` on scene surface), while selector text inputs remain editable.

## Architecture Notes
- Server-side data is backed by `data/approach-viz.sqlite`.
- Server interactions are implemented as Next.js server actions (`app/actions.ts`).
- Scene payloads are loaded server-side by route (`app/[[...slug]]/page.tsx`) and refreshed client-side via actions (`app/AppClient.tsx`).
- FAA plate PDF fetching is done through same-origin proxy route `app/api/faa-plate/route.ts` (avoids browser CORS issues).
- Plate metadata (`cycle`, `plateFile`) is resolved in `app/actions.ts` and included in scene payload for client rendering.
- Vercel Analytics is enabled globally from `app/layout.tsx` via `@vercel/analytics/next`.
- Build step keeps approach geometry CIFP-only.
- Approach selector merges CIFP procedures with minima/plate-only procedures that are missing CIFP geometry; selecting minima/plate-only procedures should still show plate + minimums and an explicit "geometry unavailable from CIFP" indication.

## Validation Expectations
When changing parser/render/data logic, run:
1. `npm run prepare-data`
2. `npm run test:parser` (especially for `src/cifp/parser.ts` changes)
3. `npm run build`
4. Spot-check at least one procedure with:
- RF leg(s)
- AF/DME arc leg(s)
- hold leg(s)
- missed approach with CA/DF/HM
- glidepath inside FAF
- Verify at least one minima/plate-only procedure (for example `KPOU VOR-A`) appears in selector list, shows minimums + plate, and indicates geometry is unavailable from CIFP.
- Verify legend remains concise for minima/plate-only procedures (geometry-unavailable status shown in minimums section, not as long legend copy).

## Files Frequently Touched
- `src/cifp/parser.ts`
- `src/cifp/parser.test.ts`
- `src/cifp/__fixtures__/real-cifp-procedures.txt`
- `src/components/ApproachPath.tsx`
- `src/components/AirspaceVolumes.tsx`
- `src/components/TerrainWireframe.tsx`
- `src/components/ApproachPlateSurface.tsx`
- `src/components/SatelliteSurface.tsx`
- `app/AppClient.tsx`
- `app/actions.ts`
- `app/layout.tsx`
- `app/api/faa-plate/route.ts`
- `app/[[...slug]]/page.tsx`
- `lib/db.ts`
- `lib/types.ts`
- `scripts/build-db.ts`
- `scripts/download-data.sh`
