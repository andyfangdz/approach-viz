/**
 * Three.js 3D Visualization for Instrument Approaches
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { CIFPData, Approach, Waypoint, Airport } from '../cifp/parser';

// Earth radius in nautical miles
const EARTH_RADIUS_NM = 3440.065;

// Scale factor: 1 unit = 1 NM
const ALTITUDE_SCALE = 1 / 6076.12; // feet to NM
const VERTICAL_EXAGGERATION = 15; // Make altitude differences more visible

interface AirspaceFeature {
  type: string;
  class?: string;
  name: string;
  lowerAlt: number;
  upperAlt: number;
  coordinates: [number, number][][];
}

export class ApproachVisualization {
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private labelRenderer: CSS2DRenderer;
  private controls: OrbitControls;
  private container: HTMLElement;
  
  // Reference point for coordinate conversion
  private refLat: number = 0;
  private refLon: number = 0;
  
  // Colors
  private colors = {
    approach: 0x00ff88,
    transition: 0xffaa00,
    missed: 0xff4444,
    waypoint: 0xffffff,
    runway: 0xff00ff,
    airspaceB: 0x0066ff,
    airspaceC: 0xff00ff,
    airspaceD: 0x0099ff,
    ground: 0x1a1a2e,
    grid: 0x333355
  };

  constructor(container: HTMLElement) {
    this.container = container;
    
    // Check WebGL availability
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) {
      this.showWebGLError(container);
      throw new Error('WebGL not available');
    }
    
    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0a14);
    this.scene.fog = new THREE.Fog(0x0a0a14, 50, 200);
    
    // Camera
    this.camera = new THREE.PerspectiveCamera(
      60,
      container.clientWidth / container.clientHeight,
      0.1,
      500
    );
    this.camera.position.set(15, 8, 15);
    
    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);
    
    // Label renderer
    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.setSize(container.clientWidth, container.clientHeight);
    this.labelRenderer.domElement.style.position = 'absolute';
    this.labelRenderer.domElement.style.top = '0';
    this.labelRenderer.domElement.style.pointerEvents = 'none';
    container.appendChild(this.labelRenderer.domElement);
    
    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.target.set(0, 2, 0);
    
    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
    this.scene.add(ambientLight);
    
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(10, 20, 10);
    this.scene.add(directionalLight);
    
    // Ground plane
    this.createGroundPlane();
    
    // Resize handler
    window.addEventListener('resize', () => this.onResize());
    
    // Start animation loop
    this.animate();
  }
  
  private createGroundPlane(): void {
    // Grid
    const gridSize = 100;
    const gridDivisions = 50;
    const grid = new THREE.GridHelper(gridSize, gridDivisions, this.colors.grid, this.colors.grid);
    grid.material.opacity = 0.3;
    grid.material.transparent = true;
    this.scene.add(grid);
    
    // Ground
    const groundGeo = new THREE.PlaneGeometry(gridSize, gridSize);
    const groundMat = new THREE.MeshStandardMaterial({
      color: this.colors.ground,
      roughness: 0.9,
      metalness: 0.1
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    this.scene.add(ground);
  }
  
  // Convert lat/lon to local coordinates (nautical miles from reference)
  private latLonToLocal(lat: number, lon: number): { x: number; z: number } {
    const dLat = lat - this.refLat;
    const dLon = lon - this.refLon;
    
    // Convert to nautical miles
    const x = dLon * 60 * Math.cos(this.refLat * Math.PI / 180);
    const z = -dLat * 60; // Negative because Z is inverted
    
    return { x, z };
  }
  
  // Convert altitude to Y coordinate
  private altToY(altFeet: number): number {
    return altFeet * ALTITUDE_SCALE * VERTICAL_EXAGGERATION;
  }
  
  setReferencePoint(lat: number, lon: number): void {
    this.refLat = lat;
    this.refLon = lon;
  }
  
  addApproach(
    approach: Approach,
    waypoints: Map<string, Waypoint>,
    airport: Airport
  ): void {
    // Set reference point to airport
    this.setReferencePoint(airport.lat, airport.lon);
    
    // Add airport marker
    this.addAirportMarker(airport);
    
    // Draw final approach legs
    if (approach.finalLegs.length > 0) {
      this.drawPath(approach.finalLegs, waypoints, this.colors.approach, 'Final');
    }
    
    // Draw transitions
    for (const [name, legs] of approach.transitions) {
      this.drawPath(legs, waypoints, this.colors.transition, name);
    }
    
    // Draw missed approach
    if (approach.missedLegs.length > 0) {
      this.drawPath(approach.missedLegs, waypoints, this.colors.missed, 'Missed');
    }
    
    // Update camera to look at approach
    this.centerOnApproach();
  }
  
  private addAirportMarker(airport: Airport): void {
    const pos = this.latLonToLocal(airport.lat, airport.lon);
    const y = this.altToY(airport.elevation);
    
    // Runway marker
    const geometry = new THREE.BoxGeometry(0.5, 0.02, 2);
    const material = new THREE.MeshStandardMaterial({
      color: this.colors.runway,
      emissive: this.colors.runway,
      emissiveIntensity: 0.3
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(pos.x, y, pos.z);
    this.scene.add(mesh);
    
    // Airport label
    this.addLabel(airport.id, pos.x, y + 0.5, pos.z, '#ff00ff');
  }
  
  private drawPath(
    legs: Array<{ waypointId: string; waypointName: string; altitude?: number }>,
    waypoints: Map<string, Waypoint>,
    color: number,
    name: string
  ): void {
    const points: THREE.Vector3[] = [];
    
    for (const leg of legs) {
      const wp = waypoints.get(leg.waypointId);
      if (!wp) continue;
      
      const pos = this.latLonToLocal(wp.lat, wp.lon);
      const y = this.altToY(leg.altitude || 0);
      
      points.push(new THREE.Vector3(pos.x, y, pos.z));
      
      // Add waypoint marker
      this.addWaypointMarker(wp, pos.x, y, pos.z, leg.altitude);
    }
    
    if (points.length < 2) return;
    
    // Create tube along path
    const curve = new THREE.CatmullRomCurve3(points, false, 'catmullrom', 0.1);
    const tubeGeo = new THREE.TubeGeometry(curve, points.length * 10, 0.08, 8, false);
    const tubeMat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 0.3,
      transparent: true,
      opacity: 0.9
    });
    const tube = new THREE.Mesh(tubeGeo, tubeMat);
    this.scene.add(tube);
    
    // Add vertical lines from path to ground
    for (const point of points) {
      this.addVerticalLine(point.x, point.y, point.z, color);
    }
  }
  
  private addWaypointMarker(
    wp: Waypoint,
    x: number,
    y: number,
    z: number,
    altitude?: number
  ): void {
    // Waypoint sphere
    const geometry = new THREE.SphereGeometry(0.15, 16, 16);
    const material = new THREE.MeshStandardMaterial({
      color: this.colors.waypoint,
      emissive: this.colors.waypoint,
      emissiveIntensity: 0.5
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    
    // Label
    const altText = altitude ? ` ${altitude}'` : '';
    this.addLabel(`${wp.name}${altText}`, x, y + 0.4, z, '#ffffff');
  }
  
  private addVerticalLine(x: number, y: number, z: number, color: number): void {
    const points = [
      new THREE.Vector3(x, 0, z),
      new THREE.Vector3(x, y, z)
    ];
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.2
    });
    const line = new THREE.Line(geometry, material);
    this.scene.add(line);
  }
  
  private addLabel(text: string, x: number, y: number, z: number, color: string): void {
    const div = document.createElement('div');
    div.className = 'waypoint-label';
    div.textContent = text;
    div.style.cssText = `
      color: ${color};
      font-family: 'JetBrains Mono', 'SF Mono', monospace;
      font-size: 11px;
      font-weight: 500;
      text-shadow: 0 0 4px rgba(0,0,0,0.8), 0 0 8px rgba(0,0,0,0.6);
      white-space: nowrap;
    `;
    
    const label = new CSS2DObject(div);
    label.position.set(x, y, z);
    this.scene.add(label);
  }
  
  addAirspace(features: AirspaceFeature[]): void {
    for (const feature of features) {
      this.addAirspaceVolume(feature);
    }
  }
  
  private addAirspaceVolume(feature: AirspaceFeature): void {
    // Determine color based on class
    let color: number;
    switch (feature.class) {
      case 'B': color = this.colors.airspaceB; break;
      case 'C': color = this.colors.airspaceC; break;
      case 'D': color = this.colors.airspaceD; break;
      default: return; // Skip unknown classes
    }
    
    // Create 2D shape from coordinates
    for (const ring of feature.coordinates) {
      const shape = new THREE.Shape();
      
      for (let i = 0; i < ring.length; i++) {
        const [lon, lat] = ring[i];
        const pos = this.latLonToLocal(lat, lon);
        
        if (i === 0) {
          shape.moveTo(pos.x, pos.z);
        } else {
          shape.lineTo(pos.x, pos.z);
        }
      }
      
      // Extrude to 3D
      const lowerY = this.altToY(feature.lowerAlt);
      const upperY = this.altToY(feature.upperAlt);
      const height = upperY - lowerY;
      
      if (height <= 0) continue;
      
      const extrudeSettings = {
        depth: height,
        bevelEnabled: false
      };
      
      const geometry = new THREE.ExtrudeGeometry(shape, extrudeSettings);
      geometry.rotateX(-Math.PI / 2);
      geometry.translate(0, lowerY, 0);
      
      const material = new THREE.MeshStandardMaterial({
        color,
        transparent: true,
        opacity: 0.15,
        side: THREE.DoubleSide,
        depthWrite: false
      });
      
      const mesh = new THREE.Mesh(geometry, material);
      this.scene.add(mesh);
      
      // Add wireframe edge
      const edges = new THREE.EdgesGeometry(geometry);
      const lineMaterial = new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.4
      });
      const wireframe = new THREE.LineSegments(edges, lineMaterial);
      this.scene.add(wireframe);
    }
  }
  
  private centerOnApproach(): void {
    // Find bounding box of all objects
    const box = new THREE.Box3();
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        box.expandByObject(obj);
      }
    });
    
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.z);
    
    // Position camera
    this.camera.position.set(
      center.x + maxDim * 0.8,
      center.y + maxDim * 0.6,
      center.z + maxDim * 0.8
    );
    this.controls.target.copy(center);
    this.controls.update();
  }
  
  private onResize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    
    this.renderer.setSize(width, height);
    this.labelRenderer.setSize(width, height);
  }
  
  private animate(): void {
    requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
  }
  
  dispose(): void {
    window.removeEventListener('resize', () => this.onResize());
    this.renderer.dispose();
    this.container.innerHTML = '';
  }
  
  private showWebGLError(container: HTMLElement): void {
    container.innerHTML = `
      <div style="
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: #e8e8f0;
        font-family: 'Space Grotesk', system-ui, sans-serif;
        text-align: center;
        padding: 40px;
      ">
        <div style="
          font-size: 48px;
          margin-bottom: 24px;
        ">⚠️</div>
        <h2 style="
          font-size: 24px;
          margin-bottom: 12px;
          color: #ffaa00;
        ">WebGL Not Available</h2>
        <p style="
          font-size: 14px;
          color: #8888aa;
          max-width: 400px;
          line-height: 1.6;
        ">
          This 3D visualization requires WebGL support.<br>
          Please use a modern browser with hardware acceleration enabled,
          or try on a device with GPU support.
        </p>
        <div style="
          margin-top: 24px;
          padding: 16px 24px;
          background: rgba(26, 26, 46, 0.8);
          border: 1px solid #2a2a44;
          border-radius: 8px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 12px;
          color: #00ffcc;
        ">
          Data loaded successfully — 3D rendering unavailable
        </div>
      </div>
    `;
  }
}
