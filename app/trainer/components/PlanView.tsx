'use client';

import { memo, useMemo } from 'react';
import type { AircraftState, GuidanceState, TrainerProcedure } from '../sim/types';

/**
 * North-up top-down moving map. Local frame is x = east, z = south, so screen
 * coordinates map directly: screenX = x, screenY = z (north points up).
 */
interface PlanViewProps {
  procedure: TrainerProcedure;
  aircraft: AircraftState;
  guidance: GuidanceState;
  trail: readonly { x: number; z: number }[];
}

function pathD(points: readonly { x: number; z: number }[]): string {
  if (points.length === 0) return '';
  return points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(3)} ${p.z.toFixed(3)}`)
    .join(' ');
}

export const PlanView = memo(function PlanView({
  procedure,
  aircraft,
  guidance,
  trail
}: PlanViewProps) {
  const view = useMemo(() => {
    const pts: { x: number; z: number }[] = [
      ...procedure.approachPath,
      ...procedure.missedPath,
      ...procedure.fixes
    ];
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    if (!Number.isFinite(minX)) {
      minX = -5;
      maxX = 5;
      minZ = -5;
      maxZ = 5;
    }
    const pad = Math.max(1.5, (maxX - minX + maxZ - minZ) * 0.06);
    minX -= pad;
    maxX += pad;
    minZ -= pad;
    maxZ += pad;
    // Keep square aspect so headings look correct.
    const w = maxX - minX;
    const h = maxZ - minZ;
    const size = Math.max(w, h);
    const cx = (minX + maxX) / 2;
    const cz = (minZ + maxZ) / 2;
    return {
      x: cx - size / 2,
      y: cz - size / 2,
      size,
      strokeScale: size / 100
    };
  }, [procedure]);

  const track = aircraft.headingMagDeg + procedure.magVarDeg;
  const s = view.strokeScale;
  const activeFix = procedure.fixes[guidance.activeFixIndex];

  return (
    <svg
      className="tr-planview"
      viewBox={`${view.x} ${view.y} ${view.size} ${view.size}`}
      preserveAspectRatio="xMidYMid meet"
      aria-label="Approach plan view"
    >
      {/* Range rings around the airport reference (origin). */}
      {[5, 10, 15].map((r) => (
        <circle
          key={r}
          cx={0}
          cy={0}
          r={r}
          fill="none"
          stroke="rgba(136,136,170,0.18)"
          strokeWidth={s}
        />
      ))}

      {/* Missed approach path. */}
      {procedure.missedPath.length >= 2 && (
        <path
          d={pathD(procedure.missedPath)}
          fill="none"
          stroke="#ff6b5a"
          strokeWidth={2.4 * s}
          strokeDasharray={`${2 * s} ${1.6 * s}`}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.9}
        />
      )}

      {/* Approach path (transition → final). */}
      <path
        d={pathD(procedure.approachPath)}
        fill="none"
        stroke="#45e0c0"
        strokeWidth={2.6 * s}
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Fixes. */}
      {procedure.fixes.map((fix, i) => {
        const isActive = i === guidance.activeFixIndex;
        const color = fix.isFaf ? '#ffd166' : fix.isMap ? '#ff6b5a' : '#9fb2d8';
        const d = 1.5 * s;
        return (
          <g key={`${fix.id}-${i}`}>
            <path
              d={`M ${fix.x - d} ${fix.z} L ${fix.x} ${fix.z - d} L ${fix.x + d} ${fix.z} L ${fix.x} ${fix.z + d} Z`}
              fill="none"
              stroke={isActive ? '#ffffff' : color}
              strokeWidth={0.7 * s}
              opacity={fix.isHoldFix ? 0.5 : 1}
            />
            <circle
              cx={fix.x}
              cy={fix.z}
              r={(isActive ? 0.9 : 0.5) * s}
              fill={isActive ? '#ffffff' : color}
            />
            <text
              x={fix.x + 1.1 * s}
              y={fix.z}
              fontSize={3.4 * s}
              fill={color}
              dominantBaseline="middle"
              className="tr-planview-label"
            >
              {fix.name}
            </text>
          </g>
        );
      })}

      {/* Active leg highlight from aircraft to active fix. */}
      {activeFix && (
        <line
          x1={aircraft.x}
          y1={aircraft.z}
          x2={activeFix.x}
          y2={activeFix.z}
          stroke="rgba(255,255,255,0.35)"
          strokeWidth={s}
          strokeDasharray={`${1.4 * s} ${1.4 * s}`}
        />
      )}

      {/* Trail. */}
      {trail.length >= 2 && (
        <path
          d={pathD(trail)}
          fill="none"
          stroke="rgba(255,255,255,0.5)"
          strokeWidth={1.2 * s}
          strokeLinecap="round"
        />
      )}

      {/* Aircraft symbol. */}
      <g transform={`translate(${aircraft.x} ${aircraft.z}) rotate(${track})`}>
        <path
          d={`M 0 ${-2.6 * s} L ${1.7 * s} ${2.2 * s} L 0 ${1.2 * s} L ${-1.7 * s} ${2.2 * s} Z`}
          fill="#ffffff"
          stroke="#0a0a14"
          strokeWidth={0.4 * s}
        />
      </g>
    </svg>
  );
});
