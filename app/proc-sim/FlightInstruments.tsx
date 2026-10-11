import { useId } from 'react';
import type { SimUpdate, SimSnapshot } from './types';

const wrap = (angle: number) => ((angle % 360) + 360) % 360;
const heading = (angle: number) => String(Math.round(wrap(angle)) % 360 || 360).padStart(3, '0');
const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));
const mode = (value: string | null | undefined) =>
  ({
    Heading: 'HDG',
    Nav: 'NAV',
    Localizer: 'LOC',
    AltitudeHold: 'ALT',
    VerticalSpeed: 'VS',
    GlideSlope: 'GS'
  })[value ?? ''] ?? '—';

function Tape({
  value,
  altitude,
  bug,
  trend
}: {
  value: number;
  altitude?: boolean;
  bug: number;
  trend: number | null;
}) {
  const id = useId();
  const interval = altitude ? 100 : 10;
  const scale = altitude ? 0.3 : 3;
  const base = Math.floor(value / interval) * interval;
  return (
    <svg
      viewBox="0 0 90 250"
      role="img"
      aria-label={`${altitude ? 'Altitude' : 'Airspeed'} tape ${value.toFixed(0)} ${altitude ? 'feet MSL' : 'KIAS'}`}
    >
      <defs>
        <clipPath id={id}>
          <rect x="0" y="25" width="90" height="200" />
        </clipPath>
      </defs>
      <rect width="90" height="250" fill="#172233" />
      <text x="45" y="17" textAnchor="middle">
        {altitude ? 'FT MSL' : 'KIAS'}
      </text>
      <g clipPath={`url(#${id})`}>
        {Array.from({ length: 11 }, (_, i) => base + (i - 5) * interval)
          .filter((n) => n >= 0)
          .map((n) => (
            <g key={n} transform={`translate(0 ${125 - (n - value) * scale})`}>
              <path d="M65 0h12" stroke="white" />
              <text x="59" y="4" textAnchor="end">
                {n}
              </text>
            </g>
          ))}
        {trend != null && (
          <path
            d={`M81 125V${125 - clamp(trend * scale, 98)}h-7`}
            stroke="#e879f9"
            strokeWidth="3"
            fill="none"
          />
        )}
        <path d={`M88 ${125 - clamp((bug - value) * scale, 94)}l-12 -6v12z`} fill="#67d9ff" />
      </g>
      <path d="M3 111H65L76 125L65 139H3Z" fill="#050a12" stroke="white" />
      <text x="38" y="131" textAnchor="middle" fontSize="19">
        {Math.round(value)}
      </text>
      <text x="45" y="242" textAnchor="middle" fill="#67d9ff">
        {Math.round(bug)}
      </text>
    </svg>
  );
}

export function PFD({ update }: { update: SimUpdate }) {
  const id = useId();
  const { snapshot: s } = update;
  const a = s.state;
  // TAS is horizontal speed in the core; convert knots to feet/minute for flight-path angle.
  const pitch = (Math.atan2(a.vsFpm, (a.tasKts * 6076.12) / 60) * 180) / Math.PI;
  const magnetic = wrap(a.hdgDegTrue - a.magVarDeg);
  return (
    <section className="sim-display sim-pfd" aria-label="Primary flight display">
      <div className="sim-fma" aria-label="Autopilot mode annunciator">
        <span>
          ACTIVE{' '}
          <b>
            {mode(s.lateralActive)} · {mode(s.verticalActive)}
          </b>
        </span>
        <span>
          ARMED{' '}
          <b className="sim-armed">
            {mode(s.lateralArmed)} · {mode(s.verticalArmed)}
          </b>
        </span>
      </div>
      <div className="sim-pfd-row">
        <Tape value={a.iasKts} bug={s.autopilot.spdBugKts} trend={update.airspeedTrendKts} />
        <svg
          viewBox="0 0 240 250"
          role="img"
          aria-label={`Attitude bank ${a.bankDeg.toFixed(1)} degrees, flight-path pitch ${pitch.toFixed(1)} degrees`}
        >
          <defs>
            <clipPath id={id}>
              <rect width="240" height="250" rx="8" />
            </clipPath>
          </defs>
          <g clipPath={`url(#${id})`}>
            <g transform={`translate(120 125) rotate(${-a.bankDeg}) translate(0 ${pitch * 4})`}>
              <rect x="-400" y="-500" width="800" height="500" fill="#246aa3" />
              <rect x="-400" width="800" height="500" fill="#81532e" />
              <path d="M-400 0H400" stroke="white" strokeWidth="2" />
              {[-20, -15, -10, -5, 5, 10, 15, 20].map((n) => (
                <g key={n} transform={`translate(0 ${-n * 4})`}>
                  <path d={`M${n % 10 ? -20 : -40} 0h${n % 10 ? 40 : 80}`} stroke="white" />
                  <text x="-58" y="4">
                    {Math.abs(n)}
                  </text>
                  <text x="45" y="4">
                    {Math.abs(n)}
                  </text>
                </g>
              ))}
            </g>
            {[-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60].map((n) => (
              <path key={n} d="M120 20v10" stroke="white" transform={`rotate(${n} 120 125)`} />
            ))}
            <path d="M120 33l-6 10h12z" fill="white" transform={`rotate(${-a.bankDeg} 120 125)`} />
            <path
              d="M59 125h35v7m52 0v-7h35M113 125h14"
              fill="none"
              stroke="#ffcf40"
              strokeWidth="4"
            />
          </g>
          <text x="120" y="233" textAnchor="middle">
            FPA {pitch.toFixed(1)}° · BANK {a.bankDeg.toFixed(1)}°
          </text>
        </svg>
        <Tape altitude value={a.altFtMsl} bug={s.autopilot.altBugFt} trend={a.vsFpm / 10} />
        <svg
          viewBox="0 0 60 250"
          role="img"
          aria-label={`Vertical speed ${a.vsFpm.toFixed(0)} feet per minute`}
        >
          <text x="30" y="17" textAnchor="middle">
            VS
          </text>
          {[-2, -1, 0, 1, 2].map((n) => (
            <g key={n} transform={`translate(0 ${125 - n * 45})`}>
              <path d="M5 0h12" stroke="white" />
              <text x="23" y="4">
                {n}
              </text>
            </g>
          ))}
          <path
            d={`M3 ${125 - clamp((a.vsFpm / 1000) * 45, 90)}h17`}
            stroke="#ffcf40"
            strokeWidth="4"
          />
          <text x="30" y="242" textAnchor="middle">
            {Math.round(a.vsFpm)}
          </text>
        </svg>
      </div>
      <svg
        viewBox="0 0 420 45"
        className="sim-heading"
        role="img"
        aria-label={`Magnetic heading ${heading(magnetic)} degrees`}
      >
        {Array.from({ length: 13 }, (_, i) => Math.floor(magnetic / 10) * 10 + (i - 6) * 10).map(
          (n) => (
            <g key={n} transform={`translate(${210 + (n - magnetic) * 4} 0)`}>
              <path d="M0 0v8" stroke="white" />
              <text y="22" textAnchor="middle">
                {heading(n)}
              </text>
            </g>
          )
        )}
        <rect x="181" y="23" width="58" height="22" fill="#050a12" stroke="white" />
        <text x="210" y="39" textAnchor="middle">
          {heading(magnetic)} M
        </text>
      </svg>
      <p className="sim-display-note">
        Pitch = flight-path angle · trends predict 6 s · GS {a.gsKts.toFixed(0)} kt
      </p>
    </section>
  );
}

export function HSI({ snapshot: s }: { snapshot: SimSnapshot }) {
  const a = s.state;
  const magnetic = wrap(a.hdgDegTrue - a.magVarDeg);
  const course = s.courseDegTrue == null ? null : wrap(s.courseDegTrue - a.magVarDeg);
  const bug = wrap(s.autopilot.hdgBugDeg - a.magVarDeg);
  return (
    <section className="sim-display sim-hsi" aria-label="Horizontal situation indicator">
      <div className="sim-hsi-readout">
        <b>{s.activeLegFix ?? 'Procedure complete'}</b>
        <span>{s.distToFixNm == null ? '—' : s.distToFixNm.toFixed(2)} NM</span>
      </div>
      <svg
        viewBox="0 0 320 320"
        role="img"
        aria-label={`HSI heading ${heading(magnetic)} magnetic, course ${course == null ? 'unavailable' : heading(course)}, ${s.courseTo == null ? 'flag unavailable' : s.courseTo ? 'TO' : 'FROM'}, CDI ${s.cdi?.toFixed(2) ?? 'unavailable'}`}
      >
        <circle cx="160" cy="160" r="128" fill="#101b2a" stroke="#8294ac" />
        <g transform={`rotate(${-magnetic} 160 160)`}>
          {Array.from({ length: 72 }, (_, i) => i * 5).map((n) => (
            <g key={n} transform={`rotate(${n} 160 160)`}>
              <path d={`M160 34v${n % 30 === 0 ? 15 : 7}`} stroke="white" />
              {n % 30 === 0 && (
                <text x="160" y="65" textAnchor="middle">
                  {['N', 'E', 'S', 'W'][n / 90] ?? n / 10}
                </text>
              )}
            </g>
          ))}
          <path d="M151 30h18l-9 13z" fill="#67d9ff" transform={`rotate(${bug} 160 160)`} />
        </g>
        {course != null && (
          <g transform={`rotate(${course - magnetic} 160 160)`}>
            <path
              d="M160 74v48M160 198v48M151 85l9 -12l9 12"
              stroke="#e879f9"
              strokeWidth="3"
              fill="none"
            />
            {[-2, -1, 1, 2].map((n) => (
              <circle key={n} cx={160 + n * 22} cy="160" r="3" fill="white" />
            ))}
            {s.cdi != null && (
              <path d={`M${160 - s.cdi * 44} 125v70`} stroke="#e879f9" strokeWidth="4" />
            )}
            {s.courseTo != null && (
              <path d={s.courseTo ? 'M154 113l6 -10l6 10z' : 'M154 207l6 10l6 -10z'} fill="white" />
            )}
          </g>
        )}
        <path
          d="M160 10l-7 13h14zM160 140v43M141 163h38M151 181h18"
          stroke="#ffcf40"
          fill="#ffcf40"
          strokeWidth="3"
        />
        <rect x="132" y="0" width="56" height="20" fill="#050a12" />
        <text x="160" y="15" textAnchor="middle">
          {heading(magnetic)} M
        </text>
      </svg>
      <div className="sim-hsi-readout">
        <span>
          HDG <b>{heading(bug)} M</b>
        </span>
        <span>
          CRS <b>{course == null ? '—' : `${heading(course)} M`}</b>
        </span>
        <span>{s.courseTo == null ? '—' : s.courseTo ? 'TO' : 'FROM'}</span>
      </div>
      <p className="sim-display-note">CDI ±1 NM · XTK {s.xtkNm?.toFixed(2) ?? '—'} NM (right +)</p>
    </section>
  );
}
