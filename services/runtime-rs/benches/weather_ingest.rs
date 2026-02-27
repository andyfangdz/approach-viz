mod fixtures;
use approach_viz_runtime::weather::resolve_thermo_phase;
use criterion::{criterion_group, criterion_main, Criterion};

fn bench_filter_pass(c: &mut Criterion) {
    let data = fixtures::generate_grid(3500, 3500);
    let threshold: i16 = 50;

    c.bench_function("filter_pass_baseline", |b| {
        b.iter(|| {
            let mut valid = Vec::with_capacity(data.dbz_tenths.len() / 3);
            for (i, &dbz) in data.dbz_tenths.iter().enumerate() {
                if dbz >= threshold {
                    valid.push(i as u32);
                }
            }
            std::hint::black_box(valid.len())
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
        .filter(|(_, &d)| d >= threshold)
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

criterion_group!(benches, bench_filter_pass, bench_phase_scoring);
criterion_main!(benches);
