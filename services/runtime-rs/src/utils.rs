use std::cmp::{max, min};
use std::sync::OnceLock;

use anyhow::{Context, Result};
use chrono::{DateTime, NaiveDateTime, Utc};
use opentelemetry::global;
use opentelemetry::trace::TracerProvider as _;
use opentelemetry::KeyValue;
use opentelemetry_otlp::WithExportConfig;
use opentelemetry_sdk::trace::SdkTracerProvider;
use opentelemetry_sdk::Resource;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

static DATADOG_TRACER_PROVIDER: OnceLock<SdkTracerProvider> = OnceLock::new();

pub fn init_tracing() {
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));

    if datadog_tracing_enabled() {
        match init_datadog_tracing(env_filter.clone()) {
            Ok(()) => {
                tracing::info!(
                    endpoint = %datadog_otlp_endpoint(),
                    "Datadog runtime tracing enabled via OTLP export."
                );
                return;
            }
            Err(error) => {
                eprintln!(
                    "Failed to initialize Datadog runtime tracing (falling back to stdout-only tracing): {error:#}"
                );
            }
        }
    }

    init_stdout_tracing(env_filter);
}

pub fn shutdown_tracing() {
    if let Some(provider) = DATADOG_TRACER_PROVIDER.get() {
        if let Err(error) = provider.force_flush() {
            eprintln!("Datadog tracer force-flush failed: {error}");
        }
        if let Err(error) = provider.shutdown() {
            eprintln!("Datadog tracer shutdown failed: {error}");
        }
    }
}

fn init_stdout_tracing(env_filter: tracing_subscriber::EnvFilter) {
    tracing_subscriber::registry()
        .with(env_filter)
        .with(
            tracing_subscriber::fmt::layer()
                .with_target(false)
                .without_time(),
        )
        .init();
}

fn init_datadog_tracing(env_filter: tracing_subscriber::EnvFilter) -> Result<()> {
    let tracer_provider = build_datadog_tracer_provider()?;
    let tracer = tracer_provider.tracer("approach-viz-runtime-rs");

    tracing_subscriber::registry()
        .with(env_filter)
        .with(
            tracing_subscriber::fmt::layer()
                .with_target(false)
                .without_time(),
        )
        .with(tracing_opentelemetry::layer().with_tracer(tracer))
        .try_init()
        .context("Failed to install tracing subscriber with Datadog OTLP layer")?;

    let _ = global::set_tracer_provider(tracer_provider.clone());
    let _ = DATADOG_TRACER_PROVIDER.set(tracer_provider);
    Ok(())
}

fn build_datadog_tracer_provider() -> Result<SdkTracerProvider> {
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_tonic()
        .with_endpoint(datadog_otlp_endpoint())
        .build()
        .context("Failed to build OTLP span exporter for Datadog")?;

    let service_name = env_optional("RUNTIME_DD_SERVICE")
        .or_else(|| env_optional("DD_SERVICE"))
        .unwrap_or_else(|| "approach-viz-runtime-rs".to_string());
    let service_env = env_optional("RUNTIME_DD_ENV").or_else(|| env_optional("DD_ENV"));
    let service_version = env_optional("RUNTIME_DD_VERSION").or_else(|| env_optional("DD_VERSION"));

    let mut attributes = vec![KeyValue::new("service.name", service_name)];
    if let Some(env) = service_env {
        attributes.push(KeyValue::new("env", env.clone()));
        attributes.push(KeyValue::new("deployment.environment.name", env));
    }
    if let Some(version) = service_version {
        attributes.push(KeyValue::new("service.version", version));
    }

    Ok(SdkTracerProvider::builder()
        .with_resource(
            Resource::builder_empty()
                .with_attributes(attributes)
                .build(),
        )
        .with_batch_exporter(exporter)
        .build())
}

fn datadog_tracing_enabled() -> bool {
    env_bool("RUNTIME_DD_TRACE_ENABLED")
        .or_else(|| env_bool("DD_TRACE_ENABLED"))
        .unwrap_or(false)
}

fn datadog_otlp_endpoint() -> String {
    if let Some(endpoint) = env_optional("RUNTIME_DD_TRACE_OTLP_ENDPOINT")
        .or_else(|| env_optional("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"))
        .or_else(|| env_optional("OTEL_EXPORTER_OTLP_ENDPOINT"))
    {
        return endpoint;
    }

    let host = env_optional("RUNTIME_DD_AGENT_HOST")
        .or_else(|| env_optional("DD_AGENT_HOST"))
        .unwrap_or_else(|| "127.0.0.1".to_string());
    let port = env_optional("RUNTIME_DD_TRACE_OTLP_PORT")
        .or_else(|| env_optional("DD_OTLP_GRPC_PORT"))
        .unwrap_or_else(|| "4317".to_string());

    format!("http://{host}:{port}")
}

fn env_optional(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn env_bool(name: &str) -> Option<bool> {
    let raw = std::env::var(name).ok()?;
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

pub fn clamp(value: f64, min_value: f64, max_value: f64) -> f64 {
    value.max(min_value).min(max_value)
}

pub fn round_i16(value: f64) -> i16 {
    if !value.is_finite() {
        return 0;
    }
    value.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16
}

pub fn round_u16(value: f64) -> u16 {
    if !value.is_finite() {
        return 0;
    }
    value.round().clamp(0.0, u16::MAX as f64) as u16
}

pub fn to_lon360(lon_deg: f64) -> f64 {
    let normalized = lon_deg % 360.0;
    if normalized < 0.0 {
        normalized + 360.0
    } else {
        normalized
    }
}

pub fn shortest_lon_delta_degrees(lon_deg360: f64, origin_lon_deg360: f64) -> f64 {
    let mut delta = lon_deg360 - origin_lon_deg360;
    if delta > 180.0 {
        delta -= 360.0;
    }
    if delta < -180.0 {
        delta += 360.0;
    }
    delta
}

pub fn projection_scales_nm_per_degree(lat_deg: f64) -> (f64, f64) {
    approach_viz_core::coords::projection_scales_nm_per_degree(lat_deg)
}

pub fn clamp_i64(value: i64, min_value: i64, max_value: i64) -> i64 {
    min(max(value, min_value), max_value)
}

pub fn parse_timestamp_utc(timestamp: &str) -> Option<DateTime<Utc>> {
    let naive = NaiveDateTime::parse_from_str(timestamp, "%Y%m%d-%H%M%S").ok()?;
    Some(DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc))
}

pub fn iso_from_ms(timestamp_ms: i64) -> Option<String> {
    DateTime::<Utc>::from_timestamp_millis(timestamp_ms).map(|ts| ts.to_rfc3339())
}
