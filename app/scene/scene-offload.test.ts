// Pure builders the scene workers run in place of former main-thread code.
// Each is checked against the three.js or inline logic it replaced.

import test from 'node:test';
import assert from 'node:assert';
import * as THREE from 'three';
import {
  LABEL_ATLAS_GUTTER_PX,
  labelBoxMetrics,
  packShelves,
  premultiplyRgba
} from './labels/label-atlas';
import { OBSTACLE_LABEL_STYLE, WAYPOINT_LABEL_STYLE, labelStyleKey } from './labels/label-styles';
import {
  TRAFFIC_FLAG_IS_CURRENTLY_PRESENT,
  buildTrafficDrawBuffers
} from './traffic/traffic-draw-buffers';
import { buildWireframeIndex } from './terrain/terrain-mesh';
import { buildMosaicDrapeMesh, mosaicDrapeKey } from './nexrad/nexrad-drape';
import { buildPathTubeBuffers, splitPointsAtAltitude } from './approach-path/path-tube';

test('labelBoxMetrics pads chips and reserves the glow margin', () => {
  const chip = labelBoxMetrics(OBSTACLE_LABEL_STYLE, { widthPx: 40, ascentPx: 8, descentPx: 3 });
  // padding 4px + border 1px on each side; line-height 1 (9px) plus 2px + 1px vertically.
  assert.equal(chip.boxWidthPx, 50);
  assert.equal(chip.boxHeightPx, 15);
  assert.equal(chip.marginPx, 1);
  assert.equal(chip.widthPx, 52);
  // An 11px-tall font in a 9px line box overflows by half the difference each side.
  assert.equal(chip.textBaselineYPx, 3 + (9 - 11) / 2 + 8);

  const glow = labelBoxMetrics(WAYPOINT_LABEL_STYLE, { widthPx: 30, ascentPx: 10, descentPx: 3 });
  // The 8px text-shadow blur needs its full radius around the text.
  assert.equal(glow.marginPx, 9);
  assert.equal(glow.textXPx, 0);
  // `line-height: normal` is the font's own height, baseline at its ascent.
  assert.equal(glow.boxHeightPx, 13);
  assert.equal(glow.textBaselineYPx, 10);
});

test('packShelves keeps entries inside the row limit without overlap', () => {
  const sizes = Array.from({ length: 30 }, (_, i) => ({ width: 60 + (i % 7) * 11, height: 20 }));
  const packing = packShelves(sizes, 256);
  assert.equal(packing.rects.length, sizes.length);
  packing.rects.forEach((rect, i) => {
    assert.ok(rect.x >= LABEL_ATLAS_GUTTER_PX && rect.y >= LABEL_ATLAS_GUTTER_PX);
    assert.ok(rect.x + sizes[i].width <= packing.width);
    assert.ok(rect.y + sizes[i].height <= packing.height);
    for (let j = 0; j < i; j += 1) {
      const other = packing.rects[j];
      const disjoint =
        rect.x >= other.x + sizes[j].width ||
        other.x >= rect.x + sizes[i].width ||
        rect.y >= other.y + sizes[j].height ||
        other.y >= rect.y + sizes[i].height;
      assert.ok(disjoint, `entries ${i} and ${j} overlap`);
    }
  });
  assert.throws(() => packShelves([{ width: 0, height: 4 }]), /positive size/);
});

test('premultiplyRgba scales color by alpha', () => {
  const pixels = new Uint8Array([200, 100, 50, 128, 10, 20, 30, 255, 90, 90, 90, 0]);
  premultiplyRgba(pixels);
  assert.deepEqual([...pixels], [100, 50, 25, 128, 10, 20, 30, 255, 0, 0, 0, 0]);
});

test('labelStyleKey separates styles that render differently', () => {
  assert.notEqual(labelStyleKey(WAYPOINT_LABEL_STYLE), labelStyleKey(OBSTACLE_LABEL_STYLE));
  assert.equal(labelStyleKey({ ...WAYPOINT_LABEL_STYLE }), labelStyleKey(WAYPOINT_LABEL_STYLE));
});

test('buildTrafficDrawBuffers matches the per-track trail, marker, and heading layout', () => {
  const soa = {
    trackCount: 3,
    markerPositions: new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]),
    headingDeg: new Float32Array([90, 0, 180]),
    flags: new Uint8Array([
      TRAFFIC_FLAG_IS_CURRENTLY_PRESENT,
      0,
      TRAFFIC_FLAG_IS_CURRENTLY_PRESENT
    ]),
    trailPointsFlat: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 5, 5, 5, 6, 6, 6]),
    trailOffsets: new Uint32Array([0, 3, 5]),
    trailCounts: new Uint32Array([3, 2, 0])
  };
  const draw = buildTrafficDrawBuffers(soa);
  assert.deepEqual([...draw.trailSegments], [0, 0, 0, 1, 0, 0, 1, 0, 0, 2, 0, 0, 5, 5, 5, 6, 6, 6]);
  assert.deepEqual([...draw.activeTrackIndices], [0, 2]);

  // Marker matrices equal Object3D.updateMatrix() for a pure translation.
  const dummy = new THREE.Object3D();
  dummy.position.set(7, 8, 9);
  dummy.updateMatrix();
  assert.deepEqual([...draw.markerMatrices.subarray(16, 32)], dummy.matrix.elements);

  // Heading 90° points east (+x); 180° points south (+z).
  const heading = [...draw.headingSegments];
  assert.deepEqual(heading.slice(0, 3), [1, 2, 3]);
  assert.ok(Math.abs(heading[3] - 1.2) < 1e-6 && Math.abs(heading[5] - 3) < 1e-6);
  assert.ok(Math.abs(heading[9] - 7) < 1e-6 && Math.abs(heading[11] - 9.2) < 1e-6);
});

test('buildWireframeIndex yields the same edge set as THREE.WireframeGeometry', () => {
  const plane = new THREE.PlaneGeometry(1, 1, 5, 4);
  const index = plane.getIndex();
  assert.ok(index);
  const positions = plane.getAttribute('position');
  const ours = buildWireframeIndex(index.array, positions.count);

  const edgeKey = (a: THREE.Vector3, b: THREE.Vector3) =>
    [a, b]
      .map((v) => `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`)
      .sort()
      .join('|');
  const vertex = (i: number) => new THREE.Vector3().fromBufferAttribute(positions, i);
  const oursKeys = new Set<string>();
  for (let i = 0; i < ours.length; i += 2)
    oursKeys.add(edgeKey(vertex(ours[i]), vertex(ours[i + 1])));

  const wire = new THREE.WireframeGeometry(plane);
  const wirePositions = wire.getAttribute('position');
  const threeKeys = new Set<string>();
  for (let i = 0; i < wirePositions.count; i += 2) {
    threeKeys.add(
      edgeKey(
        new THREE.Vector3().fromBufferAttribute(wirePositions, i),
        new THREE.Vector3().fromBufferAttribute(wirePositions, i + 1)
      )
    );
  }
  assert.equal(ours.length / 2, oursKeys.size, 'no duplicate edges');
  assert.deepEqual([...oursKeys].sort(), [...threeKeys].sort());
});

test('buildMosaicDrapeMesh drapes over sampled terrain and flattens without it', () => {
  const params = {
    grid: { width: 40, height: 20, originXNm: -20, originZNm: -10, cellSizeXNm: 1, cellSizeZNm: 1 },
    surfaceElevationFeet: 100,
    applyEarthCurvatureCompensation: false,
    refLat: 40
  };
  const flat = buildMosaicDrapeMesh(params, null);
  assert.equal(flat.positions.length, 4 * 3);
  assert.deepEqual([...flat.indices], [0, 2, 1, 1, 2, 3]);

  const draped = buildMosaicDrapeMesh(params, (x) => 1000 + x);
  // 32 segments minimum per axis at 1 NM spacing over a 40 x 20 NM grid.
  assert.equal(draped.positions.length / 3, 41 * 33);
  const firstY = draped.positions[1];
  assert.ok(Math.abs(firstY - (1000 - 20 + 200) / 6076.12) < 1e-6);
  assert.notEqual(mosaicDrapeKey(params, true), mosaicDrapeKey(params, false));
});

test('buildPathTubeBuffers splits at the minimums and sweeps only the solid part', () => {
  const points = [
    [0, 3, 0],
    [1, 2, 0],
    [2, 1, 0],
    [3, 0, 0]
  ];
  const flat = Float32Array.from(points.flat());
  const split = splitPointsAtAltitude(
    points.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
    1.5
  );
  assert.equal(split.solidPoints.length, 3);
  assert.deepEqual(split.dashedLinePoints?.[0], [1.5, 1.5, 0]);

  const buffers = buildPathTubeBuffers(flat, 1.5);
  assert.ok(buffers.tube);
  assert.deepEqual([...(buffers.dashedPointsFlat ?? [])], [1.5, 1.5, 0, 2, 1, 0, 3, 0, 0]);
  const reference = new THREE.TubeGeometry(
    (() => {
      const path = new THREE.CurvePath<THREE.Vector3>();
      for (let i = 0; i < split.solidPoints.length - 1; i += 1) {
        path.add(new THREE.LineCurve3(split.solidPoints[i], split.solidPoints[i + 1]));
      }
      return path;
    })(),
    48,
    0.08,
    8,
    false
  );
  assert.deepEqual([...buffers.tube.positions], [...reference.getAttribute('position').array]);

  const unsplit = buildPathTubeBuffers(flat, null);
  assert.equal(unsplit.dashedPointsFlat, null);
});
