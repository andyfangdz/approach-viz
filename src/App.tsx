/**
 * Approach Viz — 3D Instrument Approach Visualization
 * React Three Fiber implementation
 */

import { useState, useEffect, Suspense, useMemo } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment, Html } from '@react-three/drei';
import { parseCIFP, type CIFPData, type Approach, type Airport } from './cifp/parser';
import { ApproachPath } from './components/ApproachPath';
import { AirspaceVolumes } from './components/AirspaceVolumes';
import { TerrainWireframe } from './components/TerrainWireframe';
import './App.css';

const SUPPORTED_AIRPORT_IDS = [
  'KCDW',
  'KTEB',
  'KMMU',
  'KEWR',
  'KRNO',
  // NY-area Class D airports
  'KBDR',
  'KDXR',
  'KFOK',
  'KFRG',
  'KHPN',
  'KHVN',
  'KOXC',
  'KPOU',
  'KSMQ',
  'KSWF',
  'KTTN',
  'KPNE',
  // LA-area Class D airports
  'KCMA',
  'KCNO',
  'KCRQ',
  'KEMT',
  'KFUL',
  'KHHR',
  'KLGB',
  'KMHV',
  'KOXR',
  'KPMD',
  'KPOC',
  'KRAL',
  'KSBD',
  'KSMO',
  'KTOA',
  'KVCV',
  'KVNY',
  'KWHP',
  'KWJF'
] as const;
const NEARBY_AIRPORT_RADIUS_NM = 20;
const DEFAULT_AIRPORT = SUPPORTED_AIRPORT_IDS[0];
const DEFAULT_VERTICAL_SCALE = 3;

function isSupportedAirport(id: string | null): id is string {
  if (!id) return false;
  return SUPPORTED_AIRPORT_IDS.includes(id as typeof SUPPORTED_AIRPORT_IDS[number]);
}

function getSelectionFromUrl(): { airport: string; approach: string } {
  if (typeof window === 'undefined') {
    return { airport: DEFAULT_AIRPORT, approach: '' };
  }

  const segments = window.location.pathname.split('/').filter(Boolean);
  const airportFromPath = segments[0] || null;
  const approachFromPath = segments[1] ? decodeURIComponent(segments[1]) : '';

  if (isSupportedAirport(airportFromPath)) {
    return {
      airport: airportFromPath,
      approach: approachFromPath
    };
  }

  // Backward compatibility for existing query-param links.
  const params = new URLSearchParams(window.location.search);
  const airportParam = params.get('airport');
  const approachParam = params.get('approach') || '';

  return {
    airport: isSupportedAirport(airportParam) ? airportParam : DEFAULT_AIRPORT,
    approach: approachParam
  };
}

// Sample CIFP data for development
const SAMPLE_CIFP_DATA = `
SUSAP KCDWK6ACDW     0     045YHN40523081W074165286W013000172         1800018000C    MNAR    ESSEX COUNTY                  
SUSAP KCDWK6CAPART K60    W     N41052814W074152179                       W0125     NAR           APART                    
SUSAP KCDWK6CDOWDY K60    C     N41004710W074103809                       W0125     NAR           DOWDY                    
SUSAP KCDWK6CFAAIR K60    C     N40572253W074131190                       W0125     NAR           FAAIR                    
SUSAP KCDWK6CKOLLI K60    C     N40544713W074150853                       W0124     NAR           KOLLI                    
SUSAP KCDWK6CWELDD K60    W     N41063651W074203494                       W0124     NAR           WELDD                    
SUSAP KCDWK6CYOVUN K60    W     N40415932W074244211                       W0123     NAR           YOVUN                    
SUSAP KCDWK6CZEZEE K60    W     N41074464W074254827                       W0124     NAR           ZEZEE                    
SUSAP KCDWK6FR22   AAPART 010APARTK6PC0E  A    IF                                             18000                 A JS   
SUSAP KCDWK6FR22   AAPART 020DOWDYK6PC0EE B 010TF                                 + 02400                           A JS   
SUSAP KCDWK6FR22   AWELDD 010WELDDK6PC0E  A    IF                                             18000                 A JS   
SUSAP KCDWK6FR22   AWELDD 020APARTK6PC0E    010TF                                 + 03000                           A JS   
SUSAP KCDWK6FR22   AWELDD 030DOWDYK6PC0EE B 010TF                                 + 02400                           A JS   
SUSAP KCDWK6FR22   AZEZEE 010ZEZEEK6PC0E  A    IF                                             18000                 A JS   
SUSAP KCDWK6FR22   AZEZEE 020WELDDK6PC0E    010TF                                 + 03000                           A JS   
SUSAP KCDWK6FR22   AZEZEE 030APARTK6PC0E    010TF                                 + 03000                           A JS   
SUSAP KCDWK6FR22   AZEZEE 040DOWDYK6PC0EE B 010TF                                 + 02400                           A JS   
SUSAP KCDWK6FR22   R      010DOWDYK6PC0E  I    IF                                 + 02400     18000                 A JS   
SUSAP KCDWK6FR22   R      020FAAIRK6PC1E  F 010TF                                 + 02000                 RW22  K6PGA JS   
SUSAP KCDWK6FR22   R      021KOLLIK6PC0E S  031TF                                 V 0100001020        -310          A JS   
SUSAP KCDWK6FR22   R      030RW22 K6PG0GY M 031TF                                   00230             -310          A JS   
SUSAP KCDWK6FR22   R      040         0  M     CA                     2227        + 00459                           A JS   
SUSAP KCDWK6FR22   R      050YOVUNK6PC0EY   010DF                                 + 02000                           A JS   
SUSAP KCDWK6FR22   R      060YOVUNK6PC0EE  R   HM                     04250040    + 02000                           A JS   
`.trim();

interface AirspaceFeature {
  type: string;
  class: string;
  name: string;
  lowerAlt: number;
  upperAlt: number;
  coordinates: [number, number][][];
}

interface MinimumsValue {
  altitude: string;
  rvr: string | null;
  visibility: string | null;
}

interface ApproachMinimums {
  minimums_type: string;
  cat_a: MinimumsValue | 'NA' | null;
  cat_b: MinimumsValue | 'NA' | null;
  cat_c: MinimumsValue | 'NA' | null;
  cat_d: MinimumsValue | 'NA' | null;
}

interface ExternalApproach {
  name: string;
  types: string[];
  runway: string | null;
  minimums: ApproachMinimums[];
}

interface ExternalAirport {
  approaches: ExternalApproach[];
}

interface ApproachMinimumsDb {
  dtpp_cycle_number: string;
  airports: Record<string, ExternalAirport>;
}

interface MinimumsSummary {
  sourceApproachName: string;
  cycle: string;
  daCatA?: { altitude: number; type: string };
  mdaCatA?: { altitude: number; type: string };
}

async function loadCIFPFile(): Promise<string> {
  try {
    const response = await fetch('/data/cifp/FAACIFP18');
    if (response.ok) return await response.text();
  } catch { /* fallback */ }
  return SAMPLE_CIFP_DATA;
}

async function loadApproachMinimumsDb(): Promise<ApproachMinimumsDb | null> {
  const candidates = [
    '/data/approach-db/approaches_supported.json',
    '/data/approach-db/approaches.json'
  ];

  for (const path of candidates) {
    try {
      const response = await fetch(path);
      if (!response.ok) continue;
      return await response.json();
    } catch {
      // try next source
    }
  }
  return null;
}

function normalizeRunwayKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const match = raw.toUpperCase().match(/(\d{1,2})([LRC]?)/);
  if (!match) return null;
  const number = match[1].padStart(2, '0');
  return `${number}${match[2] || ''}`;
}

function parseProcedureRunway(runway: string): { runwayKey: string | null; variant: string } {
  const cleaned = runway.toUpperCase().replace(/\s+/g, '');
  const match = cleaned.match(/^(\d{1,2}[LRC]?)(?:-?([A-Z]))?$/);
  if (!match) {
    return { runwayKey: normalizeRunwayKey(cleaned), variant: '' };
  }
  return {
    runwayKey: normalizeRunwayKey(match[1]),
    variant: match[2] || ''
  };
}

function parseApproachNameVariant(name: string): string {
  const match = name.toUpperCase().match(/\b([XYZ])\s+RWY\b/);
  return match ? match[1] : '';
}

function getTypeMatchScore(currentApproachType: string, externalApproach: ExternalApproach): number {
  const current = currentApproachType.toUpperCase();
  const external = `${externalApproach.name} ${(externalApproach.types || []).join(' ')}`.toUpperCase();

  if (current.includes('RNAV/RNP') || current.includes('RNP')) {
    if (external.includes('RNP')) return 4;
    if (external.includes('RNAV')) return 2;
    return 0;
  }
  if (current === 'RNAV') return external.includes('RNAV') ? 3 : 0;
  if (current === 'ILS') return external.includes('ILS') ? 3 : 0;
  if (current === 'LOC') return external.includes('LOC') ? 3 : 0;
  if (current === 'VOR') return external.includes('VOR') ? 3 : 0;
  return 1;
}

function resolveExternalApproach(
  db: ApproachMinimumsDb | null,
  airportId: string,
  approach: Approach | undefined
): ExternalApproach | null {
  if (!db || !approach) return null;
  const airportData = db.airports[airportId];
  if (!airportData || !Array.isArray(airportData.approaches)) return null;

  const { runwayKey, variant } = parseProcedureRunway(approach.runway);
  if (!runwayKey) return null;

  const runwayCandidates = airportData.approaches.filter((candidate) => (
    normalizeRunwayKey(candidate.runway ?? candidate.name) === runwayKey
  ));
  if (runwayCandidates.length === 0) return null;

  const scored = runwayCandidates
    .map((candidate) => {
      const candidateVariant = parseApproachNameVariant(candidate.name);
      const variantScore = variant
        ? (candidateVariant === variant ? 4 : 0)
        : (candidateVariant ? 0 : 1);
      const typeScore = getTypeMatchScore(approach.type, candidate);
      return { candidate, score: variantScore + typeScore };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.candidate ?? null;
}

function parseMinimumAltitude(value: MinimumsValue | 'NA' | null): number | null {
  if (!value || value === 'NA') return null;
  const match = value.altitude.match(/\d+/);
  if (!match) return null;
  const parsed = parseInt(match[0], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function getCategoryAAltitude(minimums: ApproachMinimums): number | null {
  return parseMinimumAltitude(minimums.cat_a);
}

function isDecisionAltitudeType(minimumsType: string): boolean {
  return /(LPV|VNAV|RNP|ILS|GLS|LP\+V|GBAS|PAR)/i.test(minimumsType);
}

function deriveMinimumsSummary(
  db: ApproachMinimumsDb | null,
  airportId: string,
  approach: Approach | undefined
): MinimumsSummary | null {
  const externalApproach = resolveExternalApproach(db, airportId, approach);
  if (!db || !externalApproach) return null;

  let bestDa: { altitude: number; type: string } | undefined;
  let bestMda: { altitude: number; type: string } | undefined;

  for (const minima of externalApproach.minimums || []) {
    const altitude = getCategoryAAltitude(minima);
    if (altitude === null) continue;
    if (isDecisionAltitudeType(minima.minimums_type)) {
      if (!bestDa || altitude < bestDa.altitude) {
        bestDa = { altitude, type: minima.minimums_type };
      }
    } else {
      if (!bestMda || altitude < bestMda.altitude) {
        bestMda = { altitude, type: minima.minimums_type };
      }
    }
  }

  return {
    sourceApproachName: externalApproach.name,
    cycle: db.dtpp_cycle_number,
    daCatA: bestDa,
    mdaCatA: bestMda
  };
}

async function loadAirspaceData(): Promise<AirspaceFeature[]> {
  const allFeatures: AirspaceFeature[] = [];
  const classes = [
    { file: 'class_b.geojson', class: 'B' },
    { file: 'class_c.geojson', class: 'C' },
    { file: 'class_d.geojson', class: 'D' }
  ];
  
  for (const { file, class: airspaceClass } of classes) {
    try {
      const response = await fetch(`/data/airspace/${file}`);
      if (response.ok) {
        const data = await response.json();
        for (const f of data.features) {
          const parseAlt = (alt: string): number => {
            if (!alt || alt === 'SFC') return 0;
            return parseInt(alt) || 0;
          };
          
          allFeatures.push({
            type: 'CLASS',
            class: airspaceClass,
            name: f.properties.NAME || f.properties.AIRSPACE,
            lowerAlt: parseAlt(f.properties.LOWALT),
            upperAlt: parseAlt(f.properties.HIGHALT),
            coordinates: f.geometry.type === 'Polygon' 
              ? f.geometry.coordinates 
              : f.geometry.coordinates.flat()
          });
        }
      }
    } catch { /* no data available */ }
  }
  
  return allFeatures;
}

function LoadingFallback() {
  return (
    <Html center>
      <div className="loading-3d">Loading 3D scene...</div>
    </Html>
  );
}

export default function App() {
  const initialSelection = getSelectionFromUrl();
  const [cifpData, setCifpData] = useState<CIFPData | null>(null);
  const [approachMinimumsDb, setApproachMinimumsDb] = useState<ApproachMinimumsDb | null>(null);
  const [airspace, setAirspace] = useState<AirspaceFeature[]>([]);
  const [selectedAirport, setSelectedAirport] = useState<string>(initialSelection.airport);
  const [selectedApproach, setSelectedApproach] = useState<string>(initialSelection.approach);
  const [verticalScale, setVerticalScale] = useState<number>(DEFAULT_VERTICAL_SCALE);
  const [loading, setLoading] = useState(true);

  // Load data on mount
  useEffect(() => {
    async function loadData() {
      const cifpContent = await loadCIFPFile();
      const parsed = parseCIFP(cifpContent, selectedAirport);
      setCifpData(parsed);
      
      const approaches = parsed.approaches.get(selectedAirport);
      if (approaches && approaches.length > 0) {
        setSelectedApproach((current) => {
          const selectedApproachStillValid = approaches.some(
            approach => approach.procedureId === current
          );
          return selectedApproachStillValid ? current : approaches[0].procedureId;
        });
      } else {
        setSelectedApproach('');
      }
      
      const airspaceData = await loadAirspaceData();
      const airport = parsed.airports.get(selectedAirport);
      
      if (airport) {
        // Filter to ~30nm radius
        const nearby = airspaceData.filter(f => {
          for (const ring of f.coordinates) {
            for (const [lon, lat] of ring) {
              const dist = Math.sqrt(
                Math.pow((lat - airport.lat) * 60, 2) +
                Math.pow((lon - airport.lon) * 60 * Math.cos(airport.lat * Math.PI / 180), 2)
              );
              if (dist < 30) return true;
            }
          }
          return false;
        });
        setAirspace(nearby);
      }
      
      setLoading(false);
    }
    loadData();
  }, [selectedAirport]);

  useEffect(() => {
    async function loadMinimums() {
      const loaded = await loadApproachMinimumsDb();
      setApproachMinimumsDb(loaded);
    }
    loadMinimums();
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const encodedApproach = selectedApproach ? `/${encodeURIComponent(selectedApproach)}` : '';
    const nextPath = `/${selectedAirport}${encodedApproach}`;
    const nextUrl = `${nextPath}${window.location.hash}`;
    if (`${window.location.pathname}${window.location.hash}` !== nextUrl) {
      window.history.replaceState(null, '', nextUrl);
    }
  }, [selectedAirport, selectedApproach]);

  const approaches = cifpData?.approaches.get(selectedAirport) || [];
  const currentApproach = approaches.find(a => a.procedureId === selectedApproach);
  const minimumsSummary = useMemo(
    () => deriveMinimumsSummary(approachMinimumsDb, selectedAirport, currentApproach),
    [approachMinimumsDb, selectedAirport, currentApproach]
  );
  const airport = cifpData?.airports.get(selectedAirport);
  const waypoints = cifpData?.waypoints || new Map();
  const runways = cifpData?.runways.get(selectedAirport) || [];
  const airportOptions = useMemo(
    () => SUPPORTED_AIRPORT_IDS.map((id) => {
      const knownAirport = cifpData?.airports.get(id);
      const label = knownAirport ? `${id} - ${knownAirport.name}` : id;
      return { id, label };
    }),
    [cifpData]
  );
  const nearbyAirports = useMemo(() => {
    if (!cifpData || !airport) return [];

    const cosRef = Math.cos(airport.lat * Math.PI / 180);
    return Array.from(cifpData.airports.values())
      .filter(other => other.id !== airport.id)
      .map((other) => {
        const dist = Math.sqrt(
          Math.pow((other.lat - airport.lat) * 60, 2) +
          Math.pow((other.lon - airport.lon) * 60 * cosRef, 2)
        );
        return {
          airport: other,
          distanceNm: dist,
          runways: cifpData.runways.get(other.id) || []
        };
      })
      .filter(item => item.distanceNm <= NEARBY_AIRPORT_RADIUS_NM)
      .filter(item => item.runways.length > 0)
      .sort((a, b) => a.distanceNm - b.distanceNm)
      .slice(0, 8);
  }, [cifpData, airport]);

  return (
    <div className="app">
      <header>
        <div className="logo">
          <div className="logo-icon">A</div>
          <div className="logo-text">Approach<span>Viz</span></div>
        </div>
        
        <div className="controls">
          <div className="control-group">
            <label>Airport</label>
            <select 
              value={selectedAirport}
              onChange={(e) => {
                setSelectedApproach('');
                setSelectedAirport(e.target.value);
              }}
            >
              {airportOptions.map((airportOption) => (
                <option key={airportOption.id} value={airportOption.id}>
                  {airportOption.label}
                </option>
              ))}
            </select>
          </div>
          
          <div className="control-group">
            <label>Approach</label>
            <select 
              value={selectedApproach}
              onChange={(e) => setSelectedApproach(e.target.value)}
              disabled={approaches.length === 0}
            >
              {approaches.length > 0 ? approaches.map(a => (
                <option key={a.procedureId} value={a.procedureId}>
                  {a.type} RWY {a.runway}
                </option>
              )) : (
                <option value="">No approaches available</option>
              )}
            </select>
          </div>

          <div className="control-group vertical-scale">
            <label>Vertical</label>
            <input
              type="range"
              min={1}
              max={15}
              step={0.5}
              value={verticalScale}
              onChange={(e) => setVerticalScale(parseFloat(e.target.value))}
            />
            <span className="control-value">{verticalScale.toFixed(1)}x</span>
          </div>
        </div>
      </header>

      <main className="main-content">
        {loading ? (
          <div className="loading">Loading approach data...</div>
        ) : (
          <Canvas
            camera={{ position: [15, 8, 15], fov: 60, near: 0.1, far: 500 }}
            gl={{ antialias: true }}
          >
            <color attach="background" args={['#0a0a14']} />
            <fog attach="fog" args={['#0a0a14', 50, 200]} />
            
            <Suspense fallback={<LoadingFallback />}>
              <ambientLight intensity={0.4} />
              <directionalLight position={[10, 20, 10]} intensity={0.8} />

              {airport && (
                <TerrainWireframe
                  refLat={airport.lat}
                  refLon={airport.lon}
                  verticalScale={verticalScale}
                />
              )}
              
              {airport && currentApproach && (
                <ApproachPath
                  approach={currentApproach}
                  waypoints={waypoints}
                  airport={airport}
                  runways={runways}
                  verticalScale={verticalScale}
                  nearbyAirports={nearbyAirports}
                />
              )}
              
              {airport && airspace.length > 0 && (
                <AirspaceVolumes
                  key={`airspace-${airspace.length}-${airspace.map(a => a.name).join(',')}`}
                  features={airspace}
                  refLat={airport.lat}
                  refLon={airport.lon}
                  verticalScale={verticalScale}
                />
              )}
              
              <OrbitControls
                enableDamping
                dampingFactor={0.05}
                target={[0, 2, 0]}
              />
            </Suspense>
          </Canvas>
        )}

        <div className="info-panel">
          <h3>Legend</h3>
          <div className="legend">
            <div className="legend-item">
              <div className="legend-color final" />
              <span>Final Approach</span>
            </div>
            <div className="legend-item">
              <div className="legend-color transition" />
              <span>Transitions</span>
            </div>
            <div className="legend-item">
              <div className="legend-color missed" />
              <span>Missed Approach</span>
            </div>
            <div className="legend-item">
              <div className="legend-color hold" />
              <span>Hold</span>
            </div>
            <div className="legend-item">
              <div className="legend-color terrain" />
              <span>Terrain Wireframe</span>
            </div>
            <div className="legend-item">
              <div className="legend-color airspace-b" />
              <span>Class B</span>
            </div>
            <div className="legend-item">
              <div className="legend-color airspace-c" />
              <span>Class C</span>
            </div>
            <div className="legend-item">
              <div className="legend-color airspace-d" />
              <span>Class D</span>
            </div>
          </div>

          <div className="minimums-section">
            <h3>Minimums (Cat A)</h3>
            {minimumsSummary ? (
              <>
                <div className="minimums-source">{minimumsSummary.sourceApproachName}</div>
                <div className="minimums-row">
                  <span>DA</span>
                  <span className="minimums-value">
                    {minimumsSummary.daCatA ? `${minimumsSummary.daCatA.altitude}' (${minimumsSummary.daCatA.type})` : 'n/a'}
                  </span>
                </div>
                <div className="minimums-row">
                  <span>MDA</span>
                  <span className="minimums-value">
                    {minimumsSummary.mdaCatA ? `${minimumsSummary.mdaCatA.altitude}' (${minimumsSummary.mdaCatA.type})` : 'n/a'}
                  </span>
                </div>
                <div className="minimums-cycle">DTPP cycle {minimumsSummary.cycle}</div>
              </>
            ) : (
              <div className="minimums-empty">No matching minimums found</div>
            )}
          </div>
        </div>

        <div className="help-panel">
          <p><kbd>Drag</kbd> Rotate view</p>
          <p><kbd>Scroll</kbd> Zoom in/out</p>
          <p><kbd>Right-drag</kbd> Pan</p>
        </div>
      </main>
    </div>
  );
}
