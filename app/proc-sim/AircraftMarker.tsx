import type { SimUpdate } from './types';

export function SimAircraftMarker({ update }: { update: SimUpdate }) {
  return (
    <group
      position={update.position}
      rotation={[0, (-update.snapshot.state.hdgDegTrue * Math.PI) / 180, 0]}
    >
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.09, 0.28, 3]} />
        <meshBasicMaterial color="#ffcf40" />
      </mesh>
      <mesh>
        <boxGeometry args={[0.36, 0.015, 0.04]} />
        <meshBasicMaterial color="#ffcf40" />
      </mesh>
    </group>
  );
}
