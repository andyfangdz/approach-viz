'use client';

import { useEffect, useRef } from 'react';
import './landing.css';

/* ── Feature data ──────────────────────────────────── */
const FEATURES = [
  {
    title: '3D Approach Paths',
    desc: 'Final approach, missed approach, holds, arc legs, step-downs, and MDA/DA markers rendered as 3D geometry from FAA CIFP data.',
    icon: (
      <svg viewBox="0 0 40 40" fill="none" className="landing-feature-icon">
        <path
          d="M6 32 C12 28, 18 14, 24 10 S32 8, 36 6"
          stroke="#00ffcc"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <circle cx="14" cy="22" r="2.5" fill="#00ffcc" />
        <circle cx="28" cy="8" r="2.5" fill="#00ffcc" />
        <path d="M36 6l-4-2 1 4" fill="#00ffcc" />
      </svg>
    )
  },
  {
    title: 'Live MRMS Weather',
    desc: 'Real-time 3D volumetric precipitation from NOAA MRMS radar with rain/snow/mixed phase coloring, echo-top caps, and vertical cross-sections.',
    icon: (
      <svg viewBox="0 0 40 40" fill="none" className="landing-feature-icon">
        <path
          d="M8 26a8 8 0 0114-6 6 6 0 0110 6"
          stroke="#ff00aa"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path d="M12 32v4M20 32v6M28 32v3" stroke="#6f7bff" strokeWidth="2" strokeLinecap="round" />
        <circle cx="32" cy="14" r="5" stroke="#ff00aa" strokeWidth="1.5" strokeDasharray="3 2" />
      </svg>
    )
  },
  {
    title: 'ADS-B Traffic',
    desc: 'Live aircraft positions, altitude, heading, and historical departed trails from ADS-B Exchange. Batched instanced rendering via SharedArrayBuffer.',
    icon: (
      <svg viewBox="0 0 40 40" fill="none" className="landing-feature-icon">
        <path
          d="M20 6l-4 12-10 2 10 2 4 12 4-12 10-2-10-2z"
          fill="none"
          stroke="#ffaa00"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path d="M20 18v8" stroke="#ffaa00" strokeWidth="1.5" />
      </svg>
    )
  },
  {
    title: 'Terrain & Satellite',
    desc: 'High-resolution Terrarium elevation tiles, Google 3D photorealistic tiles, and projected FAA approach plates on terrain surfaces.',
    icon: (
      <svg viewBox="0 0 40 40" fill="none" className="landing-feature-icon">
        <path
          d="M4 32L14 16l8 10 6-8 8 14"
          stroke="#6f7bff"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <circle cx="30" cy="12" r="4" stroke="#ffaa00" strokeWidth="1.5" />
      </svg>
    )
  },
  {
    title: 'Airspace Volumes',
    desc: 'Class B, C, and D airspace boundaries rendered as translucent 3D volumes with surface-floor clamping to airport elevation.',
    icon: (
      <svg viewBox="0 0 40 40" fill="none" className="landing-feature-icon">
        <ellipse cx="20" cy="28" rx="14" ry="5" stroke="#ff5599" strokeWidth="1.5" />
        <ellipse cx="20" cy="16" rx="14" ry="5" stroke="#ff5599" strokeWidth="1.5" />
        <path d="M6 16v12M34 16v12" stroke="#ff5599" strokeWidth="1.5" />
      </svg>
    )
  },
  {
    title: 'Approach Minimums',
    desc: 'Decision altitudes and minimum descent altitudes sourced from FAA data, with dashed below-minimums segments and MDA/DA waypoint markers.',
    icon: (
      <svg viewBox="0 0 40 40" fill="none" className="landing-feature-icon">
        <path d="M4 22h32" stroke="#00ff88" strokeWidth="2" strokeDasharray="5 3" />
        <path d="M8 14l12 8 12-8" stroke="#00ff88" strokeWidth="1.5" strokeLinecap="round" />
        <text
          x="20"
          y="34"
          fill="#00ff88"
          fontSize="8"
          fontFamily="JetBrains Mono, monospace"
          textAnchor="middle"
        >
          MDA
        </text>
      </svg>
    )
  }
];

const AIRPORTS = [
  { id: 'KJFK', label: 'KJFK' },
  { id: 'KLAX', label: 'KLAX' },
  { id: 'KORD', label: 'KORD' },
  { id: 'KSFO', label: 'KSFO' },
  { id: 'KATL', label: 'KATL' },
  { id: 'KDEN', label: 'KDEN' }
];

/* ── Morph geometry data ───────────────────────────── */
// Realistic ILS-style approach: step-down from IAF, level IF→FAF, 3° glideslope to DA
// Profile: x = distance-to-go (left=far, right=runway), y = altitude (up=higher)
// Ground ≈ y=410, 5000' ≈ y=115, scale ≈ 59px per 1000'
const PROF_WP = [
  [130, 115],
  [365, 220],
  [530, 220],
  [730, 342]
] as const;
// Plan: overhead view, runway at bottom-center, IAF offset to upper-left
// IF/FAF/MAP on extended centerline (x=500) — straight final approach course
const PLAN_WP = [
  [180, 80],
  [500, 210],
  [500, 350],
  [500, 460]
] as const;

const PROF_RWY: [number, number] = [820, 398];
const PLAN_RWY: [number, number] = [500, 510];

// Cubic bezier control points per segment: [cp1x, cp1y, cp2x, cp2y]
const PROF_CP = [
  [210, 115, 305, 198], // IAF→IF: descending arc
  [405, 220, 490, 220], // IF→FAF: level segment (both 3200')
  [578, 228, 685, 318], // FAF→DA: 3° glideslope
  [758, 358, 808, 392] // DA→RWY: flare to threshold
];
const PLAN_CP = [
  [300, 55, 465, 120], // IAF→IF: sweeping turn to align with centerline
  [500, 255, 500, 310], // IF→FAF: straight on localizer
  [500, 390, 500, 435], // FAF→MAP: straight on localizer
  [500, 478, 500, 500] // MAP→RWY: to threshold
];

const PROF_LABELS = ["IAF  5000'", "IF  3200'", "FAF  3200'", "DA  1080'"];
const PLAN_LABELS = ['IAF', 'IF', 'FAF', 'MAP'];

// Label positioning offsets: profile labels centered above, plan labels offset for centerline
const PROF_LABEL_DX = [0, 0, 0, 0];
const PROF_LABEL_DY = [-18, -18, -18, -18];
const PLAN_LABEL_DX = [0, 40, 40, 40]; // IAF centered, IF/FAF/MAP offset right of centerline
const PLAN_LABEL_DY = [-18, 5, 5, 5]; // IAF above, rest at midline

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function buildPath(wp: number[][], rwy: number[], cp: number[][]) {
  let d = `M${wp[0][0]},${wp[0][1]}`;
  for (let i = 0; i < 3; i++) {
    d += ` C${cp[i][0]},${cp[i][1]} ${cp[i][2]},${cp[i][3]} ${wp[i + 1][0]},${wp[i + 1][1]}`;
  }
  d += ` C${cp[3][0]},${cp[3][1]} ${cp[3][2]},${cp[3][3]} ${rwy[0]},${rwy[1]}`;
  return d;
}

const INITIAL_PATH = buildPath(PROF_WP as unknown as number[][], [...PROF_RWY], PROF_CP);

/* ── Unified Hero Approach SVG ─────────────────────── */
function HeroApproachViz() {
  const vizRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = vizRef.current;
    if (!root) return;

    const stage = root.querySelector('.landing-viz-stage') as HTMLElement;
    const svg = root.querySelector('svg')!;

    // Morphing elements
    const paths = svg.querySelectorAll<SVGPathElement>('[data-m="path"]');
    const wpDots = svg.querySelectorAll<SVGCircleElement>('[data-m="wp"]');
    const wpGlows = svg.querySelectorAll<SVGCircleElement>('[data-m="wp-glow"]');
    const profLabels = svg.querySelectorAll<SVGTextElement>('[data-m="prof-label"]');
    const planLabels = svg.querySelectorAll<SVGTextElement>('[data-m="plan-label"]');

    // Cross-fade groups
    const profGroup = svg.querySelector('[data-m="prof-only"]') as SVGGElement;
    const planGroup = svg.querySelector('[data-m="plan-only"]') as SVGGElement;
    const profRwy = svg.querySelector('[data-m="prof-rwy"]') as SVGGElement;
    const planRwy = svg.querySelector('[data-m="plan-rwy"]') as SVGGElement;
    const profMissed = svg.querySelector('[data-m="prof-missed"]') as SVGGElement;
    const planMissed = svg.querySelector('[data-m="plan-missed"]') as SVGGElement;

    let raf: number;
    const timer = setTimeout(() => {
      // Disable all CSS animations before morphing so inline styles take precedence
      paths.forEach((p) => {
        p.style.strokeDasharray = 'none';
        p.style.strokeDashoffset = '0';
        p.style.animation = 'none';
      });
      profLabels.forEach((el) => {
        el.style.animation = 'none';
      });
      planLabels.forEach((el) => {
        el.style.animation = 'none';
      });

      const start = performance.now();
      const dur = 2400;

      function tick(now: number) {
        const rawT = Math.min((now - start) / dur, 1);
        const t = easeInOutCubic(rawT);

        // Interpolate waypoints
        const wp = PROF_WP.map((pw, i) => [
          lerp(pw[0], PLAN_WP[i][0], t),
          lerp(pw[1], PLAN_WP[i][1], t)
        ]);
        const rwy = [lerp(PROF_RWY[0], PLAN_RWY[0], t), lerp(PROF_RWY[1], PLAN_RWY[1], t)];
        const cp = PROF_CP.map((pc, i) => pc.map((v, j) => lerp(v, PLAN_CP[i][j], t)));

        // Update path
        const d = buildPath(wp, rwy, cp);
        paths.forEach((p) => p.setAttribute('d', d));

        // Update waypoint positions
        wpDots.forEach((el, i) => {
          if (i >= wp.length) return;
          el.setAttribute('cx', String(wp[i][0]));
          el.setAttribute('cy', String(wp[i][1]));
        });
        wpGlows.forEach((el, i) => {
          if (i >= wp.length) return;
          el.setAttribute('cx', String(wp[i][0]));
          el.setAttribute('cy', String(wp[i][1]));
        });

        // Update label positions with interpolated offsets and fade
        profLabels.forEach((el, i) => {
          if (i >= wp.length) return;
          const dx = lerp(PROF_LABEL_DX[i], PLAN_LABEL_DX[i], t);
          const dy = lerp(PROF_LABEL_DY[i], PLAN_LABEL_DY[i], t);
          el.setAttribute('x', String(wp[i][0] + dx));
          el.setAttribute('y', String(wp[i][1] + dy));
          el.style.opacity = String(1 - t);
        });
        planLabels.forEach((el, i) => {
          if (i >= wp.length) return;
          const dx = lerp(PROF_LABEL_DX[i], PLAN_LABEL_DX[i], t);
          const dy = lerp(PROF_LABEL_DY[i], PLAN_LABEL_DY[i], t);
          el.setAttribute('x', String(wp[i][0] + dx));
          el.setAttribute('y', String(wp[i][1] + dy));
          el.style.opacity = String(t);
        });

        // Cross-fade groups
        profGroup.style.opacity = String(1 - t);
        planGroup.style.opacity = String(t);
        profRwy.style.opacity = String(1 - t);
        planRwy.style.opacity = String(t);
        profMissed.style.opacity = String(Math.max(0, 1 - t * 2));
        planMissed.style.opacity = String(Math.max(0, t * 2 - 1));

        // Rotate stage into 3D perspective
        stage.style.transform = `rotateX(${t * 50}deg) scale(${1 + t * 0.08})`;

        if (rawT < 1) raf = requestAnimationFrame(tick);
      }

      raf = requestAnimationFrame(tick);
    }, 3800);

    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="landing-hero-viz" ref={vizRef}>
      <div className="landing-viz-stage">
        <svg viewBox="0 0 1000 560" className="landing-hero-svg" aria-hidden="true">
          <defs>
            <linearGradient id="l-terrain-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0e1a2e" stopOpacity="0.6" />
              <stop offset="100%" stopColor="#040410" stopOpacity="0.9" />
            </linearGradient>
            <linearGradient id="l-path-grad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#00ffcc" />
              <stop offset="100%" stopColor="#00ff88" />
            </linearGradient>
            <filter id="l-glow">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id="l-glow-lg">
              <feGaussianBlur stdDeviation="8" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* ── Profile-only elements (fade out) ──── */}
          <g data-m="prof-only">
            {/* Grid lines at 1000' intervals */}
            <g className="landing-svg-grid" opacity="0.5">
              {[115, 174, 233, 292, 351, 410].map((y) => (
                <line
                  key={`h${y}`}
                  x1="80"
                  y1={y}
                  x2="900"
                  y2={y}
                  stroke="#1a1a30"
                  strokeWidth="0.5"
                />
              ))}
              {[200, 340, 480, 620, 760].map((x) => (
                <line
                  key={`v${x}`}
                  x1={x}
                  y1="80"
                  x2={x}
                  y2="420"
                  stroke="#1a1a30"
                  strokeWidth="0.5"
                />
              ))}
            </g>

            {/* Altitude scale labels */}
            <g className="landing-svg-grid">
              {(
                [
                  [72, 119, "5000'"],
                  [72, 178, "4000'"],
                  [72, 237, "3000'"],
                  [72, 296, "2000'"],
                  [72, 355, "1000'"]
                ] as const
              ).map(([x, y, label]) => (
                <text
                  key={label}
                  x={x}
                  y={y}
                  fill="rgba(136,136,170,0.4)"
                  fontSize="8"
                  fontFamily="JetBrains Mono, monospace"
                  textAnchor="end"
                >
                  {label}
                </text>
              ))}
            </g>

            {/* Airspace rectangle */}
            <g className="landing-svg-airspace">
              <rect
                x="200"
                y="55"
                width="650"
                height="300"
                rx="4"
                fill="none"
                stroke="rgba(111,123,255,0.25)"
                strokeWidth="1"
                strokeDasharray="8 6"
              />
              <text
                x="210"
                y="49"
                fill="rgba(111,123,255,0.5)"
                fontSize="10"
                fontFamily="JetBrains Mono, monospace"
              >
                CLASS D — SFC / 2500
              </text>
            </g>

            {/* Terrain with ridge near final approach */}
            <path
              className="landing-svg-terrain"
              d="M0,418 C100,414 200,420 320,416 S440,422 520,416 C580,410 640,400 680,396 C710,394 740,397 770,402 S840,412 900,414 Q950,416 1000,418 L1000,460 L0,460 Z"
              fill="url(#l-terrain-grad)"
            />
            <path
              className="landing-svg-terrain"
              d="M0,418 C100,414 200,420 320,416 S440,422 520,416 C580,410 640,400 680,396 C710,394 740,397 770,402 S840,412 900,414 Q950,416 1000,418"
              fill="none"
              stroke="rgba(45,140,255,0.35)"
              strokeWidth="1"
            />

            {/* Altitude guide lines (waypoint to ground) */}
            {(
              [
                [130, 115, 416],
                [365, 220, 418],
                [530, 220, 416],
                [730, 342, 400]
              ] as const
            ).map(([x, y1, y2], i) => (
              <line
                key={i}
                className="landing-svg-altitude-line"
                x1={x}
                y1={y1}
                x2={x}
                y2={y2}
                stroke="rgba(136,136,170,0.3)"
                strokeWidth="0.5"
              />
            ))}

            {/* MDA/DA line */}
            <line
              className="landing-svg-mda"
              x1="460"
              y1="342"
              x2="750"
              y2="342"
              stroke="#ff00aa"
              strokeWidth="1"
              opacity="0.6"
            />
            <text
              className="landing-svg-mda"
              x="466"
              y="336"
              fill="#ff00aa"
              fontSize="9"
              fontFamily="JetBrains Mono, monospace"
              opacity="0.6"
            >
              DA 1080
            </text>

            {/* Dashed below-DA segment (visual descent below minimums) */}
            <path
              className="landing-svg-terrain"
              d="M730,342 C758,358 808,392 820,398"
              fill="none"
              stroke="rgba(0,255,204,0.25)"
              strokeWidth="2"
              strokeDasharray="6 4"
              strokeLinecap="round"
            />
          </g>

          {/* ── Plan-only elements (fade in) ──────── */}
          <g data-m="plan-only" opacity="0">
            {/* Terrain contours centered on airport */}
            <g opacity="0.15">
              <ellipse
                cx="500"
                cy="400"
                rx="400"
                ry="200"
                fill="none"
                stroke="#2d8cff"
                strokeWidth="0.5"
              />
              <ellipse
                cx="490"
                cy="410"
                rx="290"
                ry="150"
                fill="none"
                stroke="#2d8cff"
                strokeWidth="0.5"
              />
              <ellipse
                cx="480"
                cy="420"
                rx="180"
                ry="90"
                fill="none"
                stroke="#2d8cff"
                strokeWidth="0.5"
              />
            </g>

            {/* Airspace circle centered near runway */}
            <circle
              cx="500"
              cy="420"
              r="240"
              fill="none"
              stroke="rgba(111,123,255,0.22)"
              strokeWidth="1"
              strokeDasharray="8 6"
            />
            <text
              x="500"
              y="168"
              fill="rgba(111,123,255,0.45)"
              fontSize="10"
              fontFamily="JetBrains Mono, monospace"
              textAnchor="middle"
            >
              CLASS D
            </text>

            {/* Extended final approach course / localizer centerline */}
            <line
              x1="500"
              y1="100"
              x2="500"
              y2="510"
              stroke="rgba(136,136,170,0.15)"
              strokeWidth="0.5"
              strokeDasharray="6 4"
            />

            {/* Distance rings (5 NM, 10 NM from runway) */}
            <circle
              cx="500"
              cy="510"
              r="120"
              fill="none"
              stroke="rgba(136,136,170,0.08)"
              strokeWidth="0.5"
              strokeDasharray="4 6"
            />
            <text
              x="625"
              y="475"
              fill="rgba(136,136,170,0.2)"
              fontSize="7"
              fontFamily="JetBrains Mono, monospace"
            >
              5 NM
            </text>
            <circle
              cx="500"
              cy="510"
              r="240"
              fill="none"
              stroke="rgba(136,136,170,0.06)"
              strokeWidth="0.5"
              strokeDasharray="4 6"
            />
            <text
              x="745"
              y="435"
              fill="rgba(136,136,170,0.2)"
              fontSize="7"
              fontFamily="JetBrains Mono, monospace"
            >
              10 NM
            </text>

            {/* Compass rose */}
            <g opacity="0.5">
              <text
                x="930"
                y="48"
                fill="#8888aa"
                fontSize="11"
                fontFamily="JetBrains Mono, monospace"
                textAnchor="middle"
                fontWeight="700"
              >
                N
              </text>
              <path d="M926,56 L930,50 L934,56" fill="none" stroke="#8888aa" strokeWidth="1.2" />
              <line x1="930" y1="56" x2="930" y2="72" stroke="#8888aa" strokeWidth="1" />
            </g>
          </g>

          {/* ── Profile runway (fade out) ─────────── */}
          <g data-m="prof-rwy">
            <g className="landing-svg-runway">
              <rect x="795" y="392" width="55" height="6" rx="1" fill="#e4e4f0" opacity="0.8" />
              <line
                x1="803"
                y1="395"
                x2="842"
                y2="395"
                stroke="var(--l-bg)"
                strokeWidth="1"
                strokeDasharray="4 3"
              />
            </g>
          </g>

          {/* ── Plan runway (fade in) ─────────────── */}
          <g data-m="plan-rwy" opacity="0">
            <rect x="494" y="496" width="12" height="48" rx="1" fill="#e4e4f0" opacity="0.8" />
            <line
              x1="500"
              y1="501"
              x2="500"
              y2="539"
              stroke="var(--l-bg)"
              strokeWidth="1"
              strokeDasharray="4 3"
            />
            <text
              x="518"
              y="530"
              fill="#8888aa"
              fontSize="9"
              fontFamily="JetBrains Mono, monospace"
            >
              RWY
            </text>
          </g>

          {/* ── Profile missed approach (fade out) ── */}
          <g data-m="prof-missed">
            <path
              className="landing-svg-path-missed"
              d="M820,398 C835,390 855,340 920,220"
              fill="none"
              stroke="rgba(255,68,68,0.12)"
              strokeWidth="6"
              strokeLinecap="round"
              filter="url(#l-glow-lg)"
            />
            <path
              className="landing-svg-path-missed"
              d="M820,398 C835,390 855,340 920,220"
              fill="none"
              stroke="#ff4444"
              strokeWidth="2"
              strokeLinecap="round"
              filter="url(#l-glow)"
              opacity="0.8"
            />
            <text
              className="landing-svg-path-missed"
              x="928"
              y="215"
              fill="rgba(255,68,68,0.6)"
              fontSize="9"
              fontFamily="JetBrains Mono, monospace"
            >
              MISSED
            </text>
          </g>

          {/* ── Plan missed approach (fade in) ────── */}
          <g data-m="plan-missed" opacity="0">
            <path
              d="M500,530 L500,550 Q500,570 480,570 L400,570 Q375,570 375,548 L375,440"
              fill="none"
              stroke="#ff4444"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              filter="url(#l-glow)"
              opacity="0.7"
            />
            <text
              x="358"
              y="435"
              fill="rgba(255,68,68,0.6)"
              fontSize="9"
              fontFamily="JetBrains Mono, monospace"
              textAnchor="end"
            >
              MISSED
            </text>
          </g>

          {/* ── Morphing approach path ────────────── */}
          <path
            data-m="path"
            className="landing-svg-path-main"
            d={INITIAL_PATH}
            fill="none"
            stroke="rgba(0,255,204,0.15)"
            strokeWidth="8"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter="url(#l-glow-lg)"
          />
          <path
            data-m="path"
            className="landing-svg-path-main"
            d={INITIAL_PATH}
            fill="none"
            stroke="url(#l-path-grad)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter="url(#l-glow)"
          />

          {/* ── Morphing waypoints ────────────────── */}
          <g>
            {PROF_WP.map(([cx, cy], i) => (
              <g key={i} className="landing-svg-waypoint">
                <circle
                  data-m="wp-glow"
                  cx={cx}
                  cy={cy}
                  r="12"
                  fill="rgba(0,255,204,0.08)"
                  className="landing-svg-waypoint-glow"
                />
                <circle
                  data-m="wp"
                  cx={cx}
                  cy={cy}
                  r="4"
                  fill="#040410"
                  stroke="#00ffcc"
                  strokeWidth="2"
                />
              </g>
            ))}
          </g>

          {/* ── Profile waypoint labels (fade out) ── */}
          {PROF_WP.map(([x, y], i) => (
            <text
              key={`pl${i}`}
              data-m="prof-label"
              x={x + PROF_LABEL_DX[i]}
              y={y + PROF_LABEL_DY[i]}
              fill="#8888aa"
              fontSize="10"
              fontFamily="JetBrains Mono, monospace"
              textAnchor="middle"
              className="landing-svg-label"
            >
              {PROF_LABELS[i]}
            </text>
          ))}

          {/* ── Plan waypoint labels (fade in) ────── */}
          {PLAN_WP.map(([x, y], i) => (
            <text
              key={`ql${i}`}
              data-m="plan-label"
              x={x + PROF_LABEL_DX[i]}
              y={y + PROF_LABEL_DY[i]}
              fill="#8888aa"
              fontSize="10"
              fontFamily="JetBrains Mono, monospace"
              textAnchor="middle"
              opacity="0"
            >
              {PLAN_LABELS[i]}
            </text>
          ))}
        </svg>
      </div>
    </div>
  );
}

/* ── Main Landing Page ─────────────────────────────── */
export default function LandingPage() {
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const body = document.body;
    const html = document.documentElement;
    const origStyles = {
      bodyPos: body.style.position,
      bodyOverflow: body.style.overflow,
      bodyFixed: body.style.inset,
      bodySelect: body.style.userSelect,
      bodyTouch: body.style.touchAction,
      htmlOverflow: html.style.overflow
    };
    body.style.position = 'static';
    body.style.overflow = 'hidden';
    body.style.inset = 'auto';
    body.style.userSelect = 'auto';
    body.style.touchAction = 'auto';
    html.style.overflow = 'hidden';
    return () => {
      body.style.position = origStyles.bodyPos;
      body.style.overflow = origStyles.bodyOverflow;
      body.style.inset = origStyles.bodyFixed;
      body.style.userSelect = origStyles.bodySelect;
      body.style.touchAction = origStyles.bodyTouch;
      html.style.overflow = origStyles.htmlOverflow;
    };
  }, []);

  useEffect(() => {
    const page = document.querySelector('.landing-page');
    if (!page) return;
    const handleScroll = () => {
      navRef.current?.classList.toggle('scrolled', page.scrollTop > 40);
    };
    page.addEventListener('scroll', handleScroll, { passive: true });
    return () => page.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) entry.target.classList.add('visible');
        });
      },
      { threshold: 0.12 }
    );
    document.querySelectorAll('.landing-reveal').forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="landing-page">
      <nav className="landing-nav" ref={navRef}>
        <div className="landing-nav-inner">
          <a href="/landing" className="landing-nav-logo">
            <div className="landing-nav-logo-mark">A</div>
            <div className="landing-nav-logo-text">
              Approach<span>Viz</span>
            </div>
          </a>
          <a href="/" className="landing-nav-cta">
            Launch App
          </a>
        </div>
      </nav>

      <section className="landing-hero">
        <div className="landing-hero-glow" />
        <div className="landing-hero-content">
          <div className="landing-hero-label">3D Instrument Approach Visualization</div>
          <h1>
            See the approach
            <br />
            <span className="landing-accent">in three dimensions</span>
          </h1>
          <p className="landing-hero-sub">
            <span className="landing-chip">3D flight paths</span>
            <span className="landing-sep">/</span>
            <span className="landing-chip">MRMS weather</span>
            <span className="landing-sep">/</span>
            <span className="landing-chip">ADS-B traffic</span>
            <span className="landing-sep">/</span>
            <span className="landing-chip">terrain</span>
            <span className="landing-sep">/</span>
            <span className="landing-chip">airspace</span>
          </p>
          <div className="landing-hero-actions">
            <a href="/" className="landing-btn-primary">
              Launch ApproachViz
            </a>
            <a href="#features" className="landing-btn-secondary">
              See Features
            </a>
          </div>
        </div>
        <HeroApproachViz />
        <div className="landing-hero-scroll">
          <span>scroll</span>
          <div className="landing-hero-scroll-line" />
        </div>
      </section>

      <section id="features" className="landing-section landing-features">
        <div className="landing-inner">
          <div className="landing-reveal">
            <div className="landing-section-label">Capabilities</div>
            <h2>
              Everything you need to
              <br />
              understand the approach
            </h2>
          </div>
          <div className="landing-features-grid">
            {FEATURES.map((f, i) => (
              <div
                key={f.title}
                className={`landing-feature-card landing-reveal landing-reveal-delay-${(i % 3) + 1}`}
              >
                {f.icon}
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="landing-section landing-try">
        <div className="landing-inner">
          <div className="landing-reveal">
            <div className="landing-section-label">Jump In</div>
            <h2>Try it now</h2>
            <p>Pick an airport and explore its approaches in 3D</p>
          </div>
          <div className="landing-airports landing-reveal landing-reveal-delay-2">
            {AIRPORTS.map((a) => (
              <a key={a.id} href={`/${a.id}`} className="landing-airport-link">
                {a.label}
              </a>
            ))}
          </div>
        </div>
      </section>

      <footer className="landing-footer">
        <div className="landing-footer-inner">
          <div className="landing-footer-logo">
            Approach<span>Viz</span>
          </div>
          <p>3D visualization for instrument approach procedures</p>
        </div>
      </footer>
    </div>
  );
}
