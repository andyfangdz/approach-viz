'use client';

import { useState, type CSSProperties } from 'react';

function accentStyle(accent: string): CSSProperties {
  // SAFETY: overview.css reads `--accent` on this element; React's CSSProperties omits dashed custom properties.
  return { '--accent': accent } as CSSProperties;
}

/* ------------------------------------------------------------------ */
/* Interactive system map (hero)                                       */
/* ------------------------------------------------------------------ */

interface SysNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  title: string;
  sub: string;
  desc: string;
  jump?: string;
}

interface SysEdge {
  from: string;
  to: string;
  color: string;
}

const NODES: SysNode[] = [
  {
    id: 'src-faa',
    x: 16,
    y: 56,
    w: 196,
    h: 54,
    color: '#6ea8ff',
    title: 'FAA CIFP + d-TPP',
    sub: 'ARINC 424 · plate PDFs',
    desc: 'AIRAC-cycle procedure data (FAACIFP18) parsed at build time; georeferenced approach plate PDFs proxied from aeronav.faa.gov at runtime.',
    jump: 'cifp'
  },
  {
    id: 'src-arcgis',
    x: 16,
    y: 126,
    w: 196,
    h: 54,
    color: '#6ea8ff',
    title: 'FAA ArcGIS Tiles',
    sub: 'VFR · TAC · IFR low/high',
    desc: 'Public FAA chart tile services fetched directly by the browser, streamed through a dedicated worker and cached by the service worker.',
    jump: 'chart-tiles'
  },
  {
    id: 'src-terrarium',
    x: 16,
    y: 196,
    w: 196,
    h: 54,
    color: '#6dff9c',
    title: 'AWS Terrarium DEM',
    sub: 'elevation-tiles-prod S3',
    desc: 'Terrarium-encoded RGB elevation tiles at zoom 10, decoded client-side into the terrain wireframe mesh.',
    jump: 'terrain'
  },
  {
    id: 'src-google',
    x: 16,
    y: 266,
    w: 196,
    h: 54,
    color: '#6dff9c',
    title: 'Google 3D Tiles',
    sub: 'photorealistic tiles API',
    desc: 'Google photorealistic 3D tiles streamed via 3d-tiles-renderer, reanchored from ECEF into the local nautical-mile scene frame.',
    jump: 'tiles3d'
  },
  {
    id: 'src-mrms',
    x: 16,
    y: 336,
    w: 196,
    h: 54,
    color: '#ff2ea6',
    title: 'NOAA MRMS',
    sub: 'S3 + SNS · GRIB2',
    desc: '33-level MergedReflectivityQC mosaic plus dual-pol, thermodynamic and echo-top products, announced over SNS and ingested from S3.',
    jump: 'mrms-ingest'
  },
  {
    id: 'src-adsb',
    x: 16,
    y: 406,
    w: 196,
    h: 54,
    color: '#ffb52e',
    title: 'ADS-B Exchange',
    sub: 'binCraft + zstd feed',
    desc: 'Live aircraft state for CONUS/AK/HI/PR polled from tar1090 re-api endpoints and merged into a SQLite-backed track store.',
    jump: 'adsb-ingest'
  },
  {
    id: 'svc-pipeline',
    x: 306,
    y: 56,
    w: 212,
    h: 64,
    color: '#6ea8ff',
    title: 'Data Pipeline',
    sub: 'download-data → build-db',
    desc: 'Build-time scripts download CIFP, the approach-minimums release and pinned airspace GeoJSON, then compile everything into approach-viz.sqlite with R-tree spatial indexes.',
    jump: 'cifp'
  },
  {
    id: 'svc-next',
    x: 306,
    y: 182,
    w: 212,
    h: 72,
    color: '#45e0c0',
    title: 'Next.js 16 App',
    sub: 'Vercel · SSR + API proxies',
    desc: 'App Router service: server actions read the SQLite bundle, API routes validate/clamp params and proxy the Rust runtime, FAA plates, ProbSevere and Datadog RUM.',
    jump: 'nextjs'
  },
  {
    id: 'svc-runtime',
    x: 306,
    y: 342,
    w: 212,
    h: 72,
    color: '#ffb52e',
    title: 'Rust Runtime',
    sub: 'axum · OCI Arm · systemd',
    desc: 'Long-lived ingest + query service: MRMS GRIB2 decode and snapshot assembly, ADS-B track store, FlatBuffers wire encoding, OTLP tracing to Datadog.',
    jump: 'runtime'
  },
  {
    id: 'core',
    x: 606,
    y: 202,
    w: 220,
    h: 104,
    color: '#ffb52e',
    title: 'approach-viz-core',
    sub: 'one crate · three targets',
    desc: 'The shared Rust engine: approach-path geometry, WGS84 projection, MRMS prepare/render join, traffic merge, and all wire-format decoders. Compiled to rlib (runtime), WASM (web) and a UniFFI XCFramework (Apple).',
    jump: 'core'
  },
  {
    id: 'web',
    x: 908,
    y: 82,
    w: 196,
    h: 112,
    color: '#45e0c0',
    title: 'Web Client',
    sub: 'React Three Fiber · workers',
    desc: 'Worker-first browser client: Comlink-proxied workers run the WASM core off the main thread; react-three-fiber renders terrain, approaches, airspace, traffic and weather.',
    jump: 'frontend'
  },
  {
    id: 'native',
    x: 908,
    y: 352,
    w: 196,
    h: 104,
    color: '#6dff9c',
    title: 'iOS / macOS',
    sub: 'SwiftUI · Metal · TCA',
    desc: 'Native shell over the same engine: MetalKit renderer, Composable Architecture state, GRDB-read SQLite bundle, direct runtime polling via UniFFI-decoded FlatBuffers.',
    jump: 'native'
  }
];

const EDGES: SysEdge[] = [
  { from: 'src-faa', to: 'svc-pipeline', color: '#6ea8ff' },
  { from: 'src-faa', to: 'svc-next', color: '#6ea8ff' },
  { from: 'svc-pipeline', to: 'svc-next', color: '#6ea8ff' },
  { from: 'src-mrms', to: 'svc-runtime', color: '#ff2ea6' },
  { from: 'src-adsb', to: 'svc-runtime', color: '#ffb52e' },
  { from: 'svc-runtime', to: 'svc-next', color: '#ffb52e' },
  { from: 'svc-next', to: 'web', color: '#45e0c0' },
  { from: 'svc-runtime', to: 'native', color: '#ffb52e' },
  { from: 'core', to: 'web', color: '#ffb52e' },
  { from: 'core', to: 'native', color: '#ffb52e' },
  { from: 'core', to: 'svc-runtime', color: '#ffb52e' },
  { from: 'src-arcgis', to: 'web', color: '#6ea8ff' },
  { from: 'src-terrarium', to: 'web', color: '#6dff9c' },
  { from: 'src-google', to: 'web', color: '#6dff9c' }
];

const COLUMN_LABELS: { x: number; label: string }[] = [
  { x: 16, label: 'Sources' },
  { x: 306, label: 'Services' },
  { x: 606, label: 'Shared core' },
  { x: 908, label: 'Clients' }
];

function edgePath(from: SysNode, to: SysNode): string {
  const x1 = from.x + from.w;
  const y1 = from.y + from.h / 2;
  const x2 = to.x;
  const y2 = to.y + to.h / 2;
  const mid = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
}

export function SystemMap() {
  const [focus, setFocus] = useState<string | null>(null);
  const nodeById = new Map(NODES.map((n) => [n.id, n]));
  const focused = focus ? nodeById.get(focus) : undefined;
  const litEdges = focus ? EDGES.filter((e) => e.from === focus || e.to === focus) : EDGES;
  const litNodeIds = focus ? new Set([focus, ...litEdges.flatMap((e) => [e.from, e.to])]) : null;

  return (
    <div className="ov-diagram" style={accentStyle('#45e0c0')}>
      <div className="ov-diagram-bar">
        <span>FIG 1 — SYSTEM MAP</span>
        <span className="ov-diagram-hint">
          {focus ? 'click background to clear' : 'click a node to trace its connections'}
        </span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <svg
          viewBox="0 0 1120 490"
          style={{ minWidth: 760 }}
          role="img"
          aria-label="ApproachViz system architecture map"
          onClick={() => setFocus(null)}
        >
          {COLUMN_LABELS.map((c) => (
            <text key={c.label} className="ov-svg-label" x={c.x + 2} y={30} fontSize={10}>
              {c.label}
            </text>
          ))}
          {EDGES.map((e, i) => {
            const from = nodeById.get(e.from);
            const to = nodeById.get(e.to);
            if (!from || !to) return null;
            const lit = !focus || e.from === focus || e.to === focus;
            return (
              <path
                key={i}
                className={`ov-flow ${lit ? 'ov-lit' : 'ov-dim'}`}
                d={edgePath(from, to)}
                stroke={e.color}
                strokeWidth={lit && focus ? 1.6 : 1}
                strokeOpacity={0.55}
              />
            );
          })}
          {NODES.map((n) => {
            const lit = !litNodeIds || litNodeIds.has(n.id);
            return (
              <g
                key={n.id}
                className={`ov-sysnode ${lit ? 'ov-lit' : 'ov-dim'} ${focus === n.id ? 'ov-focus' : ''}`}
                role="button"
                tabIndex={0}
                aria-label={`${n.title} — show connections`}
                aria-pressed={focus === n.id}
                onClick={(ev) => {
                  ev.stopPropagation();
                  setFocus(focus === n.id ? null : n.id);
                }}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter' || ev.key === ' ') {
                    ev.preventDefault();
                    ev.stopPropagation();
                    setFocus(focus === n.id ? null : n.id);
                  } else if (ev.key === 'Escape') {
                    setFocus(null);
                  }
                }}
              >
                <rect
                  x={n.x}
                  y={n.y}
                  width={n.w}
                  height={n.h}
                  rx={3}
                  fill={focus === n.id ? 'rgba(20, 22, 40, 0.98)' : 'rgba(13, 13, 26, 0.92)'}
                  stroke={n.color}
                  strokeOpacity={focus === n.id ? 1 : 0.55}
                />
                <rect x={n.x} y={n.y} width={3} height={n.h} fill={n.color} fillOpacity={0.9} />
                <text className="ov-svg-node-title" x={n.x + 14} y={n.y + 22} fontSize={14}>
                  {n.title}
                </text>
                <text className="ov-svg-node-sub" x={n.x + 14} y={n.y + 39} fontSize={9.5}>
                  {n.sub}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      {focused && (
        <div className="ov-syscard" style={accentStyle(focused.color)}>
          <span className="ov-syscard-title">{focused.title}</span>
          <span className="ov-syscard-desc">{focused.desc}</span>
          {focused.jump && (
            // plain anchor: the container's scroll-spy re-syncs the rail as the jump scrolls
            <a className="ov-syscard-jump" href={`#${focused.jump}`}>
              GO TO SECTION ↓
            </a>
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Small static flow diagrams                                          */
/* ------------------------------------------------------------------ */

interface FlowBox {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
  color: string;
}

function FlowNode({ b }: { b: FlowBox }) {
  return (
    <g>
      <rect
        x={b.x}
        y={b.y}
        width={b.w}
        height={b.h}
        rx={3}
        fill="rgba(13, 13, 26, 0.92)"
        stroke={b.color}
        strokeOpacity={0.55}
      />
      <rect x={b.x} y={b.y} width={3} height={b.h} fill={b.color} fillOpacity={0.9} />
      <text className="ov-svg-node-title" x={b.x + 12} y={b.y + 21} fontSize={12.5}>
        {b.title}
      </text>
      {b.sub && (
        <text className="ov-svg-node-sub" x={b.x + 12} y={b.y + 37} fontSize={9}>
          {b.sub}
        </text>
      )}
    </g>
  );
}

function FlowArrow({
  d,
  color,
  label,
  lx,
  ly
}: {
  d: string;
  color: string;
  label?: string;
  lx?: number;
  ly?: number;
}) {
  return (
    <g>
      <path className="ov-flow" d={d} stroke={color} strokeWidth={1.2} strokeOpacity={0.6} />
      {label && lx !== undefined && ly !== undefined && (
        <text className="ov-svg-label" x={lx} y={ly} fontSize={8.5} fill={color} fillOpacity={0.9}>
          {label}
        </text>
      )}
    </g>
  );
}

export function MrmsPipelineDiagram() {
  const M = '#ff2ea6';
  const G = '#ffb52e';
  return (
    <div className="ov-diagram">
      <div className="ov-diagram-bar">
        <span>FIG 2 — MRMS INGEST PIPELINE</span>
        <span className="ov-diagram-hint">runs continuously on the OCI runtime host</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <svg
          viewBox="0 0 1060 250"
          style={{ minWidth: 720 }}
          role="img"
          aria-label="MRMS ingest pipeline"
        >
          <FlowNode
            b={{
              x: 16,
              y: 30,
              w: 168,
              h: 50,
              title: 'noaa-mrms-pds S3',
              sub: 'GRIB2 (.grib2.gz)',
              color: M
            }}
          />
          <FlowNode
            b={{
              x: 16,
              y: 130,
              w: 168,
              h: 50,
              title: 'SNS → SQS',
              sub: 'filter: MergedReflectivityQC_00.50/',
              color: M
            }}
          />
          <FlowNode
            b={{
              x: 250,
              y: 80,
              w: 190,
              h: 56,
              title: 'Timestamp queue',
              sub: 'dedup + retry backoff (≤20)',
              color: M
            }}
          />
          <FlowNode
            b={{
              x: 505,
              y: 30,
              w: 210,
              h: 62,
              title: 'Parallel fetch',
              sub: '33 levels + ZDR/RhoHV + aux + echo tops',
              color: M
            }}
          />
          <FlowNode
            b={{
              x: 505,
              y: 140,
              w: 210,
              h: 62,
              title: 'Assemble (blocking pool)',
              sub: 'SIMD filter → gather → phase → tiles',
              color: G
            }}
          />
          <FlowNode
            b={{
              x: 790,
              y: 30,
              w: 250,
              h: 62,
              title: 'ScanSnapshot',
              sub: 'Arc<RwLock<…>> + zstd persist (5 GB cap)',
              color: G
            }}
          />
          <FlowNode
            b={{
              x: 790,
              y: 140,
              w: 250,
              h: 62,
              title: 'axum /v1/weather/*',
              sub: 'window filter + FlatBuffers encode',
              color: G
            }}
          />
          <FlowArrow d="M 100 130 C 100 105, 100 100, 100 80" color={M} />
          <FlowArrow
            d="M 184 155 C 220 155, 215 110, 250 108"
            color={M}
            label="notify"
            lx={196}
            ly={140}
          />
          <FlowArrow
            d="M 440 108 C 475 108, 470 62, 505 61"
            color={M}
            label="fetch ts"
            lx={450}
            ly={80}
          />
          <FlowArrow
            d="M 184 55 C 350 55, 400 61, 505 61"
            color={M}
            label="GET objects"
            lx={300}
            ly={44}
          />
          <FlowArrow d="M 610 92 L 610 140" color={G} />
          <FlowArrow
            d="M 715 171 C 755 171, 750 61, 790 61"
            color={G}
            label="swap latest"
            lx={722}
            ly={120}
          />
          <FlowArrow
            d="M 915 92 L 915 140"
            color={G}
            label="Arc clone, lock-free encode"
            lx={925}
            ly={122}
          />
        </svg>
      </div>
    </div>
  );
}

export function PlateProjectionDiagram() {
  const C = '#45e0c0';
  const B = '#6ea8ff';
  return (
    <div className="ov-diagram">
      <div className="ov-diagram-bar">
        <span>FIG 4 — PLATE → TERRAIN PROJECTION</span>
        <span className="ov-diagram-hint">fragment-shader path used on Google 3D tiles</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <svg
          viewBox="0 0 1060 300"
          style={{ minWidth: 720 }}
          role="img"
          aria-label="FAA plate projection pipeline"
        >
          {/* PDF page */}
          <rect
            x={30}
            y={40}
            width={150}
            height={200}
            rx={2}
            fill="rgba(232,232,240,0.06)"
            stroke={B}
            strokeOpacity={0.6}
          />
          <rect
            x={48}
            y={92}
            width={114}
            height={120}
            fill="none"
            stroke={B}
            strokeOpacity={0.9}
            strokeDasharray="4 3"
          />
          {[
            [48, 92],
            [162, 92],
            [48, 212],
            [162, 212]
          ].map(([x, y], i) => (
            <g key={i}>
              <circle cx={x} cy={y} r={3.5} fill={C} />
            </g>
          ))}
          <text className="ov-svg-node-title" x={30} y={28} fontSize={12}>
            d-TPP plate PDF
          </text>
          <text className="ov-svg-node-sub" x={48} y={82} fontSize={9}>
            /GPTS + /LPTS control points
          </text>
          <text className="ov-svg-node-sub" x={48} y={258} fontSize={9}>
            pdf.js raster @4x → CanvasTexture
          </text>

          {/* bilinear + homography */}
          <FlowArrow d="M 185 140 C 235 140, 240 140, 285 140" color={C} />
          <rect
            x={290}
            y={86}
            width={240}
            height={112}
            rx={3}
            fill="rgba(13,13,26,0.92)"
            stroke={C}
            strokeOpacity={0.55}
          />
          <rect x={290} y={86} width={3} height={112} fill={C} fillOpacity={0.9} />
          <text className="ov-svg-node-title" x={306} y={110} fontSize={12.5}>
            Bilinear fit → homography
          </text>
          <text className="ov-svg-node-sub" x={306} y={132} fontSize={9.5}>
            lat/lon = a + b·u + c·v + d·u·v
          </text>
          <text className="ov-svg-node-sub" x={306} y={148} fontSize={9.5}>
            4 corners → latLonToLocal() → 8-unknown
          </text>
          <text className="ov-svg-node-sub" x={306} y={164} fontSize={9.5}>
            homography solve → mat3 uPlateHomography
          </text>
          <text className="ov-svg-node-sub" x={306} y={186} fontSize={9.5} fill="#ffb52e">
            world (x, z) plane → plate UV
          </text>

          {/* shader */}
          <FlowArrow d="M 530 140 C 580 140, 585 140, 630 140" color={C} />
          <rect
            x={635}
            y={40}
            width={400}
            height={210}
            rx={3}
            fill="rgba(13,13,26,0.92)"
            stroke={C}
            strokeOpacity={0.55}
          />
          <rect x={635} y={40} width={3} height={210} fill={C} fillOpacity={0.9} />
          <text className="ov-svg-node-title" x={652} y={66} fontSize={12.5}>
            onBeforeCompile patch — every tile material
          </text>
          <text className="ov-svg-node-sub" x={652} y={94} fontSize={9.5}>
            1 · clamp bathymetry to sea level (+ curvature term)
          </text>
          <text className="ov-svg-node-sub" x={652} y={114} fontSize={9.5}>
            2 · vPlateWorldPos = clamped world position
          </text>
          <text className="ov-svg-node-sub" x={652} y={134} fontSize={9.5}>
            3 · uvH = uPlateHomography · (x, z, 1)
          </text>
          <text className="ov-svg-node-sub" x={652} y={154} fontSize={9.5}>
            4 · uv = uvH.xy / uvH.z — perspective divide
          </text>
          <text className="ov-svg-node-sub" x={652} y={174} fontSize={9.5}>
            5 · clip: uv ∈ [0,1]² else keep satellite texel
          </text>
          <text className="ov-svg-node-sub" x={652} y={194} fontSize={9.5}>
            6 · chart texel overwrites RGB; plate alpha-blends on top
          </text>
          <text className="ov-svg-node-sub" x={652} y={222} fontSize={9.5} fill="#ffb52e">
            uniforms synced per-frame; cache key |faa-overlay-v5
          </text>
        </svg>
      </div>
    </div>
  );
}

export function WorkerTopologyDiagram() {
  const C = '#45e0c0';
  const G = '#ffb52e';
  return (
    <div className="ov-diagram">
      <div className="ov-diagram-bar">
        <span>FIG 3 — WORKER TOPOLOGY</span>
        <span className="ov-diagram-hint">no synchronous compute fallback on the main thread</span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <svg
          viewBox="0 0 1060 300"
          style={{ minWidth: 720 }}
          role="img"
          aria-label="Web worker topology"
        >
          <FlowNode
            b={{
              x: 340,
              y: 20,
              w: 380,
              h: 54,
              title: 'Main thread — React Three Fiber scene',
              sub: 'Comlink typed proxies · zero-copy Comlink.transfer()',
              color: C
            }}
          />
          <FlowNode
            b={{
              x: 16,
              y: 140,
              w: 190,
              h: 58,
              title: 'approach.worker',
              sub: 'altitudes · path · holds (WASM)',
              color: C
            }}
          />
          <FlowNode
            b={{
              x: 226,
              y: 140,
              w: 190,
              h: 58,
              title: 'nexrad.worker',
              sub: 'poll · decode · prepare (WASM)',
              color: C
            }}
          />
          <FlowNode
            b={{
              x: 436,
              y: 140,
              w: 190,
              h: 58,
              title: 'traffic.worker',
              sub: 'merge · render tracks (WASM)',
              color: C
            }}
          />
          <FlowNode
            b={{
              x: 646,
              y: 140,
              w: 190,
              h: 58,
              title: 'chart-tiles.worker',
              sub: '60-way tile streaming',
              color: C
            }}
          />
          <FlowNode
            b={{
              x: 856,
              y: 140,
              w: 185,
              h: 58,
              title: 'filter.worker',
              sub: 'selector filtering',
              color: C
            }}
          />
          <FlowNode
            b={{
              x: 226,
              y: 240,
              w: 400,
              h: 44,
              title: 'approach_viz_core.wasm',
              sub: 'shared Rust engine — one implementation',
              color: G
            }}
          />
          <FlowArrow d="M 111 140 C 111 100, 300 74, 340 60" color={C} />
          <FlowArrow d="M 321 140 C 321 110, 400 90, 430 74" color={C} />
          <FlowArrow d="M 531 140 L 531 74" color={C} />
          <FlowArrow d="M 741 140 C 741 110, 680 90, 655 74" color={C} />
          <FlowArrow d="M 948 140 C 948 100, 760 74, 720 60" color={C} />
          <FlowArrow d="M 111 198 C 111 240, 180 254, 226 258" color={G} />
          <FlowArrow d="M 321 198 L 321 240" color={G} />
          <FlowArrow d="M 531 198 L 531 240" color={G} />
        </svg>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Interactive dBZ legend — real band tables from nexrad-types.ts      */
/* ------------------------------------------------------------------ */

type Band = [minDbz: number, hex: string];

const RAIN_BANDS: Band[] = [
  [5, '#49ff64'],
  [10, '#39eb53'],
  [15, '#2ed643'],
  [20, '#23bc34'],
  [25, '#ffd700'],
  [30, '#ffb000'],
  [35, '#ff8600'],
  [40, '#ff5a00'],
  [45, '#f92d00'],
  [50, '#e90000'],
  [55, '#d500f5'],
  [60, '#ba00e8'],
  [65, '#9a00d5'],
  [70, '#7b00bb'],
  [75, '#9a9a9a'],
  [80, '#b1b1b1'],
  [85, '#c6c6c6'],
  [90, '#d9d9d9'],
  [95, '#ebebeb']
];

const MIXED_BANDS: Band[] = [
  [5, '#fab8dc'],
  [10, '#f5a6d3'],
  [15, '#f093cb'],
  [20, '#ea80c2'],
  [25, '#e46db9'],
  [30, '#dd59b0'],
  [35, '#d746a7'],
  [40, '#d0339f'],
  [45, '#c92096'],
  [50, '#c30d8d'],
  [55, '#b30086'],
  [60, '#a10080'],
  [65, '#8f0079'],
  [70, '#7d0072'],
  [75, '#6b006b']
];

const SNOW_BANDS: Band[] = [
  [5, '#7de8ff'],
  [10, '#69dcff'],
  [15, '#56d0ff'],
  [20, '#43c4ff'],
  [25, '#31b8ff'],
  [30, '#27a7ff'],
  [35, '#2196ff'],
  [40, '#1a82ff'],
  [45, '#146eff'],
  [50, '#0f5aff'],
  [55, '#0a46e6'],
  [60, '#0837c4'],
  [65, '#062aa3'],
  [70, '#041f82'],
  [75, '#031763']
];

const PHASES: { name: string; bands: Band[] }[] = [
  { name: 'Rain', bands: RAIN_BANDS },
  { name: 'Mixed', bands: MIXED_BANDS },
  { name: 'Snow', bands: SNOW_BANDS }
];

export function DbzLegend() {
  const [hover, setHover] = useState<{ phase: string; band: Band } | null>(null);
  return (
    <div className="ov-dbz">
      <div className="ov-diagram-bar" style={{ border: 'none', padding: '0 0 4px' }}>
        <span>REFLECTIVITY COLOR LUTS — 5 dBZ BANDS PER PHASE</span>
        <span className="ov-diagram-hint">hover a band</span>
      </div>
      {PHASES.map((p) => (
        <div className="ov-dbz-row" key={p.name}>
          <span className="ov-dbz-phase">{p.name}</span>
          <div className="ov-dbz-bands">
            {p.bands.map((b) => (
              <span
                key={b[0]}
                className="ov-dbz-band"
                style={{ background: b[1] }}
                onMouseEnter={() => setHover({ phase: p.name, band: b })}
                onMouseLeave={() => setHover(null)}
              />
            ))}
          </div>
        </div>
      ))}
      <div className="ov-dbz-scale">
        <span>5</span>
        <span>15</span>
        <span>25</span>
        <span>35</span>
        <span>45</span>
        <span>55</span>
        <span>65</span>
        <span>75+</span>
      </div>
      <div className="ov-dbz-readout">
        {hover ? (
          <>
            <b>{hover.phase.toUpperCase()}</b> · ≥{hover.band[0]} dBZ · {hover.band[1]} — indexed by{' '}
            <b>floor(dbz / 5)</b>, visibility-gain applied at LUT build
          </>
        ) : (
          'source: RAIN/MIXED/SNOW_DBZ_COLOR_BANDS in app/scene/nexrad/nexrad-types.ts'
        )}
      </div>
    </div>
  );
}
