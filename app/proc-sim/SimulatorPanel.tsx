import { useEffect, useRef, useState } from 'react';
import type { Approach, Waypoint } from '@/lib/cifp/parser';
import { SimWorkerClient } from './worker-client';
import type { AutopilotSettings, SceneFrame, SimControls, SimUpdate } from './types';
import './simulator.css';
import { PFD, HSI } from './FlightInstruments';

function NumericInput({
  label,
  value,
  onChange,
  min,
  max,
  step = 1
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number | 'any';
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => {
    setDraft(String(value));
  }, [value]);
  return (
    <label>
      {label}
      <input
        aria-label={label}
        type="number"
        required
        value={draft}
        min={min}
        max={max}
        step={step}
        onChange={(event) => {
          setDraft(event.target.value);
          if (Number.isFinite(event.target.valueAsNumber)) onChange(event.target.valueAsNumber);
        }}
      />
    </label>
  );
}

export function SimulatorPanel({
  approach,
  waypoints,
  magVar,
  frame,
  onUpdate
}: {
  approach: Approach;
  waypoints: Map<string, Waypoint>;
  magVar: number;
  frame: SceneFrame;
  onUpdate: (update: SimUpdate | null) => void;
}) {
  const clientRef = useRef<SimWorkerClient | null>(null);
  const frameRef = useRef(frame);
  const updateRef = useRef(onUpdate);
  useEffect(() => {
    frameRef.current = frame;
    updateRef.current = onUpdate;
  }, [frame, onUpdate]);
  const [open, setOpen] = useState(false);
  const [transition, setTransition] = useState('');
  const [altitude, setAltitude] = useState(3000);
  const [airspeed, setAirspeed] = useState(110);
  const [update, setUpdate] = useState<SimUpdate | null>(null);
  const [controls, setControls] = useState<SimControls | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [session, setSession] = useState<SimWorkerClient | null>(null);

  useEffect(() => {
    if (!session) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const client = session;
    async function poll() {
      if (!client || disposed) return;
      try {
        const next = await client.read(frameRef.current);
        if (disposed || clientRef.current !== client) return;
        setUpdate(next);
        updateRef.current(next);
        timer = setTimeout(() => {
          void poll();
        }, 250);
      } catch (failure) {
        if (!disposed && clientRef.current === client) {
          setError(String(failure));
          client.dispose();
          clientRef.current = null;
          setSession(null);
          setUpdate(null);
          setControls(null);
          setBusy(false);
          updateRef.current(null);
        }
      }
    }
    const onVisibility = () => {
      if (document.hidden && client)
        void client.suspend().catch((failure) => {
          if (!disposed) setError(String(failure));
        });
    };
    document.addEventListener('visibilitychange', onVisibility);
    void poll();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      disposed = true;
      clearTimeout(timer);
    };
  }, [session]);

  useEffect(
    () => () => {
      clientRef.current?.dispose();
      clientRef.current = null;
      updateRef.current(null);
    },
    []
  );

  function stop() {
    clientRef.current?.dispose();
    clientRef.current = null;
    setSession(null);
    setUpdate(null);
    setControls(null);
    setError(null);
    setBusy(false);
    onUpdate(null);
  }

  async function start() {
    setBusy(true);
    setError(null);
    clientRef.current?.dispose();
    clientRef.current = null;
    setSession(null);
    setUpdate(null);
    setControls(null);
    onUpdate(null);
    let client: SimWorkerClient | null = null;
    try {
      client = new SimWorkerClient();
      clientRef.current = client;
      const entry = transition ? approach.transitions.get(transition) : [];
      if (!entry) throw new Error('Selected transition is missing.');
      const legs = [...entry, ...approach.finalLegs];
      await client.start({
        legs,
        waypoints: [...waypoints.values()],
        magVar,
        altitudeFt: altitude,
        speedKts: airspeed
      });
      const next = await client.read(frameRef.current);
      if (clientRef.current !== client) return;
      setControls({
        autopilot: next.snapshot.autopilot,
        wind: { directionFromDegTrue: 0, speedKts: 0 },
        assignedAltitude: altitude
      });
      setUpdate(next);
      onUpdate(next);
      setSession(client);
    } catch (failure) {
      if (clientRef.current === client) {
        setError(String(failure));
        client?.dispose();
        setBusy(false);
        clientRef.current = null;
      }
    } finally {
      if (clientRef.current === client) setBusy(false);
    }
  }

  async function apply() {
    const client = clientRef.current;
    if (!client || !controls) return;
    setBusy(true);
    try {
      await client.controls(controls);
      if (clientRef.current !== client) return;
      setError(null);
    } catch (failure) {
      if (clientRef.current === client) setError(String(failure));
    } finally {
      if (clientRef.current === client) setBusy(false);
    }
  }
  async function playback(paused: boolean, speed: number) {
    const client = clientRef.current;
    if (!client) return;
    setBusy(true);
    try {
      await client.playback(paused, speed);
      const next = await client.read(frameRef.current);
      if (clientRef.current !== client) return;
      setUpdate(next);
      onUpdate(next);
    } catch (failure) {
      if (clientRef.current === client) setError(String(failure));
    } finally {
      if (clientRef.current === client) setBusy(false);
    }
  }
  function bug(key: 'hdgBugDeg' | 'altBugFt' | 'vsBugFpm' | 'spdBugKts', value: number) {
    setControls((current) =>
      current ? { ...current, autopilot: { ...current.autopilot, [key]: value } } : null
    );
  }
  const snapshot = update?.snapshot;
  return (
    <aside
      className={`simulator${open && snapshot ? ' sim-cockpit-open' : ''}`}
      aria-label="Procedure simulator"
    >
      <button className="sim-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        Procedure simulator {open ? '▾' : '▸'}
      </button>
      {open && (
        <div className="sim-body">
          <p>
            {approach.airportId} / {approach.procedureId} · Training only
          </p>
          <p className="sim-note">
            Use the airport and approach selectors above. Starts at the first fix. All headings and
            wind directions are TRUE. Straight IF/TF/CF legs only; no missed approach, holds, arcs,
            or glidepath guidance. Start altitude and speed are training choices, not published
            constraints.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            <label>
              Entry
              <select
                aria-label="Simulator entry"
                value={transition}
                onChange={(event) => setTransition(event.target.value)}
              >
                <option value="">Final segment</option>
                {[...approach.transitions.keys()].map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <div className="sim-grid">
              <NumericInput
                label="Start altitude (ft MSL)"
                value={altitude}
                min={0}
                max={20000}
                onChange={setAltitude}
                step={100}
              />
              <NumericInput
                label="Start speed (KIAS)"
                value={airspeed}
                min={40}
                max={250}
                onChange={setAirspeed}
              />
            </div>
            <button disabled={busy} type="submit">
              {update ? 'Reset session' : 'Load procedure'}
            </button>
          </form>
          {error && (
            <p role="alert" className="sim-error">
              {error}
            </p>
          )}
          {snapshot && update && controls && (
            <>
              <div className="sim-playback">
                <button
                  disabled={busy || snapshot.activeLegIndex == null}
                  onClick={() => {
                    void playback(!update.paused, update.speed);
                  }}
                >
                  {update.paused ? 'Run' : 'Pause'}
                </button>
                <label>
                  Sim speed
                  <select
                    aria-label="Sim speed"
                    disabled={busy}
                    value={update.speed}
                    onChange={(event) => {
                      void playback(update.paused, Number(event.target.value));
                    }}
                  >
                    {[0.5, 1, 1.5, 2, 3].map((speed) => (
                      <option key={speed} value={speed}>
                        {speed}×
                      </option>
                    ))}
                  </select>
                </label>
                <button disabled={busy} onClick={stop}>
                  End session
                </button>
                <span>{snapshot.simTimeS.toFixed(1)} s</span>
              </div>
              <div className="sim-cockpit">
                <div className="sim-flight-displays">
                  <PFD update={update} />
                  <HSI snapshot={snapshot} />
                </div>
                <div className="sim-autopilot">
                  <h3>Autopilot and clearance</h3>
                  <p className="sim-note">
                    Controls are drafts until applied. Bugs use TRUE degrees; instruments show
                    magnetic.
                  </p>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void apply();
                    }}
                  >
                    <div className="sim-grid">
                      <label>
                        Lateral mode
                        <select
                          aria-label="Lateral mode"
                          value={controls.autopilot.lateral}
                          onChange={(event) => {
                            // SAFETY: the options below are exactly the AutopilotSettings lateral variants.
                            const lateral = event.target.value as AutopilotSettings['lateral'];
                            setControls({
                              ...controls,
                              autopilot: { ...controls.autopilot, lateral }
                            });
                          }}
                        >
                          <option value="Heading">HDG</option>
                          <option value="Nav">NAV</option>
                          <option value="Localizer">LOC (course trainer)</option>
                        </select>
                      </label>
                      <label>
                        Vertical mode
                        <select
                          aria-label="Vertical mode"
                          value={controls.autopilot.vertical}
                          onChange={(event) => {
                            // SAFETY: the options below are exactly the AutopilotSettings vertical variants.
                            const vertical = event.target.value as AutopilotSettings['vertical'];
                            setControls({
                              ...controls,
                              autopilot: { ...controls.autopilot, vertical }
                            });
                          }}
                        >
                          <option value="AltitudeHold">ALT</option>
                          <option value="VerticalSpeed">VS</option>
                          <option value="GlideSlope" disabled>
                            GS arm (unavailable)
                          </option>
                        </select>
                      </label>
                      <NumericInput
                        label="HDG bug (° true)"
                        step="any"
                        value={controls.autopilot.hdgBugDeg}
                        min={0}
                        max={360}
                        onChange={(value) => bug('hdgBugDeg', value)}
                      />
                      <NumericInput
                        label="ALT bug (ft MSL)"
                        value={controls.autopilot.altBugFt}
                        min={0}
                        max={20000}
                        step={100}
                        onChange={(value) => bug('altBugFt', value)}
                      />
                      <NumericInput
                        label="VS bug (fpm)"
                        value={controls.autopilot.vsBugFpm}
                        min={-2000}
                        max={2000}
                        step={100}
                        onChange={(value) => bug('vsBugFpm', value)}
                      />
                      <NumericInput
                        label="Speed bug (KIAS)"
                        value={controls.autopilot.spdBugKts}
                        min={40}
                        max={250}
                        onChange={(value) => bug('spdBugKts', value)}
                      />
                      <NumericInput
                        label="Wind from (° true)"
                        step="any"
                        value={controls.wind.directionFromDegTrue}
                        min={0}
                        max={360}
                        onChange={(value) =>
                          setControls({
                            ...controls,
                            wind: { ...controls.wind, directionFromDegTrue: value }
                          })
                        }
                      />
                      <NumericInput
                        label="Wind speed (kt)"
                        value={controls.wind.speedKts}
                        min={0}
                        max={150}
                        onChange={(value) =>
                          setControls({ ...controls, wind: { ...controls.wind, speedKts: value } })
                        }
                      />
                    </div>
                    <label>
                      Assigned altitude (ft MSL; blank = none)
                      <input
                        aria-label="Assigned altitude"
                        type="number"
                        min={0}
                        max={20000}
                        step={100}
                        value={controls.assignedAltitude ?? ''}
                        onChange={(event) => {
                          if (
                            event.target.value === '' ||
                            Number.isFinite(event.target.valueAsNumber)
                          )
                            setControls({
                              ...controls,
                              assignedAltitude:
                                event.target.value === '' ? null : event.target.valueAsNumber
                            });
                        }}
                      />
                    </label>
                    <button disabled={busy} type="submit">
                      Apply autopilot and clearance
                    </button>
                  </form>
                </div>
              </div>
              <div aria-label="Mistake feed" aria-live="polite">
                <h3>Debrief · {snapshot.mistakes.length} findings</h3>
                {snapshot.mistakes.map((mistake, index) => (
                  <article key={`${mistake.kind}:${mistake.simTimeS}:${index}`}>
                    <strong>
                      {mistake.severity}: {mistake.title}
                    </strong>
                    <p>{mistake.details}</p>
                    <p>{mistake.solution}</p>
                  </article>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </aside>
  );
}
