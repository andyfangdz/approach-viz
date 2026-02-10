# Rendering Coordinate System

- Coordinates are local NM relative to the selected airport reference point.
- Local lat/lon to scene-coordinate conversion uses WGS84 radii-of-curvature at the selected-airport latitude (east/north tangent-plane approximation).
- Published CIFP leg/hold courses are magnetic; when synthesizing geometry from course values (for example holds or `CA` legs), convert to true heading using airport magnetic variation.
- Vertical scale is user-adjustable from the header slider and is applied consistently to approach paths/waypoints/holds, terrain wireframe, and Class B/C/D airspace volumes.
- Live ADS-B traffic markers/trails use the same local NM conversion and vertical-scale transform as the approach geometry.
- Optional live ADS-B callsign labels are anchored at each marker in the same local coordinate frame and follow marker altitude updates.
- In satellite/3D plate modes, live ADS-B traffic altitude is curvature-compensated (`altitudeFeet - earthCurvatureDrop`) so markers remain aligned to curved tiled surfaces.
- Airspace sectors with floors at/near sea level (<= `100 ft MSL`) omit their bottom caps and bottom perimeter edge segments to avoid coplanar shimmering against sea-level-aligned surface meshes (plate and clamped satellite/3D tiles).
- Header includes a `Recenter View` control that resets camera position and orbit target to airport-centered defaults.
