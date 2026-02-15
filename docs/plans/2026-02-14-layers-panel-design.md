# Layers Panel Design

Extract visibility toggles from the settings (gear) panel into a dedicated layers panel, with URL-encoded layer state using a delta-from-defaults format.

## Layer Definitions

7 independent layers, visually grouped in the layers panel:

| Group         | Layer ID   | Label           | Default |
| ------------- | ---------- | --------------- | ------- |
| _(ungrouped)_ | `approach` | Approach        | on      |
| _(ungrouped)_ | `airspace` | Airspace        | on      |
| _(ungrouped)_ | `adsb`     | ADS-B Traffic   | on      |
| Weather       | `mrms`     | MRMS 3D Precip  | on      |
| Weather       | `echotops` | Echo Tops       | off     |
| Weather       | `slice`    | Vertical Slice  | off     |
| Weather       | `guides`   | Altitude Guides | on      |

Each layer is a simple boolean (on/off).

## URL Encoding

Format: `?layers=-mrms,+slice` — delta from defaults.

- `+layerId` turns a default-off layer on.
- `-layerId` turns a default-on layer off.
- No `?layers=` param means pure defaults.
- Redundant entries (e.g. `+approach` when approach is default-on) are harmless no-ops; the app won't generate them.
- `?surface=` continues to work alongside `?layers=`. Example: `?surface=satellite&layers=-airspace,+echotops`.
- Parsing: start with the default set, apply each `+/-` delta. Invalid layer IDs are silently ignored.
- URL sync via `replaceState`: `?layers=` is included only when layer state diverges from defaults. If all layers match defaults, the param is omitted.
- localStorage: layer state is also persisted in `approach-viz:options:v1`. URL takes precedence over localStorage on page load (URL is the share mechanism; localStorage is the remember-my-preferences mechanism).

## Button Layout

Bottom-right FAB stack, bottom to top:

1. **Gear** (settings) — `bottom: 24px` (unchanged)
2. **Layers** (new) — `bottom: 72px` (between gear and recenter)
3. **Recenter** — `bottom: 120px` (shifted up by 48px)

The layers button uses a stacked-layers SVG icon, same size/style as existing FABs (40×40).

## Layers Panel

- Opens at `position: absolute; right: 24px; bottom: 24px`, same region as the gear panel.
- Mutually exclusive with the settings panel — opening one closes the other.
- Contains toggle switches for each layer, organized by group.
- Weather group has a subtle heading/divider.
- No sub-settings in the layers panel — purely visibility toggles.

## Reorganized Settings Panel (Gear)

Structured into sections by layer relevance. Master on/off toggles for layers are removed from the gear panel (they live in the layers panel now).

### General

- Vertical Scale (slider)
- Terrain Radius (slider)
- Flatten Bathymetry (checkbox)

### Approach

- Use Parsed Climb Gradient (checkbox) — disabled when approach layer is off

### ADS-B Traffic

- Hide Ground Traffic (checkbox) — disabled when adsb layer is off
- Show Callsigns (checkbox) — disabled when adsb layer is off
- Traffic History (slider) — disabled when adsb layer is off

### MRMS Weather

- Threshold (slider) — disabled when mrms layer is off
- Opacity (slider) — disabled when mrms layer is off
- Declutter / V cycles (dropdown) — disabled when mrms layer is off

### Vertical Slice

- Slice Heading (slider) — disabled when slice layer is off
- Slice Range (slider) — disabled when slice layer is off

## Migration / Backwards Compatibility

- Existing localStorage values for `nexradVolumeEnabled`, `liveTrafficEnabled`, `nexradShowEchoTops`, `nexradShowAltitudeGuides`, `nexradCrossSectionEnabled` are migrated to the new layer booleans on first load.
- Existing bookmarked URLs without `?layers=` continue to work (defaults apply).
- The `V` keyboard shortcut for cycling declutter mode continues to work unchanged.
