// Browser entry for the raymarch volume GPU smoke test. It decodes an AVMR
// payload through the same WASM build the app ships, mounts the real
// `NexradVolumeRaymarch` component in an R3F canvas, and publishes the
// volume-texture stats plus rendered pixel coverage as JSON in `#result` for
// the Node driver (`run.ts`) to read. Scenario knobs arrive as URL params:
//   ground=none|ridge|flat  groundFeet=<ft> (flat)  cam=wide|close
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import initWasm, {
  decode_and_prepare_mrms
} from '../../packages/approach-viz-core-wasm/approach_viz_core.js';
import { NexradVolumeRaymarch } from '../../app/scene/nexrad/NexradVolumeRaymarch';
import type { NexradVolumeTextureData } from '../../app/scene/nexrad/nexrad-types';
import type { ElevationSampler } from '../../app/scene/terrain/terrarium';
import {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  CLOSE_CAMERA,
  COVERAGE_FRAMES,
  PROBE_MIN_DBZ_TENTHS,
  VERTICAL_SCALE,
  WIDE_CAMERA,
  type SmokeResult,
  type VolumeTextureStats
} from './contract';

const params = new URLSearchParams(location.search);
const groundMode = params.get('ground') ?? 'none';
const flatGroundFeet = Number(params.get('groundFeet') ?? '0');
const closeCamera = params.get('cam') === 'close';
const refLat = Number(params.get('lat') ?? '0');

/** Publish the outcome for the driver; the element is the only channel. */
function publish(result: SmokeResult): void {
  const target = document.getElementById('result');
  if (!target) throw new Error('harness page is missing #result');
  target.textContent = JSON.stringify(result);
}

/** Synthetic terrain so the ground-occlusion path (heightfield, per-page
 *  maximum, skip gating) runs without Terrarium tiles: a 2,000 ft floor with
 *  a ridge rising to 10,000 ft near (30, -10) NM, or a flat plane. */
function buildGround(): ElevationSampler | null {
  if (groundMode === 'none') return null;
  if (groundMode === 'flat') {
    if (!(flatGroundFeet > 0)) throw new Error('ground=flat needs a positive groundFeet');
    return { sampleFeet: () => flatGroundFeet, fallbackRatio: () => 0 };
  }
  if (groundMode === 'ridge') {
    return {
      sampleFeet: (xNm, zNm) =>
        2_000 + 8_000 * Math.max(0, 1 - Math.hypot(xNm - 30, zNm + 10) / 25),
      fallbackRatio: () => 0
    };
  }
  throw new Error(`unknown ground mode "${groundMode}"`);
}

function CoverageProbe({ stats }: { stats: VolumeTextureStats }) {
  const { gl } = useThree();
  const [frames, setFrames] = useState(0);
  useFrame(() => setFrames((n) => n + 1));
  useEffect(() => {
    if (frames !== COVERAGE_FRAMES) return;
    const source = gl.domElement;
    const probe = document.createElement('canvas');
    probe.width = source.width;
    probe.height = source.height;
    const context = probe.getContext('2d');
    if (!context) throw new Error('2D probe context unavailable');
    context.drawImage(source, 0, 0);
    const data = context.getImageData(0, 0, probe.width, probe.height).data;
    let covered = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] + data[i + 1] + data[i + 2] > 12) covered += 1;
    }
    publish({
      kind: 'rendered',
      stats,
      coveredPixels: covered,
      totalPixels: probe.width * probe.height
    });
  }, [frames, gl, stats]);
  return null;
}

function Scene({
  texture,
  stats
}: {
  texture: NexradVolumeTextureData;
  stats: VolumeTextureStats;
}) {
  const camera = closeCamera ? CLOSE_CAMERA : WIDE_CAMERA;
  return (
    <Canvas
      gl={{ preserveDrawingBuffer: true, antialias: false }}
      camera={{ position: camera.position, fov: 60, near: 0.5, far: 2000 }}
      style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT, background: '#101418' }}
      frameloop="always"
      onCreated={({ camera: created }) => created.lookAt(...camera.target)}
    >
      <group scale={[1, VERTICAL_SCALE, 1]}>
        <NexradVolumeRaymarch
          texture={texture}
          opacity={0.35}
          ground={buildGround()}
          applyEarthCurvatureCompensation
          refLat={refLat}
        />
      </group>
      <CoverageProbe stats={stats} />
    </Canvas>
  );
}

async function main(): Promise<void> {
  await initWasm({ module_or_path: '/approach_viz_core_bg.wasm' });
  const response = await fetch('/volume.avmr');
  if (!response.ok) throw new Error(`payload fetch failed: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  // SAFETY: wasm-bindgen returns the decode_and_prepare_mrms FFI object documented in approach_viz_core.d.ts.
  const result: { volumeTexture: NexradVolumeTextureData | null } = decode_and_prepare_mrms(
    bytes,
    PROBE_MIN_DBZ_TENTHS,
    1, // surface precip-type phase mode (the app default)
    0, // declutter: all
    true,
    refLat,
    false,
    1,
    0,
    0,
    1,
    0.5,
    5,
    false,
    0
  );
  const texture = result.volumeTexture;
  if (!texture) {
    publish({ kind: 'empty' });
    return;
  }
  const stats: VolumeTextureStats = {
    width: texture.width,
    height: texture.height,
    depth: texture.depth,
    coarsenX: texture.coarsenX,
    coarsenZ: texture.coarsenZ,
    cellSizeXNm: texture.cellSizeXNm,
    pageWidth: texture.pageWidth,
    pageHeight: texture.pageHeight,
    pageDepth: texture.pageDepth,
    pageTableBytes: texture.pageTable.length,
    brickCount: texture.brickCount,
    poolBricksX: texture.poolBricksX,
    poolBricksY: texture.poolBricksY,
    poolBricksZ: texture.poolBricksZ,
    poolBytes: texture.pool.length,
    filledTexelCount: texture.filledTexelCount,
    renderedVoxelCount: texture.renderedVoxelCount
  };
  const root = document.getElementById('root');
  if (!root) throw new Error('harness page is missing #root');
  createRoot(root).render(<Scene texture={texture} stats={stats} />);
}

main().catch((error: Error) => {
  publish({ kind: 'error', message: `${error.message}\n${error.stack ?? ''}` });
});
