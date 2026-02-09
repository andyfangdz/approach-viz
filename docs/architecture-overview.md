# Architecture Overview

This project uses a server-first data-loading model with a client-side 3D scene runtime.

## High-Level Flow

```mermaid
flowchart TD
  U["User Browser"] --> R["App Router Pages<br/>app/page.tsx<br/>app/[airportId]/page.tsx<br/>app/[airportId]/[procedureId]/page.tsx"]
  R --> L["Route Loader<br/>app/route-page.tsx"]
  L --> A["Server Actions Wrapper<br/>app/actions.ts"]
  A --> AL["Actions Lib Modules<br/>app/actions-lib/*"]
  AL --> DB["SQLite<br/>data/approach-viz.sqlite"]
  AL --> EXT["External Data<br/>CIFP + minima + plate metadata"]
  A --> C["Client Runtime<br/>app/AppClient.tsx"]
  C --> S["Scene Components<br/>app/app-client/* + src/components/*"]
  C --> P["FAA Plate Proxy<br/>app/api/faa-plate/route.ts"]
  S --> G["Path Geometry Modules<br/>src/components/approach-path/*"]
```

## Architecture Docs

- `docs/architecture-data-and-actions.md`: server data model, action layering, and matching/enrichment behavior.
- `docs/architecture-client-and-scene.md`: client state orchestration, UI section boundaries, and scene composition responsibilities.
