'use client';

import { memo } from 'react';
import type { AircraftState, GuidanceState } from '../sim/types';

/**
 * Horizontal Situation Indicator: rotating compass card, course pointer for the
 * active leg, lateral CDI, and (when a glidepath is active) a glideslope needle
 * on the right. Deviation dots are the standard ±2.5 full-scale.
 */
interface HsiProps {
  aircraft: AircraftState;
  guidance: GuidanceState;
  headingBugMagDeg: number;
}

const R = 46;
const DOT_SPACING = 7;

export const Hsi = memo(function Hsi({ aircraft, guidance, headingBugMagDeg }: HsiProps) {
  const heading = aircraft.headingMagDeg;
  const course = guidance.activeCourseMagDeg ?? heading;
  const cardRotation = -heading; // rotate card so current heading is at top
  const cdi = guidance.cdiDots ?? 0;
  const gs = guidance.gsDots;

  const ticks = [];
  for (let deg = 0; deg < 360; deg += 5) {
    const major = deg % 30 === 0;
    const len = major ? 8 : 4;
    const rad = (deg * Math.PI) / 180;
    const x1 = Math.sin(rad) * R;
    const y1 = -Math.cos(rad) * R;
    const x2 = Math.sin(rad) * (R - len);
    const y2 = -Math.cos(rad) * (R - len);
    ticks.push(
      <line
        key={deg}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke="rgba(232,232,240,0.6)"
        strokeWidth={major ? 1.1 : 0.7}
      />
    );
    if (major) {
      const lx = Math.sin(rad) * (R - 15);
      const ly = -Math.cos(rad) * (R - 15);
      ticks.push(
        <text
          key={`l${deg}`}
          x={lx}
          y={ly}
          fontSize={7}
          fill="#e8e8f0"
          textAnchor="middle"
          dominantBaseline="central"
        >
          {deg === 0 ? 'N' : deg === 90 ? 'E' : deg === 180 ? 'S' : deg === 270 ? 'W' : deg / 10}
        </text>
      );
    }
  }

  return (
    <svg className="tr-hsi" viewBox="-60 -60 120 120" aria-label="Horizontal situation indicator">
      <circle cx={0} cy={0} r={R + 8} fill="#0d0d18" stroke="var(--border)" strokeWidth={1.5} />

      {/* Rotating compass card. */}
      <g transform={`rotate(${cardRotation})`}>
        {ticks}
        {/* Heading bug. */}
        <g transform={`rotate(${headingBugMagDeg})`}>
          <path d={`M 0 ${-R - 6} l 4 6 l -8 0 Z`} fill="#45e0c0" />
        </g>

        {/* Course pointer + CDI, rotated to the active course. */}
        <g transform={`rotate(${course})`}>
          <line x1={0} y1={-R + 2} x2={0} y2={-14} stroke="#ffd166" strokeWidth={2.4} />
          <path d={`M 0 ${-R + 2} l 4 7 l -8 0 Z`} fill="#ffd166" />
          <line x1={0} y1={14} x2={0} y2={R - 2} stroke="#ffd166" strokeWidth={2.4} />
          {/* CDI deviation dots. */}
          {[-2, -1, 1, 2].map((n) => (
            <circle
              key={n}
              cx={n * DOT_SPACING}
              cy={0}
              r={1.6}
              fill="none"
              stroke="rgba(232,232,240,0.5)"
              strokeWidth={0.8}
            />
          ))}
          {/* CDI bar. */}
          <line
            x1={cdi * DOT_SPACING}
            y1={-13}
            x2={cdi * DOT_SPACING}
            y2={13}
            stroke="#45e0c0"
            strokeWidth={2.6}
            strokeLinecap="round"
          />
        </g>
      </g>

      {/* Fixed aircraft symbol. */}
      <g stroke="#ffffff" strokeWidth={2} fill="none" strokeLinecap="round">
        <line x1={0} y1={-9} x2={0} y2={9} />
        <line x1={-8} y1={0} x2={8} y2={0} />
        <line x1={-5} y1={7} x2={5} y2={7} />
      </g>

      {/* Lubber line. */}
      <path d="M 0 -58 l 4 7 l -8 0 Z" fill="#ffffff" />

      {/* Glideslope needle (right side) when a glidepath is active. */}
      {gs != null && (
        <g transform="translate(54 0)">
          <line x1={0} y1={-26} x2={0} y2={26} stroke="var(--border)" strokeWidth={3} />
          {[-2, -1, 1, 2].map((n) => (
            <circle
              key={n}
              cx={0}
              cy={n * 11}
              r={1.6}
              fill="none"
              stroke="rgba(232,232,240,0.5)"
              strokeWidth={0.8}
            />
          ))}
          {/* gsDots > 0 means fly up (needle below center means below path). */}
          <line
            x1={-6}
            y1={-gs * 11}
            x2={6}
            y2={-gs * 11}
            stroke="#45e0c0"
            strokeWidth={2.6}
            strokeLinecap="round"
          />
        </g>
      )}
    </svg>
  );
});
