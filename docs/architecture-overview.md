# Architecture Overview

This project uses a server-first data-loading model with a client-side 3D scene runtime and an external Rust runtime service for weather and traffic APIs.

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
  C --> S["Scene Components<br/>app/app-client/* + app/scene/*"]
  C --> PP["FAA Plate Proxy<br/>app/api/faa-plate/route.ts"]
  S --> G["Path Geometry Modules<br/>app/scene/approach-path/*"]
  S --> TP["Traffic Proxy<br/>app/api/traffic/adsbx/route.ts"]
  S --> WP["Weather Proxy<br/>app/api/weather/nexrad/route.ts"]
  S --> EP["Echo-Top Proxy<br/>app/api/weather/nexrad/echo-tops/route.ts"]
  TP --> RS["Rust Runtime Service<br/>services/runtime-rs"]
  WP --> RS
  EP --> RS
  RS --> SQS["AWS SNS/SQS<br/>NOAA MRMS events"]
  RS --> ADSB["ADSB Exchange<br/>tar1090 feed"]
  RS --> S3["NOAA S3 Bucket<br/>MRMS GRIB2 data"]
```

## Architecture Docs

- [`docs/architecture-data-and-actions.md`](architecture-data-and-actions.md): server data model, action layering, matching/enrichment, proxies, CI/instrumentation.
- [`docs/architecture-client-and-scene.md`](architecture-client-and-scene.md): client state orchestration, UI section boundaries, scene composition.
- [`docs/mrms-rust-pipeline.md`](mrms-rust-pipeline.md): Rust runtime service design, wire format, deployment, endpoints.
- [`docs/mrms-phase-methodology.md`](mrms-phase-methodology.md): thermodynamic-first phase resolver, dual-pol correction, debug telemetry.
