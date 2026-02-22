import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { CrossSectionData, NexradVolumePayload } from './nexrad-types';
import { CROSS_SECTION_BINS_X, CROSS_SECTION_BINS_Y, PHASE_RAIN } from './nexrad-types';
import { dbzToHex, feetToNm, altitudeTickLabel } from './nexrad-render';

interface NexradCrossSectionProps {
  payload: NexradVolumePayload;
  volumeData: {
    validCount: number;
    validIndices: Int32Array;
    correctedBottomFeet: Float32Array;
    correctedTopFeet: Float32Array;
    effectivePhaseCode: Uint8Array;
  };
  crossSectionData?: CrossSectionData | null;
  normalizedCrossSectionHeading: number;
  normalizedCrossSectionRange: number;
  sliceAxis: { x: number; z: number };
  slicePerpAxis: { x: number; z: number };
  crossSectionHalfWidthNm: number;
  echoTopSummary18: string;
  echoTopSummary30: string;
  echoTopSummary50: string;
}

export function NexradCrossSection({
  payload,
  volumeData,
  crossSectionData: precomputedCrossSectionData,
  normalizedCrossSectionHeading,
  normalizedCrossSectionRange,
  sliceAxis,
  slicePerpAxis,
  crossSectionHalfWidthNm,
  echoTopSummary18,
  echoTopSummary30,
  echoTopSummary50
}: NexradCrossSectionProps) {
  const sliceCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const crossSectionData = useMemo<CrossSectionData | null>(() => {
    if (precomputedCrossSectionData) {
      return precomputedCrossSectionData;
    }
    const { validCount, validIndices, correctedBottomFeet, correctedTopFeet, effectivePhaseCode } =
      volumeData;
    if (validCount === 0 || !payload) return null;

    let maxTopFeet = 0;
    for (let i = 0; i < validCount; i += 1) {
      maxTopFeet = Math.max(maxTopFeet, correctedTopFeet[i]);
    }
    if (!Number.isFinite(maxTopFeet) || maxTopFeet <= 0) return null;
    maxTopFeet = Math.max(10_000, Math.ceil(maxTopFeet / 1000) * 1000);
    const grid = new Float32Array(CROSS_SECTION_BINS_X * CROSS_SECTION_BINS_Y);
    grid.fill(-1);
    const phaseGrid = new Int8Array(CROSS_SECTION_BINS_X * CROSS_SECTION_BINS_Y);
    phaseGrid.fill(PHASE_RAIN);
    const topEnvelopeFeet = new Float32Array(CROSS_SECTION_BINS_X);
    for (let i = 0; i < topEnvelopeFeet.length; i += 1) topEnvelopeFeet[i] = 0;

    for (let i = 0; i < validCount; i += 1) {
      const idx = validIndices[i];
      const vx = payload.xNm[idx];
      const vz = payload.zNm[idx];

      const alongNm = vx * sliceAxis.x + vz * sliceAxis.z;
      if (alongNm < -normalizedCrossSectionRange || alongNm > normalizedCrossSectionRange) {
        continue;
      }
      const crossNm = Math.abs(vx * slicePerpAxis.x + vz * slicePerpAxis.z);
      if (crossNm > crossSectionHalfWidthNm) continue;

      const x01 = (alongNm + normalizedCrossSectionRange) / (normalizedCrossSectionRange * 2);
      const binX = Math.max(
        0,
        Math.min(CROSS_SECTION_BINS_X - 1, Math.floor(x01 * CROSS_SECTION_BINS_X))
      );
      const bottomFeet = Math.max(0, correctedBottomFeet[i]);
      const topFeet = Math.max(0, correctedTopFeet[i]);
      const y0 = Math.max(
        0,
        Math.min(
          CROSS_SECTION_BINS_Y - 1,
          Math.floor((bottomFeet / maxTopFeet) * CROSS_SECTION_BINS_Y)
        )
      );
      const y1 = Math.max(
        0,
        Math.min(CROSS_SECTION_BINS_Y - 1, Math.ceil((topFeet / maxTopFeet) * CROSS_SECTION_BINS_Y))
      );
      topEnvelopeFeet[binX] = Math.max(topEnvelopeFeet[binX], topFeet);
      for (let y = y0; y <= y1; y += 1) {
        const gridIdx = y * CROSS_SECTION_BINS_X + binX;
        const vDbz = payload.dbz[idx];
        if (vDbz > grid[gridIdx]) {
          grid[gridIdx] = vDbz;
          phaseGrid[gridIdx] = effectivePhaseCode[i];
        }
      }
    }

    return {
      binsX: CROSS_SECTION_BINS_X,
      binsY: CROSS_SECTION_BINS_Y,
      grid,
      phaseGrid,
      topEnvelopeFeet,
      maxTopFeet
    };
  }, [
    precomputedCrossSectionData,
    payload,
    volumeData,
    sliceAxis,
    slicePerpAxis,
    normalizedCrossSectionRange,
    crossSectionHalfWidthNm
  ]);

  const crossSectionDataRef = useRef(crossSectionData);
  crossSectionDataRef.current = crossSectionData;

  const paintSliceCanvas = useCallback((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext('2d');
    if (!context) return;
    const data = crossSectionDataRef.current;

    if (!data) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const pixelW = 2;
    const pixelH = 2;
    const width = data.binsX * pixelW;
    const height = data.binsY * pixelH;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#08111d';
    context.fillRect(0, 0, width, height);

    for (let y = 0; y < data.binsY; y += 1) {
      for (let x = 0; x < data.binsX; x += 1) {
        const idx = y * data.binsX + x;
        const dbz = data.grid[idx];
        if (!(dbz >= 0)) continue;
        const phaseCode = data.phaseGrid[idx];
        const hex = dbzToHex(dbz, phaseCode);
        const cssHex = `#${hex.toString(16).padStart(6, '0')}`;
        context.fillStyle = cssHex;
        const px = x * pixelW;
        const py = height - (y + 1) * pixelH;
        context.fillRect(px, py, pixelW, pixelH);
      }
    }

    context.strokeStyle = 'rgba(255,255,255,0.75)';
    context.lineWidth = 1;
    context.beginPath();
    let started = false;
    for (let x = 0; x < data.binsX; x += 1) {
      const topFeet = data.topEnvelopeFeet[x];
      if (!Number.isFinite(topFeet) || topFeet <= 0) continue;
      const px = x * pixelW + pixelW / 2;
      const py = height - (topFeet / data.maxTopFeet) * height;
      if (!started) {
        context.moveTo(px, py);
        started = true;
      } else {
        context.lineTo(px, py);
      }
    }
    if (started) {
      context.stroke();
    }
  }, []);

  const sliceCanvasCallbackRef = useCallback(
    (node: HTMLCanvasElement | null) => {
      sliceCanvasRef.current = node;
      if (node) paintSliceCanvas(node);
    },
    [paintSliceCanvas]
  );

  useEffect(() => {
    const canvas = sliceCanvasRef.current;
    if (!canvas) return;
    paintSliceCanvas(canvas);
  }, [crossSectionData, paintSliceCanvas]);

  const crossSectionAltitudeTicks = useMemo(() => {
    const maxFeet = crossSectionData?.maxTopFeet ?? 0;
    if (!Number.isFinite(maxFeet) || maxFeet <= 0) return [];
    const stepFeet = maxFeet <= 15_000 ? 2_500 : maxFeet <= 45_000 ? 5_000 : 10_000;
    const values: number[] = [];
    for (let feet = 0; feet <= maxFeet; feet += stepFeet) {
      values.push(feet);
    }
    if (values[values.length - 1] !== maxFeet) {
      values.push(maxFeet);
    }
    return values
      .slice()
      .reverse()
      .map((feet) => ({
        feet,
        label: altitudeTickLabel(feet),
        topPercent: (1 - feet / maxFeet) * 100
      }));
  }, [crossSectionData?.maxTopFeet]);

  if (!crossSectionData) {
    return null;
  }

  const slicePlaneHeightNm = feetToNm(Math.max(crossSectionData.maxTopFeet, 12_000));
  const sliceYawRad = Math.atan2(-sliceAxis.z, sliceAxis.x);

  return (
    <>
      <group rotation={[0, sliceYawRad, 0]}>
        <mesh position={[0, slicePlaneHeightNm / 2, 0]} renderOrder={79}>
          <planeGeometry args={[normalizedCrossSectionRange * 2, slicePlaneHeightNm]} />
          <meshBasicMaterial
            color={0x99e9ff}
            transparent
            opacity={0.06}
            side={THREE.DoubleSide}
            depthWrite={false}
            depthTest={true}
            toneMapped={false}
            fog={false}
          />
        </mesh>
        <mesh position={[0, 0, 0]} renderOrder={79}>
          <boxGeometry args={[normalizedCrossSectionRange * 2, 0.01, 0.01]} />
          <meshBasicMaterial
            color={0x7de8ff}
            transparent
            opacity={0.9}
            depthWrite={false}
            toneMapped={false}
            fog={false}
          />
        </mesh>
      </group>
      <Html fullscreen zIndexRange={[120, 0]} style={{ pointerEvents: 'none' }}>
        <div className="mrms-cross-section-panel">
          <div className="mrms-cross-section-header">
            <span>MRMS Vertical Slice</span>
            <span>
              {normalizedCrossSectionHeading}&deg; / {normalizedCrossSectionRange} NM
            </span>
          </div>
          <div className="mrms-cross-section-body">
            <div className="mrms-cross-section-y-axis">
              <div className="mrms-cross-section-y-title">ALT</div>
              {crossSectionAltitudeTicks.map((tick) => (
                <div
                  key={`mrms-slice-alt-${tick.feet}`}
                  className="mrms-cross-section-y-tick"
                  style={{ top: `${tick.topPercent}%` }}
                >
                  <span className="mrms-cross-section-y-mark" />
                  <span>{tick.label}</span>
                </div>
              ))}
            </div>
            <canvas ref={sliceCanvasCallbackRef} className="mrms-cross-section-canvas" />
          </div>
          <div className="mrms-cross-section-footer">
            <span>
              Echo Tops 18/30/50: {echoTopSummary18} / {echoTopSummary30} / {echoTopSummary50}
            </span>
          </div>
        </div>
      </Html>
    </>
  );
}
