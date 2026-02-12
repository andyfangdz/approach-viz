pub const MRMS_BUCKET_URL: &str = "https://noaa-mrms-pds.s3.amazonaws.com";
pub const MRMS_CONUS_PREFIX: &str = "CONUS";
pub const MRMS_PRODUCT_PREFIX: &str = "MergedReflectivityQC";
pub const MRMS_BASE_LEVEL_TAG: &str = "00.50";
pub const MRMS_PRECIP_FLAG_PRODUCT: &str = "PrecipFlag_00.00";
pub const MRMS_MODEL_FREEZING_HEIGHT_PRODUCT: &str = "Model_0degC_Height_00.50";
pub const LEVEL_TAGS: [&str; 33] = [
    "00.50", "00.75", "01.00", "01.25", "01.50", "01.75", "02.00", "02.25", "02.50", "02.75",
    "03.00", "03.50", "04.00", "04.50", "05.00", "05.50", "06.00", "06.50", "07.00", "07.50",
    "08.00", "08.50", "09.00", "10.00", "11.00", "12.00", "13.00", "14.00", "15.00", "16.00",
    "17.00", "18.00", "19.00",
];

pub const FEET_PER_KM: f64 = 3280.84;
pub const FEET_PER_METER: f64 = 3.28084;
pub const METERS_TO_NM: f64 = 1.0 / 1852.0;
pub const DEG_TO_RAD: f64 = std::f64::consts::PI / 180.0;
pub const WGS84_SEMI_MAJOR_METERS: f64 = 6_378_137.0;
pub const WGS84_FLATTENING: f64 = 1.0 / 298.257_223_563;
pub const WGS84_E2: f64 = WGS84_FLATTENING * (2.0 - WGS84_FLATTENING);

pub const PHASE_RAIN: u8 = 0;
pub const PHASE_MIXED: u8 = 1;
pub const PHASE_SNOW: u8 = 2;
pub const FREEZING_LEVEL_TRANSITION_FEET: f64 = 1500.0;

pub const DEFAULT_MIN_DBZ: f64 = 5.0;
pub const DEFAULT_MAX_RANGE_NM: f64 = 120.0;
pub const MIN_ALLOWED_DBZ: f64 = 5.0;
pub const MAX_ALLOWED_DBZ: f64 = 60.0;
pub const MIN_ALLOWED_RANGE_NM: f64 = 30.0;
pub const MAX_ALLOWED_RANGE_NM: f64 = 220.0;

pub const DEFAULT_TILE_SIZE: u16 = 64;
pub const DEFAULT_RETENTION_BYTES: u64 = 5 * 1024 * 1024 * 1024;
pub const DEFAULT_REQUEST_TIMEOUT_SECONDS: u64 = 10;
pub const DEFAULT_BOOTSTRAP_INTERVAL_SECONDS: u64 = 300;
pub const DEFAULT_SQS_POLL_DELAY_SECONDS: u64 = 3;
pub const DEFAULT_PENDING_RETRY_SECONDS: u64 = 30;
pub const MAX_PENDING_ATTEMPTS: u32 = 20;
pub const STORE_MIN_DBZ_TENTHS: i16 = 50;
pub const PRECIP_FLAG_STEP_SECONDS: i64 = 120;
pub const MODEL_STEP_SECONDS: i64 = 3600;
pub const MAX_BASE_KEYS_LOOKUP: usize = 8;
pub const MAX_BASE_DAY_LOOKBACK: i64 = 1;

pub const WIRE_MAGIC: [u8; 4] = *b"AVMR";
pub const WIRE_VERSION: u16 = 1;
pub const WIRE_HEADER_BYTES: usize = 64;

pub const SNAPSHOT_MAGIC: [u8; 4] = *b"AVSN";
pub const SNAPSHOT_VERSION: u16 = 1;
