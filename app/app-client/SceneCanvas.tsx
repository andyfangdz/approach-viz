import { Suspense, useEffect, useRef, type RefObject } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Environment, Html, OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { AirspaceVolumes } from '@/src/components/AirspaceVolumes';
import { ApproachPath } from '@/src/components/ApproachPath';
import { ApproachPlateSurface } from '@/src/components/ApproachPlateSurface';
import { SatelliteSurface } from '@/src/components/SatelliteSurface';
import { SceneErrorBoundary } from '@/src/components/SceneErrorBoundary';
import { TerrainWireframe } from '@/src/components/TerrainWireframe';
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

export function SceneCanvas({
  airport,
  sceneData,
  contextApproach,
  waypoints,
  verticalScale,
  selectedApproach,
  surfaceMode,
  satelliteRetryNonce,
  satelliteRetryCount,
  surfaceErrorMessage,
  recenterNonce,
  missedApproachStartAltitudeFeet,
  onSatelliteRuntimeError
}: SceneCanvasProps) {
  const controlsRef = useRef<OrbitControlsImpl | null>(null);
  const hasApproachPlate = Boolean(sceneData.approachPlate);
  const showApproachPlateSurface = surfaceMode === 'plate' && hasApproachPlate;
  const showSatelliteSurface = surfaceMode === 'satellite';
  const showTerrainSurface =
    surfaceMode === 'terrain' || (surfaceMode === 'plate' && !hasApproachPlate);

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
            verticalScale={verticalScale}
          />
        )}

        {showApproachPlateSurface && sceneData.approachPlate && (
          <ApproachPlateSurface
            plate={sceneData.approachPlate}
            refLat={airport.lat}
            refLon={airport.lon}
            airportElevationFeet={airport.elevation}
            verticalScale={verticalScale}
          />
        )}

        {showSatelliteSurface && (
          <SceneErrorBoundary
            resetKey={`${airport.id}:${selectedApproach}:${surfaceMode}:${satelliteRetryNonce}`}
            onError={(error) => onSatelliteRuntimeError('Satellite renderer crashed.', error)}
            fallback={
              <Html center>
                <div className="loading-3d">
                  {surfaceErrorMessage ||
                    `Retrying satellite (${satelliteRetryCount + 1}/${SATELLITE_MAX_RETRIES})...`}
                </div>
              </Html>
            }
          >
            {!surfaceErrorMessage && (
              <SatelliteSurface
                key={`${airport.id}:${selectedApproach}:${satelliteRetryNonce}`}
                refLat={airport.lat}
                refLon={airport.lon}
                airportElevationFeet={airport.elevation}
                geoidSeparationFeet={sceneData.geoidSeparationFeet}
                verticalScale={verticalScale}
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
            applyEarthCurvatureCompensation={surfaceMode === 'satellite'}
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

        <OrbitControls ref={controlsRef} enableDamping dampingFactor={0.05} target={ORBIT_TARGET} />
      </Suspense>
    </Canvas>
  );
}
