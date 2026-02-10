import { formatMinimumValue } from '@/app/app-client-utils';
import type { InfoPanelProps } from './types';

export function InfoPanel({
  legendCollapsed,
  onToggleLegend,
  surfaceLegendClass,
  surfaceLegendLabel,
  surfaceMode,
  liveTrafficEnabled,
  nexradVolumeEnabled,
  hasApproachPlate,
  sceneData,
  selectedApproachSource
}: InfoPanelProps) {
  if (legendCollapsed) {
    return (
      <button type="button" className="info-panel-fab" onClick={onToggleLegend} title="Show legend">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <rect x="2" y="3" width="8" height="2" rx="1" fill="currentColor" />
          <rect x="2" y="8" width="8" height="2" rx="1" fill="currentColor" />
          <rect x="2" y="13" width="8" height="2" rx="1" fill="currentColor" />
          <circle cx="14" cy="4" r="2" fill="#00ff88" />
          <circle cx="14" cy="9" r="2" fill="#ffaa00" />
          <circle cx="14" cy="14" r="2" fill="#ff4444" />
        </svg>
      </button>
    );
  }

  return (
    <div className="info-panel compact">
      <div className="section-header">
        <h3>Legend</h3>
        <button
          type="button"
          className="info-panel-close"
          onClick={onToggleLegend}
          title="Hide legend"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
            <path
              d="M2 2l10 10M12 2L2 12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      <div className="legend compact">
        <div className="legend-item">
          <div className="legend-color final" />
          <span>Final</span>
        </div>
        <div className="legend-item">
          <div className="legend-color transition" />
          <span>Transitions</span>
        </div>
        <div className="legend-item">
          <div className="legend-color missed" />
          <span>Missed</span>
        </div>
        <div className="legend-item">
          <div className="legend-color hold" />
          <span>Hold</span>
        </div>
        <div className="legend-item">
          <div className={`legend-color ${surfaceLegendClass}`} />
          <span>{surfaceLegendLabel}</span>
        </div>
        {liveTrafficEnabled && (
          <div className="legend-item">
            <div className="legend-color traffic" />
            <span>Live Traffic</span>
          </div>
        )}
        {nexradVolumeEnabled && (
          <div className="legend-item">
            <div className="legend-color nexrad" />
            <span>NEXRAD Volume</span>
          </div>
        )}
        <div className="legend-item">
          <div className="legend-color airspace-b" />
          <span>B</span>
        </div>
        <div className="legend-item">
          <div className="legend-color airspace-c" />
          <span>C</span>
        </div>
        <div className="legend-item">
          <div className="legend-color airspace-d" />
          <span>D</span>
        </div>
      </div>
      {(surfaceMode === 'plate' || surfaceMode === '3dplate') && !hasApproachPlate && (
        <div className="legend-note">No FAA plate matched this approach.</div>
      )}

      <div className="minimums-section">
        <h3>Minimums</h3>
        {sceneData.requestedProcedureNotInCifp && (
          <div className="minimums-empty">
            Requested <strong>{sceneData.requestedProcedureNotInCifp}</strong> not found; showing{' '}
            <strong>{sceneData.selectedApproachId || 'none'}</strong>.
          </div>
        )}
        {selectedApproachSource === 'external' && (
          <div className="minimums-row">
            <span>Geometry</span>
            <span className="minimums-value">Unavailable (CIFP)</span>
          </div>
        )}
        {sceneData.minimumsSummary ? (
          <>
            <div className="minimums-source">{sceneData.minimumsSummary.sourceApproachName}</div>
            <div className="minimums-row">
              <span>DA</span>
              <span className="minimums-value">
                {formatMinimumValue(sceneData.minimumsSummary.da)}
              </span>
            </div>
            <div className="minimums-row">
              <span>MDA</span>
              <span className="minimums-value">
                {formatMinimumValue(sceneData.minimumsSummary.mda)}
              </span>
            </div>
            <div className="minimums-cycle">DTPP cycle {sceneData.minimumsSummary.cycle}</div>
          </>
        ) : (
          <div className="minimums-empty">No matching minimums found</div>
        )}
      </div>
    </div>
  );
}
