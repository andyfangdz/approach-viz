import { formatMinimumValue } from '@/app/app-client-utils';
import type { InfoPanelProps } from './types';

export function InfoPanel({
  legendCollapsed,
  onToggleLegend,
  surfaceLegendClass,
  surfaceLegendLabel,
  surfaceMode,
  hasApproachPlate,
  sceneData,
  selectedApproachSource
}: InfoPanelProps) {
  return (
    <div className="info-panel">
      <div className="section-header">
        <h3>Legend</h3>
        <button type="button" className="panel-toggle small" onClick={onToggleLegend}>
          {legendCollapsed ? 'Show' : 'Hide'}
        </button>
      </div>
      {!legendCollapsed && (
        <div className="legend">
          <div className="legend-item">
            <div className="legend-color final" />
            <span>Final Approach</span>
          </div>
          <div className="legend-item">
            <div className="legend-color transition" />
            <span>Transitions</span>
          </div>
          <div className="legend-item">
            <div className="legend-color missed" />
            <span>Missed Approach</span>
          </div>
          <div className="legend-item">
            <div className="legend-color hold" />
            <span>Hold</span>
          </div>
          <div className="legend-item">
            <div className={`legend-color ${surfaceLegendClass}`} />
            <span>{surfaceLegendLabel}</span>
          </div>
          <div className="legend-item">
            <div className="legend-color airspace-b" />
            <span>Class B</span>
          </div>
          <div className="legend-item">
            <div className="legend-color airspace-c" />
            <span>Class C</span>
          </div>
          <div className="legend-item">
            <div className="legend-color airspace-d" />
            <span>Class D</span>
          </div>
          {(surfaceMode === 'plate' || surfaceMode === '3dplate') && !hasApproachPlate && (
            <div className="legend-note">No FAA plate matched this approach.</div>
          )}
        </div>
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
