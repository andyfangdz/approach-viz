import { useMemo } from 'react';
import { Html } from '@react-three/drei';
import type { Airport, RunwayThreshold } from '@/src/cifp/parser';
import { altToY, latLonToLocal } from './coordinates';

export function AirportMarker({
  airport,
  runways,
  verticalScale,
  refLat,
  refLon,
  runwayColor,
  airportLabelColor,
  showRunwayLabels
}: {
  airport: Airport;
  runways: RunwayThreshold[];
  verticalScale: number;
  refLat: number;
  refLon: number;
  runwayColor: string;
  airportLabelColor: string;
  showRunwayLabels: boolean;
}) {
  const pos = latLonToLocal(airport.lat, airport.lon, refLat, refLon);
  const y = altToY(airport.elevation, verticalScale) + 0.01;
  const runwayWidthNm = 0.05;

  const runwaySegments = useMemo(() => {
    const suffixReciprocal: Record<string, string> = { L: 'R', R: 'L', C: 'C' };
    const parseRunwayId = (id: string): { num: number; suffix: string } | null => {
      const ident = id.replace(/^RW/, '').trim();
      const match = ident.match(/^(\d{1,2})([LRC]?)$/);
      if (!match) return null;
      const num = parseInt(match[1], 10);
      if (!Number.isFinite(num) || num < 1 || num > 36) return null;
      return { num, suffix: match[2] || '' };
    };
    const reciprocalId = (id: string): string | null => {
      const parsed = parseRunwayId(id);
      if (!parsed) return null;
      const reciprocalNum = ((parsed.num + 17) % 36) + 1;
      const reciprocalSuffix = parsed.suffix
        ? (suffixReciprocal[parsed.suffix] ?? parsed.suffix)
        : '';
      return `RW${String(reciprocalNum).padStart(2, '0')}${reciprocalSuffix}`;
    };

    const localRunways = runways.map((runway) => ({
      ...runway,
      ...latLonToLocal(runway.lat, runway.lon, refLat, refLon)
    }));
    const byId = new Map(localRunways.map((runway) => [runway.id, runway]));
    const visited = new Set<string>();
    const segments: Array<{
      key: string;
      label: string;
      x: number;
      z: number;
      length: number;
      rotationY: number;
    }> = [];

    for (const runway of localRunways) {
      if (visited.has(runway.id)) continue;
      visited.add(runway.id);

      const reciprocal = reciprocalId(runway.id);
      const opposite = reciprocal ? byId.get(reciprocal) : undefined;

      if (opposite && !visited.has(opposite.id)) {
        visited.add(opposite.id);
        const dx = opposite.x - runway.x;
        const dz = opposite.z - runway.z;
        const length = Math.max(0.2, Math.hypot(dx, dz));
        segments.push({
          key: `${runway.id}-${opposite.id}`,
          label: `${runway.id}/${opposite.id.replace(/^RW/, '')}`,
          x: (runway.x + opposite.x) / 2,
          z: (runway.z + opposite.z) / 2,
          length,
          rotationY: Math.atan2(dx, dz)
        });
      } else {
        const parsed = parseRunwayId(runway.id);
        const heading = parsed ? parsed.num * 10 : 0;
        const headingRad = (heading * Math.PI) / 180;
        const dx = Math.sin(headingRad) * 1.0;
        const dz = -Math.cos(headingRad) * 1.0;
        segments.push({
          key: runway.id,
          label: runway.id,
          x: runway.x + dx / 2,
          z: runway.z + dz / 2,
          length: 1.0,
          rotationY: Math.atan2(dx, dz)
        });
      }
    }

    return segments;
  }, [runways, refLat, refLon]);

  return (
    <group>
      {runwaySegments.map((segment) => (
        <group
          key={segment.key}
          position={[segment.x, y, segment.z]}
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
      ))}

      <Html
        position={[pos.x, altToY(airport.elevation, verticalScale) + 0.5, pos.z]}
        center
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
