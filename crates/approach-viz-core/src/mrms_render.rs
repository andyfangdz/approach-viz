// Render-ready MRMS voxel assembly.
//
// `prepare_volume` outputs two index spaces: full-length payload columns
// addressed by raw payload index, and compacted per-valid-voxel columns
// addressed via `valid_indices`, with `declutter_indices` selecting the
// rendered subset. Mixing those spaces caused the web ghost-layer bug, so the
// join is resolved here — once, in Rust — and clients receive flat per-voxel
// columns they can upload directly.

use crate::mrms_preprocess::VolumeSource;
use crate::types::PreparedVolume;

/// Flat per-rendered-voxel columns. All positions/sizes are local-frame
/// nautical miles without vertical exaggeration; renderers multiply the `y`
/// center and height by their vertical scale.
///
/// `max_abs_x_nm`/`max_abs_z_nm`/`max_corrected_top_feet` summarize the
/// rendered set for altitude-guide sizing (web `guideData` semantics).
#[derive(Debug, Clone, PartialEq)]
pub struct MrmsRenderVolumeData {
    pub center_x_nm: Vec<f32>,
    pub center_y_nm: Vec<f32>,
    pub center_z_nm: Vec<f32>,
    pub size_x_nm: Vec<f32>,
    pub size_y_nm: Vec<f32>,
    pub size_z_nm: Vec<f32>,
    pub dbz: Vec<f32>,
    pub phase_code: Vec<u8>,
    pub max_abs_x_nm: f32,
    pub max_abs_z_nm: f32,
    pub max_corrected_top_feet: f32,
}

/// Join `prepare_volume` outputs with payload columns into render-ready
/// voxel boxes ordered by `declutter_indices`.
pub fn build_render_volume(
    volume: &impl VolumeSource,
    footprint_base_x_nm: f32,
    footprint_base_y_nm: f32,
    prepared: &PreparedVolume,
) -> MrmsRenderVolumeData {
    let count = prepared.declutter_count;
    let mut data = MrmsRenderVolumeData {
        center_x_nm: Vec::with_capacity(count),
        center_y_nm: Vec::with_capacity(count),
        center_z_nm: Vec::with_capacity(count),
        size_x_nm: Vec::with_capacity(count),
        size_y_nm: Vec::with_capacity(count),
        size_z_nm: Vec::with_capacity(count),
        dbz: Vec::with_capacity(count),
        phase_code: Vec::with_capacity(count),
        max_abs_x_nm: 0.0,
        max_abs_z_nm: 0.0,
        max_corrected_top_feet: 0.0,
    };

    for i in 0..count {
        let valid_index = prepared.declutter_indices[i] as usize;
        let payload_index = prepared.valid_indices[valid_index] as usize;

        let x = volume.x_nm(payload_index);
        let z = volume.z_nm(payload_index);
        data.max_abs_x_nm = data.max_abs_x_nm.max(x.abs());
        data.max_abs_z_nm = data.max_abs_z_nm.max(z.abs());
        data.max_corrected_top_feet = data
            .max_corrected_top_feet
            .max(prepared.corrected_top_feet[valid_index]);

        data.center_x_nm.push(x);
        data.center_y_nm.push(prepared.y_base[valid_index]);
        data.center_z_nm.push(z);
        data.size_x_nm
            .push(footprint_base_x_nm * f32::from(volume.footprint_x_span(payload_index).max(1)));
        data.size_y_nm.push(prepared.height_base[valid_index]);
        data.size_z_nm
            .push(footprint_base_y_nm * f32::from(volume.footprint_y_span(payload_index).max(1)));
        data.dbz
            .push(f32::from(volume.dbz_tenths(payload_index)) / 10.0);
        data.phase_code
            .push(prepared.effective_phase_code[valid_index]);
    }

    data
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mrms_preprocess::prepare_volume;
    use crate::types::{
        DeclutterMode, DecodedMrmsVolume, PhaseMode, ALTITUDE_SCALE, PHASE_MIXED, PHASE_RAIN,
        PHASE_SNOW,
    };

    fn test_volume() -> DecodedMrmsVolume {
        DecodedMrmsVolume {
            voxel_count: 3,
            layer_count: 2,
            generated_at_ms: 1_000,
            scan_time_ms: 2_000,
            footprint_x_nm: 0.5,
            footprint_y_nm: 0.6,
            layer_voxel_counts: vec![2, 1],
            x_nm: vec![1.0, -2.0, 3.0],
            z_nm: vec![4.0, 5.0, -6.0],
            bottom_feet: vec![1_000, 2_000, 30_000],
            top_feet: vec![3_000, 4_000, 34_000],
            dbz_tenths: vec![150, 50, 455],
            phase: vec![PHASE_RAIN, PHASE_MIXED, PHASE_SNOW],
            surface_phase: vec![PHASE_SNOW, PHASE_RAIN, PHASE_MIXED],
            footprint_x_span: vec![1, 2, 3],
            footprint_y_span: vec![1, 4, 1],
        }
    }

    #[test]
    fn joins_declutter_and_valid_indices_to_payload_columns() {
        let volume = test_volume();
        // min 10 dBZ drops the middle voxel, so valid voxels map to payload
        // indices [0, 2] and the index spaces genuinely diverge.
        let prepared = prepare_volume(
            &volume,
            100,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
        assert_eq!(prepared.valid_count, 2);
        assert_eq!(prepared.valid_indices, vec![0, 2]);

        let data = build_render_volume(&volume, 0.5, 0.6, &prepared);
        assert_eq!(data.center_x_nm, vec![1.0, 3.0]);
        assert_eq!(data.center_z_nm, vec![4.0, -6.0]);
        // Voxel 1 (payload index 2): center 32k ft, height 4k ft.
        let expected_y = (32_000.0 * ALTITUDE_SCALE) as f32;
        let expected_h = (4_000.0 * ALTITUDE_SCALE) as f32;
        assert!((data.center_y_nm[1] - expected_y).abs() < 1e-5);
        assert!((data.size_y_nm[1] - expected_h).abs() < 1e-5);
        // Footprint spans multiply the scalar base footprint.
        assert!((data.size_x_nm[0] - 0.5).abs() < 1e-6);
        assert!((data.size_z_nm[0] - 0.6).abs() < 1e-6);
        assert!((data.size_x_nm[1] - 1.5).abs() < 1e-6);
        assert!((data.size_z_nm[1] - 0.6).abs() < 1e-6);
        assert_eq!(data.dbz, vec![15.0, 45.5]);
        assert_eq!(data.phase_code, vec![PHASE_RAIN, PHASE_SNOW]);
        // Guide summary covers the rendered set: |x| max 3, |z| max 6,
        // top max 34k ft (no curvature correction applied).
        assert!((data.max_abs_x_nm - 3.0).abs() < 1e-6);
        assert!((data.max_abs_z_nm - 6.0).abs() < 1e-6);
        assert!((data.max_corrected_top_feet - 34_000.0).abs() < 1e-3);
    }

    #[test]
    fn surface_phase_mode_selects_surface_column() {
        let volume = test_volume();
        let prepared = prepare_volume(
            &volume,
            0,
            PhaseMode::Surface,
            DeclutterMode::All,
            false,
            40.0,
        );
        let data = build_render_volume(&volume, 0.5, 0.6, &prepared);
        assert_eq!(data.phase_code, vec![PHASE_SNOW, PHASE_RAIN, PHASE_MIXED]);
    }

    #[test]
    fn declutter_low_renders_only_low_voxels() {
        let volume = test_volume();
        let prepared = prepare_volume(
            &volume,
            0,
            PhaseMode::Altitude,
            DeclutterMode::Low,
            false,
            40.0,
        );
        let data = build_render_volume(&volume, 0.5, 0.6, &prepared);
        // The 30k-34k ft voxel is excluded by the low band.
        assert_eq!(data.center_x_nm, vec![1.0, -2.0]);
        assert_eq!(data.phase_code, vec![PHASE_RAIN, PHASE_MIXED]);
    }

    #[test]
    fn empty_prepared_volume_yields_empty_columns() {
        let volume = test_volume();
        let prepared = prepare_volume(
            &volume,
            1_000,
            PhaseMode::Altitude,
            DeclutterMode::All,
            false,
            40.0,
        );
        let data = build_render_volume(&volume, 0.5, 0.6, &prepared);
        assert!(data.center_x_nm.is_empty());
        assert!(data.phase_code.is_empty());
    }
}
