'use client';

import { useEffect, useRef } from 'react';
import './landing.css';

/* ── Feature data ──────────────────────────────────── */
const FEATURES = [
  {
    title: '3D Approach Paths',
    desc: 'Final approach, missed approach, holds, arc legs, step-downs, and MDA/DA markers rendered as 3D geometry from FAA CIFP data.',
    color: '#00ffcc',
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
    color: '#ff00aa',
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
    color: '#ffaa00',
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
    color: '#6f7bff',
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
    color: '#ff5599',
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
    color: '#00ff88',
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
  { id: 'KJFK', label: 'KJFK', name: 'New York' },
  { id: 'KLAX', label: 'KLAX', name: 'Los Angeles' },
  { id: 'KORD', label: 'KORD', name: "Chicago" },
  { id: 'KSFO', label: 'KSFO', name: 'San Francisco' },
  { id: 'KATL', label: 'KATL', name: 'Atlanta' },
  { id: 'KDEN', label: 'KDEN', name: 'Denver' }
];

/* ── Approach Profile SVG ──────────────────────────── */
function ApproachProfileSvg() {
  return (
    <svg className="landing-hero-svg" viewBox="0 0 1000 480" aria-hidden="true">
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
        <filter id="l-glow-strong">
          <feGaussianBlur stdDeviation="8" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Grid lines */}
      <g className="landing-svg-grid" opacity="0.5">
        {[80, 140, 200, 260, 320, 380].map((y) => (
          <line
            key={`h-${y}`}
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
            key={`v-${x}`}
            x1={x}
            y1="60"
            x2={x}
            y2="420"
            stroke="#1a1a30"
            strokeWidth="0.5"
          />
        ))}
      </g>

      {/* Airspace ceiling */}
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

      {/* Runway */}
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

      {/* Altitude guide lines (dashed verticals from waypoints to terrain) */}
      <g>
        <line
          className="landing-svg-altitude-line"
          x1="140"
          y1="100"
          x2="140"
          y2="398"
          stroke="rgba(136,136,170,0.3)"
          strokeWidth="0.5"
        />
        <line
          className="landing-svg-altitude-line"
          x1="360"
          y1="100"
          x2="360"
          y2="395"
          stroke="rgba(136,136,170,0.3)"
          strokeWidth="0.5"
        />
        <line
          className="landing-svg-altitude-line"
          x1="500"
          y1="170"
          x2="500"
          y2="396"
          stroke="rgba(136,136,170,0.3)"
          strokeWidth="0.5"
        />
        <line
          className="landing-svg-altitude-line"
          x1="720"
          y1="330"
          x2="720"
          y2="402"
          stroke="rgba(136,136,170,0.3)"
          strokeWidth="0.5"
        />
      </g>

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

      {/* Main approach path (glow layer) */}
      <path
        className="landing-svg-path-main"
        d="M140,100 L280,100 L360,170 L500,170 L720,330 L780,376"
        fill="none"
        stroke="rgba(0,255,204,0.15)"
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter="url(#l-glow-strong)"
      />

      {/* Main approach path */}
      <path
        className="landing-svg-path-main"
        d="M140,100 L280,100 L360,170 L500,170 L720,330 L780,376"
        fill="none"
        stroke="url(#l-path-grad)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter="url(#l-glow)"
      />

      {/* Below-minimums dashed segment */}
      <path
        className="landing-svg-path-main"
        d="M720,330 L780,376"
        fill="none"
        stroke="rgba(0,255,136,0.5)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray="6 4"
      />

      {/* Missed approach path (glow) */}
      <path
        className="landing-svg-path-missed"
        d="M780,376 L800,376 L900,200"
        fill="none"
        stroke="rgba(255,68,68,0.12)"
        strokeWidth="6"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter="url(#l-glow-strong)"
      />

      {/* Missed approach path */}
      <path
        className="landing-svg-path-missed"
        d="M780,376 L800,376 L900,200"
        fill="none"
        stroke="#ff4444"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter="url(#l-glow)"
        opacity="0.8"
      />

      {/* Transition segment marker */}
      <circle cx="360" cy="170" r="3" fill="#ffaa00" opacity="0.6" />
      <circle cx="780" cy="376" r="3" fill="#ffaa00" opacity="0.6" />

      {/* Waypoints */}
      <g>
        {[
          { cx: 140, cy: 100 },
          { cx: 360, cy: 170 },
          { cx: 500, cy: 170 },
          { cx: 720, cy: 330 }
        ].map((pt, i) => (
          <g key={i} className="landing-svg-waypoint">
            <circle
              cx={pt.cx}
              cy={pt.cy}
              r="12"
              fill="rgba(0,255,204,0.08)"
              className="landing-svg-waypoint-glow"
            />
            <circle cx={pt.cx} cy={pt.cy} r="4" fill="#040410" stroke="#00ffcc" strokeWidth="2" />
          </g>
        ))}
      </g>

      {/* Waypoint labels */}
      <text
        className="landing-svg-label"
        x="140"
        y="86"
        fill="#8888aa"
        fontSize="10"
        fontFamily="JetBrains Mono, monospace"
        textAnchor="middle"
      >
        IAF 5000&apos;
      </text>
      <text
        className="landing-svg-label"
        x="360"
        y="160"
        fill="#8888aa"
        fontSize="10"
        fontFamily="JetBrains Mono, monospace"
        textAnchor="middle"
      >
        IF 3200&apos;
      </text>
      <text
        className="landing-svg-label"
        x="500"
        y="160"
        fill="#8888aa"
        fontSize="10"
        fontFamily="JetBrains Mono, monospace"
        textAnchor="middle"
      >
        FAF 3200&apos;
      </text>
      <text
        className="landing-svg-label"
        x="720"
        y="350"
        fill="#8888aa"
        fontSize="10"
        fontFamily="JetBrains Mono, monospace"
        textAnchor="middle"
      >
        DA 1080&apos;
      </text>

      {/* Missed approach label */}
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
    </svg>
  );
}

/* ── Plan View SVG (top-down 3D) ───────────────────── */
function ApproachPlanViewSvg() {
  return (
    <svg className="landing-hero-svg" viewBox="0 0 1000 600" aria-hidden="true">
      <defs>
        <linearGradient id="l-plan-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#00ffcc" />
          <stop offset="100%" stopColor="#00ff88" />
        </linearGradient>
        <filter id="l-plan-glow">
          <feGaussianBlur stdDeviation="4" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="l-plan-glow-lg">
          <feGaussianBlur stdDeviation="8" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Terrain contour lines */}
      <g className="landing-plan-terrain" opacity="0.18">
        <ellipse cx="500" cy="360" rx="380" ry="200" fill="none" stroke="#2d8cff" strokeWidth="0.5" />
        <ellipse cx="480" cy="380" rx="280" ry="150" fill="none" stroke="#2d8cff" strokeWidth="0.5" />
        <ellipse cx="470" cy="400" rx="170" ry="90" fill="none" stroke="#2d8cff" strokeWidth="0.5" />
      </g>

      {/* Airspace circle */}
      <circle
        className="landing-plan-airspace"
        cx="500"
        cy="380"
        r="230"
        fill="none"
        stroke="rgba(111,123,255,0.22)"
        strokeWidth="1"
        strokeDasharray="8 6"
      />
      <text
        className="landing-plan-airspace"
        x="500"
        y="140"
        fill="rgba(111,123,255,0.45)"
        fontSize="10"
        fontFamily="JetBrains Mono, monospace"
        textAnchor="middle"
      >
        CLASS D
      </text>

      {/* Extended localizer centerline */}
      <line
        x1="500"
        y1="120"
        x2="500"
        y2="470"
        stroke="rgba(136,136,170,0.15)"
        strokeWidth="0.5"
        strokeDasharray="6 4"
      />

      {/* Compass north indicator */}
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

      {/* Runway */}
      <g className="landing-plan-runway">
        <rect x="494" y="470" width="12" height="58" rx="1" fill="#e4e4f0" opacity="0.8" />
        <line
          x1="500"
          y1="475"
          x2="500"
          y2="523"
          stroke="var(--l-bg)"
          strokeWidth="1"
          strokeDasharray="4 3"
        />
        <text
          x="500"
          y="544"
          fill="#8888aa"
          fontSize="9"
          fontFamily="JetBrains Mono, monospace"
          textAnchor="middle"
        >
          RWY 36
        </text>
      </g>

      {/* Main approach path — glow */}
      <path
        className="landing-plan-path"
        d="M180,80 C260,80 340,120 400,190 Q450,250 500,310 L500,470"
        fill="none"
        stroke="rgba(0,255,204,0.12)"
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter="url(#l-plan-glow-lg)"
      />

      {/* Main approach path */}
      <path
        className="landing-plan-path"
        d="M180,80 C260,80 340,120 400,190 Q450,250 500,310 L500,470"
        fill="none"
        stroke="url(#l-plan-grad)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter="url(#l-plan-glow)"
      />

      {/* Missed approach path */}
      <path
        className="landing-plan-missed"
        d="M500,528 L500,558 Q500,578 520,578 L610,578 Q650,578 650,538 L650,440"
        fill="none"
        stroke="#ff4444"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        filter="url(#l-plan-glow)"
        opacity="0.7"
      />

      {/* Waypoints */}
      <g>
        {[
          { cx: 180, cy: 80, label: 'IAF', ly: -16 },
          { cx: 400, cy: 190, label: 'IF', ly: -16 },
          { cx: 500, cy: 310, label: 'FAF', ly: -16 },
          { cx: 500, cy: 470, label: 'MAP', ly: 26 }
        ].map((pt, i) => (
          <g key={i} className="landing-plan-waypoint">
            <circle cx={pt.cx} cy={pt.cy} r="12" fill="rgba(0,255,204,0.08)" />
            <circle cx={pt.cx} cy={pt.cy} r="4" fill="#040410" stroke="#00ffcc" strokeWidth="2" />
            <text
              x={pt.cx}
              y={pt.cy + pt.ly}
              fill="#8888aa"
              fontSize="10"
              fontFamily="JetBrains Mono, monospace"
              textAnchor="middle"
            >
              {pt.label}
            </text>
          </g>
        ))}
      </g>

      {/* Missed label */}
      <text
        className="landing-plan-missed"
        x="668"
        y="486"
        fill="rgba(255,68,68,0.6)"
        fontSize="9"
        fontFamily="JetBrains Mono, monospace"
      >
        MISSED
      </text>
    </svg>
  );
}

/* ── Main Landing Page ─────────────────────────────── */
export default function LandingPage() {
  const navRef = useRef<HTMLElement>(null);

  useEffect(() => {
    // Override body styles for scrollable page
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

  // Nav scroll effect
  useEffect(() => {
    const page = document.querySelector('.landing-page');
    if (!page) return;

    const handleScroll = () => {
      navRef.current?.classList.toggle('scrolled', page.scrollTop > 40);
    };
    page.addEventListener('scroll', handleScroll, { passive: true });
    return () => page.removeEventListener('scroll', handleScroll);
  }, []);

  // Scroll reveal
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('visible');
          }
        });
      },
      { threshold: 0.12 }
    );

    document.querySelectorAll('.landing-reveal').forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="landing-page">
      {/* Navigation */}
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

      {/* Hero */}
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
        <div className="landing-hero-viz">
          <div className="landing-viz-stage">
            <div className="landing-viz-profile">
              <ApproachProfileSvg />
            </div>
            <div className="landing-viz-plan">
              <ApproachPlanViewSvg />
            </div>
          </div>
        </div>
        <div className="landing-hero-scroll">
          <span>scroll</span>
          <div className="landing-hero-scroll-line" />
        </div>
      </section>

      {/* Features */}
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
                className={`landing-feature-card landing-reveal landing-reveal-delay-${i % 3 + 1}`}
              >
                {f.icon}
                <h3>{f.title}</h3>
                <p>{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Try it */}
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

      {/* Footer */}
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
