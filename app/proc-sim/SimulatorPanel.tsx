'use client';

import { useEffect, useRef, useState } from 'react';
import type { Approach, Waypoint } from '@/lib/cifp/parser';
import { SimWorkerClient } from './worker-client';
import type { AutopilotSettings, SceneFrame, SimControls, SimUpdate } from './types';
import './simulator.css';
import { PFD, HSI } from './FlightInstruments';
import { ACK_TIMEOUT_S, flightResult, TRAINING_ALTITUDE_FT, TRAINING_SPEED_KTS } from './scenario';

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
  frame
}: {
  approach: Approach;
  waypoints: Map<string, Waypoint>;
  magVar: number;
  frame: SceneFrame;
}) {
  const clientRef = useRef<SimWorkerClient | null>(null);
  const frameRef = useRef(frame);
  useEffect(() => {
    frameRef.current = frame;
  }, [frame]);
  const [phase, setPhase] = useState<'briefing' | 'flight' | 'debrief'>('briefing');
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
        if (next.training.complete) {
          setPhase('debrief');
          client.dispose();
          clientRef.current = null;
          setSession(null);
          return;
        }
        timer = setTimeout(() => {
          void poll();
        }, 250);
      } catch (failure) {
        if (!disposed && clientRef.current === client) {
          setError(String(failure));
          client.dispose();
          clientRef.current = null;
          setSession(null);
          setPhase('debrief');
          setBusy(false);
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
    },
    []
  );

  async function stop() {
    const client = clientRef.current;
    if (!client) return;
    setBusy(true);
    try {
      await client.suspend();
      const final = await client.read(frameRef.current);
      if (clientRef.current !== client) return;
      setUpdate(final);
      setPhase('debrief');
      client.dispose();
      clientRef.current = null;
      setSession(null);
    } catch (failure) {
      if (clientRef.current === client) setError(String(failure));
    } finally {
      setBusy(false);
    }
  }

  async function acknowledge(id: string) {
    const client = clientRef.current;
    if (!client) return;
    setBusy(true);
    try {
      await client.acknowledge(id);
      const next = await client.read(frameRef.current);
      if (clientRef.current === client) setUpdate(next);
    } catch (failure) {
      if (clientRef.current === client) setError(String(failure));
    } finally {
      if (clientRef.current === client) setBusy(false);
    }
  }

  async function start() {
    setBusy(true);
    setError(null);
    clientRef.current?.dispose();
    clientRef.current = null;
    setSession(null);
    setUpdate(null);
    setControls(null);
    let client: SimWorkerClient | null = null;
    try {
      client = new SimWorkerClient();
      clientRef.current = client;
      const legs = approach.finalLegs;
      await client.start({
        legs,
        waypoints: [...waypoints.values()],
        magVar,
        altitudeFt: TRAINING_ALTITUDE_FT,
        speedKts: TRAINING_SPEED_KTS
      });
      const next = await client.read(frameRef.current);
      if (clientRef.current !== client) return;
      setControls({
        autopilot: next.snapshot.autopilot,
        wind: { directionFromDegTrue: 0, speedKts: 0 }
      });
      setUpdate(next);
      setSession(client);
      setPhase('flight');
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
  const result = update ? flightResult(update.training, update.snapshot.mistakes) : null;
  return (
    <section className="simulator training-cockpit" aria-label="Procedure training">
      <div className="sim-body">
        {phase === 'briefing' && (
          <section aria-labelledby="briefing-title" className="training-briefing">
            <p className="training-eyebrow">01 / BRIEFING · AUTOPILOT COURSE TRAINING</p>
            <h1 id="briefing-title">Vectors to the RNAV 6 Y course</h1>
            <p>
              {approach.airportId} / {approach.procedureId} · VINGS → LEESY → DANDY → TORBY
            </p>
            <h2>Your mission</h2>
            <p>
              Acknowledge each simulated ATC clearance, set the autopilot, and comply. Hold 3,000 ft
              MSL and 110 KIAS in calm wind, fly a short heading vector, then select NAV to
              intercept and track the sourced straight course to TORBY.
            </p>
            <h2>What will be graded</h2>
            <ul>
              <li>Acknowledge each instruction within {ACK_TIMEOUT_S} simulation seconds.</li>
              <li>
                Set the ALT bug to the controller’s assigned altitude and hold it within 200 ft.
              </li>
              <li>Set the assigned HDG/NAV mode, heading and 110-knot speed bug.</li>
              <li>Track the course after the NAV instruction and reach the final available fix.</li>
            </ul>
            <h2>Exercise limits</h2>
            <p>
              This is a synthetic lateral exercise at 3,000 ft, not a published vertical profile or
              an approach clearance. Published at-fix restrictions are not evaluated. Only straight
              IF/TF/CF legs are flown; no holds, arcs, reversals, missed approach, glidepath or
              landing. TORBY is the last available fix. This is not a certified trainer.
            </p>
            <p>
              Headings on the controls and ATC messages are magnetic. Use autopilot bugs and modes
              only; edits take effect when you press Apply autopilot. You start paused: acknowledge
              the initial instruction, then Run. Pause freezes ATC timers; 3× speeds them up. Ending
              early keeps a debrief but does not pass the lesson.
            </p>
            <button
              disabled={busy}
              onClick={() => {
                void start();
              }}
            >
              {busy ? 'Loading flight…' : 'Start training flight'}
            </button>
          </section>
        )}
        {error && (
          <p role="alert" className="sim-error">
            {error}
          </p>
        )}
        {phase === 'flight' && snapshot && update && controls && (
          <>
            <section
              className="training-transmission"
              aria-label="Latest ATC transmission"
              aria-live="polite"
            >
              <p className="training-eyebrow">02 / FLIGHT · SIMULATED ATC</p>
              <p>{update.training.clearances.at(-1)?.message}</p>
              <p className="sim-note">
                Reply in the ATC action box below the autopilot. Acknowledge does not apply or
                change the autopilot.
              </p>
            </section>
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
              <button
                disabled={busy}
                onClick={() => {
                  void stop();
                }}
              >
                End flight and debrief
              </button>
              <span>{snapshot.simTimeS.toFixed(1)} s</span>
            </div>
            <div className="sim-cockpit">
              <div className="sim-flight-displays">
                <PFD update={update} />
                <HSI snapshot={snapshot} />
              </div>
              <div className="sim-autopilot">
                <h3>Autopilot</h3>
                <p className="sim-note">
                  Controls are drafts until applied. Heading bugs and instruments use magnetic
                  degrees.
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
                      label="HDG bug (° magnetic)"
                      value={
                        Math.round((((controls.autopilot.hdgBugDeg - magVar) % 360) + 360) % 360) %
                        360
                      }
                      min={0}
                      max={360}
                      onChange={(value) => bug('hdgBugDeg', (((value + magVar) % 360) + 360) % 360)}
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
                  </div>
                  <button disabled={busy} type="submit">
                    Apply autopilot
                  </button>
                </form>
                <section className="training-atc" aria-label="ATC action box">
                  <h3>
                    ATC · assigned {update.training.assignedAltitudeFt.toLocaleString()} ft MSL
                  </h3>
                  {update.training.clearances.toReversed().map((clearance) => (
                    <article key={clearance.id}>
                      <p className="sim-note">
                        {clearance.atS} s ·{' '}
                        {clearance.acknowledgedAtS !== null
                          ? clearance.timedOut
                            ? 'Acknowledged late'
                            : 'Acknowledged'
                          : clearance.timedOut
                            ? 'Reply overdue'
                            : `Reply within ${Math.max(0, Math.ceil(clearance.atS + ACK_TIMEOUT_S - snapshot.simTimeS))} s`}
                      </p>
                      <p>{clearance.message}</p>
                      <button
                        disabled={busy || clearance.acknowledgedAtS !== null}
                        aria-label={`Acknowledge ${clearance.id}`}
                        onClick={() => {
                          void acknowledge(clearance.id);
                        }}
                      >
                        {clearance.acknowledgedAtS !== null ? 'Acknowledged' : 'Acknowledge'}
                      </button>
                    </article>
                  ))}
                </section>
              </div>
            </div>
            <div aria-label="Mistake feed" aria-live="polite">
              <h3>Flight findings · {snapshot.mistakes.length} findings</h3>
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
        {phase === 'debrief' && update && (
          <section aria-labelledby="debrief-title" className="training-debrief">
            <p className="training-eyebrow">03 / DEBRIEF</p>
            <h1 id="debrief-title">
              {update.training.complete ? 'Flight complete' : 'Flight ended early'}
            </h1>
            <h2>
              {result?.passed ? 'PASS' : 'RETRY'} · {result?.score}/100
            </h2>
            <p>
              {update.snapshot.simTimeS.toFixed(1)} simulation seconds · {result?.timely}/3 timely
              replies · {result?.complied}/3 instructions complied with
            </p>
            <p>
              Pass requires completing the route, three timely replies, compliance with all three
              instructions, and no findings. Each finding costs 10 points, each missing timely reply
              or compliance 5, and an incomplete flight 20.
            </p>
            <h2>Controller log</h2>
            {update.training.clearances.map((clearance) => (
              <article key={clearance.id}>
                <p>{clearance.message}</p>
                <p>
                  {clearance.acknowledgedAtS === null
                    ? 'No reply'
                    : `Reply at ${clearance.acknowledgedAtS.toFixed(1)} s${clearance.timedOut ? ' (late)' : ' (on time)'}`}{' '}
                  · {clearance.complied ? 'Compliance observed' : 'Compliance not observed'}
                </p>
              </article>
            ))}
            <div aria-label="Debrief findings">
              <h2>{update.snapshot.mistakes.length} findings and fixes</h2>
              {update.snapshot.mistakes.length === 0 && <p>No findings recorded.</p>}
              {update.snapshot.mistakes.map((mistake, index) => (
                <article key={`${mistake.kind}:${index}`}>
                  <strong>{mistake.title}</strong>
                  <p>
                    {mistake.simTimeS.toFixed(1)} s · {mistake.severity} · {mistake.details}
                  </p>
                  <p>{mistake.solution}</p>
                </article>
              ))}
            </div>
            <button
              onClick={() => {
                setPhase('briefing');
                setError(null);
                setUpdate(null);
                setControls(null);
              }}
            >
              Review briefing and try again
            </button>
          </section>
        )}
      </div>
    </section>
  );
}
