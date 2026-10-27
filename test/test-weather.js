/* Glasshouse Home's weather: a place found by name once, Open-Meteo's
 * current reading and today's range, cached, and kept through a failure
 * only while it is recent. Strict ES5: also runs on node 0.10. */
var assert = require('assert');
var weather = require('../server/lib/weather');

var clock = Date.UTC(2026, 9, 27, 12);
var fetched, answer;

var PLACES = { results: [
  { name: 'Sandbach', latitude: 40.1, longitude: -75.2, country_code: 'US' },
  { name: 'Sandbach', latitude: 53.1446, longitude: -2.3613, country_code: 'GB' }
] };
var FORECAST = {
  current_units: { temperature_2m: '°C' },
  current: { time: '2026-10-27T12:00', temperature_2m: 13.6, weather_code: 61, is_day: 1 },
  daily: { time: ['2026-10-27'], temperature_2m_max: [15.4], temperature_2m_min: [6.5] }
};

var fakeFetch = {
  getJson: function (url, cb) {
    fetched.push(url);
    var reply = answer(url);
    if (fetched.hold) return fetched.hold.push(function () { cb(reply.err || null, reply.doc); });
    process.nextTick(function () { cb(reply.err || null, reply.doc); });
  }
};

function normal(url) {
  return { doc: /geocoding-api/.test(url) ? PLACES : FORECAST };
}

function setUp(cfg) {
  fetched = [];
  answer = normal;
  weather.init({ config: cfg, fetch: fakeFetch, now: function () { return clock; } });
}

function quietly(fn) {
  var warn = console.warn, said = [];
  console.warn = function (m) { said.push(m); };
  return function () { console.warn = warn; return said; };
}

var tests = [
  function noPlaceAsksNothing(done) {
    setUp({});
    weather.current(null, function (r) {
      assert.ok(r.ok && r.enabled === false);
      assert.equal(fetched.length, 0);
      setUp({ weather: { place: '  ' } });
      weather.current(null, function (r2) {
        assert.ok(r2.enabled === false && fetched.length === 0);
        done();
      });
    });
  },

  function placeInItsCountry(done) {
    setUp({ weather: { place: 'Sandbach', country: 'gb' } });
    weather.current(null, function (r) {
      assert.ok(/^https:\/\/geocoding-api\.open-meteo\.com\/v1\/search\?name=Sandbach&count=10&language=en&format=json$/.test(fetched[0]));
      assert.ok(fetched[1].indexOf('https://api.open-meteo.com/v1/forecast?latitude=53.1446&longitude=-2.3613&') === 0,
        'the Sandbach in the configured country, not the first');
      assert.ok(fetched[1].indexOf('current=temperature_2m,weather_code,is_day') !== -1);
      assert.ok(fetched[1].indexOf('daily=temperature_2m_max,temperature_2m_min') !== -1);
      assert.ok(fetched[1].indexOf('timezone=auto&forecast_days=1') !== -1);
      assert.equal(fetched[1].indexOf('temperature_unit'), -1, 'Celsius is Open-Meteo\'s own');
      assert.deepEqual(r, { ok: true, enabled: true, at: clock, place: 'Sandbach', temperature: 14, code: 61, day: true,
        high: 15, low: 7, unit: 'C' });
      done();
    });
  },

  function coordinatesAndFahrenheit(done) {
    setUp({ weather: { latitude: 53.14, longitude: -2.36, place: 'Home', units: 'fahrenheit' } });
    answer = function () {
      return { doc: { current: { temperature_2m: 56.4, weather_code: 0, is_day: 0 }, daily: {} } };
    };
    weather.current('de', function (r) {
      assert.equal(fetched.length, 1, 'coordinates need no search');
      assert.ok(fetched[0].indexOf('latitude=53.14&longitude=-2.36') !== -1);
      assert.ok(/temperature_unit=fahrenheit$/.test(fetched[0]));
      assert.equal(r.place, 'Home');
      assert.equal(r.unit, 'F');
      assert.strictEqual(r.day, false);
      assert.strictEqual(r.high, null);
      done();
    });
  },

  function placeFoundOnce(done) {
    setUp({ weather: { place: 'Sandbach' } });
    weather.current(null, function () {
      clock += 16 * 60 * 1000;
      weather.current(null, function (r) {
        assert.equal(fetched.length, 3, 'the place is searched once, the weather again after 15 minutes');
        assert.ok(/forecast/.test(fetched[2]));
        assert.equal(r.at, clock);
        done();
      });
    });
  },

  function cachedForAQuarterHour(done) {
    setUp({ weather: { place: 'Sandbach' } });
    weather.current(null, function () {
      clock += 14 * 60 * 1000;
      weather.current(null, function (r) {
        assert.ok(r.ok);
        assert.equal(fetched.length, 2);
        done();
      });
    });
  },

  function oneRequestAtATime(done) {
    setUp({ weather: { place: 'Sandbach' } });
    fetched.hold = [];
    var n = 0;
    function got(r) { assert.ok(r.ok); if (++n === 3) done(); }
    weather.current(null, got);
    weather.current(null, got);
    weather.current(null, got);
    var release = function () {
      var hold = fetched.hold;
      fetched.hold = hold.length && fetched.length < 2 ? [] : null;
      hold.forEach(function (f) { f(); });
      if (fetched.hold) setTimeout(release, 5);
    };
    assert.equal(fetched.length, 1, 'callers wait for the request already made');
    release();
  },

  function failureKeepsARecentReading(done) {
    setUp({ weather: { place: 'Sandbach' } });
    weather.current(null, function () {
      var restore = quietly();
      clock += 20 * 60 * 1000;
      answer = function () { return { err: new Error('api.open-meteo.com returned 503') }; };
      weather.current(null, function (r) {
        assert.ok(r.ok && r.temperature === 14, 'a reading 20 minutes old is still shown');
        var before = fetched.length;
        clock += 2 * 60 * 1000;
        weather.current(null, function () {
          assert.equal(fetched.length, before, 'no new request within 5 minutes of a failure');
          clock += 3 * 3600 * 1000;
          weather.current(null, function (old) {
            restore();
            assert.ok(!old.ok && old.enabled, 'a reading over three hours old is not shown');
            done();
          });
        });
      });
    });
  },

  function unknownPlace(done) {
    setUp({ weather: { place: 'Nowhereville', country: 'GB' } });
    answer = function () { return { doc: { results: [{ name: 'Nowhereville', latitude: 1, longitude: 2, country_code: 'US' }] } }; };
    var restore = quietly();
    weather.current(null, function (r) {
      restore();
      assert.ok(!r.ok && /Nowhereville/.test(r.error));
      assert.equal(fetched.length, 1);
      done();
    });
  },

  function routeAnswers(done) {
    var routes = require('../server/lib/routes');
    var events = require('events');
    setUp({ weather: { place: 'Sandbach' } });
    routes.init({ config: { token: '' }, weather: weather });
    var req = new events.EventEmitter();
    req.url = '/api/weather'; req.method = 'GET'; req.headers = {}; req.connection = { remoteAddress: '192.168.1.20' };
    var res = { body: '', writeHead: function (code) { res.code = code; }, end: function (b) {
      res.body += b || '';
      assert.equal(res.code, 200);
      assert.equal(JSON.parse(res.body).temperature, 14);
      done();
    } };
    routes.handleRequest(req, res);
  }
];

(function next(i) {
  if (i === tests.length) return console.log('test-weather: ' + tests.length + ' passed');
  tests[i](function () { next(i + 1); });
})(0);
