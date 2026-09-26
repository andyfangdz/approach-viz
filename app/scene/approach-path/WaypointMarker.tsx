import { useMemo } from 'react';
import { SceneLabels, type SceneLabel } from '../labels/SceneLabels';
import { WAYPOINT_LABEL_STYLE } from '../labels/label-styles';
import { COLORS } from './constants';

/** Height of a waypoint label above its marker, in scene units. */
const WAYPOINT_LABEL_OFFSET_Y = 0.4;
const SCREEN_SIZING = { mode: 'screen' } as const;

export function waypointLabel(
  position: readonly [number, number, number],
  name: string,
  altitudeLabel?: number
): SceneLabel {
  return {
    text: altitudeLabel !== undefined ? `${name} ${altitudeLabel}'` : name,
    position: [position[0], position[1] + WAYPOINT_LABEL_OFFSET_Y, position[2]],
    style: WAYPOINT_LABEL_STYLE
  };
}

/** Labels for many waypoints in one draw call. */
export function WaypointLabels({ labels }: { labels: readonly SceneLabel[] }) {
  return <SceneLabels labels={labels} sizing={SCREEN_SIZING} />;
}

export function WaypointMarker({
  position,
  name,
  altitudeLabel,
  showLabel = true
}: {
  position: [number, number, number];
  name: string;
  altitudeLabel?: number;
  /** Off when a parent batches every waypoint label into one {@link WaypointLabels}. */
  showLabel?: boolean;
}) {
  const labels = useMemo(
    () => (showLabel ? [waypointLabel([0, 0, 0], name, altitudeLabel)] : []),
    [showLabel, name, altitudeLabel]
  );

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
      {showLabel && <WaypointLabels labels={labels} />}
    </group>
  );
}
