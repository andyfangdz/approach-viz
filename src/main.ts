/**
 * Instrument Approach 3D Visualization
 * Main entry point
 */

import { parseCIFP } from './cifp/parser';
import { ApproachVisualization } from './visualization/scene';

// Sample CIFP data for KCDW (will be replaced with actual data loading)
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

interface AppState {
  visualization: ApproachVisualization | null;
  cifpData: ReturnType<typeof parseCIFP> | null;
  selectedAirport: string;
  selectedApproach: string;
}

const state: AppState = {
  visualization: null,
  cifpData: null,
  selectedAirport: 'KCDW',
  selectedApproach: 'R22'
};

async function loadCIFPFile(): Promise<string> {
  // Try to load from file, fallback to sample
  try {
    const response = await fetch('/data/cifp/FAACIFP18');
    if (response.ok) {
      return await response.text();
    }
  } catch {
    console.log('Using sample CIFP data');
  }
  return SAMPLE_CIFP_DATA;
}

async function loadAirspaceData(): Promise<any[]> {
  try {
    const response = await fetch('/data/airspace/airspace_boundary.geojson');
    if (response.ok) {
      const data = await response.json();
      return data.features
        .filter((f: any) => f.properties.CLASS && ['B', 'C', 'D'].includes(f.properties.CLASS))
        .map((f: any) => ({
          type: f.properties.TYPE_CODE,
          class: f.properties.CLASS,
          name: f.properties.NAME,
          lowerAlt: f.properties.LOWER_VAL || 0,
          upperAlt: f.properties.UPPER_VAL || 10000,
          coordinates: f.geometry.type === 'Polygon' 
            ? f.geometry.coordinates 
            : f.geometry.coordinates.flat()
        }));
    }
  } catch (e) {
    console.log('No airspace data available');
  }
  return [];
}

function populateApproachSelector(): void {
  const selector = document.getElementById('approach-select') as HTMLSelectElement;
  if (!selector || !state.cifpData) return;
  
  selector.innerHTML = '';
  
  const approaches = state.cifpData.approaches.get(state.selectedAirport) || [];
  for (const approach of approaches) {
    const option = document.createElement('option');
    option.value = approach.procedureId;
    option.textContent = `${approach.type} RWY ${approach.runway}`;
    selector.appendChild(option);
  }
  
  if (approaches.length > 0) {
    state.selectedApproach = approaches[0].procedureId;
    selector.value = state.selectedApproach;
  }
}

function renderApproach(): void {
  if (!state.cifpData || !state.visualization) return;
  
  const approaches = state.cifpData.approaches.get(state.selectedAirport);
  if (!approaches) return;
  
  const approach = approaches.find(a => a.procedureId === state.selectedApproach);
  if (!approach) return;
  
  const airport = state.cifpData.airports.get(state.selectedAirport);
  if (!airport) return;
  
  state.visualization.addApproach(approach, state.cifpData.waypoints, airport);
}

async function init(): Promise<void> {
  const container = document.getElementById('visualization');
  if (!container) {
    console.error('Container not found');
    return;
  }
  
  // Show loading state
  container.innerHTML = '<div class="loading">Loading approach data...</div>';
  
  // Load data
  const cifpContent = await loadCIFPFile();
  state.cifpData = parseCIFP(cifpContent, state.selectedAirport);
  
  // Debug output
  console.log('Parsed CIFP data:', {
    airports: state.cifpData.airports.size,
    waypoints: state.cifpData.waypoints.size,
    approaches: state.cifpData.approaches.get(state.selectedAirport)?.length || 0
  });
  
  // Clear loading state
  container.innerHTML = '';
  
  // Create visualization (may fail if WebGL unavailable)
  try {
    state.visualization = new ApproachVisualization(container);
    
    // Load airspace
    const airspaceFeatures = await loadAirspaceData();
    
    // Filter airspace to area around airport
    const airport = state.cifpData.airports.get(state.selectedAirport);
    if (airport) {
      const nearbyAirspace = airspaceFeatures.filter(f => {
        // Check if any coordinate is within ~30nm of airport
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
      
      if (nearbyAirspace.length > 0) {
        state.visualization.addAirspace(nearbyAirspace);
      }
    }
    
    // Render initial approach
    renderApproach();
  } catch (e) {
    console.warn('3D visualization unavailable:', e);
    // WebGL error message already shown by ApproachVisualization
  }
  
  // Populate UI regardless
  populateApproachSelector();
  
  // Event listeners
  const approachSelect = document.getElementById('approach-select') as HTMLSelectElement;
  approachSelect?.addEventListener('change', (e) => {
    state.selectedApproach = (e.target as HTMLSelectElement).value;
    // Would need to clear and re-render scene - for now just log
    console.log('Selected approach:', state.selectedApproach);
  });
}

// Start
document.addEventListener('DOMContentLoaded', init);
