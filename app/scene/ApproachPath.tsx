/**
 * 3D Approach Path visualization
 * Renders waypoints, approach segments, and vertical reference lines
 */

import { memo, useMemo } from 'react';
import type { Approach, ApproachLeg, Airport, RunwayThreshold, Waypoint } from '@/lib/cifp/parser';
import {
  applyGlidepathInsideFaf,
  resolveMissedApproachAltitudes,
  resolveSegmentAltitudes
} from './approach-path/altitudes';
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

  const resolvedAltitudes = useMemo(() => {
    const altitudes = new Map<ApproachLeg, number>();
    const finalAltitudes = resolveSegmentAltitudes(approach.finalLegs, waypoints, refLat, refLon);
    for (const [leg, altitude] of finalAltitudes.entries()) {
      altitudes.set(leg, altitude);
    }

    for (const legs of approach.transitions.values()) {
      const transitionAltitudes = resolveSegmentAltitudes(legs, waypoints, refLat, refLon);
      for (const [leg, altitude] of transitionAltitudes.entries()) {
        altitudes.set(leg, altitude);
      }
    }

    const missedAltitudes = resolveSegmentAltitudes(approach.missedLegs, waypoints, refLat, refLon);
    for (const [leg, altitude] of missedAltitudes.entries()) {
      altitudes.set(leg, altitude);
    }

    return applyGlidepathInsideFaf(
      approach.finalLegs,
      approach.missedLegs,
      altitudes,
      waypoints,
      refLat,
      refLon,
      airport.elevation
    );
  }, [approach, airport.elevation, waypoints, refLat, refLon]);

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

  const missedPathAltitudes = useMemo(
    () =>
      resolveMissedApproachAltitudes(
        approach.missedLegs,
        resolvedAltitudes,
        waypoints,
        refLat,
        refLon,
        missedApproachStartAltitudeFeet
      ),
    [
      approach.missedLegs,
      missedApproachStartAltitudeFeet,
      resolvedAltitudes,
      waypoints,
      refLat,
      refLon
    ]
  );

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
