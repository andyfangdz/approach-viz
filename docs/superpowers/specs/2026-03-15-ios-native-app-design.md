# iOS Native App — Design Spec

## Context

approach-viz is a 3D visualization of FAA instrument approaches, currently a Next.js web app using react-three-fiber/Three.js for rendering. The web app has inherent limitations: WebGL vs Metal performance, web worker overhead, touch gesture friction, and no native platform integration. This spec describes a native iOS rewrite targeting performance and platform feel, starting with a focused MVP.

## Decisions

- **Framework**: SwiftUI + RealityKit (LowLevelMesh, iOS 18+)
- **Rust integration**: UniFFI (auto-generated Swift bindings from existing core crate)
- **MVP scope**: Approach path 3D visualization + terrain surface + airport/approach selection
- **Repo structure**: Monorepo — `ios/` subfolder sharing the Rust workspace
- **3D engine**: RealityKit with LowLevelMesh for custom geometry, CustomMaterial for Metal shaders

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    SwiftUI Layer                    │
│  AirportPicker  ApproachSelector  LayerToggles  Opts│
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │               RealityView                   │    │
│  │  TerrainEntity    ApproachPathEntity         │    │
│  │  WaypointEntities RunwayEntity               │    │
│  │  CameraController (gesture-driven orbit)     │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
                        │
                  ViewModel Layer
                 (Swift async/await)
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
  Rust Core        REST API         SQLite
  (UniFFI)         Client           (bundled)
  • coords         • runtime        • airports
  • decode         • tile fetch     • approaches
  • prepare                         • waypoints
```

### Project Layout

```
approach-viz/
├── ios/
│   ├── ApproachViz.xcodeproj
│   ├── ApproachViz/
│   │   ├── App/                  — App entry, navigation
│   │   ├── Views/                — SwiftUI views (panels, controls)
│   │   ├── Scene/                — RealityKit scene components
│   │   │   ├── ApproachPathEntity.swift
│   │   │   ├── TerrainEntity.swift
│   │   │   ├── WaypointEntity.swift
│   │   │   ├── RunwayEntity.swift
│   │   │   ├── CameraController.swift
│   │   │   └── Shaders/         — .metal shader files
│   │   ├── ViewModels/          — @Observable view models
│   │   ├── Services/            — API client, tile fetcher, DB access
│   │   ├── Models/              — Swift data types
│   │   └── RustBridge/          — UniFFI generated Swift bindings
│   └── ApproachVizTests/
├── crates/approach-viz-core/     — shared Rust core (add ios feature)
├── app/                          — existing Next.js web app
├── services/runtime-rs/          — existing backend (unchanged)
└── data/                         — SQLite DB (bundled in iOS app)
```

## Rendering

### Approach Path Tubes

- **Web**: Three.js TubeGeometry from CatmullRomCurve3, MeshStandardMaterial with vertex colors
- **iOS**: LowLevelMesh tube geometry (same algorithm ported to Swift), CustomMaterial with Metal surface shader for per-vertex color
- One Entity per leg segment (approach, transition, missed, hold), color-coded
- 8-segment radial cross-section, same as web

### Terrain Grid

- **Web**: PlaneGeometry with vertex Y displacement from Terrarium elevation tiles, wireframe material
- **iOS**: LowLevelMesh grid, vertex Y displaced by decoded elevation, CustomMaterial wireframe shader
- Same Terrarium tile source, decoded in Swift: `r×256 + g + b/256 - 32768`
- Tile fetching via URLSession + NSCache (replaces service worker caching)
- Configurable radius (20–80 NM)
- Wireframe rendering via barycentric coordinate technique: bake barycentric coords (vec3) into LowLevelMesh vertex attributes, fragment shader discards fill and draws edges only

### Waypoint Markers

- MeshResource.generateSphere (high-level API, no LowLevelMesh needed)
- Color-coded SimpleMaterial per fix type
- Altitude guide lines via LowLevelMesh line primitive
- Labels via SwiftUI overlay positioned from 3D→screen projection

### Runway Geometry

- MeshResource.generateBox — thin extruded rectangle
- SimpleMaterial, dark gray, positioned via Entity transform

### Camera System

- **CameraController.swift** — custom gesture-driven, no built-in orbit in RealityKit
- DragGesture → orbit (spherical coordinates around target point)
- MagnifyGesture → zoom (distance from target)
- Two-finger DragGesture → pan (translate target point)
- Spring animation for inertia/damping
- PerspectiveCamera entity with computed transform

### Coordinate System

- Same local NM tangent plane as web app (airport reference origin)
- X = East (NM), Z = North (NM), Y = Up (altitude in NM × vertical scale)
- RealityKit uses right-handed Y-up — same as Three.js, no coordinate gymnastics
- All WGS84→local conversion via Rust core `lat_lon_to_local()` through UniFFI

## Data Flow

### State Architecture

```swift
@Observable class AppState {
    var selectedAirport: Airport?
    var selectedApproach: Approach?
    var layerState: LayerState          // approach, airspace toggles
    var surfaceMode: SurfaceMode        // terrain only for MVP
    var verticalScale: Float            // 1.0–4.0
    var terrainRadius: Float            // 20–80 NM
    var sceneData: SceneData?           // populated async after selection
    var terrainData: TerrainData?       // populated async from tile fetches
}
```

### Loading Sequence

1. User taps airport → SQLite query (GRDB.swift) → Airport + [Approach] list
2. User picks approach → background Task loads waypoints, runways, airspace, CIFP legs
3. Rust core (UniFFI) resolves altitudes: `lat_lon_to_local()`, `alt_to_y()` for each fix
4. SceneData published → RealityView update closure builds/updates entities
5. Terrain tile fetch (async, URLSession) → decode elevation → merge grid → update LowLevelMesh

### SQLite

- Same `approach-viz.sqlite` built by `npm run build-db`, bundled as app asset (read-only, ~50–80 MB)
- Accessed via GRDB.swift (`DatabasePool`, readonly) — same schema and queries as web app's `lib/db.ts`
- Update strategy: new app version = new DB bundle (aligns with 28-day CIFP cycle)

### Concurrency

| Web App | iOS App |
|---------|---------|
| Web Worker + Comlink proxy | `Task { }` on background priority |
| postMessage + Transferable | Value types (structs) — no transfer needed |
| WASM init + function call | Direct UniFFI function call (native speed) |
| 8–12s timeout per call | Task cancellation via structured concurrency |
| SharedArrayBuffer + Atomics | Not needed — Swift actors for shared state |

## UniFFI Integration

### Feature Gate Strategy

The Rust core crate uses feature gates for platform-specific binding layers:

| Feature | Target | Binding Layer | Output |
|---------|--------|--------------|--------|
| `--features wasm` | wasm32-unknown-unknown | `wasm.rs` (wasm-bindgen) | .wasm + .js |
| `--features ios` | aarch64-apple-ios[-sim] | `ios.rs` (UniFFI) | .a + .swift |
| (none) | native host | Rust library only | .rlib (runtime-rs) |

### MVP UniFFI Exports (`ios.rs`)

```rust
#[uniffi::export]
fn lat_lon_to_local(lat: f64, lon: f64, ref_lat: f64, ref_lon: f64) -> (f64, f64);

#[uniffi::export]
fn alt_to_y(alt_feet: f64, vertical_scale: f64) -> f64;

#[uniffi::export]
fn earth_curvature_drop_nm(x_nm: f64, z_nm: f64, ref_lat: f64) -> f64;

#[uniffi::export]
fn geocentric_radius_nm(latitude_deg: f64) -> f64;

#[uniffi::export]
fn projection_scales_nm_per_degree(lat_deg: f64) -> (f64, f64);
```

Future phases add: `decode_and_prepare_mrms()`, `WasmTrafficState` equivalent, etc.

**Note:** UniFFI may require wrapping bare tuple returns like `(f64, f64)` in named structs (e.g., `LocalCoord { x: f64, z: f64 }`). Verify during implementation and adjust if needed.

### Build Pipeline

```bash
# Build Rust for iOS (device + simulator)
npm run build:ios
  → cargo build --target aarch64-apple-ios --features ios --release
  → cargo build --target aarch64-apple-ios-sim --features ios --release
  → cargo build --target x86_64-apple-ios --features ios --release
  → uniffi-bindgen generate → ios/ApproachViz/RustBridge/
  → lipo -create (universal sim binary: aarch64-apple-ios-sim + x86_64-apple-ios)

# Existing commands unchanged
npm run build:wasm    # web app WASM
npm run build-db      # SQLite DB (bundled into iOS app)
```

## Testing

| Layer | What | How |
|-------|------|-----|
| Rust unit tests | Coordinate math, data transforms | `cargo test --features ios` |
| UniFFI round-trip | Swift↔Rust type marshalling | XCTest calling UniFFI functions, verify against known web app outputs |
| Swift unit tests | ViewModels, services, data loading | XCTest with mock DB / mock API responses |
| SQLite integration | Query correctness | XCTest loading real approach-viz.sqlite |
| Scene snapshot | Visual regression | RealityKit snapshot → image comparison (manual initially) |
| Cross-platform parity | iOS vs web output matches | Golden test: same airport+approach → compare coordinate outputs (wasm vs ios feature) |

### Verification

```bash
# Rust tests with iOS feature
cargo test --features ios

# iOS app tests
npm run test:ios
  → xcodebuild test -scheme ApproachViz -destination 'platform=iOS Simulator'

# Cross-platform parity
# Run same airport (e.g., KJFK ILS 22L) through both wasm and ios features
# Compare lat_lon_to_local, alt_to_y outputs — must be identical
```

## MVP Scope (What's In / What's Out)

### In (Phase 1)

- Airport picker (search + select from bundled SQLite)
- Approach selector (list approaches for selected airport)
- 3D approach path tubes (color-coded by segment type)
- Waypoint markers with altitude guides
- Runway geometry
- Terrain wireframe surface (Terrarium tiles)
- Orbit/pan/zoom camera
- Vertical scale slider
- Terrain radius slider

### Out (Future Phases)

- MRMS weather volumes (Phase 2 — needs UniFFI decode_and_prepare_mrms)
- Echo-top surfaces (Phase 2)
- ADS-B live traffic (Phase 3 — needs UniFFI TrafficState)
- Satellite surface / Google 3D Tiles (Phase 2/3)
- Map/chart tile surfaces (Phase 2/3)
- FAA approach plate overlay (Phase 3)
- Airspace volumes (Phase 2)
- Storm cells / ProbSevere (Phase 3)
- Push notifications, offline mode, background updates
- App Store distribution

## Key Technical Risks

1. **RealityKit camera**: No built-in orbit camera — custom gesture system is the most novel code
2. **LowLevelMesh learning curve**: Relatively new API (iOS 18), less community examples than SceneKit
3. **UniFFI maturity**: Well-proven (Firefox, Signal) but complex types (Vec<f32> arrays) need careful marshalling
4. **Terrain tile performance**: Fetching + decoding many Terrarium PNGs on device — need aggressive caching
5. **App bundle size**: SQLite DB (~50–80 MB) + Rust static library — may need asset thinning strategy
