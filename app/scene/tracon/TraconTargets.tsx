import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import type { TrafficRenderBuffers } from '../traffic/traffic-worker-client';
import { SceneLabels, type SceneLabel } from '../labels/SceneLabels';
import { DATA_BLOCK_LABEL_STYLE, POSITION_SYMBOL_LABEL_STYLE } from '../labels/label-styles';
import { ScreenMarks, type ScreenMarkGlyph } from './ScreenMarks';
import { SCOPE_COLORS, SCOPE_HISTORY_SHADES } from './scope-colors';

/** Fused-track target symbol: a filled blue disc under the position symbol. */
const TARGET_GLYPH: ScreenMarkGlyph = { kind: 'dot', sizePx: 11 };
const HISTORY_GLYPH: ScreenMarkGlyph = { kind: 'dot', sizePx: 6 };
/** Leader line toward the data block, which sits up and to the right (NE). */
const LEADER_GLYPH: ScreenMarkGlyph = {
  kind: 'leader',
  sizePx: 1.25,
  fromPx: [7, 7],
  toPx: [19, 19]
};
const TARGET_COLORS = [SCOPE_COLORS.target] as const;
const LEADER_COLORS = [SCOPE_COLORS.dataBlock] as const;
const POSITION_SYMBOL = '*';
const POSITION_SYMBOL_SIZING = { mode: 'screen', offsetPx: [0, -1] } as const;
const IDENT_SIZING = { mode: 'screen', offsetPx: [22, 25], align: 'start' } as const;
const FIELDS_SIZING = { mode: 'screen', offsetPx: [22, 12], align: 'start' } as const;

const HISTORY_RENDER_ORDER = 950;
const TARGET_RENDER_ORDER = 955;
const LEADER_RENDER_ORDER = 960;

function segmentsGeometry(segments: Float32Array): THREE.BufferGeometry | null {
  if (segments.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(segments, 3));
  return geometry;
}

/**
 * STARS presentation of the live traffic the worker prepared, for fused
 * (ADS-B) tracks: blue history dots that darken with age, white predicted
 * track lines, the blue target symbol with its position symbol, a leader
 * line, and a green two-line data block. In 3D also altitude stalks to the
 * floor plane. The feed has no track ownership, so every track is drawn as
 * unowned (green) with the no-owner position symbol.
 */
export function TraconTargets({
  renderBuffers,
  showAltitudeStalks
}: {
  renderBuffers: TrafficRenderBuffers;
  showAltitudeStalks: boolean;
}) {
  const predictedTrackGeometry = useMemo(
    () => segmentsGeometry(renderBuffers.predictedTrackSegments),
    [renderBuffers]
  );
  const stalkGeometry = useMemo(
    () => segmentsGeometry(renderBuffers.altitudeStalkSegments),
    [renderBuffers]
  );
  useEffect(() => () => predictedTrackGeometry?.dispose(), [predictedTrackGeometry]);
  useEffect(() => () => stalkGeometry?.dispose(), [stalkGeometry]);

  const { symbolLabels, identLabels, fieldLabels } = useMemo(() => {
    const symbols: SceneLabel[] = [];
    const idents: SceneLabel[] = [];
    const fields: SceneLabel[] = [];
    const { targetPositions, dataBlockIdents, dataBlockFields } = renderBuffers;
    for (let i = 0; i < dataBlockIdents.length; i += 1) {
      const position = [
        targetPositions[i * 3],
        targetPositions[i * 3 + 1],
        targetPositions[i * 3 + 2]
      ] as const;
      symbols.push({ text: POSITION_SYMBOL, position, style: POSITION_SYMBOL_LABEL_STYLE });
      idents.push({ text: dataBlockIdents[i], position, style: DATA_BLOCK_LABEL_STYLE });
      fields.push({ text: dataBlockFields[i], position, style: DATA_BLOCK_LABEL_STYLE });
    }
    return { symbolLabels: symbols, identLabels: idents, fieldLabels: fields };
  }, [renderBuffers]);

  return (
    <group>
      {showAltitudeStalks && stalkGeometry && (
        <lineSegments geometry={stalkGeometry} frustumCulled={false} renderOrder={940}>
          <lineBasicMaterial
            color={SCOPE_COLORS.altitudeStalk}
            transparent
            opacity={0.28}
            depthWrite={false}
            toneMapped={false}
          />
        </lineSegments>
      )}
      {predictedTrackGeometry && (
        <lineSegments geometry={predictedTrackGeometry} frustumCulled={false} renderOrder={945}>
          <lineBasicMaterial
            color={SCOPE_COLORS.predictedTrack}
            depthTest={false}
            depthWrite={false}
            toneMapped={false}
          />
        </lineSegments>
      )}
      <ScreenMarks
        positions={renderBuffers.historyDots}
        stride={4}
        colors={SCOPE_HISTORY_SHADES}
        glyph={HISTORY_GLYPH}
        renderOrder={HISTORY_RENDER_ORDER}
      />
      <ScreenMarks
        positions={renderBuffers.targetPositions}
        colors={TARGET_COLORS}
        glyph={TARGET_GLYPH}
        renderOrder={TARGET_RENDER_ORDER}
      />
      <ScreenMarks
        positions={renderBuffers.targetPositions}
        colors={LEADER_COLORS}
        glyph={LEADER_GLYPH}
        renderOrder={LEADER_RENDER_ORDER}
      />
      <SceneLabels labels={symbolLabels} sizing={POSITION_SYMBOL_SIZING} />
      <SceneLabels labels={identLabels} sizing={IDENT_SIZING} />
      <SceneLabels labels={fieldLabels} sizing={FIELDS_SIZING} />
    </group>
  );
}
