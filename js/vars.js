// Catalogue of Open-Meteo historical hourly variables and unit conversions.
// kind: 'sum' (accumulated over the hour: totals add up), 'mean' (instantaneous: mean/min/max),
//       'dir' (direction in degrees: vector mean), 'code' (WMO weather code: most severe).

export const FAMILIES = {
  precip:   { label: 'Rain / precipitation', base: 'mm',   def: 'mm',   units: ['mm', 'cm', 'in'] },
  snow:     { label: 'Snowfall',             base: 'cm',   def: 'cm',   units: ['cm', 'mm', 'in'] },
  depth:    { label: 'Snow depth',           base: 'm',    def: 'cm',   units: ['cm', 'm', 'in'] },
  temp:     { label: 'Temperature',          base: '°C',   def: '°C',   units: ['°C', '°F'] },
  speed:    { label: 'Wind speed',           base: 'km/h', def: 'km/h', units: ['km/h', 'm/s', 'mph', 'kn'] },
  pressure: { label: 'Pressure',             base: 'hPa',  def: 'hPa',  units: ['hPa', 'kPa', 'mmHg', 'inHg'] },
  duration: { label: 'Sunshine',             base: 's',    def: 'h',    units: ['h', 'min'] },
  height:   { label: 'Height',               base: 'm',    def: 'm',    units: ['m', 'ft'] },
};

const FACTORS = {
  mm: { mm: 1, cm: 0.1, in: 1 / 25.4 },
  cm: { cm: 1, mm: 10, in: 1 / 2.54 },
  m: { m: 1, cm: 100, in: 39.3701, ft: 3.28084 },
  'km/h': { 'km/h': 1, 'm/s': 1 / 3.6, mph: 0.621371, kn: 0.539957 },
  hPa: { hPa: 1, kPa: 0.1, mmHg: 0.750062, inHg: 0.0295300 },
  s: { h: 1 / 3600, min: 1 / 60 },
};

export function convert(v, base, unit) {
  if (v == null || base === unit) return v;
  if (base === '°C' && unit === '°F') return v * 9 / 5 + 32;
  const f = FACTORS[base]?.[unit];
  return f == null ? v : v * f;
}

// Decimal places to show for a unit.
export function decimals(unit) {
  if (['in', 'inHg', 'm/s', 'cm', 'kPa', 'h'].includes(unit)) return 2;
  if (['mm', '°C', '°F', 'km/h', 'mph', 'kn', 'hPa', 'mmHg', 'min', 'kg/m²'].includes(unit)) return 1;
  if (unit === 'm³/m³') return 3;
  return 0;
}

// [key, label, category, kind, family-or-fixed-unit]
const RAW = [
  ['rain', 'Rain', 'Precipitation', 'sum', 'precip'],
  ['precipitation', 'Precipitation (rain + showers + snow)', 'Precipitation', 'sum', 'precip'],
  ['snowfall', 'Snowfall', 'Precipitation', 'sum', 'snow'],
  ['snow_depth', 'Snow depth', 'Precipitation', 'mean', 'depth'],

  ['temperature_2m', 'Temperature (2 m)', 'Temperature & humidity', 'mean', 'temp'],
  ['apparent_temperature', 'Apparent temperature', 'Temperature & humidity', 'mean', 'temp'],
  ['dew_point_2m', 'Dew point (2 m)', 'Temperature & humidity', 'mean', 'temp'],
  ['wet_bulb_temperature_2m', 'Wet bulb temperature (2 m)', 'Temperature & humidity', 'mean', 'temp'],
  ['relative_humidity_2m', 'Relative humidity (2 m)', 'Temperature & humidity', 'mean', '%'],
  ['vapour_pressure_deficit', 'Vapour pressure deficit', 'Temperature & humidity', 'mean', 'kPa'],

  ['wind_speed_10m', 'Wind speed (10 m)', 'Wind', 'mean', 'speed'],
  ['wind_speed_100m', 'Wind speed (100 m)', 'Wind', 'mean', 'speed'],
  ['wind_gusts_10m', 'Wind gusts (10 m)', 'Wind', 'mean', 'speed'],
  ['wind_direction_10m', 'Wind direction (10 m)', 'Wind', 'dir', '°'],
  ['wind_direction_100m', 'Wind direction (100 m)', 'Wind', 'dir', '°'],

  ['pressure_msl', 'Sea level pressure', 'Pressure & clouds', 'mean', 'pressure'],
  ['surface_pressure', 'Surface pressure', 'Pressure & clouds', 'mean', 'pressure'],
  ['cloud_cover', 'Cloud cover (total)', 'Pressure & clouds', 'mean', '%'],
  ['cloud_cover_low', 'Cloud cover low', 'Pressure & clouds', 'mean', '%'],
  ['cloud_cover_mid', 'Cloud cover mid', 'Pressure & clouds', 'mean', '%'],
  ['cloud_cover_high', 'Cloud cover high', 'Pressure & clouds', 'mean', '%'],
  ['weather_code', 'Weather code (WMO)', 'Pressure & clouds', 'code', 'wmo'],
  ['total_column_integrated_water_vapour', 'Total column water vapour', 'Pressure & clouds', 'mean', 'kg/m²'],
  ['boundary_layer_height', 'Boundary layer height', 'Pressure & clouds', 'mean', 'height'],

  ['shortwave_radiation', 'Shortwave solar radiation', 'Solar radiation', 'mean', 'W/m²'],
  ['direct_radiation', 'Direct solar radiation', 'Solar radiation', 'mean', 'W/m²'],
  ['diffuse_radiation', 'Diffuse solar radiation', 'Solar radiation', 'mean', 'W/m²'],
  ['direct_normal_irradiance', 'Direct normal irradiance (DNI)', 'Solar radiation', 'mean', 'W/m²'],
  ['terrestrial_radiation', 'Terrestrial solar radiation', 'Solar radiation', 'mean', 'W/m²'],
  ['sunshine_duration', 'Sunshine duration', 'Solar radiation', 'sum', 'duration'],

  ['et0_fao_evapotranspiration', 'Reference evapotranspiration (ET₀)', 'Evapotranspiration', 'sum', 'precip'],

  ['soil_temperature_0_to_7cm', 'Soil temperature (0–7 cm)', 'Soil', 'mean', 'temp'],
  ['soil_temperature_7_to_28cm', 'Soil temperature (7–28 cm)', 'Soil', 'mean', 'temp'],
  ['soil_temperature_28_to_100cm', 'Soil temperature (28–100 cm)', 'Soil', 'mean', 'temp'],
  ['soil_temperature_100_to_255cm', 'Soil temperature (100–255 cm)', 'Soil', 'mean', 'temp'],
  ['soil_moisture_0_to_7cm', 'Soil moisture (0–7 cm)', 'Soil', 'mean', 'm³/m³'],
  ['soil_moisture_7_to_28cm', 'Soil moisture (7–28 cm)', 'Soil', 'mean', 'm³/m³'],
  ['soil_moisture_28_to_100cm', 'Soil moisture (28–100 cm)', 'Soil', 'mean', 'm³/m³'],
  ['soil_moisture_100_to_255cm', 'Soil moisture (100–255 cm)', 'Soil', 'mean', 'm³/m³'],
];

export const VARS = RAW.map(([key, label, cat, kind, fu]) => ({
  key, label, cat, kind,
  family: FAMILIES[fu] ? fu : null,
  fixedUnit: FAMILIES[fu] ? null : fu,
}));
export const VAR_BY_KEY = Object.fromEntries(VARS.map((v) => [v.key, v]));
// Always at the top of the Data tab, before "Other variables".
export const QUICK_VARS = ['rain', 'precipitation', 'snowfall', 'snow_depth', 'temperature_2m'];

export function baseUnit(v) { return v.family ? FAMILIES[v.family].base : v.fixedUnit; }
export function displayUnit(v, units) { return v.family ? (units[v.family] || FAMILIES[v.family].def) : v.fixedUnit; }
export function defaultUnits() { return Object.fromEntries(Object.entries(FAMILIES).map(([k, f]) => [k, f.def])); }

// What "best_match" actually serves (measured by comparing its values with each model):
// from 2017-01-01 00:00 UTC everything is ECMWF IFS 9 km; before that, each variable comes
// from ERA5-Land ('land'), ERA5 (default) or a derivation mixing both ('mix').
export const IFS_FROM = Date.UTC(2017, 0, 1) / 1000;
const PRE2017 = {
  temperature_2m: 'land', dew_point_2m: 'land', relative_humidity_2m: 'land', wet_bulb_temperature_2m: 'land',
  vapour_pressure_deficit: 'land', snow_depth: 'land',
  soil_temperature_0_to_7cm: 'land', soil_temperature_7_to_28cm: 'land', soil_temperature_28_to_100cm: 'land', soil_temperature_100_to_255cm: 'land',
  soil_moisture_0_to_7cm: 'land', soil_moisture_7_to_28cm: 'land', soil_moisture_28_to_100cm: 'land', soil_moisture_100_to_255cm: 'land',
  apparent_temperature: 'mix', surface_pressure: 'mix', et0_fao_evapotranspiration: 'mix', sunshine_duration: 'mix', terrestrial_radiation: 'mix',
};
export function pre2017Source(key) { return PRE2017[key] || 'era5'; }

// Archive models offered in the advanced picker.
export const MODELS = [
  { id: 'best_match', label: 'Auto (best match)', note: 'From 2017: ECMWF IFS 9 km. Before 2017: ERA5 (rain, wind, clouds, radiation…) and ERA5-Land (temperature, humidity, snow depth, soil). Recent hours missing from the archive are completed with Open-Meteo forecast data.' },
  { id: 'era5_seamless', label: 'ERA5 seamless', note: 'ERA5 + ERA5-Land, ~25 km / 9 km. Available from 1940, about 5 days behind real time.' },
  { id: 'era5', label: 'ERA5 (0.25°)', note: 'ECMWF reanalysis ~25 km, from 1940. About 5 days behind real time.' },
  { id: 'era5_land', label: 'ERA5-Land (0.1°)', note: 'Land-only reanalysis ~9 km, from 1950. Several days behind real time.' },
  { id: 'ecmwf_ifs', label: 'ECMWF IFS (9 km)', note: 'High-resolution analysis from 2017. Close to real time.' },
  { id: 'cerra', label: 'CERRA (Europe, 5 km)', note: 'European regional reanalysis, 1985 to mid-2021 only.' },
];

const WMO = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle', 56: 'Freezing drizzle', 57: 'Dense freezing drizzle',
  61: 'Slight rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Heavy freezing rain',
  71: 'Slight snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Slight showers', 81: 'Showers', 82: 'Violent showers', 85: 'Snow showers', 86: 'Heavy snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm, hail', 99: 'Thunderstorm, heavy hail',
};
export function wmoLabel(code) { return code == null ? '–' : (WMO[code] || `Code ${code}`); }

export function compass(deg) {
  if (deg == null) return '–';
  const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return pts[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}
