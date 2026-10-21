'use client';

import { useEffect, useState } from 'react';
import { loadTraconSceneDataAction } from '@/app/actions';
import type { TraconSceneData } from '@/lib/types';

interface TraconSceneState {
  facilityId: string;
  data: TraconSceneData | null;
  error: string | null;
}

/**
 * Loads the TRACON facility scope while the TRACON view is active. A reply
 * for a facility the user has since left is dropped, and data for one
 * facility is never returned while another is selected.
 */
export function useTraconScene(facilityId: string, enabled: boolean) {
  const [state, setState] = useState<TraconSceneState | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    loadTraconSceneDataAction(facilityId)
      .then((data) => {
        if (!cancelled) setState({ facilityId, data, error: null });
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setState({ facilityId, data: null, error: `TRACON ${facilityId}: ${message}` });
      });
    return () => {
      cancelled = true;
    };
  }, [facilityId, enabled]);

  const current = state?.facilityId === facilityId ? state : null;
  return {
    traconScene: enabled ? (current?.data ?? null) : null,
    traconError: enabled ? (current?.error ?? null) : null,
    traconLoading: enabled && current === null
  };
}
