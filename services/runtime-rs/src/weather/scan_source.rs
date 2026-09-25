//! The in-memory snapshot as a `ScanSource`, so queries run through the same
//! core builders the weather edge Worker uses.

use approach_viz_core::mrms_query::{
    EchoTopSummary, GridDef, LevelBounds, ScanMeta, ScanSource, StoredVoxel,
};

use crate::types::ScanSnapshot;

impl ScanMeta for ScanSnapshot {
    fn grid(&self) -> &GridDef {
        &self.grid
    }

    fn tile_size(&self) -> u16 {
        self.tile_size
    }

    fn tile_cols(&self) -> u16 {
        self.tile_cols
    }

    fn level_bounds(&self) -> &[LevelBounds] {
        &self.level_bounds
    }

    fn generated_at_ms(&self) -> i64 {
        self.generated_at_ms
    }

    fn scan_time_ms(&self) -> i64 {
        self.scan_time_ms
    }

    fn echo_top_summary(&self) -> EchoTopSummary {
        EchoTopSummary {
            source_cell_count: self.echo_tops.len() as u32,
            max_top18_feet: self.echo_top_debug.max_top18_feet.unwrap_or(0),
            max_top30_feet: self.echo_top_debug.max_top30_feet.unwrap_or(0),
            max_top50_feet: self.echo_top_debug.max_top50_feet.unwrap_or(0),
            max_top60_feet: self.echo_top_debug.max_top60_feet.unwrap_or(0),
        }
    }
}

impl ScanSource for ScanSnapshot {
    fn tile_voxels(&self, tile_idx: usize) -> &[StoredVoxel] {
        if tile_idx + 1 >= self.tile_offsets.len() {
            return &[];
        }
        let start = self.tile_offsets[tile_idx] as usize;
        let end = self.tile_offsets[tile_idx + 1] as usize;
        &self.voxels[start..end]
    }
}
