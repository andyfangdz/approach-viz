# Rendering Approach Geometry

## Final Approach Vertical Profile

- Final approach glidepath is derived from VDA/TCH behavior and extended to MAP/threshold depiction when available.
- Altitude-profile resolution (final/transition/missed) and path-geometry assembly run through a worker-backed compute path, keeping large procedure recomputes off the main render thread without synchronous main-thread fallback.
- Path-geometry worker responses return a flat transferable `Float32Array` point buffer (`pointsFlat`) instead of tuple arrays, reducing worker->main thread clone overhead on large procedures.
- CIFP approach continuation records (`F` subsection continuation `2` / application type `W`) are parsed as level-of-service/RNP values and are not treated as VDA.
- FAF vertical angle for glidepath rendering is sourced from matched approach metadata (`approaches.json` `vertical_profile.vda`) when available, preventing CIFP level-of-service codes (for example `A152`) from being misread as descent angle.
- If runway-anchored glidepath math would cause an immediate climb after FAF (for example steep VDA with FAF at/above constraints), final-path altitude falls back to smooth FAF-to-MAP interpolation to prevent abrupt altitude spikes.
- The portion of the final approach path below MDA/DA is rendered as a dashed line instead of a solid tube, visually distinguishing the segment below minimums. The split point is interpolated exactly at the MDA/DA crossing altitude, and a waypoint-style marker labeled "MDA" or "DA" (with altitude) is placed at that crossing point. When no minimums data is available, the entire path renders as a solid tube.

## Missed Approach Vertical Profile

- Missed-approach path rendering starts at the MAP using selected minimums DA (or MDA fallback), and the missed profile climbs immediately from MAP by interpolating toward the next higher published missed-leg altitude targets (non-descending); this does not change final-approach glidepath-to-runway depiction.
- Minimums selection prefers Cat A values when available; if Cat A is unavailable for a minima line, the app falls back to the lowest available category (B/C/D), displays that category in the minimums panel, and uses it for missed-approach start altitude.
- When FAA approach metadata `missed_instructions` contains explicit missed-climb text (`minimum climb of X feet per NM to Y`), missed-profile rendering can enforce that published climb floor from MAP; the options panel lets users switch between this parsed/published gradient and the standard default gradient, with parsed/published selected by default when available and automatic standard fallback when unavailable.
- Missed-profile distance interpolation treats no-fix `CA` legs as short climb segments (distance estimated from climb requirement), preventing exaggerated straight-out segments before turns when a CA leg precedes turn-to-fix legs.
- Missed-approach interpolation handles legs without direct fix geometry using neighbor-leg distance fallback.

## Missed Turn and Join Geometry

- For missed segments with `CA` followed by fix-join legs (`DF`/`CF`/`TF`), geometry is conditional:
  - non-climbing (or near-level) `CA` uses a local course-to-fix turn join from MAP for immediate turn behavior.
  - climbing `CA` renders a straight climb-out segment first, then turns toward the downstream fix leg.
- The missed `CA->(DF/CF/TF)` change of course is rendered with a curved course-to-fix join (not a hard corner), including cases with large heading reversal after climb-out.
- `CA->(DF/CF/TF)` turn joins use a radius-constrained arc+tangent model with a minimum turn radius to avoid snap/instant-reversal geometry.
- `CA->(DF/CF/TF)` turn direction is chosen from heading-to-fix bearing delta (preferred side), with opposite-side fallback only when the preferred geometry is infeasible.
- When available, explicit turn direction published on the downstream fix leg descriptor (`L`/`R`) overrides geometric inference for `CA->(DF/CF/TF)` turn joins.
- Curved `CA->(DF/CF/TF)` turn joins are applied only when the downstream fix leg turn direction is explicitly published; otherwise missed geometry remains straight/linear to avoid synthetic loops.
- Missed `CA->(DF/CF/TF)` turn initiation points display altitude callouts only for meaningful published `CA` climb constraints (not derived/interpolated profile altitudes).
- Missed direct fix-join legs (`CF`/`DF`/`TF` to `CF`/`DF`/`TF`) also render as curved climbing turns when the downstream leg publishes explicit turn direction (`L`/`R`), using the inbound heading from the previous segment instead of hard-cornering at the first fix.
- The first missed fix-join leg can also curve directly from the last final-approach segment when that first missed leg publishes explicit turn direction, so MAP-to-missed transitions do not hard-corner at the runway end.
- When that downstream missed leg is `CF` with a published course/radial, the join turns to intercept the published course before the fix (rather than turning directly to the fix).

## No-Fix Heading Legs and Arc Legs

- Missed `VI` (heading-to-intercept) legs without a fix are rendered as short heading stubs with radius-constrained heading-transition arcs (about `0.55..0.9 NM` turn radius) before joining downstream fix legs; downstream fix joins use published turn direction when available, otherwise geometric turn-side resolution.
- Missed no-fix heading legs (`VI`, `VA`, `VR`, `VD`, `VM`, `CI`, `CD`) are synthesized as short heading stubs so radial/intercept-style legs are visible even when CIFP omits waypoint geometry.
- When those no-fix heading legs feed a downstream `CF` leg with a published course, the join intercepts the published inbound course before the fix (instead of turning directly to the fix), improving radial-intercept depiction (for example `KSAV I10` missed).
- Course-from-fix legs (`FA`/`FC`/`FD`/`FM`) originate at a named fix and proceed outbound along the published course; the outbound apex is the fix projected along the published course (by the published leg distance for `FC`/`FD`, a default length for `FA`/`FM`). When such a leg begins a teardrop/course-reversal (next is a `CI`/`VI` intercept, see below) the straight outbound is folded into the reversal arc; otherwise it draws as an outbound segment from the fix rather than collapsing back onto the fix waypoint.
- A teardrop/course-reversal (course-from-fix outbound + a no-fix `CI`/`VI` intercept, for example the `KDDC I14` `FLACK` transition at `OWENJ`) is rendered as a **single smooth circular arc** through the outbound fix and the outbound apex that **rolls out tangent onto the final approach course at an interior point** — one continuous curve with no straight outbound leg. The outbound apex distance used to shape the arc is capped (`TEARDROP_MAX_OUTBOUND_NM`) so a long published outbound leg does not bulge the loop far past the course fix, keeping the teardrop compact (near the course fix's level). The roll-out point is the tangent point of the circle (through the outbound fix and the capped apex) with the course line (`course_reversal_rollout_point`), an interior point on the course, not the course fix itself; `build_arc_through_three_points` draws the arc from the outbound fix through the apex to that tangent point, and the transition terminates there (the final approach segment shows the course inbound from the roll-out). The scene composition (web `app/scene/ApproachPath.tsx` and iOS `ApproachPathGeometry.swift`) supplies the final approach course by appending its first course-carrying fix leg (the FAF/localizer leg) to a transition ending in `CI`/`VI` before geometry assembly; that appended leg is consumed by the reversal (it defines the course/roll-out) and is not drawn as a separate inbound segment.
- As an engine-level fallback (when no roll-out fix is available to append), a terminal `CI`/`VI` intercept immediately after a course-from-fix outbound leg is drawn as a single broad, continuous turn (its own wider radius band scaled to the outbound leg length, not the tight `VI` heading-stub radius that renders a sharp spike) plus an inbound leg along the published intercept course mirroring the outbound distance (capped), so it still completes the reversal instead of dead-ending at a stub.
- `RF` and `AF` (DME arc) legs are rendered as arcs using published center fixes and turn direction.
- `CA` legs without fix geometry are synthesized along published course, with length constrained by climb and capped relative to the next known-fix leg to avoid exaggerated runway-heading extensions before turns; non-climbing (or lower-altitude) `CA` legs use a very short stub so missed approaches can turn immediately.
- Airport/runway context markers (selected airport + nearby airports/runways) render even when the selected procedure has no CIFP geometry.
