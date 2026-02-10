import { useMemo } from 'react';
import * as THREE from 'three';
import { Html } from '@react-three/drei';
import { latLonToLocal, altToY } from '@/src/components/approach-path/coordinates';
import type { TrafficTarget } from '@/src/hooks/useAdsbTraffic';

interface AdsbTrafficProps {
  traffic: Map<string, TrafficTarget>;
  refLat: number;
  refLon: number;
  verticalScale: number;
  historyLength: number;
}

const AIRCRAFT_COLOR = new THREE.Color('#00e5ff');
const AIRCRAFT_COLOR_GROUND = new THREE.Color('#ffab00');
const HISTORY_COLOR = new THREE.Color('#00e5ff');
const DEG_TO_RAD = Math.PI / 180;

function AircraftMarker({
  target,
  refLat,
  refLon,
  verticalScale,
  historyLength,
}: {
  target: TrafficTarget;
  refLat: number;
  refLon: number;
  verticalScale: number;
  historyLength: number;
}) {
  const pos = latLonToLocal(target.current.lat, target.current.lon, refLat, refLon);
  const y = altToY(target.current.altitudeFeet, verticalScale);
  const rotation = -target.current.track * DEG_TO_RAD;

  const historyLineObj = useMemo(() => {
    if (historyLength === 0 || target.history.length === 0) return null;
    const positions = target.history.slice(-historyLength);
    positions.push(target.current);
    if (positions.length < 2) return null;

    const points = positions.map((p) => {
      const local = latLonToLocal(p.lat, p.lon, refLat, refLon);
      return new THREE.Vector3(local.x, altToY(p.altitudeFeet, verticalScale), local.z);
    });

    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: HISTORY_COLOR,
      transparent: true,
      opacity: 0.3,
    });
    return new THREE.Line(geometry, material);
  }, [target.history, target.current, historyLength, refLat, refLon, verticalScale]);

  const label = target.callsign || target.hex.toUpperCase();
  const altLabel = target.onGround
    ? 'GND'
    : `${Math.round(target.current.altitudeFeet)}ft`;
  const gsLabel = target.groundSpeed > 0 ? ` ${Math.round(target.groundSpeed)}kt` : '';

  return (
    <group position={[pos.x, y, pos.z]}>
      {/* Aircraft icon: a small cone pointing in the direction of travel */}
      <group rotation={[0, rotation, 0]}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <coneGeometry args={[0.12, 0.4, 4]} />
          <meshBasicMaterial
            color={target.onGround ? AIRCRAFT_COLOR_GROUND : AIRCRAFT_COLOR}
            transparent
            opacity={0.9}
          />
        </mesh>
      </group>

      {/* Glow point */}
      <mesh>
        <sphereGeometry args={[0.06, 8, 8]} />
        <meshBasicMaterial
          color={target.onGround ? AIRCRAFT_COLOR_GROUND : AIRCRAFT_COLOR}
          transparent
          opacity={0.7}
        />
      </mesh>

      {/* Label */}
      <Html
        position={[0.3, 0.3, 0]}
        center={false}
        style={{
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
          fontSize: '10px',
          fontFamily: "'JetBrains Mono', monospace",
          color: target.onGround ? '#ffab00' : '#00e5ff',
          textShadow: '0 0 4px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.7)',
          userSelect: 'none',
          lineHeight: '1.3',
        }}
      >
        <div>{label}</div>
        <div style={{ fontSize: '9px', opacity: 0.8 }}>
          {altLabel}{gsLabel}
        </div>
      </Html>

      {/* History trail */}
      {historyLineObj && <primitive object={historyLineObj} />}
    </group>
  );
}

export function AdsbTraffic({
  traffic,
  refLat,
  refLon,
  verticalScale,
  historyLength,
}: AdsbTrafficProps) {
  const targets = useMemo(() => Array.from(traffic.values()), [traffic]);

  if (targets.length === 0) return null;

  return (
    <group>
      {targets.map((target) => (
        <AircraftMarker
          key={target.hex}
          target={target}
          refLat={refLat}
          refLon={refLon}
          verticalScale={verticalScale}
          historyLength={historyLength}
        />
      ))}
    </group>
  );
}
