import { useEffect, useRef, useState, type RefObject } from 'react';
import { useThree } from '@react-three/fiber';
import { MapControls, OrthographicCamera } from '@react-three/drei';
import type { MapControls as MapControlsImpl } from 'three-stdlib';
import { MAX_SCOPE_RANGE_NM, MIN_SCOPE_RANGE_NM } from '@/app/app-client/tracon/scope-settings';

/** Camera height above the floor; above any traffic or airspace ceiling at max vertical scale. */
const SCOPE_CAMERA_HEIGHT_NM = 600;
/**
 * A tiny southward offset keeps the look direction off the camera's up axis,
 * so the top-down view is north-up instead of degenerate.
 */
const NORTH_UP_OFFSET_NM = 1e-4;

/** Pixels per NM that put `rangeNm` from the center to the nearer display edge. */
function zoomForRange(rangeNm: number, width: number, height: number): number {
  return Math.max(1, Math.min(width, height)) / 2 / Math.max(1e-3, rangeNm);
}

/**
 * North-up orthographic camera for the 2D TRACON scope, with pan and zoom
 * only. `rangeNm` is the STARS RANGE: the distance from the display center
 * to the nearer edge. Setting it zooms the camera; zooming with the wheel or
 * a pinch reports the new whole-NM range through `onRangeChange`. Remount it
 * (key it on the facility and recenter nonce) to re-center.
 */
export function TraconScopeCamera({
  rangeNm,
  floorY,
  controlsRef,
  onRangeChange
}: {
  rangeNm: number;
  floorY: number;
  controlsRef: (controls: MapControlsImpl | null) => void;
  onRangeChange: (rangeNm: number) => void;
}) {
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const invalidate = useThree((state) => state.invalidate);
  // Initial zoom only; later range changes move the live camera below.
  const [initialZoom] = useState(() => zoomForRange(rangeNm, size.width, size.height));
  const reportedRangeRef = useRef(rangeNm);

  useEffect(() => {
    if (!('isOrthographicCamera' in camera)) return;
    const currentRange = Math.min(size.width, size.height) / 2 / camera.zoom;
    reportedRangeRef.current = rangeNm;
    // A wheel zoom already reported this range; do not snap the camera to it.
    if (Math.round(currentRange) === rangeNm) return;
    camera.zoom = zoomForRange(rangeNm, size.width, size.height);
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, rangeNm, size.width, size.height, invalidate]);

  const handleChange = () => {
    if (!('isOrthographicCamera' in camera)) return;
    const range = Math.round(Math.min(size.width, size.height) / 2 / camera.zoom);
    if (range === reportedRangeRef.current) return;
    reportedRangeRef.current = range;
    onRangeChange(range);
  };

  return (
    <>
      <OrthographicCamera
        makeDefault
        position={[0, floorY + SCOPE_CAMERA_HEIGHT_NM, NORTH_UP_OFFSET_NM]}
        zoom={initialZoom}
        near={1}
        far={SCOPE_CAMERA_HEIGHT_NM * 3}
      />
      <MapControls
        ref={controlsRef}
        enableRotate={false}
        enableDamping
        dampingFactor={0.08}
        screenSpacePanning={false}
        minZoom={zoomForRange(MAX_SCOPE_RANGE_NM, size.width, size.height)}
        maxZoom={zoomForRange(MIN_SCOPE_RANGE_NM, size.width, size.height)}
        target={[0, floorY, 0]}
        onChange={handleChange}
      />
    </>
  );
}

/** 3D framing: camera south of and above the center, distance scaled to the range. */
const PERSPECTIVE_HEIGHT_PER_RANGE = 0.55;
const PERSPECTIVE_SOUTH_PER_RANGE = 0.75;

interface FramedControls {
  target: { set: (x: number, y: number, z: number) => void };
  update: () => void;
}

/**
 * Frames the whole facility in the perspective (3D) TRACON view when
 * mounted; remount it (key on facility and recenter nonce) to re-frame.
 */
export function TraconPerspectiveFraming({
  rangeNm,
  floorY,
  controlsRef
}: {
  rangeNm: number;
  floorY: number;
  controlsRef: RefObject<FramedControls | null>;
}) {
  const camera = useThree((state) => state.camera);
  const invalidate = useThree((state) => state.invalidate);
  // Frame once per mount; later vertical-scale changes keep the user's view.
  const [framing] = useState({ rangeNm, floorY });
  useEffect(() => {
    const { rangeNm, floorY } = framing;
    camera.position.set(
      0,
      floorY + rangeNm * PERSPECTIVE_HEIGHT_PER_RANGE,
      rangeNm * PERSPECTIVE_SOUTH_PER_RANGE
    );
    camera.up.set(0, 1, 0);
    camera.lookAt(0, floorY, 0);
    const controls = controlsRef.current;
    if (controls) {
      controls.target.set(0, floorY, 0);
      controls.update();
    }
    invalidate();
  }, [camera, controlsRef, framing, invalidate]);
  return null;
}
