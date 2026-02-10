# Rendering Coordinate System

- Coordinates are local NM relative to the selected airport reference point.
- Local lat/lon to scene-coordinate conversion uses WGS84 radii-of-curvature at the selected-airport latitude (east/north tangent-plane approximation).
- Published CIFP leg/hold courses are magnetic; when synthesizing geometry from course values (for example holds or `CA` legs), convert to true heading using airport magnetic variation.
- Vertical scale is user-adjustable from the options panel slider and is applied consistently to approach paths/waypoints/holds, terrain wireframe, and Class B/C/D airspace volumes.
- Live ADS-B traffic markers/trails use the same local NM conversion and vertical-scale transform as the approach geometry.
- Optional live ADS-B callsign labels are anchored slightly above each marker in the same local coordinate frame, follow marker altitude updates, and render as text-only overlays (no bounding box).
- In satellite/3D plate modes, live ADS-B traffic altitude is curvature-compensated (`altitudeFeet - earthCurvatureDrop`) so markers remain aligned to curved tiled surfaces.
- Airspace sectors with floors at/near sea level (<= `100 ft MSL`) omit their bottom caps and bottom perimeter edge segments to avoid coplanar shimmering against sea-level-aligned surface meshes (plate and clamped satellite/3D tiles).
- A bottom-right floating `Recenter View` control resets camera position and orbit target to airport-centered defaults.
- On mobile (`<=900px`), floating legend/options/recenter controls use an elevated safe-area-aware bottom offset (`env(safe-area-inset-bottom) + 68px`) to avoid iOS browser chrome overlap.
