// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
/*
 * Glasshouse Home's Latest releases row: films and series new to streaming in
 * one region, from TMDB's discover API, and opening one as a YouTube search.
 * Nothing is fetched without a TMDB API key in config.json:
 *   { "releases": { "tmdbKey": "<v3 API key>", "region": "GB" } }
 * TMDB is reached through fetch (curl or wget), since node 0.12 cannot speak
 * the TLS it requires.
 */
var msg = require('./say').msg;

// LG's YouTube, and webosbrew's YouTube AdFree, which installs in its place.
var YOUTUBE = 'youtube.leanback.v4';
var API = 'https://api.themoviedb.org/3/';
var POSTERS = 'https://image.tmdb.org/t/p/w185';
// TMDB's lists change through the day, not by the minute.
var TTL_MS = 6 * 3600 * 1000;
// After a failure, the next request waits this long before asking TMDB again.
var RETRY_MS = 15 * 60 * 1000;
// Released or first aired within this many days.
var WINDOW_DAYS = 60;
var MAX_ITEMS = 20;
// TMDB's score from fewer votes than this says little, so none is shown.
var MIN_VOTES = 5;
// Streamed, not rented or bought.
var MONETIZATION = 'flatrate|free|ads';

var config = {};
/** @type {typeof import('./fetch')} */
var fetchLib = null;
var lunaFn = null;
var now = function () { return Date.now(); };
// By language: { at, items, region, failedAt, error, waiting }
var cache = {};

function init(opts) {
  opts = opts || {};
  if (opts.config) config = opts.config;
  if (opts.fetch) fetchLib = opts.fetch;
  if (opts.luna) lunaFn = opts.luna;
  if (opts.now) now = opts.now;
  cache = {};
}

function settings() {
  var r = (config && config.releases) || {};
  var key = typeof r.tmdbKey === 'string' ? r.tmdbKey.trim() : '';
  var region = typeof r.region === 'string' && /^[A-Za-z]{2}$/.test(r.region) ? r.region.toUpperCase() : 'GB';
  return { key: /^[\w-]{1,256}$/.test(key) ? key : '', region: region };
}

function day(ms) { return new Date(ms).toISOString().slice(0, 10); }

// TMDB's language: the page's, or English as written in the region.
function tmdbLanguage(lang, region) { return lang || 'en-' + region; }

function discoverUrl(type, s, lang) {
  var to = day(now()), from = day(now() - WINDOW_DAYS * 86400000);
  var dates = type === 'movie' ? 'primary_release_date' : 'first_air_date';
  return API + 'discover/' + type + '?api_key=' + encodeURIComponent(s.key) +
    '&language=' + encodeURIComponent(tmdbLanguage(lang, s.region)) +
    '&watch_region=' + s.region + '&with_watch_monetization_types=' + encodeURIComponent(MONETIZATION) +
    '&sort_by=popularity.desc&include_adult=false' +
    '&' + dates + '.gte=' + from + '&' + dates + '.lte=' + to;
}

function entry(type, r) {
  var title = r && (type === 'movie' ? r.title : r.name);
  if (!r || typeof r.id !== 'number' || typeof title !== 'string' || !title) return null;
  var date = String((type === 'movie' ? r.release_date : r.first_air_date) || '');
  var votes = typeof r.vote_count === 'number' ? r.vote_count : 0;
  return {
    id: (type === 'movie' ? 'film:' : 'series:') + r.id,
    kind: type === 'movie' ? 'film' : 'series',
    title: title.slice(0, 200),
    year: /^\d{4}/.test(date) ? parseInt(date, 10) : null,
    rating: typeof r.vote_average === 'number' && r.vote_average > 0 && votes >= MIN_VOTES ? Math.round(r.vote_average * 10) / 10 : null,
    poster: typeof r.poster_path === 'string' && /^\/[\w.-]+$/.test(r.poster_path) ? POSTERS + r.poster_path : null,
    popularity: typeof r.popularity === 'number' ? r.popularity : 0
  };
}

// Films and series together, the most popular first.
function merge(films, series) {
  var all = [];
  [['movie', films], ['tv', series]].forEach(function (pair) {
    var results = pair[1] && Array.isArray(pair[1].results) ? pair[1].results : [];
    results.forEach(function (r) {
      var e = entry(pair[0], r);
      if (e) all.push(e);
    });
  });
  all.sort(function (a, b) { return b.popularity - a.popularity; });
  return all.slice(0, MAX_ITEMS).map(function (e) {
    return { id: e.id, kind: e.kind, title: e.title, year: e.year, rating: e.rating, poster: e.poster };
  });
}

// The key goes in TMDB's address, which a client's error repeats.
function reason(err, key) {
  var text = String((err && err.message) || err || 'failed');
  return key ? text.split(key).join('***') : text;
}

function fetchBoth(s, lang, cb) {
  var got = {}, left = 2, failed = null;
  ['movie', 'tv'].forEach(function (type) {
    fetchLib.getJson(discoverUrl(type, s, lang), function (err, doc) {
      if (err) failed = failed || err;
      else got[type] = doc;
      if (--left) return;
      if (failed) return cb(failed);
      cb(null, merge(got.movie, got.tv));
    });
  });
}

/*
 * The row's titles, from the cache while it is fresh. One request to TMDB at
 * a time: callers meanwhile wait for its answer. A failure keeps the titles
 * already fetched.
 */
function list(lang, cb) {
  var s = settings();
  if (!s.key) return cb({ ok: true, enabled: false, items: [] });
  var key = (lang || 'en') + '@' + s.region;
  var c = cache[key] || (cache[key] = { at: 0, items: null, failedAt: 0, error: null, waiting: null });
  var t = now();
  function answer() {
    if (c.items) return { ok: true, enabled: true, region: s.region, items: c.items };
    return { ok: false, enabled: true, error: c.error };
  }
  if (c.items && t - c.at < TTL_MS) return cb(answer());
  if (c.failedAt && t - c.failedAt < RETRY_MS) return cb(answer());
  if (c.waiting) return c.waiting.push(cb);
  c.waiting = [cb];
  fetchBoth(s, lang, function (err, items) {
    if (err) {
      var why = reason(err, s.key);
      console.warn('releases: TMDB did not answer: ' + why);
      c.failedAt = now();
      c.error = /\b401\b/.test(why)
        ? msg('srv.releases.badKey', 'TMDB refused the API key in config.json')
        : msg('srv.releases.failed', 'TMDB did not answer. It needs the TV online.');
    } else {
      c.items = items;
      c.at = now();
      c.failedAt = 0;
      c.error = null;
    }
    var waiting = c.waiting;
    c.waiting = null;
    var r = answer();
    waiting.forEach(function (w) { w(r); });
  });
}

function find(id) {
  for (var k in cache) {
    if (!cache.hasOwnProperty(k) || !cache[k].items) continue;
    for (var i = 0; i < cache[k].items.length; i++) if (cache[k].items[i].id === id) return cache[k].items[i];
  }
  return null;
}

/*
 * Opens a listed title as a search in YouTube: the voice search launch LG's
 * ThinQ sends, which LG's YouTube and YouTube AdFree both take (AdFree's
 * handleLaunch: launch=search&vq=<intentParam>). noApp tells the view to
 * search Glasshouse Home instead.
 */
function open(id, cb) {
  var it = typeof id === 'string' ? find(id) : null;
  if (!it) return cb({ ok: false, error: msg('srv.home.unknownTile', 'that is not on Glasshouse Home') });
  lunaFn('com.webos.applicationManager/getAppInfo', { id: YOUTUBE }, function (info) {
    if (!info || !info.returnValue) {
      return cb({ ok: false, noApp: true, error: msg('srv.releases.noYoutube', 'YouTube is not installed on this TV') });
    }
    var query = it.title + (it.year ? ' ' + it.year : '') + ' trailer';
    console.log('releases: opening YouTube for ' + it.id);
    lunaFn('com.webos.applicationManager/launch', {
      id: YOUTUBE,
      params: { contentTarget: { intent: 'SearchContent', intentParam: query } }
    }, function (r) {
      cb({ ok: !!(r && r.returnValue), error: r && r.returnValue ? undefined : msg('srv.home.launchRefused', 'the TV would not open it') });
    });
  });
}

module.exports = {
  init: init,
  list: list,
  open: open,
  YOUTUBE: YOUTUBE,
  _discoverUrl: discoverUrl
};
