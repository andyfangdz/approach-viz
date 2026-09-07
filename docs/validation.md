# Validation Expectations

Checklist for verifying parser, render, and data-logic changes.

## Automated Steps (Local)

Run in order after any parser/render/data change:

1. `npm run format:check` — verify repository formatting.
2. `npm run lint` — ESLint parse/lint checks.
3. `npm run typecheck` — TypeScript compile checks without emit.
4. `npm run prepare-data` — download fresh FAA/CIFP + airspace + minimums data and rebuild SQLite.
5. `npm run test` — full test suite (parser + geometry + layers + MRMS decode helpers).
6. `npm run test:parser` — especially after `lib/cifp/parser.ts` changes.
7. `npm run test:geometry` — for path/curve/runway/coordinate geometry changes.
8. `npm run build` — production build (also refreshes data).

## CI Pipeline

CI (`.github/workflows/parser-tests.yml`) runs on every push/PR:

1. `npm run format:check`
2. `npm run lint`
3. `npm run typecheck`
4. `npm run test`
5. `npx next build` — uses `npx next build` (not `npm run build`) so CI does not trigger the FAA data download that `prepare-data` includes.

Runtime integration tests are intentionally excluded from CI (see below).

## Raymarch Volume GPU Smoke (Local Browser)

Use this after any change to the MRMS volume prepare pass (`crates/approach-viz-core/src/mrms_render.rs::build_volume_texture`), the WASM bridge fields it exposes, or the raymarch shader (`app/scene/nexrad/NexradVolumeRaymarch.tsx`):

1. `npm run build:wasm` — the smoke test renders through the WASM in `packages/approach-viz-core-wasm/`, so it must reflect the Rust you changed.
2. `npm run test:smoke:volume` — bundles `scripts/volume-smoke/harness.tsx` (the real `NexradVolumeRaymarch` in an R3F canvas), serves it locally, and drives headless Chromium on SwiftShader WebGL2 through five scenarios: a wide view with no terrain, a flat ground at 60,000 ft (must render zero pixels), a flat ground at 15,000 ft (must render fewer pixels than the wide view), a close-in view where a seam on an 8-texel page face would show, and a close-in camera under a 15,000 ft ground (zero pixels). Any browser console error or warning fails the run; three.js reports shader compile and link failures there. It also checks the page table and brick pool byte sizes against their reported layouts and that the payload rendered at full source resolution (`coarsen 1x`) inside the brick budget.
3. Look at the screenshots in `.tmp/volume-smoke/` — the coverage counts prove occlusion and compilation, not appearance.

Notes:

- Default input is `fixtures/mrms/kmia-20260907-volume.avmr`, a live AVMR v5 volume captured at KMIA (25.79, -80.29) so the result is repeatable; `--live <lat>,<lon>` fetches a current payload from the runtime and `--payload <file>` uses another capture. A payload with no echo fails loudly rather than passing an empty render.
- The browser defaults to Playwright's bundled Chromium (`npx playwright install chromium` once); `--chromium <path>` or `APPROACHVIZ_CHROMIUM_PATH` points at another build.
- Not part of CI or `npm run test`: it needs a browser with WebGL2 and takes about a minute on SwiftShader.

## Runtime Integration (Live Network)

Use this when validating deployed runtime service behavior end-to-end:

1. `npm run test:integration:runtime` — verifies traffic (`/v1/traffic/adsbx`, including `historyHexes`-scoped trail history behavior) and MRMS (`/v1/meta`, `/v1/weather/volume`) response structure against the configured runtime base URL.

Notes:

- This suite is intentionally separate from `npm run test` and CI because it requires live internet and upstream data availability.
- Override target host with `RUNTIME_INTEGRATION_BASE_URL` if needed.
- The `.agents/skills/runtime-validate-live` runbook provides an agent-assisted smoke-check workflow for post-deploy validation.
- The `.agents/skills/runtime-stress-traffic-live` runbook provides a reusable high-concurrency stress profile for `/v1/traffic/adsbx` with percentile and error-rate artifacts.

## Manual Spot-Checks

After a successful build, visually verify at least one procedure exercising each of these features:

- RF leg(s)
- AF / DME arc leg(s)
- Hold leg(s)
- Missed approach with CA / DF / HM
- Glidepath inside FAF
- MRMS weather volume rendering (if runtime service is reachable)
- ProbSevere storm-cell overlay rendering (all in-range footprints, optional top caps/labels, movement vectors)
- Live ADS-B traffic overlay (if runtime service is reachable)
- Mobile viewport behavior: viewport is locked to prevent scroll, zoom, and text selection outside form inputs.

## Minima/Plate-Only Procedure Checks

- Verify at least one minima/plate-only procedure (e.g. `KPOU VOR-A`) appears in the selector list, shows minimums + plate, and indicates geometry is unavailable from CIFP.
- Verify the legend remains concise for these procedures (geometry-unavailable status shown in the minimums section, not as long legend copy).
