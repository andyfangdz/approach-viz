import { Suspense, memo, useEffect, useMemo, useRef, type RefObject } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Environment, Html, OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { AirspaceVolumes } from '@/app/scene/AirspaceVolumes';
import { ApproachPath } from '@/app/scene/ApproachPath';
import { ApproachPlateSurface } from '@/app/scene/ApproachPlateSurface';
import { SatelliteSurface } from '@/app/scene/SatelliteSurface';
import { SceneErrorBoundary } from '@/app/scene/SceneErrorBoundary';
import { TerrainWireframe } from '@/app/scene/TerrainWireframe';
import { LiveTrafficOverlay, type SceneAirport } from '@/app/scene/LiveTrafficOverlay';
import { NexradVolumeOverlay } from '@/app/scene/NexradVolumeOverlay';
import {
  CAMERA_POSITION,
  DIRECTIONAL_LIGHT_POSITION,
  FOG_ARGS,
  ORBIT_TARGET,
  SATELLITE_MAX_RETRIES
} from './constants';
import type { SceneCanvasProps } from './types';

function LoadingFallback() {
  return (
    <Html center>
      <div className="loading-3d">Loading 3D scene...</div>
    </Html>
  );
}

function RecenterCamera({
  recenterNonce,
  controlsRef
}: {
  recenterNonce: number;
  controlsRef: RefObject<OrbitControlsImpl | null>;
}) {
  const { camera } = useThree();

  useEffect(() => {
    if (recenterNonce <= 0) return;
    camera.position.set(...CAMERA_POSITION);
    camera.lookAt(...ORBIT_TARGET);
    const controls = controlsRef.current;
    if (controls) {
      controls.target.set(...ORBIT_TARGET);
      controls.update();
    }
  }, [camera, controlsRef, recenterNonce]);

  return null;
}

export const SceneCanvas = memo(function SceneCanvas({
  airport,
  sceneData,
  contextApproach,
  waypoints,
  verticalScale,
  terrainRadiusNm,
  flattenBathymetry,
  liveTrafficEnabled,
  hideGroundTraffic,
  showTrafficCallsigns,
  trafficHistoryMinutes,
  nexradVolumeEnabled,
  nexradMinDbz,
  nexradOpacity,
  surfaceMode,
  satelliteRetryNonce,
  satelliteRetryCount,
  surfaceErrorMessage,
  recenterNonce,
  missedApproachStartAltitudeFeet,
  onSatelliteRuntimeError
}: SceneCanvasProps) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const sceneAirports = useMemo<SceneAirport[]>(() => {
    const list: SceneAirport[] = [
      { lat: airport.lat, lon: airport.lon, elevation: airport.elevation }
    ];
    for (const ea of sceneData.elevationAirports) {
      list.push({ lat: ea.lat, lon: ea.lon, elevation: ea.elevation });
    }
    return list;
  }, [airport, sceneData.elevationAirports]);
  const hasApproachPlate = Boolean(sceneData.approachPlate);
  const showFlatPlateSurface = surfaceMode === 'plate' && hasApproachPlate;
  const showTerrainSurface =
    surfaceMode === 'terrain' || (surfaceMode === 'plate' && !hasApproachPlate);
  const showTiledSurface = surfaceMode === 'satellite' || surfaceMode === '3dplate';

  return (
    <Canvas
      camera={{ position: CAMERA_POSITION, fov: 60, near: 0.1, far: 500 }}
      dpr={[1, 1.5]}
      gl={{
        antialias: true,
        alpha: false,
        stencil: false,
        powerPreference: 'high-performance'
      }}
    >
      <color attach="background" args={['#0a0a14']} />
      <fog attach="fog" args={FOG_ARGS} />

      <Suspense fallback={<LoadingFallback />}>
        <RecenterCamera recenterNonce={recenterNonce} controlsRef={controlsRef} />
        <ambientLight intensity={0.4} />
        <directionalLight position={DIRECTIONAL_LIGHT_POSITION} intensity={0.8} />
        <Environment preset="night" />

        {showTerrainSurface && (
          <TerrainWireframe
            refLat={airport.lat}
            refLon={airport.lon}
            radiusNm={terrainRadiusNm}
            verticalScale={verticalScale}
          />
        )}

        {showFlatPlateSurface && sceneData.approachPlate && (
          <ApproachPlateSurface
            plate={sceneData.approachPlate}
            refLat={airport.lat}
            refLon={airport.lon}
            airportElevationFeet={airport.elevation}
            verticalScale={verticalScale}
          />
        )}

        {showTiledSurface && (
          <SceneErrorBoundary
            resetKey={`${airport.id}:${satelliteRetryNonce}`}
            onError={(error) => onSatelliteRuntimeError('3D tiles renderer crashed.', error)}
            fallback={
              <Html center>
                <div className="loading-3d">
                  {surfaceErrorMessage ||
                    `Retrying 3D tiles (${satelliteRetryCount + 1}/${SATELLITE_MAX_RETRIES})...`}
                </div>
              </Html>
            }
          >
            {!surfaceErrorMessage && (
              <SatelliteSurface
                key={`${airport.id}:${satelliteRetryNonce}`}
                refLat={airport.lat}
                refLon={airport.lon}
                airportElevationFeet={airport.elevation}
                geoidSeparationFeet={sceneData.geoidSeparationFeet}
                verticalScale={verticalScale}
                flattenBathymetry={flattenBathymetry}
                plateOverlay={surfaceMode === '3dplate' ? sceneData.approachPlate : null}
                onRuntimeError={onSatelliteRuntimeError}
              />
            )}
          </SceneErrorBoundary>
        )}

        {contextApproach && (
          <ApproachPath
            approach={contextApproach}
            waypoints={waypoints}
            airport={airport}
            runways={sceneData.runways}
            verticalScale={verticalScale}
            missedApproachStartAltitudeFeet={missedApproachStartAltitudeFeet}
            applyEarthCurvatureCompensation={
              surfaceMode === 'satellite' || surfaceMode === '3dplate'
            }
            nearbyAirports={sceneData.nearbyAirports}
          />
        )}

        {sceneData.airspace.length > 0 && (
          <AirspaceVolumes
            features={sceneData.airspace}
            refLat={airport.lat}
            refLon={airport.lon}
            verticalScale={verticalScale}
          />
        )}

        {liveTrafficEnabled && (
          <LiveTrafficOverlay
            refLat={airport.lat}
            refLon={airport.lon}
            sceneAirports={sceneAirports}
            verticalScale={verticalScale}
            hideGroundTargets={hideGroundTraffic}
            showCallsignLabels={showTrafficCallsigns}
            historyMinutes={trafficHistoryMinutes}
            applyEarthCurvatureCompensation={
              surfaceMode === 'satellite' || surfaceMode === '3dplate'
            }
          />
        )}

        {nexradVolumeEnabled && (
          <NexradVolumeOverlay
            refLat={airport.lat}
            refLon={airport.lon}
            verticalScale={verticalScale}
            minDbz={nexradMinDbz}
            enabled={nexradVolumeEnabled}
            opacity={nexradOpacity}
            applyEarthCurvatureCompensation={
              surfaceMode === 'satellite' || surfaceMode === '3dplate'
            }
          />
        )}

        <OrbitControls ref={controlsRef} enableDamping dampingFactor={0.05} target={ORBIT_TARGET} />
      </Suspense>
    </Canvas>
  );
});
