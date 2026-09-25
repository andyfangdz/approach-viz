//! Build a scan pack from a stored snapshot and prove that queries answered
//! from the pack are byte-identical to queries answered from the snapshot.
//!
//! cargo run --release -p approach-viz-runtime --example scan_pack -- \
//!     <snapshot.avsn.zst> [<out.avsp>]

use std::alloc::{GlobalAlloc, Layout, System};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use approach_viz_core::mrms_pack::{read_header_len, ScanPackIndex};
use approach_viz_core::mrms_query::{
    build_echo_top_wire_fb, build_query_window, build_volume_wire_fb,
};
use approach_viz_runtime::weather::{build_scan_pack, load_snapshot_file};

/// Tracks the heap high-water mark, the figure that must fit the edge
/// Worker's 128 MB isolate (WASM linear memory never shrinks).
struct PeakAlloc;

static CURRENT: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for PeakAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let now = CURRENT.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
        PEAK.fetch_max(now, Ordering::Relaxed);
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        CURRENT.fetch_sub(layout.size(), Ordering::Relaxed);
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: PeakAlloc = PeakAlloc;

/// Peak heap growth over `f`, in bytes.
fn peak_during<T>(f: impl FnOnce() -> T) -> (T, usize) {
    let base = CURRENT.load(Ordering::Relaxed);
    PEAK.store(base, Ordering::Relaxed);
    let value = f();
    (value, PEAK.load(Ordering::Relaxed) - base)
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let snapshot_path = PathBuf::from(args.next().context("missing <snapshot.avsn.zst>")?);
    let out_path = args.next().map(PathBuf::from);

    let scan = load_snapshot_file(&snapshot_path).await?;
    let started = Instant::now();
    let pack = build_scan_pack(&scan)?;
    let pack_ms = started.elapsed().as_millis();
    let header_len = read_header_len(&pack)? as usize;
    let index = ScanPackIndex::parse(&pack[..header_len])?;
    println!(
        "scan {}: {} voxels, {} echo tops -> pack {:.1} MB (header {} bytes) in {pack_ms} ms",
        scan.timestamp,
        scan.voxels.len(),
        scan.echo_tops.len(),
        pack.len() as f64 / 1e6,
        header_len,
    );
    if let Some(out_path) = out_path {
        std::fs::write(&out_path, &pack)?;
        println!("wrote {}", out_path.display());
    }

    let fetch = |ranges: &[approach_viz_core::mrms_pack::ByteRange]| -> Vec<u8> {
        ranges
            .iter()
            .flat_map(|r| {
                pack[r.offset as usize..(r.offset + r.len) as usize]
                    .iter()
                    .copied()
            })
            .collect()
    };
    let mut queries = 0;
    let mut pack_time = std::time::Duration::ZERO;
    let mut max_ranges = 0;
    let mut max_fetch = 0;
    let mut max_voxels = (0_u32, 0_u32, 0_u64, 0.0, 0.0, 0.0);
    let mut max_peak = 0;
    for lat in (18..=56).step_by(2) {
        for lon in (-160..=-60).step_by(3) {
            for (min_dbz, range) in [(5.0, 120.0), (5.0, 220.0), (30.0, 60.0)] {
                let (lat, lon) = (lat as f64 + 0.37, lon as f64 + 0.21);
                let window = build_query_window(&scan, lat, lon, min_dbz, range);
                let expected_volume = build_volume_wire_fb(&scan, &window);
                let expected_echo = build_echo_top_wire_fb(&scan, &window, &scan.echo_tops);

                let started = Instant::now();
                let pack_window = index.query_window(lat, lon, min_dbz, range);
                let ranges = index.volume_ranges(&pack_window);
                let data = fetch(&ranges);
                max_ranges = max_ranges.max(ranges.len());
                max_fetch = max_fetch.max(data.len());
                // Mirror the edge Worker: the fetched bytes are freed once
                // the tiles are decoded.
                let data_len = data.len();
                let (actual_volume, peak) = peak_during(|| -> Result<Vec<u8>> {
                    let collector = index.collect_volume(&pack_window, &data)?;
                    drop(data);
                    Ok(collector.finish())
                });
                let actual_volume = actual_volume?;
                max_peak = max_peak.max(peak + data_len);
                let echo_data = fetch(
                    &index
                        .echo_top_range(&pack_window)
                        .into_iter()
                        .collect::<Vec<_>>(),
                );
                let actual_echo = index.build_echo_tops(&pack_window, &echo_data)?;
                pack_time += started.elapsed();

                let fb =
                    flatbuffers::root::<approach_viz_core::generated::MrmsVolume>(&actual_volume)?;
                if fb.source_voxel_count() > max_voxels.0 {
                    max_voxels = (
                        fb.source_voxel_count(),
                        fb.brick_count(),
                        index.volume_voxel_count(&pack_window),
                        lat,
                        lon,
                        range,
                    );
                }
                if actual_volume != expected_volume || actual_echo != expected_echo {
                    bail!(
                        "pack query differs at lat={lat} lon={lon} minDbz={min_dbz} range={range}"
                    );
                }
                queries += 1;
            }
        }
    }
    println!(
        "{queries} volume+echo-top queries identical; pack path {:.1} ms/query avg, \
         max {max_ranges} ranges and {:.1} MB fetched per volume query",
        pack_time.as_secs_f64() * 1000.0 / queries as f64,
        max_fetch as f64 / 1e6,
    );
    println!(
        "heaviest window: {max_voxels:?} (source voxels, bricks, decoded voxels, lat, lon, range)"
    );
    println!(
        "peak heap of one pack volume query (fetched data included): {:.1} MB",
        max_peak as f64 / 1e6
    );
    Ok(())
}
