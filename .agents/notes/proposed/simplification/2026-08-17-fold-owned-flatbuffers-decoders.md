# Agent Note: Fold owned FlatBuffers decoders into zero-copy views

Status: proposed

## Problem

Production MRMS/traffic decode uses zero-copy FlatBuffers views (`FbVolumeView`, `FbEchoTopView`, `FbAircraftView`) from `wasm.rs` and `ios.rs`. The owned decoders `decode_mrms_fb`, `decode_echo_top_fb`, and `decode_traffic_fb` plus `DecodedEchoTop` / `DecodedTraffic*` exist only so unit tests can construct payloads by hand. `EchoTopSummary` in `mrms_preprocess.rs` was already unused and has been deleted; the owned decode path is the remaining test-only codec surface (~1k LOC with tests).

## Proposal

Remove the three owned `decode_*_fb` entry points. Keep encoding/round-trip tests that build FlatBuffers with the existing builders and decode through the production views. Collapse `VolumeSource` / `AircraftSource` onto FB views plus a slim test stub if tests still need an owned fixture. Update `docs/mrms-rust-pipeline.md` if it still describes decode as living in `mrms_wire_codec.rs`.

## Alternatives considered

**Keep owned decoders as a documented JSON/test fixture API.** There is no production JSON volume path anymore, and `MergeAircraft` is already test-only. Keeping a second decode contract invites the index-space bugs the render join just left.

**Rewrite tests in the same PR as unrelated client deletions.** High churn, easy to miss a fixture that still needs SoA column lengths.

## Acceptance criteria

- `rg decode_mrms_fb|decode_echo_top_fb|decode_traffic_fb` hits nothing outside git history.
- `cargo test -p approach-viz-core` still covers prepare/render joins and FB validation failures.
- WASM/UniFFI `decode_and_prepare_*` paths are unchanged.

## Risks

Tests that currently mutate `DecodedMrmsVolume` fields become more verbose if they must go through FB builders. That cost is the point: the production contract is the view, not the owned struct.
