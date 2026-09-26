import { useMemo } from 'react';
import type { Airport, RunwayThreshold } from '@/lib/cifp/parser';
import { SceneLabels, type SceneLabel } from '../labels/SceneLabels';
import { airportLabelStyle, runwayLabelStyle } from '../labels/label-styles';
import { altToY, earthCurvatureDropNm, latLonToLocal } from './coordinates';
import { buildRunwaySegments } from './runway-geometry';

const SCREEN_SIZING = { mode: 'screen' } as const;
const RUNWAY_SURFACE_LIFT_NM = 0.01;
const RUNWAY_LABEL_LIFT_NM = 0.15;
const AIRPORT_LABEL_LIFT_NM = 0.5;

export function AirportMarker({
  airport,
  runways,
  verticalScale,
  refLat,
  refLon,
  runwayColor,
  airportLabelColor,
  showRunwayLabels,
  applyEarthCurvatureCompensation = false
}: {
  airport: Airport;
  runways: RunwayThreshold[];
  verticalScale: number;
  refLat: number;
  refLon: number;
  runwayColor: string;
  airportLabelColor: string;
  showRunwayLabels: boolean;
  applyEarthCurvatureCompensation?: boolean;
}) {
  const pos = latLonToLocal(airport.lat, airport.lon, refLat, refLon);
  const altitudeBaseY = altToY(airport.elevation, verticalScale);
  const airportCurvatureDrop = applyEarthCurvatureCompensation
    ? earthCurvatureDropNm(pos.x, pos.z, refLat) * verticalScale
    : 0;
  const airportBaseY = altitudeBaseY - airportCurvatureDrop;
  const runwayWidthNm = 0.05;

  const runwaySegments = useMemo(() => {
    const localRunways = runways.map((runway) => ({
      ...runway,
      ...latLonToLocal(runway.lat, runway.lon, refLat, refLon)
    }));
    return buildRunwaySegments(localRunways);
  }, [runways, refLat, refLon]);

  const labels = useMemo(() => {
    const next: SceneLabel[] = [
      {
        text: airport.id,
        position: [pos.x, airportBaseY + AIRPORT_LABEL_LIFT_NM, pos.z],
        style: airportLabelStyle(airportLabelColor)
      }
    ];
    if (showRunwayLabels) {
      const runwayStyle = runwayLabelStyle(airportLabelColor);
      for (const segment of runwaySegments) {
        const segmentCurvatureDrop = applyEarthCurvatureCompensation
          ? earthCurvatureDropNm(segment.x, segment.z, refLat) * verticalScale
          : 0;
        next.push({
          text: segment.label,
          position: [
            segment.x,
            altitudeBaseY - segmentCurvatureDrop + RUNWAY_SURFACE_LIFT_NM + RUNWAY_LABEL_LIFT_NM,
            segment.z
          ],
          style: runwayStyle
        });
      }
    }
    return next;
  }, [
    airport.id,
    pos.x,
    pos.z,
    airportBaseY,
    airportLabelColor,
    showRunwayLabels,
    runwaySegments,
    applyEarthCurvatureCompensation,
    refLat,
    verticalScale,
    altitudeBaseY
  ]);

  return (
    <group>
      {runwaySegments.map((segment) => {
        const segmentCurvatureDrop = applyEarthCurvatureCompensation
          ? earthCurvatureDropNm(segment.x, segment.z, refLat) * verticalScale
          : 0;
        const segmentY = altitudeBaseY - segmentCurvatureDrop + RUNWAY_SURFACE_LIFT_NM;
        return (
          <group
            key={segment.key}
            position={[segment.x, segmentY, segment.z]}
            rotation={[0, segment.rotationY, 0]}
          >
            <mesh>
              <boxGeometry args={[runwayWidthNm, 0.02, segment.length]} />
              <meshStandardMaterial
                color={runwayColor}
                emissive={runwayColor}
                emissiveIntensity={0.25}
                transparent
                opacity={0.85}
              />
            </mesh>
            <mesh position={[0, 0.011, 0]}>
              <boxGeometry args={[0.01, 0.005, segment.length * 0.95]} />
              <meshStandardMaterial color="#ffffff" emissive="#ffffff" emissiveIntensity={0.15} />
            </mesh>
          </group>
        );
      })}

      <SceneLabels labels={labels} sizing={SCREEN_SIZING} />
    </group>
  );
}
