//! MRMS scan pack (`AVSP`): one immutable object per scan that the weather
//! edge Worker range-reads from R2.
//!
//! Layout:
//!
//! ```text
//! header   magic "AVSP", u16 version, u8 codec, u8 reserved, u32 header_len,
//!          u64 data_len, scan timing/grid/tile/level metadata, the echo-top
//!          summary, the response headers of both endpoints, then two
//!          directories: (u32 record_count, u32 byte_len) per row-major tile
//!          and per tile-row echo-top band
//! data     tiles in row-major order, then echo-top bands in row order
//! ```
//!
//! Every integer is little-endian and every chunk is compressed on its own
//! (raw deflate), so a query reads the header once and then one contiguous
//! range per tile row of its window. Voxels keep their snapshot order inside a
//! tile and echo tops keep their row-major snapshot order across bands, so the
//! [`mrms_query`](crate::mrms_query) builders produce byte-identical payloads
//! from a pack and from the runtime's in-memory snapshot.

use std::fmt;

use crate::mrms_query::{
    build_echo_top_wire_fb, build_query_window_for_grid, EchoTopSummary, GridDef, LevelBounds,
    QueryWindow, ScanMeta, StoredEchoTop, StoredVoxel, VolumeCollector,
};

pub const PACK_MAGIC: [u8; 4] = *b"AVSP";
pub const PACK_VERSION: u16 = 1;
/// Each chunk is an independent raw deflate stream (RFC 1951, no zlib/gzip framing).
pub const PACK_CODEC_DEFLATE_RAW: u8 = 1;
pub const PACK_CONTENT_TYPE: &str = "application/vnd.approach-viz.scan-pack.v1";

const VOXEL_RECORD_BYTES: usize = 9;
const ECHO_TOP_RECORD_BYTES: usize = 12;
const FIXED_PREFIX_BYTES: usize = 4 + 2 + 1 + 1 + 4 + 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackError(String);

impl PackError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for PackError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for PackError {}

/// Everything a pack stores, borrowed from the producer's snapshot.
pub struct PackInput<'a> {
    pub timestamp: &'a str,
    pub generated_at_ms: i64,
    pub scan_time_ms: i64,
    pub grid: &'a GridDef,
    pub tile_size: u16,
    pub tile_cols: u16,
    pub tile_rows: u16,
    pub level_bounds: &'a [LevelBounds],
    /// Row-major tile offsets into `voxels`, `tile_cols * tile_rows + 1` entries.
    pub tile_offsets: &'a [u32],
    pub voxels: &'a [StoredVoxel],
    /// Row-major (non-decreasing row) echo-top records.
    pub echo_tops: &'a [StoredEchoTop],
    pub echo_top_summary: EchoTopSummary,
    /// Scan metadata headers returned with every volume response.
    pub volume_headers: Vec<(String, String)>,
    /// Scan metadata headers returned with every echo-top response.
    pub echo_top_headers: Vec<(String, String)>,
}

/// Serialize a scan pack. `compress` must produce a raw deflate stream.
pub fn write_scan_pack(
    input: &PackInput<'_>,
    mut compress: impl FnMut(&[u8]) -> Vec<u8>,
) -> Result<Vec<u8>, PackError> {
    let tile_count = input.tile_cols as usize * input.tile_rows as usize;
    if input.tile_size == 0 || tile_count == 0 {
        return Err(PackError::new("scan has no tiles"));
    }
    if input.tile_offsets.len() != tile_count + 1 {
        return Err(PackError::new(format!(
            "tile offsets have {} entries, expected {}",
            input.tile_offsets.len(),
            tile_count + 1
        )));
    }
    if input.tile_offsets[tile_count] as usize != input.voxels.len() {
        return Err(PackError::new("tile offsets do not cover the voxels"));
    }
    if input
        .echo_tops
        .windows(2)
        .any(|pair| pair[1].row < pair[0].row)
    {
        // Band grouping preserves query order only for row-major input.
        return Err(PackError::new("echo tops are not in row-major order"));
    }

    let tile_size = input.tile_size as usize;
    let mut chunks: Vec<(u32, Vec<u8>)> = Vec::with_capacity(tile_count + input.tile_rows as usize);
    let mut raw = Vec::new();
    for tile_idx in 0..tile_count {
        let start = input.tile_offsets[tile_idx] as usize;
        let end = input.tile_offsets[tile_idx + 1] as usize;
        if start > end || end > input.voxels.len() {
            return Err(PackError::new(format!(
                "tile {tile_idx} has invalid offsets"
            )));
        }
        let voxels = &input.voxels[start..end];
        let tile_row = tile_idx / input.tile_cols as usize;
        let tile_col = tile_idx % input.tile_cols as usize;
        if voxels.iter().any(|voxel| {
            voxel.row as usize / tile_size != tile_row || voxel.col as usize / tile_size != tile_col
        }) {
            return Err(PackError::new(format!(
                "tile {tile_idx} holds a voxel of another tile"
            )));
        }
        chunks.push(encode_chunk(voxels.len(), &mut raw, &mut compress, |raw| {
            encode_voxels(voxels, raw)
        }));
    }

    let mut band_start = 0;
    for tile_row in 0..input.tile_rows as usize {
        let band_end = band_start
            + input.echo_tops[band_start..]
                .iter()
                .take_while(|record| record.row as usize / tile_size == tile_row)
                .count();
        let band = &input.echo_tops[band_start..band_end];
        chunks.push(encode_chunk(band.len(), &mut raw, &mut compress, |raw| {
            encode_echo_tops(band, raw)
        }));
        band_start = band_end;
    }
    if band_start != input.echo_tops.len() {
        return Err(PackError::new("echo tops lie outside the tile rows"));
    }

    let data_len: u64 = chunks.iter().map(|(_, bytes)| bytes.len() as u64).sum();
    let mut header = Vec::new();
    header.extend_from_slice(&PACK_MAGIC);
    put_u16(&mut header, PACK_VERSION);
    header.push(PACK_CODEC_DEFLATE_RAW);
    header.push(0);
    put_u32(&mut header, 0); // header_len, patched below
    put_u64(&mut header, data_len);
    put_i64(&mut header, input.generated_at_ms);
    put_i64(&mut header, input.scan_time_ms);
    put_str(&mut header, input.timestamp)?;
    let grid = input.grid;
    put_u32(&mut header, grid.nx);
    put_u32(&mut header, grid.ny);
    for value in [grid.la1_deg, grid.lo1_deg360, grid.di_deg, grid.dj_deg] {
        put_f64(&mut header, value);
    }
    header.push(grid.scanning_mode);
    put_f64(&mut header, grid.lat_step_deg);
    put_f64(&mut header, grid.lon_step_deg);
    put_u16(&mut header, input.tile_size);
    put_u16(&mut header, input.tile_cols);
    put_u16(&mut header, input.tile_rows);
    put_u16(
        &mut header,
        u16_len(input.level_bounds.len(), "level count")?,
    );
    for level in input.level_bounds {
        put_u16(&mut header, level.bottom_feet);
        put_u16(&mut header, level.top_feet);
    }
    let summary = input.echo_top_summary;
    put_u32(&mut header, summary.source_cell_count);
    for value in [
        summary.max_top18_feet,
        summary.max_top30_feet,
        summary.max_top50_feet,
        summary.max_top60_feet,
    ] {
        put_u16(&mut header, value);
    }
    for headers in [&input.volume_headers, &input.echo_top_headers] {
        put_u16(&mut header, u16_len(headers.len(), "header count")?);
        for (name, value) in headers {
            put_str(&mut header, name)?;
            put_str(&mut header, value)?;
        }
    }
    for (count, bytes) in &chunks {
        put_u32(&mut header, *count);
        put_u32(&mut header, u32_len(bytes.len(), "chunk")?);
    }
    let header_len = u32_len(header.len(), "header")?;
    header[8..12].copy_from_slice(&header_len.to_le_bytes());

    let mut pack = header;
    pack.reserve(data_len as usize);
    for (_, bytes) in chunks {
        pack.extend_from_slice(&bytes);
    }
    Ok(pack)
}

fn encode_chunk(
    count: usize,
    raw: &mut Vec<u8>,
    compress: &mut impl FnMut(&[u8]) -> Vec<u8>,
    encode: impl FnOnce(&mut Vec<u8>),
) -> (u32, Vec<u8>) {
    if count == 0 {
        return (0, Vec::new());
    }
    raw.clear();
    encode(raw);
    (count as u32, compress(raw))
}

/// Columnar records compress far better than interleaved ones.
fn encode_voxels(voxels: &[StoredVoxel], out: &mut Vec<u8>) {
    out.reserve(voxels.len() * VOXEL_RECORD_BYTES);
    voxels
        .iter()
        .for_each(|v| out.extend_from_slice(&v.row.to_le_bytes()));
    voxels
        .iter()
        .for_each(|v| out.extend_from_slice(&v.col.to_le_bytes()));
    voxels.iter().for_each(|v| out.push(v.level_idx));
    voxels.iter().for_each(|v| out.push(v.phase));
    voxels.iter().for_each(|v| out.push(v.surface_phase));
    voxels
        .iter()
        .for_each(|v| out.extend_from_slice(&v.dbz_tenths.to_le_bytes()));
}

fn decode_voxels(raw: &[u8], count: usize, out: &mut Vec<StoredVoxel>) {
    let (rows, rest) = raw.split_at(count * 2);
    let (cols, rest) = rest.split_at(count * 2);
    let (levels, rest) = rest.split_at(count);
    let (phases, rest) = rest.split_at(count);
    let (surface_phases, dbz) = rest.split_at(count);
    out.extend((0..count).map(|i| StoredVoxel {
        row: u16::from_le_bytes([rows[i * 2], rows[i * 2 + 1]]),
        col: u16::from_le_bytes([cols[i * 2], cols[i * 2 + 1]]),
        level_idx: levels[i],
        phase: phases[i],
        surface_phase: surface_phases[i],
        dbz_tenths: i16::from_le_bytes([dbz[i * 2], dbz[i * 2 + 1]]),
    }));
}

fn encode_echo_tops(records: &[StoredEchoTop], out: &mut Vec<u8>) {
    out.reserve(records.len() * ECHO_TOP_RECORD_BYTES);
    let columns: [fn(&StoredEchoTop) -> u16; 6] = [
        |r| r.row,
        |r| r.col,
        |r| r.top18_feet,
        |r| r.top30_feet,
        |r| r.top50_feet,
        |r| r.top60_feet,
    ];
    for column in columns {
        records
            .iter()
            .for_each(|r| out.extend_from_slice(&column(r).to_le_bytes()));
    }
}

fn decode_echo_tops(raw: &[u8], count: usize, out: &mut Vec<StoredEchoTop>) {
    let column = |c: usize, i: usize| {
        let at = (c * count + i) * 2;
        u16::from_le_bytes([raw[at], raw[at + 1]])
    };
    out.extend((0..count).map(|i| StoredEchoTop {
        row: column(0, i),
        col: column(1, i),
        top18_feet: column(2, i),
        top30_feet: column(3, i),
        top50_feet: column(4, i),
        top60_feet: column(5, i),
    }));
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ChunkEntry {
    count: u32,
    offset: u64,
    len: u32,
}

/// One contiguous byte range of the pack to fetch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ByteRange {
    pub offset: u64,
    pub len: u64,
}

/// The parsed pack header: scan metadata plus the chunk directories.
#[derive(Clone, Debug)]
pub struct ScanPackIndex {
    pub timestamp: String,
    pub generated_at_ms: i64,
    pub scan_time_ms: i64,
    pub grid: GridDef,
    pub tile_size: u16,
    pub tile_cols: u16,
    pub tile_rows: u16,
    pub level_bounds: Vec<LevelBounds>,
    pub echo_top_summary: EchoTopSummary,
    pub volume_headers: Vec<(String, String)>,
    pub echo_top_headers: Vec<(String, String)>,
    pub header_len: u32,
    /// Header plus data: the byte length of the whole pack object.
    pub total_len: u64,
    tiles: Vec<ChunkEntry>,
    bands: Vec<ChunkEntry>,
}

/// Length of a pack's header, from its first 12 bytes.
pub fn read_header_len(prefix: &[u8]) -> Result<u32, PackError> {
    if prefix.len() < 12 {
        return Err(PackError::new("pack prefix is shorter than 12 bytes"));
    }
    check_magic(prefix)?;
    Ok(u32::from_le_bytes(prefix[8..12].try_into().unwrap()))
}

fn check_magic(bytes: &[u8]) -> Result<(), PackError> {
    if bytes[0..4] != PACK_MAGIC {
        return Err(PackError::new("not a scan pack (bad magic)"));
    }
    let version = u16::from_le_bytes([bytes[4], bytes[5]]);
    if version != PACK_VERSION {
        return Err(PackError::new(format!(
            "unsupported scan pack version {version}"
        )));
    }
    if bytes[6] != PACK_CODEC_DEFLATE_RAW {
        return Err(PackError::new(format!(
            "unsupported scan pack codec {}",
            bytes[6]
        )));
    }
    Ok(())
}

impl ScanPackIndex {
    /// Parse a pack header. `bytes` must hold at least the whole header.
    pub fn parse(bytes: &[u8]) -> Result<Self, PackError> {
        let header_len = read_header_len(bytes)? as usize;
        if bytes.len() < header_len || header_len < FIXED_PREFIX_BYTES {
            return Err(PackError::new("truncated scan pack header"));
        }
        let mut r = Reader {
            bytes: &bytes[..header_len],
            at: 12,
        };
        let data_len = r.u64()?;
        let generated_at_ms = r.i64()?;
        let scan_time_ms = r.i64()?;
        let timestamp = r.string()?;
        let grid = GridDef {
            nx: r.u32()?,
            ny: r.u32()?,
            la1_deg: r.f64()?,
            lo1_deg360: r.f64()?,
            di_deg: r.f64()?,
            dj_deg: r.f64()?,
            scanning_mode: r.u8()?,
            lat_step_deg: r.f64()?,
            lon_step_deg: r.f64()?,
        };
        let tile_size = r.u16()?;
        let tile_cols = r.u16()?;
        let tile_rows = r.u16()?;
        if tile_size == 0 || tile_cols == 0 || tile_rows == 0 {
            return Err(PackError::new("scan pack has an empty tile layout"));
        }
        let level_count = r.u16()? as usize;
        let mut level_bounds = Vec::with_capacity(level_count);
        for _ in 0..level_count {
            level_bounds.push(LevelBounds {
                bottom_feet: r.u16()?,
                top_feet: r.u16()?,
            });
        }
        let echo_top_summary = EchoTopSummary {
            source_cell_count: r.u32()?,
            max_top18_feet: r.u16()?,
            max_top30_feet: r.u16()?,
            max_top50_feet: r.u16()?,
            max_top60_feet: r.u16()?,
        };
        let volume_headers = r.headers()?;
        let echo_top_headers = r.headers()?;

        let mut offset = header_len as u64;
        let mut directory = |count: usize| -> Result<Vec<ChunkEntry>, PackError> {
            let mut entries = Vec::with_capacity(count);
            for _ in 0..count {
                let entry = ChunkEntry {
                    count: r.u32()?,
                    offset,
                    len: r.u32()?,
                };
                if (entry.count == 0) != (entry.len == 0) {
                    return Err(PackError::new("scan pack chunk has records but no bytes"));
                }
                offset += entry.len as u64;
                entries.push(entry);
            }
            Ok(entries)
        };
        let tiles = directory(tile_cols as usize * tile_rows as usize)?;
        let bands = directory(tile_rows as usize)?;
        if r.at != header_len {
            return Err(PackError::new("scan pack header has trailing bytes"));
        }
        if offset != header_len as u64 + data_len {
            return Err(PackError::new(
                "scan pack directory does not match its data length",
            ));
        }
        Ok(Self {
            timestamp,
            generated_at_ms,
            scan_time_ms,
            grid,
            tile_size,
            tile_cols,
            tile_rows,
            level_bounds,
            echo_top_summary,
            volume_headers,
            echo_top_headers,
            header_len: header_len as u32,
            total_len: offset,
            tiles,
            bands,
        })
    }

    /// The query window of this scan for a normalized query.
    pub fn query_window(
        &self,
        origin_lat: f64,
        origin_lon: f64,
        min_dbz: f64,
        max_range_nm: f64,
    ) -> QueryWindow {
        build_query_window_for_grid(
            &self.grid,
            self.tile_size,
            self.tile_cols,
            origin_lat,
            origin_lon,
            min_dbz,
            max_range_nm,
        )
    }

    fn tile(&self, tile_row: u32, tile_col: u32) -> ChunkEntry {
        self.tiles[(tile_row * self.tile_cols as u32 + tile_col) as usize]
    }

    /// Ranges to fetch for a volume query, in the order `decode_volume` expects:
    /// one per tile row of the window that holds any voxels.
    pub fn volume_ranges(&self, window: &QueryWindow) -> Vec<ByteRange> {
        (window.tile_row_start..=window.tile_row_end)
            .filter_map(|tile_row| {
                let first = self.tile(tile_row, window.tile_col_start);
                let last = self.tile(tile_row, window.tile_col_end);
                let end = last.offset + last.len as u64;
                (end > first.offset).then_some(ByteRange {
                    offset: first.offset,
                    len: end - first.offset,
                })
            })
            .collect()
    }

    /// Voxels stored in the window's tiles: what a volume query decodes, and
    /// what its memory scales with.
    pub fn volume_voxel_count(&self, window: &QueryWindow) -> u64 {
        window
            .tile_indices(self.tile_cols)
            .map(|tile_idx| self.tiles[tile_idx].count as u64)
            .sum()
    }

    /// The single range holding the echo-top bands of the window's tile rows,
    /// or `None` when those bands are empty.
    pub fn echo_top_range(&self, window: &QueryWindow) -> Option<ByteRange> {
        let first = self.bands[window.tile_row_start as usize];
        let last = self.bands[window.tile_row_end as usize];
        let end = last.offset + last.len as u64;
        (end > first.offset).then_some(ByteRange {
            offset: first.offset,
            len: end - first.offset,
        })
    }

    /// Build the AVMR v5 payload of `window` from `data`, the concatenation
    /// of [`volume_ranges`](Self::volume_ranges) in order.
    pub fn build_volume(&self, window: &QueryWindow, data: &[u8]) -> Result<Vec<u8>, PackError> {
        Ok(self.collect_volume(window, data)?.finish())
    }

    /// Decode the window's tiles one at a time straight into a brick
    /// collector. `data` is no longer needed once this returns, so a caller
    /// that owns it can free it before [`VolumeCollector::finish`].
    pub fn collect_volume<'a>(
        &'a self,
        window: &'a QueryWindow,
        data: &[u8],
    ) -> Result<VolumeCollector<'a, Self>, PackError> {
        let expected: u64 = self
            .volume_ranges(window)
            .iter()
            .map(|range| range.len)
            .sum();
        if data.len() as u64 != expected {
            return Err(PackError::new(format!(
                "volume data is {} bytes, expected {expected}",
                data.len()
            )));
        }
        let mut collector = VolumeCollector::new(self, window);
        let mut voxels = Vec::new();
        let mut raw = Vec::new();
        let tile_size = self.tile_size as u32;
        let mut cursor = 0_usize;
        for tile_idx in window.tile_indices(self.tile_cols) {
            let entry = self.tiles[tile_idx];
            let bytes = take(data, &mut cursor, entry.len as usize)?;
            if entry.count == 0 {
                continue;
            }
            let count = entry.count as usize;
            inflate_into(bytes, count * VOXEL_RECORD_BYTES, &mut raw)?;
            voxels.clear();
            decode_voxels(&raw, count, &mut voxels);
            let (tile_row, tile_col) = (
                (tile_idx / self.tile_cols as usize) as u32,
                (tile_idx % self.tile_cols as usize) as u32,
            );
            if voxels.iter().any(|voxel| {
                voxel.row as u32 / tile_size != tile_row || voxel.col as u32 / tile_size != tile_col
            }) {
                return Err(PackError::new(format!(
                    "tile ({tile_row}, {tile_col}) holds a voxel of another tile"
                )));
            }
            collector.add_voxels(&voxels);
        }
        Ok(collector)
    }

    /// Decode the echo tops of the window's tile rows from `data`, the bytes
    /// of [`echo_top_range`](Self::echo_top_range) (empty when it is `None`).
    pub fn decode_echo_tops(
        &self,
        window: &QueryWindow,
        data: &[u8],
    ) -> Result<Vec<StoredEchoTop>, PackError> {
        let expected = self.echo_top_range(window).map_or(0, |range| range.len);
        if data.len() as u64 != expected {
            return Err(PackError::new(format!(
                "echo-top data is {} bytes, expected {expected}",
                data.len()
            )));
        }
        let tile_size = self.tile_size as u32;
        let mut echo_tops = Vec::new();
        let mut raw = Vec::new();
        let mut cursor = 0_usize;
        for tile_row in window.tile_row_start..=window.tile_row_end {
            let entry = self.bands[tile_row as usize];
            let bytes = take(data, &mut cursor, entry.len as usize)?;
            if entry.count == 0 {
                continue;
            }
            let count = entry.count as usize;
            let first = echo_tops.len();
            inflate_into(bytes, count * ECHO_TOP_RECORD_BYTES, &mut raw)?;
            decode_echo_tops(&raw, count, &mut echo_tops);
            if echo_tops[first..]
                .iter()
                .any(|record| record.row as u32 / tile_size != tile_row)
            {
                return Err(PackError::new(format!(
                    "echo-top band {tile_row} holds a record of another row"
                )));
            }
        }
        Ok(echo_tops)
    }

    /// Build the AVET v3 payload of `window` from the bytes of
    /// [`echo_top_range`](Self::echo_top_range).
    pub fn build_echo_tops(&self, window: &QueryWindow, data: &[u8]) -> Result<Vec<u8>, PackError> {
        let records = self.decode_echo_tops(window, data)?;
        Ok(build_echo_top_wire_fb(self, window, &records))
    }
}

impl ScanMeta for ScanPackIndex {
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
        self.echo_top_summary
    }
}

fn take<'a>(data: &'a [u8], cursor: &mut usize, len: usize) -> Result<&'a [u8], PackError> {
    let end = *cursor + len;
    let bytes = data
        .get(*cursor..end)
        .ok_or_else(|| PackError::new("pack data ended inside a chunk"))?;
    *cursor = end;
    Ok(bytes)
}

/// Inflate one chunk into `out` (reused across chunks), requiring exactly
/// `expected_len` bytes.
fn inflate_into(
    compressed: &[u8],
    expected_len: usize,
    out: &mut Vec<u8>,
) -> Result<(), PackError> {
    use miniz_oxide::inflate::core::{decompress, inflate_flags, DecompressorOxide};
    use miniz_oxide::inflate::TINFLStatus;

    out.clear();
    out.resize(expected_len, 0);
    let mut decompressor = DecompressorOxide::new();
    let (status, consumed, written) = decompress(
        &mut decompressor,
        compressed,
        out,
        0,
        inflate_flags::TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF,
    );
    if status != TINFLStatus::Done || consumed != compressed.len() || written != expected_len {
        return Err(PackError::new(format!(
            "chunk inflate failed ({status:?}): {written} of {expected_len} bytes from \
             {consumed} of {} input bytes",
            compressed.len()
        )));
    }
    Ok(())
}

fn put_u16(out: &mut Vec<u8>, value: u16) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put_u32(out: &mut Vec<u8>, value: u32) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put_u64(out: &mut Vec<u8>, value: u64) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put_i64(out: &mut Vec<u8>, value: i64) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put_f64(out: &mut Vec<u8>, value: f64) {
    out.extend_from_slice(&value.to_le_bytes());
}

fn put_str(out: &mut Vec<u8>, value: &str) -> Result<(), PackError> {
    put_u16(out, u16_len(value.len(), "string")?);
    out.extend_from_slice(value.as_bytes());
    Ok(())
}

fn u16_len(len: usize, what: &str) -> Result<u16, PackError> {
    u16::try_from(len).map_err(|_| PackError::new(format!("{what} length {len} exceeds u16")))
}

fn u32_len(len: usize, what: &str) -> Result<u32, PackError> {
    u32::try_from(len).map_err(|_| PackError::new(format!("{what} length {len} exceeds u32")))
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn take<const N: usize>(&mut self) -> Result<[u8; N], PackError> {
        let bytes = self
            .bytes
            .get(self.at..self.at + N)
            .ok_or_else(|| PackError::new("truncated scan pack header"))?;
        self.at += N;
        Ok(bytes.try_into().unwrap())
    }

    fn u8(&mut self) -> Result<u8, PackError> {
        Ok(self.take::<1>()?[0])
    }

    fn u16(&mut self) -> Result<u16, PackError> {
        Ok(u16::from_le_bytes(self.take()?))
    }

    fn u32(&mut self) -> Result<u32, PackError> {
        Ok(u32::from_le_bytes(self.take()?))
    }

    fn u64(&mut self) -> Result<u64, PackError> {
        Ok(u64::from_le_bytes(self.take()?))
    }

    fn i64(&mut self) -> Result<i64, PackError> {
        Ok(i64::from_le_bytes(self.take()?))
    }

    fn f64(&mut self) -> Result<f64, PackError> {
        Ok(f64::from_le_bytes(self.take()?))
    }

    fn string(&mut self) -> Result<String, PackError> {
        let len = self.u16()? as usize;
        let bytes = self
            .bytes
            .get(self.at..self.at + len)
            .ok_or_else(|| PackError::new("truncated scan pack header"))?;
        self.at += len;
        String::from_utf8(bytes.to_vec())
            .map_err(|_| PackError::new("scan pack header string is not UTF-8"))
    }

    fn headers(&mut self) -> Result<Vec<(String, String)>, PackError> {
        let count = self.u16()? as usize;
        (0..count)
            .map(|_| Ok((self.string()?, self.string()?)))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mrms_query::testkit::{sample_scan, with_voxels, TestScan};
    use crate::mrms_query::{
        build_echo_top_wire_fb, build_query_window, build_volume_wire_fb, LevelBounds,
    };

    fn deflate(raw: &[u8]) -> Vec<u8> {
        miniz_oxide::deflate::compress_to_vec(raw, 1)
    }

    fn pack_of(scan: &TestScan) -> Vec<u8> {
        write_scan_pack(
            &PackInput {
                timestamp: "20260925-034642",
                generated_at_ms: scan.generated_at_ms,
                scan_time_ms: scan.scan_time_ms,
                grid: &scan.grid,
                tile_size: scan.tile_size,
                tile_cols: scan.tile_cols,
                tile_rows: scan.tile_rows,
                level_bounds: &scan.level_bounds,
                tile_offsets: &scan.tile_offsets,
                voxels: &scan.voxels,
                echo_tops: &scan.echo_tops,
                echo_top_summary: scan.echo_top_summary,
                volume_headers: vec![
                    ("X-AV-SCAN-TIME".into(), "2023-11-14T22:13:20+00:00".into()),
                    ("X-AV-PHASE-MODE".into(), "thermo-primary".into()),
                ],
                echo_top_headers: vec![(
                    "X-AV-SCAN-TIME".into(),
                    "2023-11-14T22:13:20+00:00".into(),
                )],
            },
            deflate,
        )
        .expect("pack writes")
    }

    fn fetch(pack: &[u8], ranges: impl IntoIterator<Item = ByteRange>) -> Vec<u8> {
        ranges
            .into_iter()
            .flat_map(|range| {
                pack[range.offset as usize..(range.offset + range.len) as usize].to_vec()
            })
            .collect()
    }

    /// Voxels and echo tops scattered over all four tiles and two levels.
    fn busy_scan() -> TestScan {
        let mut scan = sample_scan();
        scan.generated_at_ms = 1_700_000_000_123;
        scan.scan_time_ms = 1_700_000_000_000;
        scan.level_bounds = vec![
            LevelBounds {
                bottom_feet: 1_000,
                top_feet: 2_000,
            },
            LevelBounds {
                bottom_feet: 2_000,
                top_feet: 3_000,
            },
        ];
        let mut voxels = Vec::new();
        for row in 0..6_u16 {
            for col in 0..8_u16 {
                for level_idx in 0..2_u8 {
                    if (row + col + level_idx as u16).is_multiple_of(3) {
                        continue;
                    }
                    voxels.push(StoredVoxel {
                        row,
                        col,
                        level_idx,
                        phase: (col % 3) as u8,
                        surface_phase: (row % 2) as u8,
                        dbz_tenths: 100 + (row * 37 + col * 11) as i16,
                    });
                }
            }
        }
        scan.echo_tops = (0..6_u16)
            .flat_map(|row| {
                (0..8_u16).step_by(3).map(move |col| StoredEchoTop {
                    row,
                    col,
                    top18_feet: 10_000 + row * 100,
                    top30_feet: col * 10,
                    top50_feet: 0,
                    top60_feet: 0,
                })
            })
            .collect();
        scan.echo_top_summary = EchoTopSummary {
            source_cell_count: scan.echo_tops.len() as u32,
            max_top18_feet: 10_500,
            ..EchoTopSummary::default()
        };
        with_voxels(scan, voxels)
    }

    #[test]
    fn pack_queries_match_the_snapshot_byte_for_byte() {
        let scan = busy_scan();
        let pack = pack_of(&scan);
        let index = ScanPackIndex::parse(&pack[..read_header_len(&pack).unwrap() as usize])
            .expect("header parses");
        assert_eq!(index.total_len, pack.len() as u64);
        assert_eq!(index.volume_headers.len(), 2);
        assert_eq!(index.echo_top_headers[0].0, "X-AV-SCAN-TIME");

        for (lat, lon, min_dbz, range) in [
            (35.15, -109.80, 5.0, 40.0),
            (35.05, -109.95, 12.0, 4.0),
            (35.25, -109.65, 5.0, 3.0),
            (20.0, -60.0, 5.0, 30.0),
        ] {
            let window = build_query_window(&scan, lat, lon, min_dbz, range);
            let expected_volume = build_volume_wire_fb(&scan, &window);
            let expected_echo = build_echo_top_wire_fb(&scan, &window, &scan.echo_tops);

            let pack_window = index.query_window(lat, lon, min_dbz, range);
            let volume_data = fetch(&pack, index.volume_ranges(&pack_window));
            let volume = index
                .build_volume(&pack_window, &volume_data)
                .expect("decodes");
            assert_eq!(volume, expected_volume);

            let echo_data = fetch(&pack, index.echo_top_range(&pack_window));
            let echo = index
                .build_echo_tops(&pack_window, &echo_data)
                .expect("decodes");
            assert_eq!(echo, expected_echo);
        }
    }

    #[test]
    fn corrupt_or_short_data_fails_loudly() {
        let scan = busy_scan();
        let mut pack = pack_of(&scan);
        let header_len = read_header_len(&pack).unwrap() as usize;
        let index = ScanPackIndex::parse(&pack[..header_len]).unwrap();
        let window = index.query_window(35.15, -109.80, 5.0, 40.0);
        let data = fetch(&pack, index.volume_ranges(&window));
        assert!(
            index.build_volume(&window, &data[1..]).is_err(),
            "short data"
        );
        let mut garbled = data.clone();
        garbled.iter_mut().for_each(|byte| *byte ^= 0x5a);
        assert!(
            index.build_volume(&window, &garbled).is_err(),
            "garbled data"
        );

        assert!(
            ScanPackIndex::parse(&pack[..header_len - 1]).is_err(),
            "truncated header"
        );
        pack[4] = 9;
        assert!(ScanPackIndex::parse(&pack).is_err(), "unknown version");
    }

    /// The weather edge Worker's tests (services/weather-edge/test) serve this
    /// pack and compare against payloads built from the in-memory scan.
    /// Regenerate after a format change with `UPDATE_EDGE_FIXTURES=1`.
    #[test]
    fn edge_worker_fixture_is_current() {
        use crate::mrms_query::normalize_volume_query;

        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../services/weather-edge/test/fixtures");
        let scan = busy_scan();
        let pack = pack_of(&scan);
        let query = normalize_volume_query(35.15, -109.80, Some(5.0), Some(40.0)).unwrap();
        let window = build_query_window(
            &scan,
            query.lat,
            query.lon,
            query.min_dbz,
            query.max_range_nm,
        );
        let files = [
            ("sample.avsp", pack),
            ("sample-volume.avmr", build_volume_wire_fb(&scan, &window)),
            (
                "sample-echo-tops.avet",
                build_echo_top_wire_fb(&scan, &window, &scan.echo_tops),
            ),
        ];
        let update = std::env::var_os("UPDATE_EDGE_FIXTURES").is_some();
        for (name, bytes) in files {
            let path = dir.join(name);
            if update {
                std::fs::create_dir_all(&dir).unwrap();
                std::fs::write(&path, &bytes).unwrap();
            } else {
                let committed = std::fs::read(&path)
                    .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
                assert!(
                    committed == bytes,
                    "{name} is stale; rerun with UPDATE_EDGE_FIXTURES=1"
                );
            }
        }
    }

    #[test]
    fn writer_rejects_echo_tops_out_of_row_order() {
        let mut scan = busy_scan();
        scan.echo_tops.swap(0, 5);
        let result = write_scan_pack(
            &PackInput {
                timestamp: "t",
                generated_at_ms: 0,
                scan_time_ms: 0,
                grid: &scan.grid,
                tile_size: scan.tile_size,
                tile_cols: scan.tile_cols,
                tile_rows: scan.tile_rows,
                level_bounds: &scan.level_bounds,
                tile_offsets: &scan.tile_offsets,
                voxels: &scan.voxels,
                echo_tops: &scan.echo_tops,
                echo_top_summary: scan.echo_top_summary,
                volume_headers: vec![],
                echo_top_headers: vec![],
            },
            deflate,
        );
        assert!(result.is_err());
    }
}
