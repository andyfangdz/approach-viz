# Validation Expectations

Checklist for verifying parser, render, and data-logic changes.

## Automated Steps

Run in order after any parser/render/data change:

1. `npm run format:check` — verify repository formatting.
2. `npm run lint` — ESLint parse/lint checks.
3. `npm run typecheck` — TypeScript compile checks without emit.
4. `npm run prepare-data` — download fresh FAA/CIFP + airspace + minimums data and rebuild SQLite.
5. `npm run test` — full test suite (parser + geometry).
6. `npm run test:parser` — especially after `lib/cifp/parser.ts` changes.
7. `npm run test:geometry` — for path/curve/runway/coordinate geometry changes.
8. `npm run build` — production build (also refreshes data).

## Runtime Integration (Live Network)

Use this when validating deployed runtime service behavior end-to-end:

1. `npm run test:integration:runtime` — verifies traffic (`/v1/traffic/adsbx`) and MRMS (`/v1/meta`, `/v1/weather/volume`) response structure against the configured runtime base URL.

Notes:

- This suite is intentionally separate from `npm run test` because it requires live internet and upstream data availability.
- Override target host with `RUNTIME_INTEGRATION_BASE_URL` if needed.

## Manual Spot-Checks

After a successful build, visually verify at least one procedure exercising each of these features:

- RF leg(s)
- AF / DME arc leg(s)
- Hold leg(s)
- Missed approach with CA / DF / HM
- Glidepath inside FAF

## Minima/Plate-Only Procedure Checks

- Verify at least one minima/plate-only procedure (e.g. `KPOU VOR-A`) appears in the selector list, shows minimums + plate, and indicates geometry is unavailable from CIFP.
- Verify the legend remains concise for these procedures (geometry-unavailable status shown in the minimums section, not as long legend copy).
