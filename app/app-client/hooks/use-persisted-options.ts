'use client';

import { useCallback, useEffect, useState, type SetStateAction } from 'react';
import { DEFAULT_OPTIONS, restoreOptions, type OptionsState } from '../options-state';

const OPTIONS_STORAGE_KEY = 'approach-viz:options:v1';

export function usePersistedOptions() {
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(OPTIONS_STORAGE_KEY);
      setOptions(restoreOptions(raw, window.location.search));
    } catch (error) {
      console.warn('Unable to restore saved options', error);
      setOptions(restoreOptions(null, window.location.search));
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(OPTIONS_STORAGE_KEY, JSON.stringify(options));
    } catch (error) {
      console.warn('Unable to save options', error);
    }
  }, [hydrated, options]);

  const updateOption = useCallback(
    <K extends keyof OptionsState>(key: K, value: SetStateAction<OptionsState[K]>) => {
      setOptions((current) => ({
        ...current,
        [key]: value instanceof Function ? value(current[key]) : value
      }));
    },
    []
  );
  const setLayerEnabled = useCallback((id: keyof OptionsState['layers'], enabled: boolean) => {
    setOptions((current) => ({ ...current, layers: { ...current.layers, [id]: enabled } }));
  }, []);

  return { ...options, updateOption, setLayerEnabled };
}
