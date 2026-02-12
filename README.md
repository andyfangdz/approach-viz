# approach-viz

3D visualization of FAA instrument approaches, nearby airspace, and terrain/surface context.

## Stack

- Next.js 16 (App Router)
- React + TypeScript
- react-three-fiber
- SQLite
- Rust (`axum`) sidecar API for MRMS + ADS-B runtime feeds

## Quick Start

```bash
npm install
npm run prepare-data
npm run dev
```

Open `http://localhost:3000`.

`npm run dev` and `npm run start` will start the Rust sidecar automatically by default. Set `RUST_API_MANAGED=0` if you run the sidecar separately.
MRMS sidecar fan-out tuning is available via `MRMS_LEVEL_FETCH_CONCURRENCY` (default `33`) and `MRMS_LEVEL_FETCH_RETRIES` (default `2`).
MRMS proxy timeout is configurable with `RUST_API_MRMS_PROXY_TIMEOUT_MS` (default `90000` ms).

## For Pilots

This tool can help with instrument-procedure study and briefing practice by turning chart/procedure data into an explorable 3D scene.

- Visualize how final, transition, and missed segments connect in space.
- Understand curved legs (`RF`) and DME arcs (`AF`) with turn direction and center-fix context.
- Study vertical profile behavior (FAF to MAP, then missed climb) with selected minimums.
- Compare terrain, FAA plate, and satellite/3D-tiles context to build terrain and obstacle awareness.
- Review no-geometry and minima/plate-only procedures with explicit status so data gaps are obvious.

Training note: this app is for education and familiarization, not for real-world navigation, dispatch, or operational decision-making.

## Routes

- `/` default airport view
- `/<AIRPORT>` airport view
- `/<AIRPORT>/<PROCEDURE_ID>` approach view
- Optional query: `?surface=terrain|plate|3dplate|satellite`

## Useful Commands

```bash
npm run test:parser
npm run format
npm run format:check
npm run rust-api:dev
npm run build
npm run start
```

## Data Pipeline

```bash
npm run download-data
npm run build-db
```
