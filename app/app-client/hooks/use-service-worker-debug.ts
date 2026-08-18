'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ensureServiceWorkerCacheRegistration,
  getServiceWorkerCacheDebugSnapshot,
  syncServiceWorkerDtppCycle
} from '@/app/app-client/service-worker-cache';
import type { ServiceWorkerCacheDebugState } from '@/app/app-client/types';

const EMPTY_SERVICE_WORKER_DEBUG: ServiceWorkerCacheDebugState = {
  supported: false,
  registered: false,
  controlling: false,
  activeState: null,
  scope: null,
  dtppCycle: null
};

/**
 * Service worker registration, d-TPP cycle sync, and the debug-panel snapshot
 * (refreshed on cycle changes and controller changes).
 */
export function useServiceWorkerDebug(dtppCycle: string | null | undefined) {
  const [serviceWorkerDebug, setServiceWorkerDebug] = useState<ServiceWorkerCacheDebugState>(
    EMPTY_SERVICE_WORKER_DEBUG
  );

  const refreshServiceWorkerDebug = useCallback((cycle: string | null | undefined) => {
    getServiceWorkerCacheDebugSnapshot(cycle)
      .then((snapshot) => {
        setServiceWorkerDebug(snapshot);
      })
      .catch((error) => {
        // Non-fatal, but report it so debug-panel gaps are explainable.
        console.warn(
          'Service worker cache introspection failed.',
          error instanceof Error ? error : String(error)
        );
      });
  }, []);

  useEffect(() => {
    if (globalThis.window === undefined) return;
    ensureServiceWorkerCacheRegistration();
  }, []);

  useEffect(() => {
    syncServiceWorkerDtppCycle(dtppCycle);
    refreshServiceWorkerDebug(dtppCycle);
  }, [refreshServiceWorkerDebug, dtppCycle]);

  useEffect(() => {
    if (globalThis.window === undefined || !('serviceWorker' in navigator)) return;

    const handleControllerChange = () => {
      refreshServiceWorkerDebug(dtppCycle);
    };

    navigator.serviceWorker.addEventListener('controllerchange', handleControllerChange);
    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', handleControllerChange);
    };
  }, [refreshServiceWorkerDebug, dtppCycle]);

  return { serviceWorkerDebug };
}
