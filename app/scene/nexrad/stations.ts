/** WSR-88D NEXRAD radar station locations (CONUS + select OCONUS). */

export interface NexradStation {
  id: string;
  lat: number;
  lon: number;
  name: string;
}

const DEG_TO_RAD = Math.PI / 180;
const EARTH_RADIUS_NM = 3440.065;

export function distanceNm(latA: number, lonA: number, latB: number, lonB: number): number {
  const latARad = latA * DEG_TO_RAD;
  const latBRad = latB * DEG_TO_RAD;
  const dLat = latBRad - latARad;
  const dLon = (lonB - lonA) * DEG_TO_RAD;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const a = sinLat * sinLat + Math.cos(latARad) * Math.cos(latBRad) * sinLon * sinLon;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return EARTH_RADIUS_NM * c;
}

/**
 * Find the nearest NEXRAD station to a given lat/lon.
 * Returns station and distance in NM, or null if no stations.
 */
export function findNearestStation(
  lat: number,
  lon: number
): { station: NexradStation; distanceNm: number } | null {
  let best: NexradStation | null = null;
  let bestDist = Infinity;
  for (const station of NEXRAD_STATIONS) {
    const dist = distanceNm(lat, lon, station.lat, station.lon);
    if (dist < bestDist) {
      bestDist = dist;
      best = station;
    }
  }
  if (!best) return null;
  return { station: best, distanceNm: bestDist };
}

// WSR-88D station locations (FAA identifiers, WGS84 coordinates)
// Source: NOAA Radar Operations Center
export const NEXRAD_STATIONS: NexradStation[] = [
  { id: 'KABR', lat: 45.4558, lon: -98.4131, name: 'Aberdeen, SD' },
  { id: 'KABX', lat: 35.1497, lon: -106.824, name: 'Albuquerque, NM' },
  { id: 'KAKQ', lat: 36.9839, lon: -77.0078, name: 'Wakefield, VA' },
  { id: 'KAMA', lat: 35.2333, lon: -101.709, name: 'Amarillo, TX' },
  { id: 'KAMX', lat: 25.6111, lon: -80.4131, name: 'Miami, FL' },
  { id: 'KAPX', lat: 44.9072, lon: -84.72, name: 'Gaylord, MI' },
  { id: 'KARX', lat: 43.8228, lon: -91.1911, name: 'La Crosse, WI' },
  { id: 'KATX', lat: 48.1947, lon: -122.496, name: 'Seattle/Tacoma, WA' },
  { id: 'KBBX', lat: 39.4961, lon: -121.632, name: 'Beale AFB, CA' },
  { id: 'KBGM', lat: 42.1997, lon: -75.985, name: 'Binghamton, NY' },
  { id: 'KBHX', lat: 40.4986, lon: -124.292, name: 'Eureka, CA' },
  { id: 'KBIS', lat: 46.7708, lon: -100.76, name: 'Bismarck, ND' },
  { id: 'KBLX', lat: 45.8537, lon: -108.607, name: 'Billings, MT' },
  { id: 'KBMX', lat: 33.1722, lon: -86.7697, name: 'Birmingham, AL' },
  { id: 'KBOX', lat: 41.9556, lon: -71.1369, name: 'Boston, MA' },
  { id: 'KBRO', lat: 25.9161, lon: -97.4189, name: 'Brownsville, TX' },
  { id: 'KBUF', lat: 42.9489, lon: -78.7369, name: 'Buffalo, NY' },
  { id: 'KBYX', lat: 24.5975, lon: -81.7033, name: 'Key West, FL' },
  { id: 'KCAE', lat: 33.9486, lon: -81.1183, name: 'Columbia, SC' },
  { id: 'KCBW', lat: 46.0392, lon: -67.8067, name: 'Caribou, ME' },
  { id: 'KCBX', lat: 43.4908, lon: -116.236, name: 'Boise, ID' },
  { id: 'KCCX', lat: 40.9228, lon: -78.0039, name: 'State College, PA' },
  { id: 'KCLE', lat: 41.4131, lon: -81.86, name: 'Cleveland, OH' },
  { id: 'KCLX', lat: 32.6556, lon: -81.0422, name: 'Charleston, SC' },
  { id: 'KCRP', lat: 27.7839, lon: -97.5111, name: 'Corpus Christi, TX' },
  { id: 'KCXX', lat: 44.5111, lon: -73.1667, name: 'Burlington, VT' },
  { id: 'KCYS', lat: 41.1519, lon: -104.806, name: 'Cheyenne, WY' },
  { id: 'KDAX', lat: 38.5011, lon: -121.678, name: 'Sacramento, CA' },
  { id: 'KDDC', lat: 37.7608, lon: -99.9686, name: 'Dodge City, KS' },
  { id: 'KDFX', lat: 29.2728, lon: -100.281, name: 'Laughlin AFB, TX' },
  { id: 'KDGX', lat: 32.28, lon: -89.9844, name: 'Brandon, MS' },
  { id: 'KDIX', lat: 39.9469, lon: -74.4108, name: 'Philadelphia, PA' },
  { id: 'KDLH', lat: 46.8369, lon: -92.21, name: 'Duluth, MN' },
  { id: 'KDMX', lat: 41.7311, lon: -93.7228, name: 'Des Moines, IA' },
  { id: 'KDOX', lat: 38.8256, lon: -75.44, name: 'Dover AFB, DE' },
  { id: 'KDTX', lat: 42.6997, lon: -83.4717, name: 'Detroit, MI' },
  { id: 'KDVN', lat: 41.6117, lon: -90.5808, name: 'Davenport, IA' },
  { id: 'KDYX', lat: 32.5386, lon: -99.2542, name: 'Dyess AFB, TX' },
  { id: 'KEAX', lat: 38.8103, lon: -94.2644, name: 'Kansas City, MO' },
  { id: 'KEMX', lat: 31.8936, lon: -110.63, name: 'Tucson, AZ' },
  { id: 'KENX', lat: 42.5864, lon: -74.0639, name: 'Albany, NY' },
  { id: 'KEOX', lat: 31.4606, lon: -85.4592, name: 'Fort Rucker, AL' },
  { id: 'KEPZ', lat: 31.8731, lon: -106.698, name: 'El Paso, TX' },
  { id: 'KESX', lat: 35.7011, lon: -114.892, name: 'Las Vegas, NV' },
  { id: 'KEVX', lat: 30.5644, lon: -85.9214, name: 'Eglin AFB, FL' },
  { id: 'KEWX', lat: 29.7039, lon: -98.0283, name: 'Austin/San Antonio, TX' },
  { id: 'KEYX', lat: 35.0978, lon: -117.561, name: 'Edwards AFB, CA' },
  { id: 'KFCX', lat: 37.0244, lon: -80.2742, name: 'Roanoke, VA' },
  { id: 'KFDR', lat: 34.3622, lon: -98.9764, name: 'Frederick, OK' },
  { id: 'KFDX', lat: 34.6353, lon: -103.63, name: 'Cannon AFB, NM' },
  { id: 'KFFC', lat: 33.3636, lon: -84.5658, name: 'Atlanta, GA' },
  { id: 'KFSD', lat: 43.5878, lon: -96.7292, name: 'Sioux Falls, SD' },
  { id: 'KFSX', lat: 34.5744, lon: -111.198, name: 'Flagstaff, AZ' },
  { id: 'KFTG', lat: 39.7867, lon: -104.546, name: 'Denver, CO' },
  { id: 'KFWS', lat: 32.5728, lon: -97.3033, name: 'Dallas/Fort Worth, TX' },
  { id: 'KGGW', lat: 48.2064, lon: -106.625, name: 'Glasgow, MT' },
  { id: 'KGJX', lat: 39.0622, lon: -108.214, name: 'Grand Junction, CO' },
  { id: 'KGLD', lat: 39.3667, lon: -101.7, name: 'Goodland, KS' },
  { id: 'KGRB', lat: 44.4986, lon: -88.1111, name: 'Green Bay, WI' },
  { id: 'KGRK', lat: 30.7217, lon: -97.3831, name: 'Fort Hood, TX' },
  { id: 'KGRR', lat: 42.8939, lon: -85.5447, name: 'Grand Rapids, MI' },
  { id: 'KGSP', lat: 34.8833, lon: -82.2194, name: 'Greenville/Spartanburg, SC' },
  { id: 'KGWX', lat: 33.8967, lon: -88.3292, name: 'Columbus AFB, MS' },
  { id: 'KGYX', lat: 43.8914, lon: -70.2564, name: 'Portland, ME' },
  { id: 'KHDX', lat: 33.0769, lon: -106.12, name: 'Holloman AFB, NM' },
  { id: 'KHGX', lat: 29.4719, lon: -95.0792, name: 'Houston, TX' },
  { id: 'KHNX', lat: 36.3142, lon: -119.632, name: 'Hanford, CA' },
  { id: 'KHPX', lat: 36.7367, lon: -87.285, name: 'Fort Campbell, KY' },
  { id: 'KHTX', lat: 34.9306, lon: -86.0833, name: 'Huntsville, AL' },
  { id: 'KICT', lat: 37.6544, lon: -97.4428, name: 'Wichita, KS' },
  { id: 'KICX', lat: 37.5908, lon: -112.862, name: 'Cedar City, UT' },
  { id: 'KILN', lat: 39.4203, lon: -83.8217, name: 'Wilmington, OH' },
  { id: 'KILX', lat: 40.1506, lon: -89.3369, name: 'Lincoln, IL' },
  { id: 'KIND', lat: 39.7075, lon: -86.2803, name: 'Indianapolis, IN' },
  { id: 'KINX', lat: 36.175, lon: -95.5647, name: 'Tulsa, OK' },
  { id: 'KIWA', lat: 33.2892, lon: -111.67, name: 'Phoenix, AZ' },
  { id: 'KIWX', lat: 41.3586, lon: -85.7, name: 'Fort Wayne, IN' },
  { id: 'KJAX', lat: 30.485, lon: -81.7019, name: 'Jacksonville, FL' },
  { id: 'KJGX', lat: 32.675, lon: -83.3511, name: 'Robins AFB, GA' },
  { id: 'KJKL', lat: 37.5908, lon: -83.3131, name: 'Jackson, KY' },
  { id: 'KLBB', lat: 33.6542, lon: -101.814, name: 'Lubbock, TX' },
  { id: 'KLCH', lat: 30.125, lon: -93.2156, name: 'Lake Charles, LA' },
  { id: 'KLIX', lat: 30.3367, lon: -89.8256, name: 'New Orleans, LA' },
  { id: 'KLNX', lat: 41.9578, lon: -100.576, name: 'North Platte, NE' },
  { id: 'KLOT', lat: 41.6044, lon: -88.0847, name: 'Chicago, IL' },
  { id: 'KLRX', lat: 40.7397, lon: -116.803, name: 'Elko, NV' },
  { id: 'KLSX', lat: 38.6986, lon: -90.6828, name: 'St. Louis, MO' },
  { id: 'KLTX', lat: 33.9892, lon: -78.4292, name: 'Wilmington, NC' },
  { id: 'KLVX', lat: 37.975, lon: -85.9439, name: 'Louisville, KY' },
  { id: 'KLWX', lat: 38.9753, lon: -77.4778, name: 'Sterling, VA' },
  { id: 'KLZK', lat: 34.8364, lon: -92.2622, name: 'Little Rock, AR' },
  { id: 'KMAF', lat: 31.9433, lon: -102.189, name: 'Midland/Odessa, TX' },
  { id: 'KMAX', lat: 42.0811, lon: -122.717, name: 'Medford, OR' },
  { id: 'KMBX', lat: 48.3925, lon: -100.864, name: 'Minot AFB, ND' },
  { id: 'KMHX', lat: 34.7761, lon: -76.8764, name: 'Morehead City, NC' },
  { id: 'KMKX', lat: 42.9678, lon: -88.5506, name: 'Milwaukee, WI' },
  { id: 'KMLB', lat: 28.1131, lon: -80.6539, name: 'Melbourne, FL' },
  { id: 'KMOB', lat: 30.6794, lon: -88.2397, name: 'Mobile, AL' },
  { id: 'KMPX', lat: 44.8489, lon: -93.5656, name: 'Minneapolis, MN' },
  { id: 'KMQT', lat: 46.5311, lon: -87.5483, name: 'Marquette, MI' },
  { id: 'KMRX', lat: 36.1686, lon: -83.4017, name: 'Knoxville, TN' },
  { id: 'KMSX', lat: 47.0411, lon: -113.986, name: 'Missoula, MT' },
  { id: 'KMTX', lat: 41.2628, lon: -112.448, name: 'Salt Lake City, UT' },
  { id: 'KMUX', lat: 37.155, lon: -121.898, name: 'San Francisco, CA' },
  { id: 'KMVX', lat: 47.5281, lon: -97.3256, name: 'Grand Forks, ND' },
  { id: 'KMXX', lat: 32.5367, lon: -85.7897, name: 'Maxwell AFB, AL' },
  { id: 'KNKX', lat: 32.9189, lon: -117.042, name: 'San Diego, CA' },
  { id: 'KNQA', lat: 35.3447, lon: -89.8733, name: 'Memphis, TN' },
  { id: 'KOAX', lat: 41.3203, lon: -96.3667, name: 'Omaha, NE' },
  { id: 'KOHX', lat: 36.2472, lon: -86.5625, name: 'Nashville, TN' },
  { id: 'KOKX', lat: 40.8656, lon: -72.8639, name: 'New York City, NY' },
  { id: 'KOTX', lat: 47.6806, lon: -117.627, name: 'Spokane, WA' },
  { id: 'KPAH', lat: 37.0683, lon: -88.7719, name: 'Paducah, KY' },
  { id: 'KPBZ', lat: 40.5317, lon: -80.0183, name: 'Pittsburgh, PA' },
  { id: 'KPDT', lat: 45.6906, lon: -118.853, name: 'Pendleton, OR' },
  { id: 'KPOE', lat: 31.1556, lon: -92.9764, name: 'Fort Polk, LA' },
  { id: 'KPUX', lat: 38.4594, lon: -104.182, name: 'Pueblo, CO' },
  { id: 'KRAX', lat: 35.6653, lon: -78.49, name: 'Raleigh/Durham, NC' },
  { id: 'KRGX', lat: 39.7542, lon: -119.462, name: 'Reno, NV' },
  { id: 'KRIW', lat: 43.0661, lon: -108.477, name: 'Riverton, WY' },
  { id: 'KRLX', lat: 38.3111, lon: -81.7228, name: 'Charleston, WV' },
  { id: 'KRTX', lat: 45.715, lon: -122.965, name: 'Portland, OR' },
  { id: 'KSFX', lat: 43.1058, lon: -112.686, name: 'Pocatello, ID' },
  { id: 'KSGF', lat: 37.235, lon: -93.4006, name: 'Springfield, MO' },
  { id: 'KSHV', lat: 32.4508, lon: -93.8414, name: 'Shreveport, LA' },
  { id: 'KSJT', lat: 31.3711, lon: -100.493, name: 'San Angelo, TX' },
  { id: 'KSOX', lat: 33.8178, lon: -117.636, name: 'Santa Ana Mtns, CA' },
  { id: 'KSRX', lat: 35.2906, lon: -94.3622, name: 'Fort Smith, AR' },
  { id: 'KTBW', lat: 27.7056, lon: -82.4017, name: 'Tampa Bay, FL' },
  { id: 'KTFX', lat: 47.4597, lon: -111.385, name: 'Great Falls, MT' },
  { id: 'KTLH', lat: 30.3975, lon: -84.3289, name: 'Tallahassee, FL' },
  { id: 'KTLX', lat: 35.3331, lon: -97.2778, name: 'Oklahoma City, OK' },
  { id: 'KTWX', lat: 38.9967, lon: -96.2325, name: 'Topeka, KS' },
  { id: 'KTYX', lat: 43.7556, lon: -75.68, name: 'Fort Drum, NY' },
  { id: 'KUDX', lat: 44.125, lon: -102.83, name: 'Rapid City, SD' },
  { id: 'KUEX', lat: 40.3208, lon: -98.4419, name: 'Hastings, NE' },
  { id: 'KVAX', lat: 30.8903, lon: -83.0019, name: 'Moody AFB, GA' },
  { id: 'KVBX', lat: 34.8383, lon: -120.398, name: 'Vandenberg AFB, CA' },
  { id: 'KVNX', lat: 36.7408, lon: -98.1278, name: 'Vance AFB, OK' },
  { id: 'KVTX', lat: 34.4117, lon: -119.179, name: 'Los Angeles, CA' },
  { id: 'KVWX', lat: 38.2603, lon: -87.7247, name: 'Evansville, IN' },
  { id: 'KYUX', lat: 32.4953, lon: -114.656, name: 'Yuma, AZ' },
  // Alaska
  { id: 'PABC', lat: 60.7919, lon: -161.876, name: 'Bethel, AK' },
  { id: 'PACG', lat: 56.8525, lon: -135.529, name: 'Sitka, AK' },
  { id: 'PAEC', lat: 64.5114, lon: -165.295, name: 'Nome, AK' },
  { id: 'PAHG', lat: 60.7258, lon: -151.351, name: 'Kenai, AK' },
  { id: 'PAIH', lat: 59.4614, lon: -146.303, name: 'Middleton Island, AK' },
  { id: 'PAKC', lat: 58.6794, lon: -156.629, name: 'King Salmon, AK' },
  { id: 'PAPD', lat: 65.0356, lon: -147.502, name: 'Fairbanks, AK' },
  // Hawaii
  { id: 'PHKI', lat: 21.8942, lon: -159.552, name: 'South Kauai, HI' },
  { id: 'PHKM', lat: 20.1253, lon: -155.778, name: 'Kamuela, HI' },
  { id: 'PHMO', lat: 21.1328, lon: -157.18, name: 'Molokai, HI' },
  { id: 'PHWA', lat: 19.095, lon: -155.569, name: 'South Hawaii, HI' },
  // Puerto Rico / US territories
  { id: 'TJUA', lat: 18.1156, lon: -66.0781, name: 'San Juan, PR' },
  { id: 'PGUA', lat: 13.455, lon: 144.811, name: 'Andersen AFB, GU' }
];
