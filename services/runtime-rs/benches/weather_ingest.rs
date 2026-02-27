mod fixtures;
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

criterion_group!(benches, bench_filter_pass);
criterion_main!(benches);
