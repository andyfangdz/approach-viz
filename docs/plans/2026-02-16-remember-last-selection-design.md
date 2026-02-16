# Remember Last Selected Airport/Approach

## Problem

When users visit the site at `/` without specifying an airport or approach, it always loads KCDW with no approach selected. Returning users should see their last-viewed airport/approach instead.

## Approach

Client-side localStorage persistence with redirect from the root route.

## Design

### New localStorage key

`'approach-viz:last-selection'` stores `{ airportId: string, approachId: string }`. Separate from the options key (`approach-viz:options:v1`) for clean concern separation.

### New prop: `isDefaultRoute`

`AppClient` receives `isDefaultRoute: boolean` — `true` only from the root `page.tsx` (`/`). Dynamic routes don't set it.

### Write on every navigation

In the existing URL-sync effect, whenever `selectedAirport` or `selectedApproach` changes, also write to `'approach-viz:last-selection'`.

### Read on mount (root route only)

In the existing localStorage init effect, when `isDefaultRoute` is true:

1. Read `'approach-viz:last-selection'`
2. If valid, call `requestSceneData(remembered.airportId, remembered.approachId)`
3. If not found or invalid, pick randomly from `DEFAULT_SELECTIONS` (currently just `KCDW/L22`)
4. URL updates via the existing `replaceState` effect

### Default selections list

```ts
export const DEFAULT_SELECTIONS = [{ airportId: 'KCDW', approachId: 'L22' }];
```

Defined in `route-page.tsx`. Since the server already renders KCDW for `/`, and the default list also starts with KCDW, first-visit has zero extra fetch.

## Files touched

1. `app/route-page.tsx` — add `DEFAULT_SELECTIONS`, pass `isDefaultRoute`
2. `app/AppClient.tsx` — add `isDefaultRoute` prop, read/write last selection
3. `docs/ui-url-state-and-mobile.md` — document new localStorage key
