'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ApproachOption, ApproachPlate } from '@/lib/types';
import {
  ensureServiceWorkerCacheRegistration,
  syncServiceWorkerDtppCycle
} from '@/app/app-client/service-worker-cache';
import type {
  TrainerAirportEntry,
  TrainerAirportsPayload,
  TrainerApproachPayload
} from '@/app/actions-lib/trainer-data';
import { buildTrainerProcedure } from './sim/procedure-builder';
import type { TrainerMode, TrainerProcedure } from './sim/types';
import { RunScreen } from './RunScreen';
import { TRAINER_MODES, WEATHER_SCENARIOS, weatherInfo } from './trainer-options';

type Screen =
  | { kind: 'select' }
  | { kind: 'building' }
  | {
      kind: 'run';
      procedure: TrainerProcedure;
      plate: ApproachPlate | null;
      mode: TrainerMode;
      weatherId: string;
    };

const AIRPORT_LIMIT = 60;

export function TrainerClient() {
  const [catalog, setCatalog] = useState<TrainerAirportsPayload | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [airportId, setAirportId] = useState<string | null>(null);
  const [approaches, setApproaches] = useState<ApproachOption[] | null>(null);
  const [procedureId, setProcedureId] = useState<string | null>(null);
  const [mode, setMode] = useState<TrainerMode>('training');
  const [weatherId, setWeatherId] = useState('ifr');
  const [screen, setScreen] = useState<Screen>({ kind: 'select' });
  const [buildError, setBuildError] = useState<string | null>(null);
  const approachPayloadRef = useRef<TrainerApproachPayload | null>(null);

  // Register the offline cache SW and sync the plate cycle once we know it.
  useEffect(() => {
    ensureServiceWorkerCacheRegistration();
  }, []);
  useEffect(() => {
    if (catalog?.cycleInfo.dtppCycle) {
      syncServiceWorkerDtppCycle(catalog.cycleInfo.dtppCycle);
    }
  }, [catalog?.cycleInfo.dtppCycle]);

  // Load the airport catalog.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/trainer/airports');
        if (!res.ok) throw new Error(`Catalog unavailable (${res.status})`);
        const data = (await res.json()) as TrainerAirportsPayload;
        if (!cancelled) setCatalog(data);
      } catch (err) {
        if (!cancelled) {
          setCatalogError(err instanceof Error ? err.message : 'Failed to load airports.');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredAirports = useMemo(() => {
    if (!catalog) return [];
    const q = filter.trim().toUpperCase();
    const list = q
      ? catalog.airports.filter((a) => a.id.includes(q) || a.name.toUpperCase().includes(q))
      : catalog.airports;
    return list.slice(0, AIRPORT_LIMIT);
  }, [catalog, filter]);

  const selectAirport = useCallback(async (entry: TrainerAirportEntry) => {
    setAirportId(entry.id);
    setApproaches(null);
    setProcedureId(null);
    setBuildError(null);
    try {
      const res = await fetch(`/api/trainer/approach?airport=${entry.id}`);
      if (!res.ok) throw new Error(`No approaches for ${entry.id}`);
      const payload = (await res.json()) as TrainerApproachPayload;
      approachPayloadRef.current = payload;
      setApproaches(payload.approaches);
      setProcedureId(payload.selectedApproachId);
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : 'Failed to load approaches.');
    }
  }, []);

  const selectProcedure = useCallback(
    async (procId: string) => {
      setProcedureId(procId);
      if (!airportId) return;
      // Fetch the specific procedure payload (leg geometry differs per procedure).
      try {
        const res = await fetch(`/api/trainer/approach?airport=${airportId}&procedure=${procId}`);
        if (!res.ok) throw new Error(`Failed to load ${procId}`);
        approachPayloadRef.current = (await res.json()) as TrainerApproachPayload;
      } catch (err) {
        setBuildError(err instanceof Error ? err.message : 'Failed to load procedure.');
      }
    },
    [airportId]
  );

  const start = useCallback(async () => {
    const payload = approachPayloadRef.current;
    if (!payload) return;
    setScreen({ kind: 'building' });
    setBuildError(null);
    try {
      const procedure = await buildTrainerProcedure(payload);
      if (procedure.approachPath.length < 2) {
        throw new Error('This procedure has no flyable geometry (vectors-only or unmapped fixes).');
      }
      setScreen({
        kind: 'run',
        procedure,
        plate: payload.approachPlate,
        mode,
        weatherId
      });
    } catch (err) {
      setBuildError(err instanceof Error ? err.message : 'Failed to build the procedure.');
      setScreen({ kind: 'select' });
    }
  }, [mode, weatherId]);

  if (screen.kind === 'run') {
    return (
      <RunScreen
        procedure={screen.procedure}
        plate={screen.plate}
        mode={screen.mode}
        weather={weatherInfo(screen.weatherId)}
        onExit={() => setScreen({ kind: 'select' })}
      />
    );
  }

  return (
    <div className="tr-setup">
      <header className="tr-setup-header">
        <div className="tr-brand">
          <span className="tr-brand-mark">◈</span>
          <div>
            <div className="tr-brand-title">Approach Trainer</div>
            <div className="tr-brand-sub">
              Offline instrument approach simulator · CIFP {catalog?.cycleInfo.cifpCycle || '—'}
            </div>
          </div>
        </div>
        <a className="tr-brand-link" href="/">
          3D Viz ›
        </a>
      </header>

      {screen.kind === 'building' && (
        <div className="tr-building">
          <div className="tr-spinner" aria-hidden />
          <div>Building procedure geometry…</div>
        </div>
      )}

      <div className="tr-setup-grid">
        <section className="tr-card tr-airports">
          <div className="tr-card-title">Airport</div>
          <input
            className="tr-search"
            type="text"
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Search ident or name (e.g. KTEB, Aspen)"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {catalogError && <div className="tr-error">{catalogError}</div>}
          {!catalog && !catalogError && <div className="tr-muted">Loading airports…</div>}
          <div className="tr-airport-list">
            {filteredAirports.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`tr-airport-row${airportId === a.id ? ' is-active' : ''}`}
                onClick={() => selectAirport(a)}
              >
                <span className="tr-airport-id">{a.id}</span>
                <span className="tr-airport-name">{a.name}</span>
                <span className="tr-airport-count">{a.approachCount}</span>
              </button>
            ))}
            {catalog && filteredAirports.length === 0 && (
              <div className="tr-muted">No airports match “{filter}”.</div>
            )}
          </div>
        </section>

        <section className="tr-card tr-approaches">
          <div className="tr-card-title">Approach</div>
          {!airportId && <div className="tr-muted">Pick an airport first.</div>}
          {airportId && !approaches && !buildError && (
            <div className="tr-muted">Loading approaches…</div>
          )}
          <div className="tr-approach-list">
            {approaches?.map((ap) => (
              <button
                key={ap.procedureId}
                type="button"
                className={`tr-approach-row${procedureId === ap.procedureId ? ' is-active' : ''}`}
                onClick={() => selectProcedure(ap.procedureId)}
              >
                <span className="tr-approach-type">{ap.type}</span>
                <span className="tr-approach-id">{ap.procedureId}</span>
                <span className="tr-approach-rwy">RWY {ap.runway || '—'}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="tr-card tr-config">
          <div className="tr-card-title">Mode</div>
          <div className="tr-mode-list">
            {TRAINER_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`tr-mode-row${mode === m.id ? ' is-active' : ''}`}
                onClick={() => setMode(m.id)}
              >
                <span className="tr-mode-label">{m.label}</span>
                <span className="tr-mode-blurb">{m.blurb}</span>
              </button>
            ))}
          </div>

          <div className="tr-card-title tr-mt">Weather</div>
          <div className="tr-weather-list">
            {WEATHER_SCENARIOS.map((w) => (
              <button
                key={w.id}
                type="button"
                className={`tr-chip tr-weather-chip-btn${weatherId === w.id ? ' is-active' : ''}`}
                onClick={() => setWeatherId(w.id)}
              >
                {w.label}
              </button>
            ))}
          </div>

          {buildError && <div className="tr-error tr-mt">{buildError}</div>}

          <button
            type="button"
            className="tr-btn tr-btn-primary tr-start"
            disabled={!procedureId}
            onClick={start}
          >
            Start approach
          </button>
        </section>
      </div>
    </div>
  );
}
