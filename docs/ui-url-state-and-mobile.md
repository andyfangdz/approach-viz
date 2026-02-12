# UI, URL State, and Mobile

User-interface layout, URL-driven state, options panel, mobile adaptations, and PWA metadata.

## URL State

- Airport selection is encoded in the URL path: `/<AIRPORT>` or `/<AIRPORT>/<PROCEDURE_ID>`.
- Surface mode is a query parameter: `?surface=terrain`, `?surface=plate`, `?surface=3dplate`, or `?surface=satellite`.

## Options Panel

- Exposed controls: `Vertical Scale` (1.0–15.0×, step 0.5×), `Terrain Radius` (20–80 NM, step 5, default 50), `Flatten Bathymetry` toggle, `Live ADS-B Traffic`, `MRMS 3D Precip`, `MRMS Threshold` (5–60 dBZ), `MRMS Opacity` (20–100%), `Hide Ground Traffic`, `Show Traffic Callsigns`, and `Traffic History` (1–30 min).
- Live traffic is enabled by default; MRMS volumetric overlay is enabled by default; `Hide Ground Traffic` is disabled by default; default traffic history window is 3 min.
- All options-panel values are persisted to browser `localStorage` and restored on load.

## Runtime Status and Debug UI

- When MRMS overlay polling is active, a top-right in-scene status chip (`Loading MRMS...`) appears beneath the navbar/selector region.
- A right-side debug FAB expands into a runtime diagnostics panel with current context plus MRMS/traffic telemetry (enabled/loading/stale/error, voxel/track counts, phase mix, MRMS phase-source mode, aux age/timestamp telemetry, poll timestamps, and backfill state).
- MRMS and traffic debug panel state is fed from scene overlays via callback props, so telemetry reflects the currently rendered overlay state rather than cached UI assumptions.

## Header and Selector Layout

- Airport/approach selectors use `react-select` searchable comboboxes.
- Search query state is owned by `HeaderControls` (not `AppClient`) to keep high-frequency keystrokes local to the header and avoid scene re-renders.
- Selector-collapse toggle uses chevron icon states (up/down) with accessible show/hide labels.
- Expanded selector controls render as an overlay panel (absolute-positioned beneath the header row), so opening selectors does not push/reflow the scene canvas.

## Camera and Scene Controls

- Recenter camera control is a dedicated bottom-right floating button (`recenter-fab`) stacked above the options FAB.
- Scene `Html` labels (waypoints, holds, runway text, turn constraints, traffic callsigns) use capped `zIndexRange` so selector/options/legend overlays remain above scene text.
- Bottom-right help panel is error-only; static drag/scroll interaction hints are not shown.

## Mobile Defaults (≤ 900 px)

- Selectors are collapsed by default.
- Legend content is collapsed by default.
- Floating legend/options/recenter controls use safe-area-aware elevated bottom offset (`env(safe-area-inset-bottom) + 68px`) to reduce iOS address-bar overlap.
- The expanded options panel also uses the same safe-area-aware bottom offset.
- Touch/drag interactions in the 3D scene suppress iOS text selection/callout overlays (`user-select: none`, `touch-action: none`), while selector text inputs remain editable.

## App Icons and PWA

- Web manifest at `/manifest.webmanifest` via `app/manifest.ts`.
- App icon assets: `app/favicon.ico`, `app/icon.png`, `app/apple-icon.png` (Next.js metadata file conventions).
- PWA install thumbnails: `public/icon-192.png` and `public/icon-512.png`.
- Theme color for browser chrome/PWA surfaces is configured in `app/layout.tsx` viewport metadata.
