# approach-viz

3D visualization of FAA instrument approaches, nearby airspace, terrain/surface context, live ADS-B traffic, and MRMS volumetric weather.

## Stack

- Next.js 16 (App Router) + React + TypeScript
- react-three-fiber (3D scene)
- SQLite (build-time approach/airspace/minimums data)
- Rust / Axum / Tokio (shared runtime service for MRMS weather + ADS-B traffic APIs, `grib` crate for GRIB2 decoding)
- AWS SNS/SQS (event-driven MRMS scan ingestion)
- Datadog `dd-trace` (Next.js server tracing) + browser RUM + Rust runtime OTLP tracing

## Quick Start

```bash
npm install
npm run prepare-data   # download FAA data + build SQLite DB
npm run dev
```

Open `http://localhost:3000`.

## Features

### For Pilots

This tool helps with instrument-procedure study and briefing practice by turning chart/procedure data into an explorable 3D scene.

- Visualize how final, transition, and missed segments connect in space
- Understand curved legs (`RF`) and DME arcs (`AF`) with turn direction and center-fix context
- Study vertical profile behavior (FAF to MAP, then missed climb) with selected minimums
- See missed-approach turn geometry, including `CA` climb-then-turn sequences and curved course-to-fix joins
- Compare four surface modes (Terrain, FAA Plate, 3D Plate, Satellite) to build terrain and obstacle awareness
- Overlay live ADS-B traffic and MRMS volumetric precipitation for real-time situational context
- Review no-geometry and minima/plate-only procedures with explicit status so data gaps are obvious

Training note: this app is for education and familiarization, not for real-world navigation, dispatch, or operational decision-making.

### Surface Modes

| Mode                  | Description                                                                        |
| --------------------- | ---------------------------------------------------------------------------------- |
| **Terrain** (default) | Wireframe terrain grid from Terrarium elevation tiles (adjustable 20–80 NM radius) |
| **FAA Plate**         | Geolocated FAA approach plate rendered at airport elevation                        |
| **3D Plate**          | FAA plate texture projected onto Google Photorealistic 3D Tiles terrain            |
| **Satellite**         | Google Earth Photorealistic 3D Tiles with EGM96 geoid correction                   |

Satellite and 3D Plate modes require `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`.

### Live ADS-B Traffic

- Real-time aircraft positions from ADSB Exchange tar1090 feed, polled every 5 seconds
- Trail history (1–30 min, configurable) with one-time trace backfill on context change
- Optional callsign labels, ground-traffic hiding, and instanced mesh rendering
- Aircraft without altitude reports placed at nearest airport field elevation via spatial index
- ADS-B decode/trace-fetch runs in Rust runtime service (`services/runtime-rs`) via Next.js proxy route

### MRMS 3D Volumetric Weather

- Optional layer (`MRMS 3D Precip`) — renders NOAA MRMS multi-radar merged reflectivity as stacked 3D voxels across 33 altitude slices
- Phase-aware coloring (rain / mixed / snow) with selectable phase mode (`Surface Precip Type` default, `Thermodynamic` optional)
- User-adjustable reflectivity threshold (5–60 dBZ) and opacity (5–100%)
- Declutter modes (`All/Low/Mid/High`)
- Direct echo-top caps (`18/30/50/60 dBZ`) from MRMS `EchoTop_*` products (can render without 3D volume)
- 5,000-ft altitude guide bands for altitude reference
- Vertical cross-section plane/panel with altitude Y-axis and echo-top maxima
- Server-side merged-brick binary payloads (v3) reduce draw count without dropping weather coverage
- Soft-edge dual-pass shading keeps the merged volume visually smooth (aurora-like)
- Resilient polling: retains last good payload on transient errors, clears on airport change
- Powered by a Rust runtime service (`services/runtime-rs`) with compact binary wire format

### Options Panel

All settings persist to `localStorage`:

- **Vertical Scale** — 1.0–15.0× (step 0.5×)
- **Terrain Radius** — 20–80 NM (step 5, default 50)
- **Flatten Bathymetry** — clamp 3D Tiles seabed (Satellite / 3D Plate modes)
- **Use Parsed Climb Gradient** — toggle between published FAA missed-climb requirements and standard gradient
- **Live ADS-B Traffic** — toggle overlay (on by default)
- **Hide Ground Traffic** / **Show Traffic Callsigns** / **Traffic History** (1–30 min)
- **MRMS 3D Precip** — toggle overlay (off by default)
- **MRMS Threshold** (5–60 dBZ) / **MRMS Opacity** (5–100%)
- **MRMS Declutter** — All / Low / Mid / High (also cycles with `V` key)
- **MRMS Echo Tops** — direct MRMS echo-top overlay (independent of 3D volume)
- **MRMS Altitude Guides** — 5,000-ft horizontal bands
- **MRMS Vertical Cross-Section** — slice plane with heading/range sliders
- **Retina Rendering (2x)** — higher-quality rendering mode with higher GPU cost

### Mobile and PWA

- Mobile-first collapsed defaults for selectors and legend (≤ 900 px)
- Viewport locked to prevent scroll/zoom/text selection outside form inputs
- Safe-area-aware floating controls for iOS browser chrome
- PWA-installable with app icons and web manifest

### Runtime Debug Panel

- Expandable diagnostics FAB with MRMS and traffic telemetry (voxel/track counts, phase mix, poll timestamps, staleness, backfill state, echo-top maxima/timestamps)

## Routes

- `/` — default selection view (restores last selection or uses predefined defaults)
- `/<AIRPORT>` — airport view
- `/<AIRPORT>/<PROCEDURE_ID>` — approach view
- Optional query: `?surface=terrain|plate|3dplate|satellite`

## Commands

```bash
# Data pipeline
npm run download-data      # fetch FAA CIFP, airspace, minimums
npm run build-db           # build SQLite from downloaded data
npm run prepare-data       # download + build (combined)

# Development
npm run dev                # dev server (with Datadog tracing)
npm run build              # production build (also refreshes data)
npm run start              # run production server

# Quality
npm run lint               # lint with ESLint
npm run typecheck          # TypeScript type-check without emit
npm run format             # format with Prettier
npm run format:check       # verify formatting

# Testing
npm run test               # all tests (parser + geometry + layers + MRMS)
npm run test:parser        # CIFP parser fixture tests
npm run test:geometry      # geometry unit tests
npm run test:layers        # layer URL parse/serialize tests
npm run test:mrms          # MRMS request/decode helper tests
npm run test:integration:runtime # live runtime integration checks (requires internet)

# Rust runtime service
cargo check --manifest-path services/runtime-rs/Cargo.toml
```

## Runtime Service

The Rust runtime service (`services/runtime-rs`) handles both MRMS weather and ADS-B traffic:

- Consumes NOAA MRMS scan events via SNS/SQS, decodes GRIB2 data, stores zstd-compressed snapshots (5 GB retention cap), and serves compact binary voxel payloads
- Decodes ADS-B tar1090 `binCraft+zstd` feeds with history trace backfill

### Endpoints

| Endpoint                    | Description                                                   |
| --------------------------- | ------------------------------------------------------------- |
| `GET /healthz`              | Health check                                                  |
| `GET /v1/meta`              | Readiness + scan stats                                        |
| `GET /v1/weather/volume`    | Binary voxel payload (`application/vnd.approach-viz.mrms.v4`) |
| `GET /v1/weather/echo-tops` | Echo-top cells (`EchoTop_18/30/50/60`), JSON or AVET binary   |
| `GET /v1/traffic/adsbx`     | JSON aircraft + optional trail backfill                       |

Legacy aliases `/v1/volume` and `/v1/echo-tops` are still supported.

### Next.js Proxy Routes

| Proxy Route                                 | Upstream Endpoint                  |
| ------------------------------------------- | ---------------------------------- |
| `app/api/weather/nexrad/route.ts`           | `/v1/weather/volume`               |
| `app/api/weather/nexrad/echo-tops/route.ts` | `/v1/weather/echo-tops`            |
| `app/api/traffic/adsbx/route.ts`            | `/v1/traffic/adsbx`                |
| `app/api/faa-plate/route.ts`                | FAA `aeronav.faa.gov` (CORS proxy) |

## Environment Variables

| Variable                                        | Purpose                                                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RUNTIME_UPSTREAM_BASE_URL`                     | Rust runtime service base URL (used by Next.js proxy routes)                                                                                      |
| `MRMS_BINARY_UPSTREAM_BASE_URL`                 | Legacy alias for above                                                                                                                            |
| `NEXT_PUBLIC_MRMS_BINARY_BASE_URL`              | Optional: client-side direct fetch (skips Next.js proxy)                                                                                          |
| `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`               | Google 3D Tiles (Satellite / 3D Plate modes)                                                                                                      |
| `RUNTIME_ADSBX_TAR1090_BASE_URL`                | tar1090 host (default: `globe.adsbexchange.com`)                                                                                                  |
| `RUNTIME_ADSBX_TAR1090_FALLBACK_BASE_URLS`      | Comma-separated fallback tar1090 hosts                                                                                                            |
| `RUNTIME_MRMS_SQS_QUEUE_URL`                    | SNS/SQS queue URL for MRMS ingest (runtime service)                                                                                               |
| `RUNTIME_MRMS_RETENTION_BYTES`                  | Snapshot retention cap (default: 5 GB)                                                                                                            |
| `RUNTIME_INTEGRATION_BASE_URL`                  | Override runtime base URL for integration tests                                                                                                   |
| `DD_API_KEY`                                    | Datadog API key (used by local Datadog agent)                                                                                                     |
| `RUNTIME_DD_TRACE_ENABLED`                      | Enable Rust runtime OTLP trace export (`true`/`false`)                                                                                            |
| `RUNTIME_DD_TRACE_OTLP_ENDPOINT`                | Optional explicit OTLP gRPC endpoint for runtime trace export                                                                                     |
| `RUNTIME_DD_AGENT_HOST`                         | Runtime Datadog agent host (default: `127.0.0.1`)                                                                                                 |
| `RUNTIME_DD_TRACE_OTLP_PORT`                    | Runtime Datadog OTLP gRPC port (default: `4317`)                                                                                                  |
| `RUNTIME_DD_SERVICE`                            | Runtime trace service name (default: `approach-viz-runtime-rs`)                                                                                   |
| `RUNTIME_DD_ENV`                                | Runtime trace environment tag (fallback: `DD_ENV`)                                                                                                |
| `RUNTIME_DD_VERSION`                            | Legacy runtime trace version env var (ignored; runtime uses build-time stamped `<yyyymmdd.hhmmss>-<git_branch>-<git_sha>` with optional `-dirty`) |
| `NEXT_PUBLIC_DD_RUM_APPLICATION_ID`             | Datadog RUM app ID (enables browser RUM when set)                                                                                                 |
| `NEXT_PUBLIC_DD_RUM_CLIENT_TOKEN`               | Datadog RUM client token                                                                                                                          |
| `NEXT_PUBLIC_DD_SITE`                           | Datadog site for browser RUM (default: `datadoghq.com`)                                                                                           |
| `NEXT_PUBLIC_DD_RUM_SERVICE`                    | Browser RUM service name (default: `approach-viz-web`)                                                                                            |
| `NEXT_PUBLIC_DD_RUM_ENV`                        | Browser RUM environment tag                                                                                                                       |
| `NEXT_PUBLIC_DD_RUM_VERSION`                    | Browser RUM version tag (commit SHA fallback)                                                                                                     |
| `NEXT_PUBLIC_DD_RUM_SESSION_SAMPLE_RATE`        | Browser RUM session sample rate `0..100` (default: `100`)                                                                                         |
| `NEXT_PUBLIC_DD_RUM_SESSION_REPLAY_SAMPLE_RATE` | Browser RUM replay sample rate `0..100` (default: `0`)                                                                                            |
| `NEXT_PUBLIC_DD_RUM_PROXY_PATH`                 | Optional Datadog RUM proxy path override (default: `/api/datadog/rum`)                                                                            |
| `DISABLE_CROSS_ORIGIN_ISOLATION`                | Set to `1` to disable COOP/COEP headers (disables SAB/Atomics features)                                                                           |
| `CROSS_ORIGIN_EMBEDDER_POLICY`                  | Optional COEP override (`credentialless` or default `require-corp`)                                                                               |

## Data Sources

| Source                | Type                         | Ingestion                                |
| --------------------- | ---------------------------- | ---------------------------------------- |
| FAA CIFP              | Approach geometry            | Build-time → SQLite                      |
| FAA Airspace GeoJSON  | Class B/C/D volumes          | Build-time → SQLite                      |
| FAA Approach Minimums | MDA/DA, VDA, TCH             | Build-time → SQLite                      |
| FAA Approach Plates   | PDF charts                   | Runtime proxy                            |
| Terrarium Tiles       | Terrain elevation            | Runtime client fetch                     |
| Google 3D Tiles       | Satellite / 3D Plate surface | Runtime client fetch                     |
| ADSB Exchange tar1090 | Live traffic                 | Rust runtime service via proxy (5s poll) |
| NOAA MRMS             | Volumetric weather           | Rust service → binary API (120s poll)    |

See [`docs/data-sources.md`](docs/data-sources.md) for details.

## Documentation

- [`docs/architecture-overview.md`](docs/architecture-overview.md) — high-level flow diagram
- [`docs/architecture-data-and-actions.md`](docs/architecture-data-and-actions.md) — server data model, action layering, matching/enrichment, proxies, CI
- [`docs/architecture-client-and-scene.md`](docs/architecture-client-and-scene.md) — client state, UI sections, scene composition
- [`docs/mrms-rust-pipeline.md`](docs/mrms-rust-pipeline.md) — Rust ingest/query design, wire format, deployment
- [`docs/mrms-phase-methodology.md`](docs/mrms-phase-methodology.md) — MRMS phase classification rules and cycle-alignment policy
- [`docs/data-sources.md`](docs/data-sources.md) — all external data feeds and ingestion paths
- [`docs/rendering-coordinate-system.md`](docs/rendering-coordinate-system.md) — local NM frame, vertical scale, curvature compensation
- [`docs/rendering-surface-modes.md`](docs/rendering-surface-modes.md) — Terrain, FAA Plate, 3D Plate, Satellite modes
- [`docs/rendering-weather-volume.md`](docs/rendering-weather-volume.md) — MRMS volumetric weather overlay, phase coloring, shading, cross-sections
- [`docs/rendering-approach-geometry.md`](docs/rendering-approach-geometry.md) — final/missed vertical profiles, turn joins, arc legs
- [`docs/rendering-performance.md`](docs/rendering-performance.md) — memoization, instanced meshes, disposal, DPR capping
- [`docs/ui-url-state-and-mobile.md`](docs/ui-url-state-and-mobile.md) — URL state, options panel, mobile, PWA
- [`docs/validation.md`](docs/validation.md) — automated tests, CI pipeline, and manual spot-checks
