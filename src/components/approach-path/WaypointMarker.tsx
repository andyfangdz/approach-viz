import { Html } from '@react-three/drei';
import { COLORS } from './constants';

export function WaypointMarker({
  position,
  name,
  altitudeLabel
}: {
  position: [number, number, number];
  name: string;
  altitudeLabel?: number;
}) {
  return (
    <group position={position}>
      <mesh>
        <sphereGeometry args={[0.15, 16, 16]} />
        <meshStandardMaterial
          color={COLORS.waypoint}
          emissive={COLORS.waypoint}
          emissiveIntensity={0.5}
        />
      </mesh>

      <Html
        position={[0, 0.4, 0]}
        center
        zIndexRange={[40, 0]}
        style={{
          color: '#ffffff',
          fontFamily: "'JetBrains Mono', 'SF Mono', monospace",
          fontSize: '11px',
          fontWeight: 500,
          textShadow: '0 0 4px rgba(0,0,0,0.8), 0 0 8px rgba(0,0,0,0.6)',
          whiteSpace: 'nowrap',
          pointerEvents: 'none'
        }}
      >
        {name}
        {typeof altitudeLabel === 'number' ? ` ${altitudeLabel}'` : ''}
      </Html>
    </group>
  );
}
