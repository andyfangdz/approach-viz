mod fixtures;
use approach_viz_runtime::weather::{
    compute_phase_scores_branchless, filter_voxels_by_threshold, resolve_thermo_phase,
    FilterResult,
};
use criterion::{criterion_group, criterion_main, Criterion};

fn bench_filter_pass(c: &mut Criterion) {
    let data = fixtures::generate_grid(3500, 3500);
    let threshold: i16 = 50;

    c.bench_function("filter_pass_baseline", |b| {
        b.iter(|| {
            let mut valid = Vec::with_capacity(data.dbz_tenths.len() / 3);
            for (i, dbz) in data.dbz_tenths.iter().enumerate() {
                if *dbz >= threshold {
                    valid.push(i as u32);
                }
            }
            std::hint::black_box(valid.len())
        })
    });

    c.bench_function("filter_pass_simd", |b| {
        let mut result = FilterResult::new();
        b.iter(|| {
            result.clear();
            filter_voxels_by_threshold(&data.dbz_tenths, threshold, data.nx, &mut result);
            std::hint::black_box(result.indices.len())
        })
    });
}

fn bench_phase_scoring(c: &mut Criterion) {
    let data = fixtures::generate_grid(3500, 3500);
    let threshold: i16 = 50;
    let voxel_mid_feet: f64 = 15_000.0;

    // Pre-filter to get valid indices
    let valid: Vec<usize> = data
        .dbz_tenths
        .iter()
        .enumerate()
        .filter(|&(_, d)| *d >= threshold)
        .map(|(i, _)| i)
        .collect();

    c.bench_function("phase_scoring_baseline", |b| {
        b.iter(|| {
            let mut rain_count = 0u32;
            let mut snow_count = 0u32;
            for &i in &valid {
                let evidence = resolve_thermo_phase(
                    voxel_mid_feet,
                    nan_to_option(data.aux_values[0][i]),
                    nan_to_option(data.aux_values[1][i]),
                    nan_to_option(data.aux_values[2][i]),
                    nan_to_option(data.aux_values[3][i]),
                    nan_to_option(data.aux_values[4][i]),
                    nan_to_option(data.aux_values[5][i]),
                    nan_to_option(data.aux_values[6][i]),
                );
                match evidence.phase {
                    0 => rain_count += 1,
                    2 => snow_count += 1,
                    _ => {}
                }
            }
            std::hint::black_box((rain_count, snow_count))
        })
    });
}

fn nan_to_option(v: f32) -> Option<f32> {
    if v.is_finite() {
        Some(v)
    } else {
        None
    }
}

fn bench_phase_scoring_branchless(c: &mut Criterion) {
    let data = fixtures::generate_grid(3500, 3500);
    let threshold: i16 = 50;
    let voxel_mid_feet: f32 = 15_000.0;

    // Pre-filter to get valid indices
    let valid: Vec<usize> = data
        .dbz_tenths
        .iter()
        .enumerate()
        .filter(|&(_, d)| *d >= threshold)
        .map(|(i, _)| i)
        .collect();

    // Gather aux values into flat arrays (simulates Pass 2 output)
    let n = valid.len();
    let mut precip_flag = Vec::with_capacity(n);
    let mut freezing_level = Vec::with_capacity(n);
    let mut wet_bulb = Vec::with_capacity(n);
    let mut surface_temp = Vec::with_capacity(n);
    let mut bright_band_top = Vec::with_capacity(n);
    let mut bright_band_bottom = Vec::with_capacity(n);
    let mut rqi = Vec::with_capacity(n);
    let mut zdr = Vec::with_capacity(n);
    let mut rhohv = Vec::with_capacity(n);

    for &i in &valid {
        precip_flag.push(data.aux_values[0][i]);
        freezing_level.push(data.aux_values[1][i]);
        wet_bulb.push(data.aux_values[2][i]);
        surface_temp.push(data.aux_values[3][i]);
        bright_band_top.push(data.aux_values[4][i]);
        bright_band_bottom.push(data.aux_values[5][i]);
        rqi.push(data.aux_values[6][i]);
        zdr.push(data.zdr_values[i]);
        rhohv.push(data.rhohv_values[i]);
    }

    c.bench_function("phase_scoring_branchless", |b| {
        b.iter(|| {
            let result = compute_phase_scores_branchless(
                voxel_mid_feet,
                &precip_flag,
                &freezing_level,
                &wet_bulb,
                &surface_temp,
                &bright_band_top,
                &bright_band_bottom,
                &rqi,
                &zdr,
                &rhohv,
                false,
            );
            let mut rain_count = 0u32;
            let mut snow_count = 0u32;
            for &phase in &result.phase {
                match phase {
                    0 => rain_count += 1,
                    2 => snow_count += 1,
                    _ => {}
                }
            }
            std::hint::black_box((rain_count, snow_count))
        })
    });
}

criterion_group!(
    benches,
    bench_filter_pass,
    bench_phase_scoring,
    bench_phase_scoring_branchless
);
criterion_main!(benches);
