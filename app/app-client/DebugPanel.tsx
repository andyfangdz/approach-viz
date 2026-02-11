import type { NexradDebugState, SurfaceMode, TrafficDebugState } from './types';

interface DebugPanelProps {
  debugCollapsed: boolean;
  onToggleDebug: () => void;
  airportId: string;
  approachId: string;
  surfaceMode: SurfaceMode;
  nexradDebug: NexradDebugState;
  trafficDebug: TrafficDebugState;
}

function formatTimestamp(value: string | null): string {
  if (!value) return 'n/a';
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return parsed.toLocaleTimeString([], { hour12: false });
}

function boolLabel(value: boolean): string {
  return value ? 'yes' : 'no';
}

export function DebugPanel({
  debugCollapsed,
  onToggleDebug,
  airportId,
  approachId,
  surfaceMode,
  nexradDebug,
  trafficDebug
}: DebugPanelProps) {
  if (debugCollapsed) {
    return (
      <button
        type="button"
        className="debug-panel-fab"
        onClick={onToggleDebug}
        title="Show debug panel"
        aria-label="Show debug panel"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M9 5h6M9 19h6M12 19v-2m0-10V5m-6 6h12M7 14h10a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-1a2 2 0 0 1 2-2Zm1-9h8a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    );
  }

  return (
    <aside className="debug-panel compact">
      <div className="section-header">
        <h3>Debug</h3>
        <button
          type="button"
          className="info-panel-close"
          onClick={onToggleDebug}
          title="Hide debug panel"
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

      <div className="debug-section">
        <div className="debug-title">Context</div>
        <div className="debug-row">
          <span>Airport</span>
          <span>{airportId || 'n/a'}</span>
        </div>
        <div className="debug-row">
          <span>Approach</span>
          <span>{approachId || 'n/a'}</span>
        </div>
        <div className="debug-row">
          <span>Surface</span>
          <span>{surfaceMode}</span>
        </div>
      </div>

      <div className="debug-section">
        <div className="debug-title">MRMS</div>
        <div className="debug-row">
          <span>Enabled</span>
          <span>{boolLabel(nexradDebug.enabled)}</span>
        </div>
        <div className="debug-row">
          <span>Loading</span>
          <span>{boolLabel(nexradDebug.loading)}</span>
        </div>
        <div className="debug-row">
          <span>Stale</span>
          <span>{boolLabel(nexradDebug.stale)}</span>
        </div>
        <div className="debug-row">
          <span>Layers</span>
          <span>{nexradDebug.layerCount}</span>
        </div>
        <div className="debug-row">
          <span>Voxels</span>
          <span>{nexradDebug.voxelCount}</span>
        </div>
        <div className="debug-row">
          <span>Rendered</span>
          <span>{nexradDebug.renderedVoxelCount}</span>
        </div>
        <div className="debug-row">
          <span>Phase R/M/S</span>
          <span>
            {nexradDebug.phaseCounts.rain}/{nexradDebug.phaseCounts.mixed}/
            {nexradDebug.phaseCounts.snow}
          </span>
        </div>
        <div className="debug-row">
          <span>Scan</span>
          <span>{formatTimestamp(nexradDebug.scanTime)}</span>
        </div>
        <div className="debug-row">
          <span>Poll</span>
          <span>{formatTimestamp(nexradDebug.lastPollAt)}</span>
        </div>
        {nexradDebug.error && <div className="debug-error">MRMS: {nexradDebug.error}</div>}
      </div>

      <div className="debug-section">
        <div className="debug-title">Traffic</div>
        <div className="debug-row">
          <span>Enabled</span>
          <span>{boolLabel(trafficDebug.enabled)}</span>
        </div>
        <div className="debug-row">
          <span>Loading</span>
          <span>{boolLabel(trafficDebug.loading)}</span>
        </div>
        <div className="debug-row">
          <span>Backfill</span>
          <span>{boolLabel(trafficDebug.historyBackfillPending)}</span>
        </div>
        <div className="debug-row">
          <span>Tracks</span>
          <span>{trafficDebug.trackCount}</span>
        </div>
        <div className="debug-row">
          <span>Rendered</span>
          <span>{trafficDebug.renderedTrackCount}</span>
        </div>
        <div className="debug-row">
          <span>History Pts</span>
          <span>{trafficDebug.historyPointCount}</span>
        </div>
        <div className="debug-row">
          <span>Radius/Limit</span>
          <span>
            {trafficDebug.radiusNm} / {trafficDebug.limit}
          </span>
        </div>
        <div className="debug-row">
          <span>Poll</span>
          <span>{formatTimestamp(trafficDebug.lastPollAt)}</span>
        </div>
        {trafficDebug.error && <div className="debug-error">Traffic: {trafficDebug.error}</div>}
      </div>
    </aside>
  );
}
