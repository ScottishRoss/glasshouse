// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
/*
 * Glasshouse Home's weather: now and today's high and low at one place, from
 * Open-Meteo, which needs no key. Nothing is asked without a place in
 * config.json, by name or as coordinates:
 *   { "weather": { "place": "Sandbach", "country": "GB" } }
 *   { "weather": { "latitude": 53.14, "longitude": -2.36, "place": "Home" } }
 * "units": "fahrenheit" for °F. Reached through fetch (curl or wget), since
 * node 0.12 cannot speak the TLS Open-Meteo requires.
 */
var msg = require('./say').msg;

var GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
var FORECAST = 'https://api.open-meteo.com/v1/forecast';
// Open-Meteo's models update hourly; a quarter of an hour keeps the view close.
var TTL_MS = 15 * 60 * 1000;
// After a failure, the next request waits this long before asking again.
var RETRY_MS = 5 * 60 * 1000;
// Older than this, the weather is not shown rather than shown wrong.
var STALE_MS = 3 * 3600 * 1000;

var config = {};
/** @type {typeof import('./fetch')} */
var fetchLib = null;
var now = function () { return Date.now(); };
// Places found by name, by name, country and language: { at, failedAt, found }
var places = {};
// The weather, by place: { at, data, failedAt, error, waiting }
var cache = {};

function init(opts) {
  opts = opts || {};
  if (opts.config) config = opts.config;
  if (opts.fetch) fetchLib = opts.fetch;
  if (opts.now) now = opts.now;
  places = {};
  cache = {};
}

function finite(v, min, max) { return typeof v === 'number' && isFinite(v) && v >= min && v <= max; }

function settings() {
  var w = (config && config.weather) || {};
  var place = typeof w.place === 'string' ? w.place.trim().slice(0, 100) : '';
  var at = finite(w.latitude, -90, 90) && finite(w.longitude, -180, 180) ? { latitude: w.latitude, longitude: w.longitude } : null;
  return {
    place: place,
    country: typeof w.country === 'string' && /^[A-Za-z]{2}$/.test(w.country) ? w.country.toUpperCase() : '',
    at: at,
    fahrenheit: w.units === 'fahrenheit'
  };
}

// cb(err, { name, latitude, longitude })
function locate(s, lang, cb) {
  if (s.at) return cb(null, { name: s.place, latitude: s.at.latitude, longitude: s.at.longitude });
  var key = s.place.toLowerCase() + '@' + s.country + '@' + (lang || 'en');
  var p = places[key] || (places[key] = { found: null, failedAt: 0 });
  if (p.found) return cb(null, p.found);
  // Several, so that one in the configured country can be picked.
  var url = GEOCODE + '?name=' + encodeURIComponent(s.place) + '&count=10&language=' + (lang || 'en') + '&format=json';
  fetchLib.getJson(url, function (err, doc) {
    if (err) return cb(err);
    var results = doc && Array.isArray(doc.results) ? doc.results : [];
    var hit = null;
    for (var i = 0; i < results.length && !hit; i++) {
      var r = results[i];
      if (!r || !finite(r.latitude, -90, 90) || !finite(r.longitude, -180, 180)) continue;
      if (s.country && String(r.country_code || '').toUpperCase() !== s.country) continue;
      hit = { name: typeof r.name === 'string' ? r.name.slice(0, 100) : s.place, latitude: r.latitude, longitude: r.longitude };
    }
    if (!hit) {
      /** @type {any} */
      var none = new Error('no place called ' + s.place + (s.country ? ' in ' + s.country : ''));
      none.notFound = true;
      return cb(none);
    }
    p.found = hit;
    cb(null, hit);
  });
}

function rounded(v) { return typeof v === 'number' && isFinite(v) ? Math.round(v) : null; }

function forecastUrl(where, s) {
  return FORECAST + '?latitude=' + where.latitude + '&longitude=' + where.longitude +
    '&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,temperature_2m_min' +
    '&timezone=auto&forecast_days=1' + (s.fahrenheit ? '&temperature_unit=fahrenheit' : '');
}

function reading(doc, where, s) {
  var c = doc && doc.current, d = (doc && doc.daily) || {};
  if (!c || rounded(c.temperature_2m) === null) return null;
  var first = function (list) { return Array.isArray(list) && list.length ? rounded(list[0]) : null; };
  return {
    place: where.name || '',
    temperature: rounded(c.temperature_2m),
    // WMO weather interpretation code, which the view names and draws.
    code: typeof c.weather_code === 'number' ? c.weather_code : null,
    day: c.is_day !== 0,
    high: first(d.temperature_2m_max),
    low: first(d.temperature_2m_min),
    unit: s.fahrenheit ? 'F' : 'C'
  };
}

/*
 * The weather, from the cache while it is fresh. One request at a time:
 * callers meanwhile wait for its answer. A failure keeps the last reading
 * until it is three hours old.
 */
function current(lang, cb) {
  var s = settings();
  if (!s.at && !s.place) return cb({ ok: true, enabled: false });
  var key = (s.at ? s.at.latitude + ',' + s.at.longitude : s.place.toLowerCase() + '@' + s.country) + '@' + s.fahrenheit + '@' + (lang || 'en');
  var c = cache[key] || (cache[key] = { at: 0, data: null, failedAt: 0, error: null, waiting: null });
  var t = now();
  function answer() {
    if (c.data && now() - c.at < STALE_MS) {
      var r = { ok: true, enabled: true, at: c.at };
      for (var k in c.data) r[k] = c.data[k];
      return r;
    }
    return { ok: false, enabled: true, error: c.error || msg('srv.weather.failed', 'Open-Meteo did not answer. It needs the TV online.') };
  }
  if (c.data && t - c.at < TTL_MS) return cb(answer());
  if (c.failedAt && t - c.failedAt < RETRY_MS) return cb(answer());
  if (c.waiting) return c.waiting.push(cb);
  c.waiting = [cb];
  function done(err, data) {
    if (err) {
      console.warn('weather: ' + ((err && err.message) || err));
      c.failedAt = now();
      c.error = err.notFound
        ? msg('srv.weather.noPlace', 'Open-Meteo knows no place called {place}', { place: s.place })
        : msg('srv.weather.failed', 'Open-Meteo did not answer. It needs the TV online.');
    } else {
      c.data = data;
      c.at = now();
      c.failedAt = 0;
      c.error = null;
    }
    var waiting = c.waiting;
    c.waiting = null;
    var r = answer();
    waiting.forEach(function (w) { w(r); });
  }
  locate(s, lang, function (err, where) {
    if (err) return done(err);
    fetchLib.getJson(forecastUrl(where, s), function (err2, doc) {
      if (err2) return done(err2);
      var data = reading(doc, where, s);
      if (!data) return done(new Error('Open-Meteo sent no current temperature'));
      done(null, data);
    });
  });
}

module.exports = {
  init: init,
  current: current
};
