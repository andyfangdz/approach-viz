# approach-viz

3D visualization of FAA instrument approaches, nearby airspace, and terrain/surface context.

## Stack

- Next.js 16 (App Router)
- React + TypeScript
- react-three-fiber
- SQLite

## Quick Start

```bash
npm install
npm run prepare-data
npm run dev
```

Open `http://localhost:3000`.

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
npm run build
npm run start
```

## Data Pipeline

```bash
npm run download-data
npm run build-db
```

## MRMS Weather Pipeline

MRMS volumetric weather now uses an external Rust ingestion service (`services/mrms-rs`) that pre-ingests NOAA MRMS scans and serves compact binary voxel payloads.

- Next.js proxy route: `app/api/weather/nexrad/route.ts`
- Rust service docs: `docs/mrms-rust-pipeline.md`
- Optional direct client fetch override:
  - `NEXT_PUBLIC_MRMS_BINARY_BASE_URL=https://oci-useast-arm-4.pigeon-justice.ts.net:8443/mrms-v1`
- Proxy upstream override:
  - `MRMS_BINARY_UPSTREAM_BASE_URL=https://oci-useast-arm-4.pigeon-justice.ts.net:8443/mrms-v1`
