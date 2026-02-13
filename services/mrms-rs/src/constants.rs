pub const MRMS_BUCKET_URL: &str = "https://noaa-mrms-pds.s3.amazonaws.com";
pub const MRMS_CONUS_PREFIX: &str = "CONUS";
pub const MRMS_PRODUCT_PREFIX: &str = "MergedReflectivityQC";
pub const MRMS_BASE_LEVEL_TAG: &str = "00.50";
pub const MRMS_ZDR_PRODUCT_PREFIX: &str = "MergedZdr";
pub const MRMS_RHOHV_PRODUCT_PREFIX: &str = "MergedRhoHV";
pub const MRMS_PRECIP_FLAG_PRODUCT: &str = "PrecipFlag_00.00";
pub const MRMS_MODEL_FREEZING_HEIGHT_PRODUCT: &str = "Model_0degC_Height_00.50";
pub const MRMS_MODEL_WET_BULB_TEMP_PRODUCT: &str = "Model_WetBulbTemp_00.50";
pub const MRMS_MODEL_SURFACE_TEMP_PRODUCT: &str = "Model_SurfaceTemp_00.50";
pub const MRMS_BRIGHT_BAND_TOP_PRODUCT: &str = "BrightBandTopHeight_00.00";
pub const MRMS_BRIGHT_BAND_BOTTOM_PRODUCT: &str = "BrightBandBottomHeight_00.00";
pub const MRMS_RQI_PRODUCT: &str = "RadarQualityIndex_00.00";
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
pub const PHASE_ZDR_MIN_VALID_DB: f32 = -8.0;
pub const PHASE_ZDR_MAX_VALID_DB: f32 = 8.0;
pub const PHASE_RHOHV_MIN_VALID: f32 = 0.0;
pub const PHASE_RHOHV_MAX_VALID: f32 = 1.05;
pub const PHASE_RHOHV_LOW_CONFIDENCE_MAX: f32 = 0.94;
pub const PHASE_RHOHV_HIGH_CONFIDENCE_MIN: f32 = 0.975;
pub const PHASE_ZDR_RAIN_HIGH_CONF_MIN_DB: f32 = 0.55;
pub const PHASE_ZDR_SNOW_HIGH_CONF_MAX_DB: f32 = 0.2;
pub const FREEZING_LEVEL_TRANSITION_FEET: f64 = 1500.0;
pub const DUAL_POL_STALE_THRESHOLD_SECONDS: i64 = 300;
pub const AUX_TIMESTAMP_LOOKBACK_DAYS: i64 = 1;
pub const THERMO_NEAR_FREEZING_FEET: f64 = 1500.0;
pub const THERMO_STRONG_COLD_WET_BULB_C: f32 = -1.5;
pub const THERMO_STRONG_WARM_WET_BULB_C: f32 = 2.0;
pub const MIXED_SELECTION_MARGIN: f32 = 0.22;
pub const MIXED_SELECTION_MARGIN_TRANSITION: f32 = 0.08;
pub const MIXED_COMPETING_RAIN_SNOW_MIN_SCORE: f32 = 1.7;
pub const MIXED_COMPETING_RAIN_SNOW_DELTA_MAX: f32 = 1.4;
pub const MIXED_COMPETING_PROMOTION_MIN_SCORE: f32 = 2.4;
pub const MIXED_COMPETING_PROMOTION_GAP_MAX: f32 = 1.6;
pub const MIXED_COMPETING_PROMOTION_MARGIN: f32 = 0.14;
pub const MIXED_DUAL_SUPPORT_CONFIDENCE_MIN: f32 = 0.5;

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
pub const MAX_BASE_KEYS_LOOKUP: usize = 120;
pub const MAX_BASE_DAY_LOOKBACK: i64 = 1;

pub const WIRE_MAGIC: [u8; 4] = *b"AVMR";
pub const WIRE_V2_VERSION: u16 = 2;
pub const WIRE_HEADER_BYTES: usize = 64;
pub const WIRE_V2_RECORD_BYTES: usize = 20;
pub const WIRE_V2_DBZ_QUANT_STEP_TENTHS: i16 = 50;
pub const WIRE_V2_MAX_SPAN_LOW_DBZ: u16 = 48;
pub const WIRE_V2_MAX_SPAN_HIGH_DBZ: u16 = 20;
pub const WIRE_V2_MAX_VERTICAL_SPAN: u16 = 4;

pub const SNAPSHOT_MAGIC: [u8; 4] = *b"AVSN";
pub const SNAPSHOT_VERSION: u16 = 1;
