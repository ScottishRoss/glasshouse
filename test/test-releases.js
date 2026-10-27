/* Glasshouse Home's Latest releases row: TMDB's discover lists for one
 * region, cached, and a listed title opening as a YouTube search.
 * Strict ES5: also runs on node 0.10. */
var assert = require('assert');
var releases = require('../server/lib/releases');

var KEY = 'abc123key';
var DAY = 86400000;
var clock = Date.UTC(2026, 9, 27, 12);
var fetched, launched, youtube, answer;

function film(id, title, popularity, extra) {
  var r = { id: id, title: title, release_date: '2026-10-01', popularity: popularity, vote_average: 7.46, vote_count: 120, poster_path: '/p' + id + '.jpg' };
  for (var k in extra || {}) r[k] = extra[k];
  return r;
}
function series(id, name, popularity) {
  return { id: id, name: name, first_air_date: '2026-09-12', popularity: popularity, vote_average: 8.1, vote_count: 3, poster_path: null };
}

var fakeFetch = {
  getJson: function (url, cb) {
    fetched.push(url);
    var reply = answer(url);
    if (fetched.hold) return fetched.hold.push(function () { cb(reply.err || null, reply.doc); });
    process.nextTick(function () { cb(reply.err || null, reply.doc); });
  }
};

function luna(uri, payload, cb) {
  if (uri === 'com.webos.applicationManager/getAppInfo') {
    return process.nextTick(function () { cb({ returnValue: youtube, appInfo: youtube ? { id: payload.id } : undefined }); });
  }
  launched.push({ uri: uri, payload: payload });
  process.nextTick(function () { cb({ returnValue: true }); });
}

function normalAnswer(url) {
  if (/discover\/movie/.test(url)) {
    return { doc: { results: [film(1, 'Quiet Harbour', 50), film(2, 'Northern Line', 300), film(3, '', 999),
      film(4, 'Odd Poster', 10, { poster_path: '/../x"onerror=1', vote_count: 2 })] } };
  }
  return { doc: { results: [series(10, 'The Long Field', 120)] } };
}

function setUp(cfg) {
  fetched = [];
  launched = [];
  youtube = true;
  answer = normalAnswer;
  releases.init({ config: cfg, fetch: fakeFetch, luna: luna, now: function () { return clock; } });
}

var tests = [
  function noKeyFetchesNothing(done) {
    setUp({});
    releases.list(null, function (r) {
      assert.ok(r.ok && r.enabled === false && !r.items.length);
      assert.equal(fetched.length, 0, 'nothing reaches TMDB without a key');
      done();
    });
  },

  function asksForTheRegionsStreamingTitles(done) {
    setUp({ releases: { tmdbKey: KEY } });
    releases.list(null, function () {
      assert.equal(fetched.length, 2);
      var movie = fetched.filter(function (u) { return /discover\/movie\?/.test(u); })[0];
      var tv = fetched.filter(function (u) { return /discover\/tv\?/.test(u); })[0];
      assert.ok(movie && tv);
      assert.ok(/^https:\/\/api\.themoviedb\.org\/3\//.test(movie));
      assert.ok(movie.indexOf('api_key=' + KEY) !== -1);
      assert.ok(movie.indexOf('watch_region=GB') !== -1 && tv.indexOf('watch_region=GB') !== -1);
      assert.ok(movie.indexOf('language=en-GB') !== -1);
      assert.ok(movie.indexOf('with_watch_monetization_types=flatrate%7Cfree%7Cads') !== -1);
      assert.ok(movie.indexOf('primary_release_date.lte=2026-10-27') !== -1);
      assert.ok(movie.indexOf('primary_release_date.gte=2026-08-28') !== -1);
      assert.ok(tv.indexOf('first_air_date.gte=2026-08-28') !== -1);
      assert.ok(!/[ "]/.test(movie));
      done();
    });
  },

  function regionAndLanguage(done) {
    setUp({ releases: { tmdbKey: KEY, region: 'de' } });
    releases.list('de', function (r) {
      assert.equal(r.region, 'DE');
      assert.ok(fetched[0].indexOf('watch_region=DE') !== -1 && fetched[0].indexOf('language=de&') !== -1);
      setUp({ releases: { tmdbKey: KEY, region: 'nowhere' } });
      releases.list(null, function (r2) {
        assert.equal(r2.region, 'GB', 'a region that is not two letters is GB');
        done();
      });
    });
  },

  function postersCardsMostPopularFirst(done) {
    setUp({ releases: { tmdbKey: KEY } });
    releases.list(null, function (r) {
      assert.ok(r.ok && r.enabled);
      assert.deepEqual(r.items.map(function (i) { return i.id; }), ['film:2', 'series:10', 'film:1', 'film:4'],
        'films and series together by popularity; one with no title left out');
      var top = r.items[0];
      assert.deepEqual(top, { id: 'film:2', kind: 'film', title: 'Northern Line', year: 2026, rating: 7.5,
        poster: 'https://image.tmdb.org/t/p/w185/p2.jpg' });
      assert.equal(r.items[1].kind, 'series');
      assert.strictEqual(r.items[1].rating, null, 'a score from three votes is not shown');
      assert.strictEqual(r.items[1].poster, null);
      assert.strictEqual(r.items[3].poster, null, 'a poster path that is not a file name is dropped');
      done();
    });
  },

  function cachedThenRefreshed(done) {
    setUp({ releases: { tmdbKey: KEY } });
    releases.list(null, function () {
      clock += 5 * 3600 * 1000;
      releases.list(null, function (r) {
        assert.equal(fetched.length, 2, 'within six hours the cache answers');
        assert.equal(r.items.length, 4);
        clock += 2 * 3600 * 1000;
        releases.list(null, function () {
          assert.equal(fetched.length, 4, 'after six hours TMDB is asked again');
          done();
        });
      });
    });
  },

  function oneRequestAtATime(done) {
    setUp({ releases: { tmdbKey: KEY } });
    fetched.hold = [];
    var answers = 0;
    function got(r) {
      assert.ok(r.ok && r.items.length === 4);
      if (++answers === 3) done();
    }
    releases.list(null, got);
    releases.list(null, got);
    releases.list(null, got);
    assert.equal(fetched.length, 2, 'callers wait for the request already made');
    var hold = fetched.hold;
    fetched.hold = null;
    hold.forEach(function (f) { f(); });
  },

  function failureKeepsWhatItHadAndHidesTheKey(done) {
    setUp({ releases: { tmdbKey: KEY } });
    var warned = [], warn = console.warn;
    console.warn = function (m) { warned.push(m); };
    releases.list(null, function () {
      clock += 7 * 3600 * 1000;
      answer = function (url) { return { err: new Error('api.themoviedb.org returned 503 for ' + url.replace(/^https:\/\/[^\/]+/, '')) }; };
      releases.list(null, function (r) {
        assert.ok(r.ok && r.items.length === 4, 'titles already fetched stay');
        assert.equal(warned.length, 1);
        assert.equal(warned[0].indexOf(KEY), -1, 'the key is not logged');
        assert.ok(/\*\*\*/.test(warned[0]));
        var before = fetched.length;
        clock += 10 * 60 * 1000;
        releases.list(null, function () {
          assert.equal(fetched.length, before, 'no new request within 15 minutes of a failure');
          console.warn = warn;
          done();
        });
      });
    });
  },

  function refusedKey(done) {
    setUp({ releases: { tmdbKey: KEY } });
    var warn = console.warn;
    console.warn = function () {};
    answer = function () { return { err: new Error('api.themoviedb.org returned 401 for /3/discover/movie') }; };
    releases.list(null, function (r) {
      console.warn = warn;
      assert.ok(!r.ok && r.enabled);
      assert.ok(/API key/.test(r.error));
      assert.equal(JSON.stringify(r).indexOf(KEY), -1);
      done();
    });
  },

  function opensAListedTitleInYouTube(done) {
    setUp({ releases: { tmdbKey: KEY } });
    releases.list(null, function () {
      releases.open('film:2', function (r) {
        assert.ok(r.ok);
        assert.equal(launched.length, 1);
        assert.equal(launched[0].uri, 'com.webos.applicationManager/launch');
        assert.deepEqual(launched[0].payload, { id: 'youtube.leanback.v4',
          params: { contentTarget: { intent: 'SearchContent', intentParam: 'Northern Line 2026 trailer' } } });
        releases.open('film:999', function (unknown) {
          assert.ok(!unknown.ok && !unknown.noApp, 'only a listed title opens');
          releases.open({ id: 'film:2' }, function (bad) {
            assert.ok(!bad.ok);
            assert.equal(launched.length, 1);
            done();
          });
        });
      });
    });
  },

  function routes(done) {
    var routesLib = require('../server/lib/routes');
    var events = require('events');
    setUp({ releases: { tmdbKey: KEY } });
    routesLib.init({ config: { allowControl: false, token: '' }, releases: releases });
    function call(method, url, remote, body, cb) {
      var req = new events.EventEmitter();
      req.url = url; req.method = method; req.connection = { remoteAddress: remote };
      req.headers = { 'content-type': 'application/json', host: 'tv' };
      req.destroy = function () {};
      var res = { body: '', writeHead: function (code) { res.code = code; }, end: function (b) { res.body += b || ''; cb(res.code, JSON.parse(res.body)); } };
      routesLib.handleRequest(req, res);
      if (method === 'POST') process.nextTick(function () { req.emit('data', JSON.stringify(body)); req.emit('end'); });
    }
    call('GET', '/api/releases', '192.168.1.20', null, function (code, r) {
      assert.equal(code, 200);
      assert.equal(r.items[0].id, 'film:2');
      call('POST', '/api/releases/open', '192.168.1.20', { id: 'film:2' }, function (refused) {
        assert.equal(refused, 403, 'opening from the network needs allowControl');
        assert.equal(launched.length, 0);
        call('POST', '/api/releases/open', '127.0.0.1', { id: 'film:2' }, function (code2, opened) {
          assert.equal(code2, 200);
          assert.ok(opened.ok && launched.length === 1, 'the TV itself opens it');
          done();
        });
      });
    });
  },

  function withoutYouTubeTheViewSearches(done) {
    setUp({ releases: { tmdbKey: KEY } });
    youtube = false;
    releases.list(null, function () {
      releases.open('series:10', function (r) {
        assert.ok(!r.ok && r.noApp);
        assert.equal(launched.length, 0);
        done();
      });
    });
  }
];

(function next(i) {
  if (i === tests.length) return console.log('test-releases: ' + tests.length + ' passed');
  tests[i](function () { next(i + 1); });
})(0);
