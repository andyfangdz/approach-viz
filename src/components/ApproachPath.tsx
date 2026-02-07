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
  hold: '#6f7bff',
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

function isHoldLeg(leg: ApproachLeg): boolean {
  return ['HM', 'HF', 'HA'].includes(leg.pathTerminator);
}

function buildHoldPoints(
  center: { x: number; z: number },
  headingDeg: number,
  holdDistanceNm: number,
  altitudeFeet: number
): [number, number, number][] {
  const radius = Math.max(0.6, holdDistanceNm / 8);
  const halfStraight = Math.max(0.6, holdDistanceNm / 2);
  const arcSteps = 24;
  const straightSteps = 12;
  const headingRad = (headingDeg * Math.PI) / 180;
  const forward = { x: Math.sin(headingRad), z: -Math.cos(headingRad) };
  const right = { x: Math.cos(headingRad), z: Math.sin(headingRad) };
  const y = altToY(altitudeFeet);
  const points: [number, number, number][] = [];

  const pushLocal = (forwardOffset: number, rightOffset: number) => {
    const x = center.x + forward.x * forwardOffset + right.x * rightOffset;
    const z = center.z + forward.z * forwardOffset + right.z * rightOffset;
    points.push([x, y, z]);
  };

  pushLocal(halfStraight, radius);

  for (let i = 0; i <= arcSteps; i += 1) {
    const t = (i / arcSteps) * Math.PI;
    const forwardOffset = halfStraight + radius * Math.sin(t);
    const rightOffset = radius * Math.cos(t);
    pushLocal(forwardOffset, rightOffset);
  }

  for (let i = 1; i <= straightSteps; i += 1) {
    const t = i / straightSteps;
    const forwardOffset = halfStraight - t * (2 * halfStraight);
    pushLocal(forwardOffset, -radius);
  }

  for (let i = 0; i <= arcSteps; i += 1) {
    const t = (i / arcSteps) * Math.PI;
    const forwardOffset = -halfStraight - radius * Math.sin(t);
    const rightOffset = -radius * Math.cos(t);
    pushLocal(forwardOffset, rightOffset);
  }

  for (let i = 1; i <= straightSteps; i += 1) {
    const t = i / straightSteps;
    const forwardOffset = -halfStraight + t * (2 * halfStraight);
    pushLocal(forwardOffset, radius);
  }

  return points;
}

// Waypoint marker component
function WaypointMarker({ 
  position, 
  name, 
  altitude 
}: { 
  position: [number, number, number]; 
  name: string; 
  altitude: number;
}) {
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
        {name} {altitude}'
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

function HoldPattern({
  leg,
  waypoints,
  refLat,
  refLon,
  color
}: {
  leg: ApproachLeg;
  waypoints: Map<string, Waypoint>;
  refLat: number;
  refLon: number;
  color: string;
}) {
  const wp = waypoints.get(leg.waypointId);
  const altitude = leg.altitude ?? 0;
  const heading = leg.holdCourse ?? 0;
  const holdDistance = leg.holdDistance ?? 4;

  const points = useMemo(() => {
    if (!wp || altitude <= 0) return [];
    const center = latLonToLocal(wp.lat, wp.lon, refLat, refLon);
    return buildHoldPoints(center, heading, holdDistance, altitude);
  }, [wp, altitude, heading, holdDistance, refLat, refLon]);

  if (!wp || points.length === 0) return null;

  return (
    <Line
      points={points}
      color={color}
      lineWidth={2}
      dashed
      dashSize={0.4}
      gapSize={0.2}
    />
  );
}

// Path segment (tube along waypoints) - NO waypoint markers here
function PathTube({
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
  const { points, verticalLines } = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const vLines: { x: number; y: number; z: number }[] = [];

    for (const leg of legs) {
      // Skip legs without valid altitude (they're just procedure markers)
      if (!leg.altitude || leg.altitude <= 0) continue;
      
      const wp = waypoints.get(leg.waypointId);
      if (!wp) continue;

      const pos = latLonToLocal(wp.lat, wp.lon, refLat, refLon);
      const y = altToY(leg.altitude);

      pts.push(new THREE.Vector3(pos.x, y, pos.z));
      vLines.push({ x: pos.x, y, z: pos.z });
    }

    return { points: pts, verticalLines: vLines };
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

// Collect unique waypoint positions from all legs
interface UniqueWaypoint {
  key: string;
  name: string;
  altitude: number;
  x: number;
  z: number;
}

function collectUniqueWaypoints(
  allLegs: ApproachLeg[],
  waypoints: Map<string, Waypoint>,
  refLat: number,
  refLon: number
): UniqueWaypoint[] {
  const seen = new Map<string, UniqueWaypoint>();
  
  for (const leg of allLegs) {
    // Skip legs without valid altitude
    if (!leg.altitude || leg.altitude <= 0) continue;
    
    const wp = waypoints.get(leg.waypointId);
    if (!wp) continue;
    
    // Key by waypoint name + altitude (same waypoint at different altitudes = different markers)
    const key = `${wp.name}-${leg.altitude}`;
    
    if (!seen.has(key)) {
      const pos = latLonToLocal(wp.lat, wp.lon, refLat, refLon);
      seen.set(key, {
        key,
        name: wp.name,
        altitude: leg.altitude,
        x: pos.x,
        z: pos.z
      });
    }
  }
  
  return Array.from(seen.values());
}

export function ApproachPath({ approach, waypoints, airport }: ApproachPathProps) {
  const refLat = airport.lat;
  const refLon = airport.lon;

  // Collect all legs from all segments
  const allLegs = useMemo(() => {
    const legs: ApproachLeg[] = [];
    legs.push(...approach.finalLegs);
    for (const [, transitionLegs] of approach.transitions) {
      legs.push(...transitionLegs);
    }
    legs.push(...approach.missedLegs);
    return legs;
  }, [approach]);

  // Get unique waypoints to render markers
  const uniqueWaypoints = useMemo(
    () => collectUniqueWaypoints(allLegs, waypoints, refLat, refLon),
    [allLegs, waypoints, refLat, refLon]
  );

  const holdLegs = useMemo(
    () => allLegs.filter(leg => isHoldLeg(leg) && leg.altitude),
    [allLegs]
  );

  return (
    <group>
      {/* Airport marker */}
      <AirportMarker airport={airport} refLat={refLat} refLon={refLon} />

      {/* Unique waypoint markers */}
      {uniqueWaypoints.map((wp) => (
        <WaypointMarker
          key={wp.key}
          position={[wp.x, altToY(wp.altitude), wp.z]}
          name={wp.name}
          altitude={wp.altitude}
        />
      ))}

      {/* Final approach path */}
      {approach.finalLegs.length > 0 && (
        <PathTube
          legs={approach.finalLegs}
          waypoints={waypoints}
          refLat={refLat}
          refLon={refLon}
          color={COLORS.approach}
        />
      )}

      {/* Transition paths */}
      {Array.from(approach.transitions.entries()).map(([name, legs]) => (
        <PathTube
          key={name}
          legs={legs}
          waypoints={waypoints}
          refLat={refLat}
          refLon={refLon}
          color={COLORS.transition}
        />
      ))}

      {/* Missed approach path */}
      {approach.missedLegs.length > 0 && (
        <PathTube
          legs={approach.missedLegs}
          waypoints={waypoints}
          refLat={refLat}
          refLon={refLon}
          color={COLORS.missed}
        />
      )}

      {/* Hold patterns */}
      {holdLegs.map((leg) => (
        <HoldPattern
          key={`hold-${leg.sequence}-${leg.waypointId}`}
          leg={leg}
          waypoints={waypoints}
          refLat={refLat}
          refLon={refLon}
          color={COLORS.hold}
        />
      ))}
    </group>
  );
}
