import type { LayerState, LayerId } from './types';

interface LayersPanelProps {
  layersCollapsed: boolean;
  onToggleLayers: () => void;
  layers: LayerState;
  onLayerChange: (id: LayerId, enabled: boolean) => void;
}

interface LayerDef {
  id: LayerId;
  label: string;
}

const UNGROUPED_LAYERS: LayerDef[] = [
  { id: 'approach', label: 'Approach' },
  { id: 'airspace', label: 'Airspace' },
  { id: 'adsb', label: 'ADS-B Traffic' }
];

const WEATHER_LAYERS: LayerDef[] = [
  { id: 'mrms', label: 'MRMS 3D Precip' },
  { id: 'echotops', label: 'Echo Tops' },
  { id: 'slice', label: 'Vertical Slice' },
  { id: 'guides', label: 'Altitude Guides' }
];

export function LayersPanel({
  layersCollapsed,
  onToggleLayers,
  layers,
  onLayerChange
}: LayersPanelProps) {
  if (layersCollapsed) {
    return (
      <button
        type="button"
        className="layers-panel-fab"
        onClick={onToggleLayers}
        title="Show layers"
        aria-label="Show layers"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path
            d="M12 2L2 7l10 5 10-5-10-5Z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <path
            d="M2 12l10 5 10-5"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M2 17l10 5 10-5"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    );
  }

  return (
    <div className="layers-panel compact">
      <div className="section-header">
        <h3>Layers</h3>
        <button
          type="button"
          className="info-panel-close"
          onClick={onToggleLayers}
          title="Hide layers"
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

      {UNGROUPED_LAYERS.map(({ id, label }) => (
        <label key={id} className="options-toggle-row">
          <span className="options-toggle-copy">
            <span className="options-toggle-title">{label}</span>
          </span>
          <input
            type="checkbox"
            checked={layers[id]}
            onChange={(e) => onLayerChange(id, e.target.checked)}
            aria-label={`Toggle ${label} layer`}
          />
        </label>
      ))}

      <div className="layers-group-divider">
        <span className="layers-group-label">Weather</span>
      </div>

      {WEATHER_LAYERS.map(({ id, label }) => (
        <label key={id} className="options-toggle-row">
          <span className="options-toggle-copy">
            <span className="options-toggle-title">{label}</span>
          </span>
          <input
            type="checkbox"
            checked={layers[id]}
            onChange={(e) => onLayerChange(id, e.target.checked)}
            aria-label={`Toggle ${label} layer`}
          />
        </label>
      ))}
    </div>
  );
}
