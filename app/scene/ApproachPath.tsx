/**
 * 3D Approach Path visualization
 * Renders waypoints, approach segments, and vertical reference lines
 */

import { memo, useEffect, useMemo, useState } from 'react';
import type { Approach, ApproachLeg, Airport, RunwayThreshold, Waypoint } from '@/lib/cifp/parser';
import type { MissedApproachClimbRequirement } from '@/lib/types';
import {
  applyGlidepathInsideFaf,
  resolveMissedApproachAltitudes,
  resolveSegmentAltitudes
} from './approach-path/altitudes';
import { resolveApproachAltitudesWithWorker } from './approach-path/approach-worker-client';
import { AirportMarker } from './approach-path/AirportMarker';
import { COLORS } from './approach-path/constants';
import { altToY, isHoldLeg, resolveWaypoint } from './approach-path/coordinates';
import { HoldPattern } from './approach-path/HoldPattern';
import { PathTube } from './approach-path/PathTube';
import { WaypointMarker } from './approach-path/WaypointMarker';
import { collectUniqueWaypoints } from './approach-path/waypointCollection';

interface ApproachPathProps {
  approach: Approach;
  waypoints: Map<string, Waypoint>;
  airport: Airport;
  runways: RunwayThreshold[];
  verticalScale: number;
  missedApproachStartAltitudeFeet?: number;
  minimumsLabel?: string;
  missedApproachClimbRequirement?: MissedApproachClimbRequirement | null;
  applyEarthCurvatureCompensation?: boolean;
  nearbyAirports: Array<{
    airport: Airport;
    runways: RunwayThreshold[];
    distanceNm: number;
  }>;
}

export const ApproachPath = memo(function ApproachPath({
  approach,
  waypoints,
  airport,
  runways,
  verticalScale,
  missedApproachStartAltitudeFeet,
  minimumsLabel,
  missedApproachClimbRequirement,
  applyEarthCurvatureCompensation = false,
  nearbyAirports
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

  const [resolvedAltitudes, setResolvedAltitudes] = useState<Map<ApproachLeg, number>>(new Map());
  const [missedPathAltitudes, setMissedPathAltitudes] = useState<Map<ApproachLeg, number>>(
    new Map()
  );

  useEffect(() => {
    let cancelled = false;
    const transitionEntries = Array.from(approach.transitions.entries());
    const setFallback = () => {
      const altitudes = new Map<ApproachLeg, number>();
      const finalAltitudes = resolveSegmentAltitudes(approach.finalLegs, waypoints, refLat, refLon);
      for (const [leg, altitude] of finalAltitudes.entries()) {
        altitudes.set(leg, altitude);
      }
      for (const [, legs] of transitionEntries) {
        const transitionAltitudes = resolveSegmentAltitudes(legs, waypoints, refLat, refLon);
        for (const [leg, altitude] of transitionAltitudes.entries()) {
          altitudes.set(leg, altitude);
        }
      }
      const missedAltitudes = resolveSegmentAltitudes(
        approach.missedLegs,
        waypoints,
        refLat,
        refLon
      );
      for (const [leg, altitude] of missedAltitudes.entries()) {
        altitudes.set(leg, altitude);
      }
      const glideAdjusted = applyGlidepathInsideFaf(
        approach.finalLegs,
        approach.missedLegs,
        altitudes,
        waypoints,
        refLat,
        refLon,
        airport.elevation
      );
      const missedAdjusted = resolveMissedApproachAltitudes(
        approach.missedLegs,
        glideAdjusted,
        waypoints,
        refLat,
        refLon,
        missedApproachStartAltitudeFeet,
        missedApproachClimbRequirement
      );
      if (cancelled) return;
      setResolvedAltitudes(glideAdjusted);
      setMissedPathAltitudes(missedAdjusted);
    };

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
        const nextMissed = new Map<ApproachLeg, number>();
        for (let i = 0; i < approach.missedLegs.length; i += 1) {
          nextMissed.set(approach.missedLegs[i], resolved.missedPathAltitudes[i] ?? 0);
        }
        setResolvedAltitudes(nextResolved);
        setMissedPathAltitudes(nextMissed);
      })
      .catch(() => {
        setFallback();
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
    missedApproachClimbRequirement
  ]);

  const finalPathLegs = useMemo(() => {
    if (approach.finalLegs.length === 0) {
      return approach.finalLegs;
    }

    const mapLeg = approach.missedLegs[0];
    if (!mapLeg) {
      return approach.finalLegs;
    }

    if (!resolveWaypoint(waypoints, mapLeg.waypointId)) {
      return approach.finalLegs;
    }

    return [...approach.finalLegs, mapLeg];
  }, [approach.finalLegs, approach.missedLegs, waypoints]);

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
      <AirportMarker
        airport={airport}
        runways={runways}
        verticalScale={verticalScale}
        refLat={refLat}
        refLon={refLon}
        runwayColor={COLORS.runway}
        airportLabelColor={COLORS.runway}
        showRunwayLabels
        applyEarthCurvatureCompensation={applyEarthCurvatureCompensation}
      />

      {nearbyAirports.map(({ airport: nearbyAirport, runways: nearbyRunways }) => (
        <AirportMarker
          key={`nearby-${nearbyAirport.id}`}
          airport={nearbyAirport}
          runways={nearbyRunways}
          verticalScale={verticalScale}
          refLat={refLat}
          refLon={refLon}
          runwayColor={COLORS.nearbyRunway}
          airportLabelColor={COLORS.nearbyAirport}
          showRunwayLabels={false}
          applyEarthCurvatureCompensation={applyEarthCurvatureCompensation}
        />
      ))}

      {uniqueWaypoints.map((wp) => (
        <WaypointMarker
          key={wp.key}
          position={[wp.x, altToY(wp.altitude, verticalScale), wp.z]}
          name={wp.name}
          altitudeLabel={wp.altitudeLabel}
        />
      ))}

      {finalPathLegs.length > 0 && (
        <PathTube
          legs={finalPathLegs}
          waypoints={waypoints}
          resolvedAltitudes={resolvedAltitudes}
          initialAltitudeFeet={airport.elevation}
          verticalScale={verticalScale}
          refLat={refLat}
          refLon={refLon}
          magVar={airport.magVar}
          color={COLORS.approach}
          dashedBelowAltitudeFeet={missedApproachStartAltitudeFeet}
          dashedBelowLabel={minimumsLabel}
        />
      )}

      {Array.from(approach.transitions.entries()).map(([name, legs]) => (
        <PathTube
          key={name}
          legs={legs}
          waypoints={waypoints}
          resolvedAltitudes={resolvedAltitudes}
          initialAltitudeFeet={airport.elevation}
          verticalScale={verticalScale}
          refLat={refLat}
          refLon={refLon}
          magVar={airport.magVar}
          color={COLORS.transition}
        />
      ))}

      {approach.missedLegs.length > 0 && (
        <PathTube
          legs={approach.missedLegs}
          waypoints={waypoints}
          resolvedAltitudes={missedPathAltitudes}
          initialAltitudeFeet={airport.elevation}
          verticalScale={verticalScale}
          refLat={refLat}
          refLon={refLon}
          magVar={airport.magVar}
          color={COLORS.missed}
          showTurnConstraintLabels
        />
      )}

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
        />
      ))}
    </group>
  );
});
