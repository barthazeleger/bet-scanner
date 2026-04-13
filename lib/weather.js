'use strict';

// Simpele city→lat/lon mapping voor grote voetbalsteden
const CITY_COORDS = {
  'london':      { lat:51.50, lon:-0.13 },  'manchester':  { lat:53.48, lon:-2.24 },
  'liverpool':   { lat:53.41, lon:-2.98 },  'birmingham':  { lat:52.48, lon:-1.89 },
  'leeds':       { lat:53.80, lon:-1.55 },  'newcastle':   { lat:54.98, lon:-1.62 },
  'madrid':      { lat:40.42, lon:-3.70 },  'barcelona':   { lat:41.39, lon:2.17 },
  'sevilla':     { lat:37.39, lon:-5.99 },  'valencia':    { lat:39.47, lon:-0.38 },
  'münchen':     { lat:48.14, lon:11.58 },  'munich':      { lat:48.14, lon:11.58 },
  'dortmund':    { lat:51.51, lon:7.47 },   'berlin':      { lat:52.52, lon:13.41 },
  'leipzig':     { lat:51.34, lon:12.37 },  'frankfurt':   { lat:50.11, lon:8.68 },
  'milano':      { lat:45.46, lon:9.19 },   'milan':       { lat:45.46, lon:9.19 },
  'roma':        { lat:41.90, lon:12.50 },  'rome':        { lat:41.90, lon:12.50 },
  'torino':      { lat:45.07, lon:7.69 },   'napoli':      { lat:40.85, lon:14.27 },
  'paris':       { lat:48.86, lon:2.35 },   'lyon':        { lat:45.76, lon:4.84 },
  'marseille':   { lat:43.30, lon:5.37 },   'lille':       { lat:50.63, lon:3.06 },
  'amsterdam':   { lat:52.37, lon:4.90 },   'rotterdam':   { lat:51.92, lon:4.48 },
  'eindhoven':   { lat:51.44, lon:5.47 },   'lisboa':      { lat:38.72, lon:-9.14 },
  'lisbon':      { lat:38.72, lon:-9.14 },  'porto':       { lat:41.16, lon:-8.63 },
  'istanbul':    { lat:41.01, lon:28.98 },  'brussel':     { lat:50.85, lon:4.35 },
  'brussels':    { lat:50.85, lon:4.35 },   'glasgow':     { lat:55.86, lon:-4.25 },
  'edinburgh':   { lat:55.95, lon:-3.19 },  'wien':        { lat:48.21, lon:16.37 },
  'vienna':      { lat:48.21, lon:16.37 },  'zürich':      { lat:47.38, lon:8.54 },
  'zurich':      { lat:47.38, lon:8.54 },   'bern':        { lat:46.95, lon:7.45 },
  'copenhagen':  { lat:55.68, lon:12.57 },  'københavn':   { lat:55.68, lon:12.57 },
  'oslo':        { lat:59.91, lon:10.75 },  'stockholm':   { lat:59.33, lon:18.07 },
  'gothenburg':  { lat:57.71, lon:11.97 },  'helsinki':     { lat:60.17, lon:24.94 },
  'reykjavik':   { lat:64.15, lon:-21.95 }, 'athens':      { lat:37.98, lon:23.73 },
  'warsaw':      { lat:52.23, lon:21.01 },  'krakow':      { lat:50.06, lon:19.94 },
  'prague':      { lat:50.08, lon:14.44 },  'bucharest':   { lat:44.43, lon:26.10 },
  'zagreb':      { lat:45.81, lon:15.98 },  'moscow':      { lat:55.76, lon:37.62 },
  'kyiv':        { lat:50.45, lon:30.52 },  'belgrade':    { lat:44.79, lon:20.47 },
  'budapest':    { lat:47.50, lon:19.04 },  'sofia':       { lat:42.70, lon:23.32 },
  'nicosia':     { lat:35.17, lon:33.37 },  'bratislava':  { lat:48.15, lon:17.11 },
  'cairo':       { lat:30.04, lon:31.24 },  'johannesburg':{ lat:-26.20, lon:28.05 },
  'cape town':   { lat:-33.93, lon:18.42 }, 'pretoria':    { lat:-25.75, lon:28.19 },
  'new york':    { lat:40.71, lon:-74.01 }, 'los angeles': { lat:34.05, lon:-118.24 },
  'mexico city': { lat:19.43, lon:-99.13 }, 'bogota':      { lat:4.71, lon:-74.07 },
  'bogotá':      { lat:4.71, lon:-74.07 },  'santiago':    { lat:-33.45, lon:-70.67 },
  'lima':        { lat:-12.05, lon:-77.04 },'buenos aires':{ lat:-34.60, lon:-58.38 },
  'são paulo':   { lat:-23.55, lon:-46.63 },'sao paulo':   { lat:-23.55, lon:-46.63 },
  'rio de janeiro':{ lat:-22.91, lon:-43.17 },
  'riyadh':      { lat:24.71, lon:46.67 },  'jeddah':      { lat:21.49, lon:39.19 },
  'tokyo':       { lat:35.68, lon:139.69 }, 'osaka':       { lat:34.69, lon:135.50 },
  'seoul':       { lat:37.57, lon:126.98 }, 'beijing':     { lat:39.90, lon:116.40 },
  'shanghai':    { lat:31.23, lon:121.47 }, 'guangzhou':   { lat:23.13, lon:113.26 },
  'sydney':      { lat:-33.87, lon:151.21 },'melbourne':   { lat:-37.81, lon:144.96 },
};

let weatherCallsThisScan = 0;
const MAX_WEATHER_CALLS = 30;

function resetWeatherCalls() { weatherCallsThisScan = 0; }

async function fetchMatchWeather(lat, lon, kickoffTime) {
  if (weatherCallsThisScan >= MAX_WEATHER_CALLS) return null;
  const date = kickoffTime.toISOString().slice(0, 10);
  const hour = kickoffTime.getUTCHours();
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=precipitation,windspeed_10m,temperature_2m&start_date=${date}&end_date=${date}`;
  try {
    weatherCallsThisScan++;
    const r = await fetch(url).then(r => r.json());
    const idx = r.hourly?.time?.findIndex(t => t.includes(`T${String(hour).padStart(2,'0')}`)) ?? -1;
    if (idx < 0) return null;
    return {
      rain: r.hourly.precipitation?.[idx] ?? 0,
      wind: r.hourly.windspeed_10m?.[idx] ?? 0,
      temp: r.hourly.temperature_2m?.[idx] ?? 15,
    };
  } catch { return null; }
}

function getVenueCoords(fixture) {
  const city = (fixture?.venue?.city || '').toLowerCase().trim();
  if (!city) return null;
  if (CITY_COORDS[city]) return CITY_COORDS[city];
  for (const [key, coords] of Object.entries(CITY_COORDS)) {
    if (city.includes(key) || key.includes(city)) return coords;
  }
  return null;
}

module.exports = {
  CITY_COORDS, fetchMatchWeather, getVenueCoords,
  MAX_WEATHER_CALLS, resetWeatherCalls,
};
