/**
 * 3D Approach Path visualization
 * Renders waypoints, approach segments, and vertical reference lines
 */

import { useMemo } from 'react';
import { Html, Line } from '@react-three/drei';
import * as THREE from 'three';
import type { Approach, Waypoint, Airport, ApproachLeg } from '../cifp/parser';

// Scale factors
const ALTITUDE_SCALE = 1 / 6076.12; // feet to NM
const VERTICAL_EXAGGERATION = 15;

// Colors
const COLORS = {
  approach: '#00ff88',
  transition: '#ffaa00',
  missed: '#ff4444',
  waypoint: '#ffffff',
  runway: '#ff00ff'
};

interface ApproachPathProps {
  approach: Approach;
  waypoints: Map<string, Waypoint>;
  airport: Airport;
}

// Convert lat/lon to local coordinates (NM from reference point)
function latLonToLocal(lat: number, lon: number, refLat: number, refLon: number) {
  const dLat = lat - refLat;
  const dLon = lon - refLon;
  const x = dLon * 60 * Math.cos(refLat * Math.PI / 180);
  const z = -dLat * 60;
  return { x, z };
}

// Convert altitude to Y coordinate
function altToY(altFeet: number): number {
  return altFeet * ALTITUDE_SCALE * VERTICAL_EXAGGERATION;
}

// Waypoint marker component
function WaypointMarker({ 
  position, 
  name, 
  altitude 
}: { 
  position: [number, number, number]; 
  name: string; 
  altitude?: number;
}) {
  const altText = altitude ? ` ${altitude}'` : '';
  
  return (
    <group position={position}>
      {/* Sphere marker */}
      <mesh>
        <sphereGeometry args={[0.15, 16, 16]} />
        <meshStandardMaterial
          color={COLORS.waypoint}
          emissive={COLORS.waypoint}
          emissiveIntensity={0.5}
        />
      </mesh>
      
      {/* Label */}
      <Html
        position={[0, 0.4, 0]}
        center
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
        {name}{altText}
      </Html>
    </group>
  );
}

// Vertical reference line from point to ground
function VerticalLine({ 
  x, y, z, color 
}: { 
  x: number; y: number; z: number; color: string;
}) {
  const points = useMemo<[number, number, number][]>(() => [
    [x, 0, z],
    [x, y, z]
  ], [x, y, z]);

  return (
    <Line
      points={points}
      color={color}
      transparent
      opacity={0.2}
      lineWidth={1}
    />
  );
}

// Path segment (tube along waypoints)
function PathSegment({
  legs,
  waypoints,
  refLat,
  refLon,
  color
}: {
  legs: ApproachLeg[];
  waypoints: Map<string, Waypoint>;
  refLat: number;
  refLon: number;
  color: string;
}) {
  const { points, waypointData, verticalLines } = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const wpData: { position: [number, number, number]; name: string; altitude?: number }[] = [];
    const vLines: { x: number; y: number; z: number }[] = [];

    for (const leg of legs) {
      const wp = waypoints.get(leg.waypointId);
      if (!wp) continue;

      const pos = latLonToLocal(wp.lat, wp.lon, refLat, refLon);
      const y = altToY(leg.altitude || 0);

      pts.push(new THREE.Vector3(pos.x, y, pos.z));
      wpData.push({
        position: [pos.x, y, pos.z],
        name: wp.name,
        altitude: leg.altitude
      });
      vLines.push({ x: pos.x, y, z: pos.z });
    }

    return { points: pts, waypointData: wpData, verticalLines: vLines };
  }, [legs, waypoints, refLat, refLon]);

  const tubeGeometry = useMemo(() => {
    if (points.length < 2) return null;
    const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.1);
    return new THREE.TubeGeometry(curve, points.length * 10, 0.08, 8, false);
  }, [points]);

  if (!tubeGeometry) return null;

  return (
    <group>
      {/* Tube path */}
      <mesh geometry={tubeGeometry}>
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.3}
          transparent
          opacity={0.9}
        />
      </mesh>

      {/* Waypoint markers */}
      {waypointData.map((wp, i) => (
        <WaypointMarker
          key={`${wp.name}-${i}`}
          position={wp.position}
          name={wp.name}
          altitude={wp.altitude}
        />
      ))}

      {/* Vertical lines */}
      {verticalLines.map((line, i) => (
        <VerticalLine
          key={`vline-${i}`}
          x={line.x}
          y={line.y}
          z={line.z}
          color={color}
        />
      ))}
    </group>
  );
}

// Airport marker
function AirportMarker({
  airport,
  refLat,
  refLon
}: {
  airport: Airport;
  refLat: number;
  refLon: number;
}) {
  const pos = latLonToLocal(airport.lat, airport.lon, refLat, refLon);
  const y = altToY(airport.elevation);

  return (
    <group position={[pos.x, y, pos.z]}>
      {/* Runway marker */}
      <mesh>
        <boxGeometry args={[0.5, 0.02, 2]} />
        <meshStandardMaterial
          color={COLORS.runway}
          emissive={COLORS.runway}
          emissiveIntensity={0.3}
        />
      </mesh>

      {/* Airport label */}
      <Html
        position={[0, 0.5, 0]}
        center
        style={{
          color: '#ff00ff',
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

export function ApproachPath({ approach, waypoints, airport }: ApproachPathProps) {
  const refLat = airport.lat;
  const refLon = airport.lon;

  return (
    <group>
      {/* Airport marker */}
      <AirportMarker airport={airport} refLat={refLat} refLon={refLon} />

      {/* Final approach */}
      {approach.finalLegs.length > 0 && (
        <PathSegment
          legs={approach.finalLegs}
          waypoints={waypoints}
          refLat={refLat}
          refLon={refLon}
          color={COLORS.approach}
        />
      )}

      {/* Transitions */}
      {Array.from(approach.transitions.entries()).map(([name, legs]) => (
        <PathSegment
          key={name}
          legs={legs}
          waypoints={waypoints}
          refLat={refLat}
          refLon={refLon}
          color={COLORS.transition}
        />
      ))}

      {/* Missed approach */}
      {approach.missedLegs.length > 0 && (
        <PathSegment
          legs={approach.missedLegs}
          waypoints={waypoints}
          refLat={refLat}
          refLon={refLon}
          color={COLORS.missed}
        />
      )}
    </group>
  );
}
