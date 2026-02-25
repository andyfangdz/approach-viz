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
// Waypoints: [x, y] for each fix in profile vs plan view
const PROF_WP = [
  [140, 100],
  [360, 170],
  [500, 170],
  [720, 330]
] as const;
const PLAN_WP = [
  [180, 80],
  [400, 200],
  [500, 320],
  [500, 440]
] as const;

const PROF_RWY: [number, number] = [790, 382];
const PLAN_RWY: [number, number] = [500, 490];

// Cubic bezier control points per segment: [[cp1x,cp1y,cp2x,cp2y], ...]
const PROF_CP = [
  [220, 100, 300, 100],
  [400, 170, 460, 170],
  [560, 200, 670, 300],
  [745, 350, 775, 372]
];
const PLAN_CP = [
  [250, 80, 340, 135],
  [440, 235, 488, 285],
  [500, 355, 500, 405],
  [500, 458, 500, 478]
];

const PROF_LABELS = ["IAF 5000'", "IF 3200'", "FAF 3200'", "DA 1080'"];
const PLAN_LABELS = ['IAF', 'IF', 'FAF', 'MAP'];

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
      // Disable stroke-dash CSS animation before morphing
      paths.forEach((p) => {
        p.style.strokeDasharray = 'none';
        p.style.strokeDashoffset = '0';
        p.style.animation = 'none';
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

        // Update label positions and fade
        profLabels.forEach((el, i) => {
          if (i >= wp.length) return;
          el.setAttribute('x', String(wp[i][0]));
          el.setAttribute('y', String(wp[i][1] - 14));
          el.style.opacity = String(1 - t);
        });
        planLabels.forEach((el, i) => {
          if (i >= wp.length) return;
          el.setAttribute('x', String(wp[i][0]));
          el.setAttribute('y', String(wp[i][1] - 14));
          el.style.opacity = String(t);
        });

        // Cross-fade groups
        profGroup.style.opacity = String(1 - t);
        planGroup.style.opacity = String(t);
        profRwy.style.opacity = String(1 - t);
        planRwy.style.opacity = String(t);
        profMissed.style.opacity = String(Math.max(0, 1 - t * 2));
        planMissed.style.opacity = String(Math.max(0, t * 2 - 1));

        // Rotate stage
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
            {/* Grid */}
            <g className="landing-svg-grid" opacity="0.5">
              {[80, 140, 200, 260, 320, 380].map((y) => (
                <line
                  key={`h${y}`}
                  x1="60"
                  y1={y}
                  x2="940"
                  y2={y}
                  stroke="#1a1a30"
                  strokeWidth="0.5"
                />
              ))}
              {[140, 280, 420, 560, 700, 840].map((x) => (
                <line
                  key={`v${x}`}
                  x1={x}
                  y1="60"
                  x2={x}
                  y2="420"
                  stroke="#1a1a30"
                  strokeWidth="0.5"
                />
              ))}
            </g>

            {/* Airspace rectangle */}
            <g className="landing-svg-airspace">
              <rect
                x="200"
                y="50"
                width="580"
                height="280"
                rx="4"
                fill="none"
                stroke="rgba(111,123,255,0.25)"
                strokeWidth="1"
                strokeDasharray="8 6"
              />
              <text
                x="210"
                y="44"
                fill="rgba(111,123,255,0.5)"
                fontSize="10"
                fontFamily="JetBrains Mono, monospace"
              >
                CLASS D — SFC/2500
              </text>
            </g>

            {/* Terrain */}
            <path
              className="landing-svg-terrain"
              d="M0,400 C60,395 120,405 200,385 S340,408 440,395 S560,415 650,405 S760,388 830,392 L920,397 Q960,399 1000,400 L1000,480 L0,480 Z"
              fill="url(#l-terrain-grad)"
            />
            <path
              className="landing-svg-terrain"
              d="M0,400 C60,395 120,405 200,385 S340,408 440,395 S560,415 650,405 S760,388 830,392 L920,397 Q960,399 1000,400"
              fill="none"
              stroke="rgba(45,140,255,0.35)"
              strokeWidth="1"
            />

            {/* Altitude guide lines */}
            {[
              [140, 100, 398],
              [360, 170, 395],
              [500, 170, 396],
              [720, 330, 402]
            ].map(([x, y1, y2], i) => (
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

            {/* MDA line */}
            <line
              className="landing-svg-mda"
              x1="380"
              y1="330"
              x2="740"
              y2="330"
              stroke="#ff00aa"
              strokeWidth="1"
              opacity="0.6"
            />
            <text
              className="landing-svg-mda"
              x="390"
              y="324"
              fill="#ff00aa"
              fontSize="9"
              fontFamily="JetBrains Mono, monospace"
              opacity="0.6"
            >
              MDA 1080
            </text>
          </g>

          {/* ── Plan-only elements (fade in) ──────── */}
          <g data-m="plan-only" opacity="0">
            {/* Terrain contours */}
            <g opacity="0.18">
              <ellipse
                cx="500"
                cy="380"
                rx="380"
                ry="200"
                fill="none"
                stroke="#2d8cff"
                strokeWidth="0.5"
              />
              <ellipse
                cx="480"
                cy="395"
                rx="280"
                ry="150"
                fill="none"
                stroke="#2d8cff"
                strokeWidth="0.5"
              />
              <ellipse
                cx="470"
                cy="410"
                rx="170"
                ry="90"
                fill="none"
                stroke="#2d8cff"
                strokeWidth="0.5"
              />
            </g>

            {/* Airspace circle */}
            <circle
              cx="500"
              cy="400"
              r="230"
              fill="none"
              stroke="rgba(111,123,255,0.22)"
              strokeWidth="1"
              strokeDasharray="8 6"
            />
            <text
              x="500"
              y="158"
              fill="rgba(111,123,255,0.45)"
              fontSize="10"
              fontFamily="JetBrains Mono, monospace"
              textAnchor="middle"
            >
              CLASS D
            </text>

            {/* Localizer centerline */}
            <line
              x1="500"
              y1="140"
              x2="500"
              y2="490"
              stroke="rgba(136,136,170,0.15)"
              strokeWidth="0.5"
              strokeDasharray="6 4"
            />

            {/* Compass */}
            <g opacity="0.45">
              <text
                x="930"
                y="52"
                fill="#8888aa"
                fontSize="12"
                fontFamily="JetBrains Mono, monospace"
                textAnchor="middle"
                fontWeight="600"
              >
                N
              </text>
              <line x1="930" y1="58" x2="930" y2="76" stroke="#8888aa" strokeWidth="1" />
              <path d="M926,61 L930,54 L934,61" fill="none" stroke="#8888aa" strokeWidth="1" />
            </g>
          </g>

          {/* ── Profile runway (fade out) ─────────── */}
          <g data-m="prof-rwy">
            <g className="landing-svg-runway">
              <rect x="765" y="376" width="55" height="6" rx="1" fill="#e4e4f0" opacity="0.8" />
              <line
                x1="773"
                y1="379"
                x2="812"
                y2="379"
                stroke="var(--l-bg)"
                strokeWidth="1"
                strokeDasharray="4 3"
              />
            </g>
          </g>

          {/* ── Plan runway (fade in) ─────────────── */}
          <g data-m="plan-rwy" opacity="0">
            <rect x="494" y="478" width="12" height="48" rx="1" fill="#e4e4f0" opacity="0.8" />
            <line
              x1="500"
              y1="483"
              x2="500"
              y2="521"
              stroke="var(--l-bg)"
              strokeWidth="1"
              strokeDasharray="4 3"
            />
            <text
              x="500"
              y="542"
              fill="#8888aa"
              fontSize="9"
              fontFamily="JetBrains Mono, monospace"
              textAnchor="middle"
            >
              RWY 36
            </text>
          </g>

          {/* ── Profile missed approach (fade out) ── */}
          <g data-m="prof-missed">
            <path
              className="landing-svg-path-missed"
              d="M790,382 L810,382 L910,200"
              fill="none"
              stroke="rgba(255,68,68,0.12)"
              strokeWidth="6"
              strokeLinecap="round"
              strokeLinejoin="round"
              filter="url(#l-glow-lg)"
            />
            <path
              className="landing-svg-path-missed"
              d="M790,382 L810,382 L910,200"
              fill="none"
              stroke="#ff4444"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              filter="url(#l-glow)"
              opacity="0.8"
            />
            <text
              className="landing-svg-path-missed"
              x="870"
              y="192"
              fill="rgba(255,68,68,0.6)"
              fontSize="9"
              fontFamily="JetBrains Mono, monospace"
              textAnchor="middle"
            >
              MISSED
            </text>
          </g>

          {/* ── Plan missed approach (fade in) ────── */}
          <g data-m="plan-missed" opacity="0">
            <path
              d="M500,530 L500,555 Q500,570 518,570 L610,570 Q640,570 640,540 L640,440"
              fill="none"
              stroke="#ff4444"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              filter="url(#l-glow)"
              opacity="0.7"
            />
            <text
              x="658"
              y="486"
              fill="rgba(255,68,68,0.6)"
              fontSize="9"
              fontFamily="JetBrains Mono, monospace"
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
              x={x}
              y={y - 14}
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
              x={x}
              y={y - 14}
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
