use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;

use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, RwLock};

use crate::config::Config;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub http: Client,
    pub latest: Arc<RwLock<Option<Arc<ScanSnapshot>>>>,
    pub pending: Arc<Mutex<HashMap<String, PendingIngest>>>,
    pub recent_timestamps: Arc<Mutex<HashSet<String>>>,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct LevelBounds {
    pub bottom_feet: u16,
    pub top_feet: u16,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct StoredVoxel {
    pub row: u16,
    pub col: u16,
    pub level_idx: u8,
    pub phase: u8,
    pub dbz_tenths: i16,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GridDef {
    pub nx: u32,
    pub ny: u32,
    pub la1_deg: f64,
    pub lo1_deg360: f64,
    pub di_deg: f64,
    pub dj_deg: f64,
    pub scanning_mode: u8,
    pub lat_step_deg: f64,
    pub lon_step_deg: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScanSnapshot {
    pub timestamp: String,
    pub generated_at_ms: i64,
    pub scan_time_ms: i64,
    pub grid: GridDef,
    pub tile_size: u16,
    pub tile_cols: u16,
    pub tile_rows: u16,
    pub level_bounds: Vec<LevelBounds>,
    pub tile_offsets: Vec<u32>,
    pub voxels: Vec<StoredVoxel>,
}

#[derive(Clone, Debug)]
pub struct PendingIngest {
    pub attempts: u32,
    pub next_attempt_at: Instant,
}

#[derive(Clone, Debug)]
pub struct ParsedReflectivityField {
    pub grid: GridDef,
    pub dbz_tenths: Vec<i16>,
}

#[derive(Clone, Debug)]
pub struct ParsedAuxField {
    pub grid: GridDef,
    pub values: Vec<f32>,
}

#[derive(Clone, Debug)]
pub struct AuxFieldSampler {
    pub grid: GridDef,
    pub values: Vec<f32>,
}

impl AuxFieldSampler {
    pub fn sample(&self, lat_deg: f64, lon_deg360: f64) -> Option<f32> {
        if self.grid.lat_step_deg.abs() < f64::EPSILON
            || self.grid.lon_step_deg.abs() < f64::EPSILON
        {
            return None;
        }

        let row = ((lat_deg - self.grid.la1_deg) / self.grid.lat_step_deg).round() as i64;
        let col = ((lon_deg360 - self.grid.lo1_deg360) / self.grid.lon_step_deg).round() as i64;
        if row < 0 || col < 0 {
            return None;
        }

        let row_u = row as u32;
        let col_u = col as u32;
        if row_u >= self.grid.ny || col_u >= self.grid.nx {
            return None;
        }

        let index = row_u as usize * self.grid.nx as usize + col_u as usize;
        self.values.get(index).copied()
    }
}
