import type { SelectOption } from '@/app/app-client-utils';
import * as Comlink from 'comlink';

const MAX_PICKER_RESULTS = 80;

function normalizeQuery(value: string): string {
  return value.trim().toLowerCase();
}

function filterOptions(options: SelectOption[], query: string): SelectOption[] {
  const normalized = normalizeQuery(query);
  if (!normalized) {
    return options.slice(0, MAX_PICKER_RESULTS);
  }
  return options
    .filter((option) => option.searchText.includes(normalized))
    .slice(0, MAX_PICKER_RESULTS);
}

export class FilterWorkerApi {
  filter(options: SelectOption[], query: string): SelectOption[] {
    return filterOptions(options, query);
  }
}

Comlink.expose(new FilterWorkerApi());
