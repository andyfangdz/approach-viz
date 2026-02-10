# Rendering — NEXRAD Weather Radar

## Overview

NEXRAD (WSR-88D) Level II reflectivity data is rendered as a 3D volumetric overlay in the scene, allowing pilots to visualize weather returns in the context of approach paths and airspace. The volume is rendered using GPU ray marching through a 3D texture, providing smooth translucent weather visualization.

## Data Flow

1. **Station Selection**: The nearest WSR-88D radar station is determined from a built-in station list (`app/scene/nexrad/stations.ts`, ~160 stations) using haversine distance from the selected airport.

2. **Data Fetch**: The API route (`app/api/nexrad/route.ts`) fetches the latest volume scan from the AWS S3 public bucket `unidata-nexrad-level2` (no authentication required). Files are ~2-5 MB compressed. The route lists the bucket for today's date prefix, falling back to yesterday near midnight UTC.

3. **Server-Side Parsing**: The `nexrad-level-2-data` npm package parses the binary NEXRAD archive format (Message Type 31, super-resolution). All elevation sweeps are iterated and high-resolution reflectivity data is extracted.

4. **Voxelization**: Polar radar data (azimuth, elevation angle, slant range) is converted to Cartesian coordinates using the 4/3 effective earth radius standard refraction model, then mapped into a regular 3D grid (128 x 128 x 48 voxels). Each voxel stores the maximum dBZ value from all samples that fall within it, encoded as a single byte (0 = no data, 1-255 = dBZ mapped from -32 to 94.5).

5. **Binary Response**: The API returns a binary payload: UTF-8 JSON metadata + null byte separator + raw voxel bytes. Metadata includes station info, grid dimensions, radius, altitude ceiling, scan time, and VCP number.

6. **Client Rendering**: The client creates a `Data3DTexture` from the voxel bytes and renders it using a custom volumetric ray marching shader.

## Coordinate Mapping

- The voxel grid covers ±`radiusNm` (default 120 NM) horizontally around the radar station and 0 to 50,000 ft vertically.
- The radar station is positioned in the scene's local NM frame using the same `latLonToLocal()` transform as other scene elements.
- Vertical scale is applied consistently with the rest of the scene via the `verticalScale` uniform.

## Volumetric Ray Marching Shader

The rendering uses a two-pass approach on a box geometry enclosing the radar volume:

- **Vertex shader**: Passes camera origin and ray direction to the fragment shader.
- **Fragment shader**:
  - Computes ray-box intersection to find entry/exit points.
  - Steps through the volume at regular intervals (step size configurable via `uStepSize`).
  - Samples the 3D texture at each step point (coordinate axes remapped: scene Y-up → texture Z).
  - Looks up the reflectivity color from a 1D colormap texture (NWS-style palette).
  - Accumulates color using front-to-back alpha compositing.
  - Early terminates when accumulated opacity exceeds 0.98.
  - Uses additive blending and double-sided rendering for correct appearance from all angles.

## NWS Reflectivity Colormap

The colormap (`app/scene/nexrad/colormap.ts`) follows the standard NWS reflectivity color scale:

| dBZ Range | Color | Opacity |
|-----------|-------|---------|
| < 5 | Transparent | 0% |
| 5-15 | Teal/gray | 15-25% |
| 15-20 | Blue | 25% |
| 20-30 | Green | 30-35% |
| 30-40 | Yellow → Orange | 40-55% |
| 40-50 | Orange → Red | 55-70% |
| 50-60 | Red → Dark red | 70-80% |
| 60-70 | Magenta | 80-90% |
| 70+ | White/pink | 90-100% |

Colors are stored as a 256×1 RGBA `DataTexture` with linear filtering for smooth interpolation.

## User Controls

- **NEXRAD Weather Radar** toggle: Enables/disables the radar overlay (default: off).
- **Radar Opacity** slider: Controls the overall opacity multiplier (10-100%, default 60%).
- Both settings are persisted to localStorage with the other options.

## Polling and Caching

- The client polls the API every 5 minutes (matching typical volume scan cadence).
- The API response is cached for 4 minutes with 2-minute stale-while-revalidate.
- When the airport changes, the previous radar data is cleared and a fresh fetch starts.

## Performance Notes

- The 3D texture is 128×128×48 × 1 byte = ~786 KB of GPU memory.
- Ray marching is limited to 512 steps maximum per fragment.
- The volume is rendered with `depthWrite: false` and additive blending to layer correctly with other scene elements.
- Textures (3D volume + 1D colormap) are disposed on unmount.

## Files

| File | Role |
|------|------|
| `app/api/nexrad/route.ts` | API proxy: S3 fetch, parse, voxelize |
| `app/scene/NexradVolume.tsx` | R3F component: fetch, texture creation, mesh rendering |
| `app/scene/nexrad/stations.ts` | WSR-88D station list + nearest-station lookup |
| `app/scene/nexrad/shaders.ts` | GLSL vertex/fragment shaders for volumetric ray marching |
| `app/scene/nexrad/colormap.ts` | NWS reflectivity colormap → DataTexture |
