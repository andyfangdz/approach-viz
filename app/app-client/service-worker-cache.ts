'use client';

const SERVICE_WORKER_PATH = '/service-worker.js';
const SET_DTPP_CYCLE_MESSAGE = 'approach-viz:set-dtpp-cycle';

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

function normalizeCycle(rawCycle: string | null | undefined): string | null {
  const digits = String(rawCycle || '').replace(/[^\d]/g, '');
  if (digits.length < 4) return null;
  return digits.slice(0, 4);
}

function canUseServiceWorker(): boolean {
  return globalThis.window !== undefined && 'serviceWorker' in navigator;
}

async function getRegisteredServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!canUseServiceWorker()) return null;
  if (registrationPromise) {
    const registered = await registrationPromise;
    if (registered) return registered;
  }
  const registration = await navigator.serviceWorker.getRegistration(SERVICE_WORKER_PATH);
  if (registration) return registration;
  return (await navigator.serviceWorker.getRegistration('/')) ?? null;
}

function postCycleMessage(registration: ServiceWorkerRegistration, cycle: string): void {
  const payload = { type: SET_DTPP_CYCLE_MESSAGE, cycle };
  if (navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage(payload);
  }
  registration.active?.postMessage(payload);
  registration.waiting?.postMessage(payload);
  registration.installing?.postMessage(payload);
}

export function ensureServiceWorkerCacheRegistration(): void {
  if (!canUseServiceWorker()) return;
  if (!registrationPromise) {
    registrationPromise = navigator.serviceWorker
      .register(SERVICE_WORKER_PATH, { scope: '/' })
      .catch((error) => {
        console.warn('Service worker registration failed', error);
        return null;
      });
  }
}

export interface ServiceWorkerCacheDebugSnapshot {
  supported: boolean;
  registered: boolean;
  controlling: boolean;
  activeState: string | null;
  scope: string | null;
  dtppCycle: string | null;
}

export async function getServiceWorkerCacheDebugSnapshot(
  rawCycle: string | null | undefined
): Promise<ServiceWorkerCacheDebugSnapshot> {
  const cycle = normalizeCycle(rawCycle);
  if (!canUseServiceWorker()) {
    return {
      supported: false,
      registered: false,
      controlling: false,
      activeState: null,
      scope: null,
      dtppCycle: cycle
    };
  }

  const registration = await getRegisteredServiceWorker();
  const activeState =
    registration?.active?.state || registration?.waiting?.state || registration?.installing?.state;
  return {
    supported: true,
    registered: Boolean(registration),
    controlling: Boolean(navigator.serviceWorker.controller),
    activeState: activeState || null,
    scope: registration?.scope || null,
    dtppCycle: cycle
  };
}

export function syncServiceWorkerDtppCycle(rawCycle: string | null | undefined): void {
  if (!canUseServiceWorker()) return;
  const cycle = normalizeCycle(rawCycle);
  if (!cycle) return;

  ensureServiceWorkerCacheRegistration();
  registrationPromise
    ?.then((registration) => {
      if (!registration) return;
      postCycleMessage(registration, cycle);
      return navigator.serviceWorker.ready;
    })
    .then((readyRegistration) => {
      if (!readyRegistration) return;
      postCycleMessage(readyRegistration, cycle);
    })
    .catch(() => {
      // Keep runtime non-fatal when service worker operations fail.
    });
}
