#![allow(dead_code, private_interfaces, unused_imports)]

// Library target: exposes crate internals for benchmarks and integration tests.
// The binary entry point remains in main.rs.
//
// Most items use `pub(crate)` visibility (sufficient for the binary), so the
// lib target sees them as dead code. Suppress here rather than widening every
// visibility annotation.
#![allow(dead_code, unused_imports)]

pub mod config;
pub mod constants;
pub mod http_client;
pub mod server;
pub mod traffic;
pub mod types;
pub mod utils;
pub mod weather;
