/**
 * Approach Viz — 3D Instrument Approach Visualization
 * React Three Fiber implementation
 */

import { useState, useEffect, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Environment, Html } from '@react-three/drei';
import { parseCIFP, type CIFPData, type Approach, type Airport } from './cifp/parser';
import { ApproachPath } from './components/ApproachPath';
import { AirspaceVolumes } from './components/AirspaceVolumes';
import { Ground } from './components/Ground';
import './App.css';

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

async function loadCIFPFile(): Promise<string> {
  try {
    const response = await fetch('/data/cifp/FAACIFP18');
    if (response.ok) return await response.text();
  } catch { /* fallback */ }
  return SAMPLE_CIFP_DATA;
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
  const [cifpData, setCifpData] = useState<CIFPData | null>(null);
  const [airspace, setAirspace] = useState<AirspaceFeature[]>([]);
  const [selectedAirport, setSelectedAirport] = useState('KCDW');
  const [selectedApproach, setSelectedApproach] = useState<string>('');
  const [loading, setLoading] = useState(true);

  // Load data on mount
  useEffect(() => {
    async function loadData() {
      const cifpContent = await loadCIFPFile();
      const parsed = parseCIFP(cifpContent, selectedAirport);
      setCifpData(parsed);
      
      const approaches = parsed.approaches.get(selectedAirport);
      if (approaches && approaches.length > 0) {
        setSelectedApproach(approaches[0].procedureId);
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

  const approaches = cifpData?.approaches.get(selectedAirport) || [];
  const currentApproach = approaches.find(a => a.procedureId === selectedApproach);
  const airport = cifpData?.airports.get(selectedAirport);
  const waypoints = cifpData?.waypoints || new Map();

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
              onChange={(e) => setSelectedAirport(e.target.value)}
            >
              <option value="KCDW">KCDW - Essex County</option>
            </select>
          </div>
          
          <div className="control-group">
            <label>Approach</label>
            <select 
              value={selectedApproach}
              onChange={(e) => setSelectedApproach(e.target.value)}
            >
              {approaches.map(a => (
                <option key={a.procedureId} value={a.procedureId}>
                  {a.type} RWY {a.runway}
                </option>
              ))}
            </select>
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
              
              <Ground />
              
              {airport && currentApproach && (
                <ApproachPath
                  approach={currentApproach}
                  waypoints={waypoints}
                  airport={airport}
                />
              )}
              
              {airport && airspace.length > 0 && (
                <AirspaceVolumes
                  features={airspace}
                  refLat={airport.lat}
                  refLon={airport.lon}
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
