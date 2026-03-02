# FAA Chart Map Surface + Plate Overlay

## Summary

Add two new surface modes (`map`, `3dmap`) for FAA aeronautical chart tiles, and refactor approach plates from standalone surface modes into an independent overlay toggle available on all surface modes.

## Surface Modes

Replace the current four modes (`terrain | plate | 3dplate | satellite`) with:

| Mode | Description |
|------|-------------|
| `terrain` | Terrarium wireframe (unchanged) |
| `satellite` | Google Photorealistic 3D Tiles (unchanged) |
| `map` | Flat textured plane with FAA chart tiles |
| `3dmap` | FAA chart tiles draped on Google 3D Tiles |

The `plate` and `3dplate` modes are removed as surface modes.

## Plate Overlay

Approach plates become an independent boolean toggle, available on all four surface modes:

- `terrain` + plate: plate mesh over wireframe (current `plate` behavior)
- `satellite` + plate: plate projected onto 3D Tiles (current `3dplate` behavior)
- `map` + plate: plate mesh over flat chart tiles
- `3dmap` + plate: plate projected onto 3D Tiles with chart tile base

Only visible when an approach with plate metadata is selected.

## Chart Type Picker

Sub-selector for `map` and `3dmap` modes:

- **VFR** — FAA VFR Sectional Charts (zoom 8-12)
- **IFR Low** — FAA IFR Low Enroute Charts (zoom 7-12)
- **IFR High** — FAA IFR High Enroute Charts (zoom 5-9)

Default: VFR.

## URL State

```
?surface=terrain|satellite|map|3dmap
&plate=on           (omitted when off)
&chart=vfr|low|high (omitted when vfr or not in map/3dmap mode)
```

### Migration

- `?surface=plate` → `?surface=terrain&plate=on`
- `?surface=3dplate` → `?surface=satellite&plate=on`

## UI

- **Header toggle bar:** `Terrain | Satellite | Map | 3D Map`
- **Plate overlay toggle:** Separate toggle near surface buttons, visible when an approach plate is available
- **Chart picker:** Segmented control or dropdown visible when `map` or `3dmap` is active: `VFR | IFR Low | IFR High`

## Tile Sources

Public FAA ArcGIS tile services. No API key required. 256x256 PNG tiles in Web Mercator (EPSG:3857).

```
VFR:      https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}
IFR Low:  https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_AreaLow/MapServer/tile/{z}/{y}/{x}
IFR High: https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_High/MapServer/tile/{z}/{y}/{x}
```

## Rendering

### `map` (flat)

Fetch chart tiles for the viewport area at an appropriate zoom level. Composite tiles onto a canvas texture and apply to a flat PlaneGeometry positioned at airport elevation. Service worker cached.

### `3dmap` (3D)

Google 3D Tiles with chart tile texture replacing satellite imagery via shader patching (same approach as current `3dplate`).

### Plate overlay on flat modes

ApproachPlateSurface rendered with a small positive Y offset above the base surface to avoid z-fighting.

### Plate overlay on 3D modes

Same shader injection technique as the current `3dplate` implementation.
