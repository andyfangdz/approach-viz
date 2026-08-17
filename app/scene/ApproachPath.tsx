/**
 * 3D Approach Path visualization
 * Renders waypoints, approach segments, and vertical reference lines
 */

import { memo, useEffect, useMemo, useState } from 'react';
import type { Approach, ApproachLeg, Airport, Waypoint } from '@/lib/cifp/parser';
import type { MissedApproachClimbRequirement } from '@/lib/types';
import { resolveApproachAltitudesWithWorker } from './approach-path/approach-worker-client';
import { COLORS } from './approach-path/constants';
import { altToY, isHoldLeg } from './approach-path/coordinates';
import { HoldPattern } from './approach-path/HoldPattern';
import { PathTube } from './approach-path/PathTube';
import { WaypointMarker } from './approach-path/WaypointMarker';
import { collectUniqueWaypoints } from './approach-path/waypointCollection';

interface ApproachPathProps {
  approach: Approach;
  waypoints: Map<string, Waypoint>;
  airport: Airport;
  verticalScale: number;
  missedApproachStartAltitudeFeet?: number;
  minimumsLabel?: string;
  missedApproachClimbRequirement?: MissedApproachClimbRequirement | null;
  showHoldProtectedAreas?: boolean;
}

type ComposedPathSegment = {
  kind: string;
  name?: string | null;
  legs: ApproachLeg[];
  resolvedAltitudes: number[];
  showTurnConstraintLabels: boolean;
};

export const ApproachPath = memo(function ApproachPath({
  approach,
  waypoints,
  airport,
  verticalScale,
  missedApproachStartAltitudeFeet,
  minimumsLabel,
  missedApproachClimbRequirement,
  showHoldProtectedAreas = false
}: ApproachPathProps) {
  const refLat = airport.lat;
  const refLon = airport.lon;

  const allLegs = useMemo(() => {
    const legs: ApproachLeg[] = [];
    legs.push(...approach.finalLegs);
    for (const [, transitionLegs] of approach.transitions) {
      legs.push(...transitionLegs);
    }
    legs.push(...approach.missedLegs);
    return legs;
  }, [approach]);

  const compositionKey = `${airport.id}:${approach.procedureId}`;
  const [composed, setComposed] = useState<{
    key: string;
    altitudes: Map<ApproachLeg, number>;
    segments: ComposedPathSegment[];
  }>(() => ({
    key: compositionKey,
    altitudes: new Map(),
    segments: []
  }));

  // Reset during render so React discards the mismatched commit. An effect-only
  // clear would still paint one frame of the previous procedure at the new
  // airport/waypoint frame.
  if (composed.key !== compositionKey) {
    setComposed({
      key: compositionKey,
      altitudes: new Map(),
      segments: []
    });
  }

  const resolvedAltitudes = composed.key === compositionKey ? composed.altitudes : new Map();
  const pathSegments = composed.key === compositionKey ? composed.segments : [];

  useEffect(() => {
    let cancelled = false;
    const transitionEntries = Array.from(approach.transitions.entries());

    void resolveApproachAltitudesWithWorker({
      finalLegs: approach.finalLegs,
      transitionEntries,
      missedLegs: approach.missedLegs,
      waypoints: Array.from(waypoints.entries()),
      refLat,
      refLon,
      airportElevation: airport.elevation,
      missedApproachStartAltitudeFeet,
      missedApproachClimbRequirement
    })
      .then((resolved) => {
        if (cancelled) return;
        const nextResolved = new Map<ApproachLeg, number>();
        for (let i = 0; i < approach.finalLegs.length; i += 1) {
          nextResolved.set(approach.finalLegs[i], resolved.finalAltitudes[i] ?? 0);
        }
        for (let t = 0; t < transitionEntries.length; t += 1) {
          const [, legs] = transitionEntries[t];
          const transition = resolved.transitionAltitudes[t]?.[1] ?? [];
          for (let i = 0; i < legs.length; i += 1) {
            nextResolved.set(legs[i], transition[i] ?? 0);
          }
        }
        for (let i = 0; i < approach.missedLegs.length; i += 1) {
          nextResolved.set(approach.missedLegs[i], resolved.missedAltitudes[i] ?? 0);
        }
        setComposed({
          key: compositionKey,
          altitudes: nextResolved,
          segments: resolved.composed.segments
        });
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('Approach altitude worker failed.', error);
        setComposed({
          key: compositionKey,
          altitudes: new Map(),
          segments: []
        });
      });

    return () => {
      cancelled = true;
    };
  }, [
    approach.finalLegs,
    approach.transitions,
    approach.missedLegs,
    waypoints,
    refLat,
    refLon,
    airport.elevation,
    missedApproachStartAltitudeFeet,
    missedApproachClimbRequirement,
    compositionKey
  ]);

  const uniqueWaypoints = useMemo(
    () => collectUniqueWaypoints(allLegs, waypoints, resolvedAltitudes, refLat, refLon),
    [allLegs, waypoints, resolvedAltitudes, refLat, refLon]
  );

  const holdLegs = useMemo(() => allLegs.filter((leg) => isHoldLeg(leg)), [allLegs]);

  const holdAltitudes = useMemo(() => {
    const altitudes = new Map<ApproachLeg, number>();
    for (const leg of holdLegs) {
      altitudes.set(leg, resolvedAltitudes.get(leg) ?? leg.altitude ?? airport.elevation);
    }
    return altitudes;
  }, [holdLegs, resolvedAltitudes, airport.elevation]);

  return (
    <group>
      {uniqueWaypoints.map((wp) => (
        <WaypointMarker
          key={wp.key}
          position={[wp.x, altToY(wp.altitude, verticalScale), wp.z]}
          name={wp.name}
          altitudeLabel={wp.altitudeLabel}
        />
      ))}

      {pathSegments
        .filter((segment) => segment.kind === 'final')
        .map((segment, index) => (
          <PathTube
            key={`final-${index}`}
            legs={segment.legs}
            waypoints={waypoints}
            resolvedAltitudes={segment.resolvedAltitudes}
            initialAltitudeFeet={airport.elevation}
            verticalScale={verticalScale}
            refLat={refLat}
            refLon={refLon}
            magVar={airport.magVar}
            color={COLORS.approach}
            dashedBelowAltitudeFeet={missedApproachStartAltitudeFeet}
            dashedBelowLabel={minimumsLabel}
          />
        ))}

      {pathSegments
        .filter((segment) => segment.kind === 'transition')
        .map((segment, index) => (
          <PathTube
            key={segment.name ?? `transition-${index}`}
            legs={segment.legs}
            waypoints={waypoints}
            resolvedAltitudes={segment.resolvedAltitudes}
            initialAltitudeFeet={airport.elevation}
            verticalScale={verticalScale}
            refLat={refLat}
            refLon={refLon}
            magVar={airport.magVar}
            color={COLORS.transition}
          />
        ))}

      {pathSegments
        .filter((segment) => segment.kind === 'missed')
        .map((segment, index) => (
          <PathTube
            key={`missed-${index}`}
            legs={segment.legs}
            waypoints={waypoints}
            resolvedAltitudes={segment.resolvedAltitudes}
            initialAltitudeFeet={airport.elevation}
            verticalScale={verticalScale}
            refLat={refLat}
            refLon={refLon}
            magVar={airport.magVar}
            color={COLORS.missed}
            showTurnConstraintLabels={segment.showTurnConstraintLabels}
          />
        ))}

      {holdLegs.map((leg, index) => (
        <HoldPattern
          key={`hold-${index}-${leg.sequence}-${leg.waypointId}-${leg.pathTerminator}-${leg.isMissedApproach ? 'm' : 'f'}`}
          leg={leg}
          altitudeOverride={holdAltitudes.get(leg) ?? leg.altitude ?? airport.elevation}
          waypoints={waypoints}
          refLat={refLat}
          refLon={refLon}
          magVar={airport.magVar}
          color={COLORS.hold}
          verticalScale={verticalScale}
          showProtectedArea={showHoldProtectedAreas}
        />
      ))}
    </group>
  );
});
