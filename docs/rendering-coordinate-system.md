# Rendering Coordinate System

- Coordinates are local NM relative to the selected airport reference point.
- Local lat/lon to scene-coordinate conversion uses WGS84 radii-of-curvature at the selected-airport latitude (east/north tangent-plane approximation).
- Published CIFP leg/hold courses are magnetic; when synthesizing geometry from course values (for example holds or `CA` legs), convert to true heading using airport magnetic variation.
- Vertical scale is user-adjustable from the header slider and is applied consistently to approach paths/waypoints/holds, terrain wireframe, and Class B/C/D airspace volumes.
- Header includes a `Recenter View` control that resets camera position and orbit target to airport-centered defaults.
