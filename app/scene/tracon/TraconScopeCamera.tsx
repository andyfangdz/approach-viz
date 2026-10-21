import { useEffect, useState, type RefObject } from 'react';
import { useThree } from '@react-three/fiber';
import { MapControls, OrthographicCamera } from '@react-three/drei';
import type { MapControls as MapControlsImpl } from 'three-stdlib';

/** Camera height above the floor; above any traffic or airspace ceiling at max vertical scale. */
const SCOPE_CAMERA_HEIGHT_NM = 600;
/**
 * A tiny southward offset keeps the look direction off the camera's up axis,
 * so the top-down view is north-up instead of degenerate.
 */
const NORTH_UP_OFFSET_NM = 1e-4;
/** Margin past the outer range ring (rose labels sit outside it). */
const FIT_MARGIN_NM = 5;
const MIN_ZOOM_FACTOR = 0.25;
const MAX_ZOOM_FACTOR = 60;

/**
 * North-up orthographic camera for the 2D TRACON scope, with pan and zoom
 * only. Fits the scope range to the canvas when mounted; remount it (key it
 * on the recenter nonce and range) to restore that framing.
 */
export function TraconScopeCamera({
  rangeNm,
  floorY,
  controlsRef
}: {
  rangeNm: number;
  floorY: number;
  controlsRef: (controls: MapControlsImpl | null) => void;
}) {
  const getState = useThree((state) => state.get);
  // Fit once per mount; resizing keeps the user's zoom.
  const [fitZoom] = useState(() => {
    const { width, height } = getState().size;
    const pixels = Math.max(1, Math.min(width, height));
    return pixels / (2 * (Math.max(1, rangeNm) + FIT_MARGIN_NM));
  });

  return (
    <>
      <OrthographicCamera
        makeDefault
        position={[0, floorY + SCOPE_CAMERA_HEIGHT_NM, NORTH_UP_OFFSET_NM]}
        zoom={fitZoom}
        near={1}
        far={SCOPE_CAMERA_HEIGHT_NM * 3}
      />
      <MapControls
        ref={controlsRef}
        enableRotate={false}
        enableDamping
        dampingFactor={0.08}
        screenSpacePanning={false}
        minZoom={fitZoom * MIN_ZOOM_FACTOR}
        maxZoom={fitZoom * MAX_ZOOM_FACTOR}
        target={[0, floorY, 0]}
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
