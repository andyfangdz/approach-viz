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
- Dev server: `npm run dev`
- Production build (also refreshes data): `npm run build`
- Run production server: `npm run start`

## Data Sources
- CIFP: FAA digital products download page (scraped latest archive URL)
- Airspace overlays: `drnic/faa-airspace-data` (`class_b`, `class_c`, `class_d`)
- Approach minimums (MDA/DA): `ammaraskar/faa-instrument-approach-db` release asset `approaches.json`
- FAA approach plates (PDF): `aeronav.faa.gov/d-tpp/<cycle>/<plate_file>` (fetched server-side via proxy route)

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
- Surface mode supports:
  - `Terrain` (existing wireframe terrain)
  - `FAA Plate` (geo-located FAA approach plate mesh replacing terrain at selected approach)
- FAA plate mode falls back to terrain when no matching plate metadata is found for the selected approach.
- Final approach glidepath is derived from VDA/TCH behavior and extended to MAP/threshold depiction when available.
- RF and AF (DME arc) legs are rendered as arcs using published center fixes and turn direction.
- Missed-approach interpolation handles legs without direct fix geometry using neighbor-leg distance fallback.

## URL State
- Selection is encoded in path format:
  - `/<AIRPORT>/<PROCEDURE_ID>`

## Architecture Notes
- Server-side data is backed by `data/approach-viz.sqlite`.
- Server interactions are implemented as Next.js server actions (`app/actions.ts`).
- Scene payloads are loaded server-side by route (`app/[[...slug]]/page.tsx`) and refreshed client-side via actions (`app/AppClient.tsx`).
- FAA plate PDF fetching is done through same-origin proxy route `app/api/faa-plate/route.ts` (avoids browser CORS issues).
- Plate metadata (`cycle`, `plateFile`) is resolved in `app/actions.ts` and included in scene payload for client rendering.

## Validation Expectations
When changing parser/render/data logic, run:
1. `npm run prepare-data`
2. `npm run build`
3. Spot-check at least one procedure with:
- RF leg(s)
- AF/DME arc leg(s)
- hold leg(s)
- missed approach with CA/DF/HM
- glidepath inside FAF

## Files Frequently Touched
- `src/cifp/parser.ts`
- `src/components/ApproachPath.tsx`
- `src/components/AirspaceVolumes.tsx`
- `src/components/TerrainWireframe.tsx`
- `src/components/ApproachPlateSurface.tsx`
- `app/AppClient.tsx`
- `app/actions.ts`
- `app/api/faa-plate/route.ts`
- `app/[[...slug]]/page.tsx`
- `lib/db.ts`
- `lib/types.ts`
- `scripts/build-db.ts`
- `scripts/download-data.sh`
