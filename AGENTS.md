# AGENTS.md

## Project
- Name: `approach-viz`
- Stack: React + TypeScript + Vite + react-three-fiber
- Purpose: visualize instrument approaches and related airspace/terrain in 3D

## Core Commands
- Install deps: `npm install`
- Refresh FAA/CIFP + airspace + approach minimums data: `npm run download-data`
- Dev server: `npm run dev`
- Production build (also refreshes data): `npm run build`

## Data Sources
- CIFP: FAA digital products download page (scraped latest archive URL)
- Airspace overlays: `drnic/faa-airspace-data` (`class_b`, `class_c`, `class_d`)
- Approach minimums (MDA/DA): `ammaraskar/faa-instrument-approach-db` release asset `approaches.json`
- Local generated subset for UI/minimums matching:
  - `public/data/approach-db/approaches_supported.json`

## Supported Airports (Selector)
Current curated airport IDs:
- `KCDW`, `KTEB`, `KMMU`, `KEWR`, `KRNO`
- NY-area/Class D expansion: `KBDR`, `KDXR`, `KFOK`, `KFRG`, `KHPN`, `KHVN`, `KOXC`, `KPOU`, `KSMQ`, `KSWF`, `KTTN`, `KPNE`
- LA-area/Class D expansion + explicit request: `KCMA`, `KCNO`, `KCRQ`, `KEMT`, `KFUL`, `KHHR`, `KLGB`, `KMHV`, `KOXR`, `KPMD`, `KPOC`, `KRAL`, `KSBD`, `KSMO`, `KTOA`, `KVCV`, `KVNY`, `KWHP`, `KWJF`

## Rendering Notes
- Coordinates are local NM relative to selected airport reference point.
- Vertical scale is user-adjustable from the header slider and is applied consistently to:
  - approach paths/waypoints/holds
  - terrain wireframe
  - Class B/C/D airspace volumes
- Final approach glidepath is derived from VDA/TCH behavior and extended to MAP/threshold depiction when available.
- RF legs are rendered as arcs using published RF center fixes and turn direction.
- Missed-approach interpolation handles legs without direct fix geometry using neighbor-leg distance fallback.

## URL State
- Selection is encoded in path format:
  - `/<AIRPORT>/<PROCEDURE_ID>`
- Query params are still accepted as backward-compatible fallback on load.

## Validation Expectations
When changing parser/render/data logic, run:
1. `npm run build`
2. Spot-check at least one procedure with:
- RF leg(s)
- hold leg(s)
- missed approach with CA/DF/HM
- glidepath inside FAF

## Files Frequently Touched
- `src/cifp/parser.ts`
- `src/components/ApproachPath.tsx`
- `src/components/AirspaceVolumes.tsx`
- `src/components/TerrainWireframe.tsx`
- `src/App.tsx`
- `scripts/download-data.sh`
