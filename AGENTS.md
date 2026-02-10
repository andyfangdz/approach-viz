# AGENTS.md

## Project

- Name: `approach-viz`
- Stack: Next.js 16 (App Router) + React + TypeScript + react-three-fiber + SQLite + `nexrad-level-3-data`
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

## Directory Layout

- `app/` — Next.js routes, server actions (`actions-lib/`), API proxies (`api/`), client UI (`app-client/`), and 3D scene components (`scene/`)
- `lib/` — shared types, SQLite singleton, spatial index, and CIFP parser (`cifp/`)
- `scripts/` — data download and database build scripts
- `docs/` — detailed topic documentation (architecture, rendering, data sources, UI, validation)
- `data/` — build-time artifacts (SQLite DB, spatial index binaries)

## Documentation Index

Each area below has a one-sentence summary; full details live in the linked `docs/` file.

### Data Sources

CIFP, airspace, minimums, plate PDFs, terrain tiles, live ADS-B traffic, and runtime NEXRAD Level 3 weather are ingested/proxied from FAA and third-party feeds into SQLite (build-time) and same-origin API routes (runtime). → [`docs/data-sources.md`](docs/data-sources.md)

### Architecture

Server-first data loading through Next.js server actions backed by SQLite and a kdbush spatial index, with a thin client runtime coordinating UI sections and a react-three-fiber scene.

- Build/runtime note: `nexrad-level-3-data` is configured as a server external package in `next.config.ts` because the parser uses dynamic `require()` patterns that Turbopack cannot statically bundle.

- [`docs/architecture-overview.md`](docs/architecture-overview.md) — high-level flow diagram
- [`docs/architecture-data-and-actions.md`](docs/architecture-data-and-actions.md) — server data model, action layering, matching/enrichment, proxies, CI
- [`docs/architecture-client-and-scene.md`](docs/architecture-client-and-scene.md) — client state orchestration, UI section boundaries, scene composition

### Rendering

3D approach paths, airspace volumes, terrain/satellite surfaces, live traffic, and optional NEXRAD volumetric weather are rendered in a local-NM coordinate frame with user-adjustable vertical exaggeration.
NEXRAD volume intensity uses a conventional aviation reflectivity palette (green to magenta).

- [`docs/rendering-coordinate-system.md`](docs/rendering-coordinate-system.md) — local NM frame, vertical scale, magnetic-to-true conversion, ADS-B placement
- [`docs/rendering-surface-modes.md`](docs/rendering-surface-modes.md) — Terrain, FAA Plate, 3D Plate, and Satellite modes
- [`docs/rendering-approach-geometry.md`](docs/rendering-approach-geometry.md) — final/missed vertical profiles, turn joins, arc legs, no-fix stubs
- [`docs/rendering-performance.md`](docs/rendering-performance.md) — memoization, batching, instanced meshes, disposal, DPR capping

### UI, URL State, and Mobile

URL-path-encoded airport/procedure selection, options panel (including traffic/weather overlays) with localStorage persistence, overlay-style selectors, mobile-first collapsed defaults, and PWA metadata. → [`docs/ui-url-state-and-mobile.md`](docs/ui-url-state-and-mobile.md)

### Validation

Automated test + build pipeline followed by manual spot-checks covering RF/AF/hold/missed legs and minima/plate-only procedures. → [`docs/validation.md`](docs/validation.md)
