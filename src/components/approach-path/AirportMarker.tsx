import { useMemo } from 'react';
import { Html } from '@react-three/drei';
import type { Airport, RunwayThreshold } from '@/src/cifp/parser';
import { altToY, earthCurvatureDropNm, latLonToLocal } from './coordinates';
import { buildRunwaySegments } from './runway-geometry';

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

  return (
    <group>
      {runwaySegments.map((segment) => {
        const segmentCurvatureDrop = applyEarthCurvatureCompensation
          ? earthCurvatureDropNm(segment.x, segment.z, refLat) * verticalScale
          : 0;
        const segmentY = altitudeBaseY - segmentCurvatureDrop + 0.01;
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
            {showRunwayLabels && (
              <Html
                position={[0, 0.15, 0]}
                center
                zIndexRange={[40, 0]}
                style={{
                  color: airportLabelColor,
                  fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
                  fontSize: '10px',
                  fontWeight: 500,
                  textShadow: '0 0 4px rgba(0,0,0,0.8), 0 0 8px rgba(0,0,0,0.6)',
                  whiteSpace: 'nowrap',
                  pointerEvents: 'none'
                }}
              >
                {segment.label}
              </Html>
            )}
          </group>
        );
      })}

      <Html
        position={[pos.x, airportBaseY + 0.5, pos.z]}
        center
        zIndexRange={[40, 0]}
        style={{
          color: airportLabelColor,
          fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
          fontSize: '11px',
          fontWeight: 500,
          textShadow: '0 0 4px rgba(0,0,0,0.8), 0 0 8px rgba(0,0,0,0.6)',
          whiteSpace: 'nowrap',
          pointerEvents: 'none'
        }}
      >
        {airport.id}
      </Html>
    </group>
  );
}
