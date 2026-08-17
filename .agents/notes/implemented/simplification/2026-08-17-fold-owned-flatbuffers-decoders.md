# Agent Note: Fold owned FlatBuffers decoders into zero-copy views

Status: implemented

## Problem

Production MRMS/traffic decode uses zero-copy FlatBuffers views (`FbVolumeView`, `FbEchoTopView`, `FbAircraftView`). The owned decoders `decode_mrms_fb`, `decode_echo_top_fb`, and `decode_traffic_fb` plus `DecodedEchoTop` / `DecodedTraffic*` / `DecodedMrmsVolume` existed only so unit tests could construct payloads by hand.

## Decision

Delete `mrms_wire_codec.rs`, `echo_top_wire_codec.rs`, and `traffic_codec.rs`. Prepare/render tests use a slim `TestVolume` fixture; merge tests keep `MergeAircraft` as `#[cfg(test)]`. Encoding/round-trip coverage builds FlatBuffers and reads them through the production views, including `collect_fb_history` (now compiled under `test` as well as `wasm`/`ios`).

## Alternatives considered

**Keep owned decoders as a documented JSON/test fixture API.** There is no production JSON volume path anymore. Keeping a second decode contract invited the index-space bugs the render join just left.

## Consequences

`VolumeSource` / `EchoTopSource` / `AircraftSource` are implemented by the FB views plus test fixtures. WASM/UniFFI `decode_and_prepare_*` paths are unchanged. Living docs (`docs/mrms-rust-pipeline.md`, `docs/worker-transport-protocols.md`, `/overview` module map) point at the views instead of the deleted codec files. Historical `docs/plans/*` still name the old modules.
