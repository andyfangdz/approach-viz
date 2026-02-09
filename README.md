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

## Routes

- `/` default airport view
- `/<AIRPORT>` airport view
- `/<AIRPORT>/<PROCEDURE_ID>` approach view
- Optional query: `?surface=terrain|plate|satellite`

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
