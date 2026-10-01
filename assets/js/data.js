/* ==========================================================================
   Bitbase – live market data engine
   Primary   : Binance public REST + WebSocket
   Fallbacks : Coinbase REST (candles), Kraken REST (tickers / candles)
   Offline   : deterministic simulated feed, clearly flagged as DEMO
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- coins */
  // supply is used only to derive market cap from the live price; it moves
  // slowly so a static approximation stays accurate between refreshes.
  var COINS = [
    { sym: 'BTC',  name: 'Bitcoin',  color: '#f7931a', supply: 19800000,     cb: 'BTC-USD',  kr: 'XBTUSD'  },
    { sym: 'ETH',  name: 'Ethereum', color: '#627eea', supply: 120500000,    cb: 'ETH-USD',  kr: 'ETHUSD'  },
    { sym: 'BNB',  name: 'BNB',      color: '#f3ba2f', supply: 145900000,    cb: null,       kr: null      },
    { sym: 'SOL',  name: 'Solana',   color: '#9945ff', supply: 478000000,    cb: 'SOL-USD',  kr: 'SOLUSD'  },
    { sym: 'XRP',  name: 'XRP',      color: '#00aae4', supply: 57000000000,  cb: 'XRP-USD',  kr: 'XRPUSD'  },
    { sym: 'ADA',  name: 'Cardano',  color: '#0033ad', supply: 36000000000,  cb: 'ADA-USD',  kr: 'ADAUSD'  },
    { sym: 'DOGE', name: 'Dogecoin', color: '#c2a633', supply: 147000000000, cb: 'DOGE-USD', kr: 'XDGUSD'  },
    { sym: 'AVAX', name: 'Avalanche',color: '#e84142', supply: 408000000,    cb: 'AVAX-USD', kr: 'AVAXUSD' },
    { sym: 'LINK', name: 'Chainlink',color: '#2a5ada', supply: 626000000,    cb: 'LINK-USD', kr: 'LINKUSD' },
    { sym: 'TRX',  name: 'TRON',     color: '#eb0029', supply: 95000000000,  cb: 'TRX-USD',  kr: 'TRXUSD'  },
    { sym: 'DOT',  name: 'Polkadot', color: '#e6007a', supply: 1520000000,   cb: 'DOT-USD',  kr: 'DOTUSD'  },
    { sym: 'LTC',  name: 'Litecoin', color: '#a6a9aa', supply: 75000000,     cb: 'LTC-USD',  kr: 'LTCUSD'  }
  ];

  var BINANCE_REST = 'https://api.binance.com/api/v3';
  var BINANCE_WS   = 'wss://stream.binance.com:9443/stream?streams=';
  var CB_REST      = 'https://api.exchange.coinbase.com';
  var KR_REST      = 'https://api.kraken.com/0/public';

  var INTERVALS = {
    '1m':  { sec: 60,     kr: 1,    label: '1m'  },
    '5m':  { sec: 300,    kr: 5,    label: '5m'  },
    '15m': { sec: 900,    kr: 15,   label: '15m' },
    '1h':  { sec: 3600,   kr: 60,   label: '1H'  },
    '4h':  { sec: 14400,  kr: 240,  label: '4H'  },
    '1d':  { sec: 86400,  kr: 1440, label: '1D'  },
    '1w':  { sec: 604800, kr: 10080,label: '1W'  }
  };

  var CANDLE_LIMIT = 160;

  /* -------------------------------------------------------------- helpers */
  function coin(sym) {
    for (var i = 0; i < COINS.length; i++) if (COINS[i].sym === sym) return COINS[i];
    return null;
  }
  function pair(sym) { return sym + 'USDT'; }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

  function fetchJSON(url, timeout) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeout || 9000);
    return fetch(url, ctrl ? { signal: ctrl.signal } : undefined)
      .then(function (r) {
        clearTimeout(t);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .catch(function (e) { clearTimeout(t); throw e; });
  }

  /* Small response cache – several widgets ask for the same URL, and some
     providers (Kraken) throttle bursts of identical calls. */
  var cch = {};
  function cached(url, ttl) {
    var hit = cch[url];
    var now = Date.now();
    if (hit && now - hit.at < (ttl || 8000)) return Promise.resolve(hit.val);
    return fetchJSON(url).then(function (v) {
      cch[url] = { at: Date.now(), val: v };
      return v;
    }).catch(function (e) {
      if (hit) return hit.val;            // serve stale rather than nothing
      throw e;
    });
  }

  /* POST helper. The commodity feed below is POST-only.

     The body is JSON but is deliberately labelled text/plain: that is a
     CORS-safelisted content type, so the browser sends this as a *simple*
     request with no preflight. The scanner's preflight only advertises
     "Referer,Accept", so asking for application/json gets the whole call
     rejected before it leaves the page. */
  function fetchPOST(url, body, timeout) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var t = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeout || 9000);
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: body,
      signal: ctrl ? ctrl.signal : undefined
    })
      .then(function (r) {
        clearTimeout(t);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .catch(function (e) { clearTimeout(t); throw e; });
  }

  /* Same idea as cached(), but for POST bodies that cannot live in a URL. */
  var pmemo = {};
  function memoPost(key, run, ttl) {
    var hit = pmemo[key], now = Date.now();
    if (hit && now - hit.at < (ttl || 20000)) return Promise.resolve(hit.val);
    return run.then(function (v) { pmemo[key] = { at: now, val: v }; return v; })
      .catch(function (e) { if (hit) return hit.val; throw e; });
  }

  /* Price decimal places that match how each asset is quoted. */
  function decimalsFor(p) {
    p = Math.abs(num(p));
    if (p >= 1000) return 2;
    if (p >= 100) return 2;
    if (p >= 1) return 4;
    if (p >= 0.01) return 5;
    if (p >= 0.0001) return 6;
    return 8;
  }

  function fmtPrice(p) {
    return num(p).toLocaleString('en-US', {
      minimumFractionDigits: decimalsFor(p),
      maximumFractionDigits: decimalsFor(p)
    });
  }

  /* Forex quotes five decimals so a one-pip move is actually visible; metals
     and commodity reference prices do not need crypto's extra precision. */
  function fmtInstrumentPrice(sym, p) {
    var i = instrument(sym);
    var d = (i && i.group !== 'crypto' && i.decimals) ? i.decimals : decimalsFor(p);
    return num(p).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  function fmtCompact(v) {
    v = num(v);
    if (v >= 1e12) return (v / 1e12).toFixed(2) + 'T';
    if (v >= 1e9)  return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6)  return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3)  return (v / 1e3).toFixed(2) + 'K';
    return v.toFixed(2);
  }

  function fmtVolume(v) {
    v = num(v);
    if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return v.toFixed(2);
  }

  function fmtQty(v) {
    v = num(v);
    if (v >= 1000) return v.toFixed(0);
    if (v >= 1) return v.toFixed(3);
    return v.toFixed(6);
  }

  /* =======================================================================
     MARKETS TABLE
     ==================================================================== */
  var marketState = {};   // sym -> row
  // Empty until a provider actually answers - defaulting to 'demo' would make
  // every page briefly claim it is serving fake prices.
  var marketSource = '';

  function binanceTickers() {
    var syms = COINS.map(function (c) { return '"' + pair(c.sym) + '"'; }).join(',');
    return fetchJSON(BINANCE_REST + '/ticker/24hr?symbols=' + encodeURIComponent('[' + syms + ']'), 10000)
      .then(function (arr) {
        var out = {};
        arr.forEach(function (t) {
          var s = String(t.symbol || '').replace(/USDT$/, '');
          if (!coin(s)) return;
          out[s] = {
            sym: s,
            price: num(t.lastPrice),
            change: num(t.priceChangePercent),
            volume: num(t.quoteVolume),
            high: num(t.highPrice),
            low: num(t.lowPrice)
          };
        });
        if (!Object.keys(out).length) throw new Error('empty');
        return out;
      });
  }

  function krakenTickers() {
    var pairs = COINS.map(function (c) { return c.kr; }).filter(Boolean);
    if (!pairs.length) return Promise.reject(new Error('no kraken pairs'));
    return krakenBatch(pairs).then(function (batch) {
      var out = {};
      COINS.forEach(function (c) {
        var d = c.kr ? batch[c.kr] : null;
        if (!d) return;
        out[c.sym] = {
          sym: c.sym, price: d.price, change: d.change,
          volume: d.volume, high: d.high, low: d.low
        };
      });
      if (!Object.keys(out).length) throw new Error('kraken empty');
      return out;
    });
  }

  /* Last-resort fallback only – Coinbase throttles bursts, so fan out 3 at a
     time rather than firing all twelve at once. */
  function coinbaseTickers() {
    var targets = COINS.filter(function (c) { return !!c.cb; });
    var out = {};
    var i = 0;
    function worker() {
      if (i >= targets.length) return Promise.resolve();
      var c = targets[i++];
      return cached(CB_REST + '/products/' + c.cb + '/stats', 8000).then(function (s) {
        var last = num(s.last), open = num(s.open);
        if (last > 0) {
          out[c.sym] = {
            sym: c.sym, price: last,
            change: open ? ((last - open) / open) * 100 : 0,
            volume: last * num(s.volume), high: num(s.high), low: num(s.low)
          };
        }
      }).catch(function () {}).then(worker);
    }
    return Promise.all([worker(), worker(), worker()]).then(function () {
      if (!Object.keys(out).length) throw new Error('coinbase empty');
      return out;
    });
  }

  /* Deterministic offline feed – anchored to the values the original site
     ships with, then random-walked so the UI stays usable with no network. */
  var SEED = {
    BTC:  64464.00, ETH: 1880.96, BNB: 569.95, SOL: 74.78,
    XRP:  1.1006,  ADA: 0.1650, DOGE: 0.07243, AVAX: 24.10,
    LINK: 11.28,  TRX: 0.1180, DOT: 3.240, LTC: 62.35
  };

  function demoRows() {
    var out = {};
    COINS.forEach(function (c, i) {
      var p = SEED[c.sym] || 1;
      var drift = (i % 2 ? 1 : -1) * 0.12;
      out[c.sym] = {
        sym: c.sym, price: p, change: drift * 4,
        volume: (1.2e9 / (i + 1.4)), high: p * 1.04, low: p * 0.96, demo: true
      };
    });
    return out;
  }

  function hydrate(raw) {
    var rows = [];
    Object.keys(raw).forEach(function (s) {
      var c = coin(s);
      if (!c) return;
      var r = raw[s];
      rows.push({
        sym: c.sym, name: c.name, color: c.color,
        price: r.price, change: r.change, volume: r.volume,
        high: r.high, low: r.low,
        cap: r.price * c.supply,
        spark: null, demo: !!r.demo
      });
    });
    rows.sort(function (a, b) { return b.cap - a.cap; });
    rows.forEach(function (r, i) { r.rank = i + 1; });
    return rows;
  }

  function loadMarkets() {
    return binanceTickers()
      .then(function (r) { marketSource = 'Binance'; return r; })
      .catch(function () {
        return krakenTickers()
          .then(function (r) { marketSource = 'Kraken'; return r; })
          .catch(function () {
            return coinbaseTickers()
              .then(function (r) { marketSource = 'Coinbase'; return r; })
              .catch(function () { marketSource = 'demo'; return demoRows(); });
          });
      })
      .then(function (raw) {
        marketState = raw;
        return hydrate(raw);
      });
  }

  function pollMarkets() {
    if (marketSource === 'demo') return Promise.resolve(hydrate(marketState));
    return binanceTickers()
      .then(function (raw) { marketState = raw; return hydrate(raw); })
      .catch(function () { return null; });   // keep previous data
  }

  /* Merge a single live price tick into the snapshot. */
  function applyTick(sym, price, open24h, baseVol) {
    var r = marketState[sym];
    if (!r || !price) return null;
    var prev = r.price;
    r.price = price;
    var c = coin(sym);
    if (c) r.cap = price * c.supply;
    if (open24h) r.change = ((price - open24h) / open24h) * 100;
    if (baseVol) r.volume = baseVol * price;
    return { sym: sym, price: price, prev: prev, change: r.change, cap: r.cap, volume: r.volume };
  }

  /* 7 days of hourly closes for the markets table sparkline. */
  function loadSpark(sym) {
    return fetchJSON(BINANCE_REST + '/klines?symbol=' + pair(sym) + '&interval=1h&limit=168', 10000)
      .then(function (rows) { return rows.map(function (k) { return num(k[4]); }); })
      .catch(function () { return null; });
  }

  function totalVolume() {
    return Object.keys(marketState).reduce(function (s, k) { return s + num(marketState[k].volume); }, 0);
  }

  /* True 24h spot volume across every USDT pair on the venue – one request. */
  var globalVol = { value: 0, at: 0 };
  function loadGlobalVolume() {
    return fetchJSON(BINANCE_REST + '/ticker/24hr', 15000).then(function (arr) {
      if (!Array.isArray(arr)) throw new Error('bad payload');
      var sum = 0, n = 0;
      arr.forEach(function (t) {
        if (String(t.symbol || '').slice(-4) !== 'USDT') return;
        sum += num(t.quoteVolume); n++;
      });
      if (!n) throw new Error('no pairs');
      globalVol = { value: sum, at: Date.now() };
      return sum;
    }).catch(function () { return globalVol.value || 0; });
  }

  /* =======================================================================
     CANDLES
     ==================================================================== */
  function binanceKlines(sym, interval) {
    return fetchJSON(
      BINANCE_REST + '/klines?symbol=' + pair(sym) + '&interval=' + interval + '&limit=' + CANDLE_LIMIT, 10000
    ).then(function (rows) {
      if (!Array.isArray(rows) || !rows.length) throw new Error('no klines');
      return rows.map(function (k) {
        return {
          time: k[0] / 1000,
          open: num(k[1]), high: num(k[2]), low: num(k[3]),
          close: num(k[4]), volume: num(k[5])
        };
      });
    });
  }

  function coinbaseCandles(sym, interval) {
    var c = coin(sym);
    if (!c || !c.cb) return Promise.reject(new Error('no cb product'));
    return fetchJSON(
      CB_REST + '/products/' + c.cb + '/candles?granularity=' + INTERVALS[interval].sec, 10000
    ).then(function (rows) {
      if (!Array.isArray(rows) || !rows.length) throw new Error('no candles');
      return rows.map(function (r) {
        return { time: r[0], low: num(r[1]), high: num(r[2]), open: num(r[3]), close: num(r[4]), volume: num(r[5]) };
      }).sort(function (a, b) { return a.time - b.time; });
    });
  }

  function krakenCandles(sym, interval) {
    var c = coin(sym);
    if (!c || !c.kr) return Promise.reject(new Error('no kraken pair'));
    return fetchJSON(
      KR_REST + '/OHLC?pair=' + c.kr + '&interval=' + INTERVALS[interval].kr, 10000
    ).then(function (r) {
      if (!r || (r.error && r.error.length) || !r.result) throw new Error('kraken error');
      var key = Object.keys(r.result).filter(function (k) { return k !== 'last'; })[0];
      var rows = key ? r.result[key] : null;
      if (!rows || !rows.length) throw new Error('no kraken candles');
      return rows.map(function (r) {
        return { time: r[0] * 1000, open: num(r[1]), high: num(r[2]), low: num(r[3]), close: num(r[4]), volume: num(r[6]) };
      });
    });
  }

  /* Offline candles: build a plausible walk around the seed price, anchored
     so the newest candle ends at the current quote. */
  function demoCandles(sym, interval) {
    var step = INTERVALS[interval].sec;
    var last = num((marketState[sym] || {}).price) || SEED[sym] || 1;
    var n = CANDLE_LIMIT, out = [], t = Math.floor(Date.now() / 1000 / step) * step;
    var vol = Math.max(last * 0.004, 1e-6);
    var p = last * (1 - 0.06);
    var seed = 0;
    for (var s = 0; s < sym.length; s++) seed = (seed * 31 + sym.charCodeAt(s)) >>> 0;
    for (var i = n - 1; i >= 0; i--) {
      var drift = ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.47) * vol;
      var o = p, c = Math.max(o + drift, last * 0.05);
      var wick = vol * (0.3 + ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 0.9);
      out.push({
        time: t - i * step, open: o, close: c,
        high: Math.max(o, c) + wick * 0.6,
        low: Math.min(o, c) - wick * 0.6,
        volume: vol * (0.5 + ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 1.5)
      });
      p = o;
    }
    // Pin the final candle to the live quote.
    var lastC = out[out.length - 1];
    lastC.close = last; lastC.high = Math.max(lastC.high, last); lastC.low = Math.min(lastC.low, last);
    return out;
  }

  function loadCandles(sym, interval) {
    // Metals / forex / commodities have their own venues; do not send them
    // through the crypto path, they would come back as unrelated data.
    var inst = instrument(sym);
    if (inst && inst.group !== 'crypto') return loadInstrumentCandles(inst, interval);
    return binanceKlines(sym, interval)
      .then(function (c) { return { candles: c, source: 'Binance' }; })
      .catch(function () {
        return coinbaseCandles(sym, interval)
          .then(function (c) { return { candles: c, source: 'Coinbase' }; })
          .catch(function () {
            return krakenCandles(sym, interval)
              .then(function (c) { return { candles: c, source: 'Kraken' }; })
              .catch(function () { return { candles: demoCandles(sym, interval), source: 'Demo feed' }; });
          });
      });
  }

  /* Kraken publishes real OHLC for the FX pairs, so forex charts are genuine
     historical candles. */
  function krakenPairCandles(pair, interval) {
    return fetchJSON(
      KR_REST + '/OHLC?pair=' + pair + '&interval=' + INTERVALS[interval].kr, 10000
    ).then(function (r) {
      if (!r || (r.error && r.error.length) || !r.result) throw new Error('kraken error');
      var key = Object.keys(r.result).filter(function (k) { return k !== 'last'; })[0];
      var rows = key ? r.result[key] : null;
      if (!rows || !rows.length) throw new Error('no kraken candles');
      return rows.map(function (x) {
        return { time: x[0] * 1000, open: num(x[1]), high: num(x[2]), low: num(x[3]), close: num(x[4]), volume: num(x[6]) };
      });
    });
  }

  /* Spot metals and commodities have no exchange to serve OHLC history, only a
     live quote. Build a reference path anchored to that real quote and say so
     in the source label, rather than implying exchange history we do not have. */
  function spotReferenceCandles(inst, interval, quote) {
    var step = INTERVALS[interval].sec;
    var last = num(quote);
    if (!last) return Promise.reject(new Error('no spot quote for ' + inst.sym));
    var n = CANDLE_LIMIT, out = [], t = Math.floor(Date.now() / 1000 / step) * step;
    var vol = Math.max(last * 0.002, 1e-6);
    var p = last * (1 - 0.012);
    var seed = 0;
    for (var s = 0; s < inst.sym.length; s++) seed = (seed * 31 + inst.sym.charCodeAt(s)) >>> 0;
    for (var i = n - 1; i >= 0; i--) {
      var drift = ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.47) * vol;
      var o = p, c = Math.max(o + drift, last * 0.2);
      var wick = vol * (0.3 + ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 0.9);
      out.push({
        time: t - i * step, open: o, close: c,
        high: Math.max(o, c) + wick * 0.6,
        low: Math.min(o, c) - wick * 0.6, volume: 0
      });
      p = o;
    }
    var tail = out[out.length - 1];
    tail.close = last; tail.high = Math.max(tail.high, last); tail.low = Math.min(tail.low, last);
    return out;
  }

  function loadInstrumentCandles(inst, interval) {
    if (inst.venue === VENUE.BINANCE) {
      return binanceKlines(inst.pair.replace(/USDT$/, ''), interval)
        .then(function (c) { return { candles: c, source: 'Binance (' + inst.sym + ')' }; })
        .catch(function () { return { candles: demoCandles(inst.sym, interval), source: 'Indicative (' + inst.sym + ')' }; });
    }
    if (inst.venue === VENUE.KRAKEN) {
      return krakenPairCandles(inst.pair, interval)
        .then(function (c) { return { candles: c, source: 'Kraken' }; })
        .catch(function () {
          return quoteFor(inst).then(function (q) {
            return { candles: spotReferenceCandles(inst, interval, q), source: 'Spot reference (' + inst.name + ')' };
          });
        });
    }
    if (inst.venue === VENUE.TV) {
      // The scanner publishes a live quote but no history, so the path is built
      // around the real current price and the source line says so.
      return quoteFor(inst).then(function (q) {
        return { candles: spotReferenceCandles(inst, interval, q), source: 'Futures reference (' + inst.name + ')' };
      });
    }
    return quoteFor(inst).then(function (q) {
      return { candles: spotReferenceCandles(inst, interval, q), source: 'Spot reference (' + inst.name + ')' };
    });
  }

  /* Latest real quote for a non-crypto instrument. The last good price is
     kept so one failed poll does not blank the chart. */
  var lastGroupQuote = {};
  function quoteFor(inst) {
    function remember(p) { if (p) lastGroupQuote[inst.sym] = p; return p; }
    function fallback() { return lastGroupQuote[inst.sym] || 0; }
    if (inst.venue === VENUE.BINANCE) {
      return binanceOne(inst.pair).then(function (d) { return remember(d.price); }).catch(fallback);
    }
    if (inst.venue === VENUE.KRAKEN) {
      return krakenBatch([inst.pair]).then(function (d) {
        return remember(d[inst.pair] ? d[inst.pair].price : 0);
      }).catch(fallback);
    }
    if (inst.venue === VENUE.TV) {
      return tvOne(inst.pair).then(function (d) { return remember(d ? d.price : 0); }).catch(fallback);
    }
    return goldOne(inst.ga).then(function (d) { return remember(d.price); }).catch(fallback);
  }

  /* =======================================================================
     STREAM – one socket carries candles, agg trades and every mini ticker
     ==================================================================== */
  var stream = { ws: null, state: 'idle', retry: 0, handlers: null, pollTimer: null, key: '' };

  function setState(s) {
    stream.state = s;
    if (stream.handlers && stream.handlers.onStatus) stream.handlers.onStatus(s);
  }

  function closeStream() {
    if (stream.ws) { try { stream.ws.close(); } catch (e) {} }
    stream.ws = null;
    if (stream.pollTimer) { clearInterval(stream.pollTimer); stream.pollTimer = null; }
    stream.pollInst = null;
    stream.pollInterval = null;
    stream.retry = 0;
    setState('idle');
  }

  function startFallbackPolling() {
    if (stream.pollTimer) return;
    setState('polling');
    stream.pollTimer = setInterval(function () {
      if (stream.handlers && stream.handlers.onMarkets) {
        pollMarkets().then(function (rows) {
          if (rows && stream.handlers.onMarkets) stream.handlers.onMarkets(rows, true);
        });
      } else {
        pollTickers();
      }
    }, 10000);
  }

  /* Metals / forex / commodities have no Binance kline socket here, so poll the
     venue that quotes them and push a candle built from the live price. The
     candle keeps the current bar's open and rolls over on the interval, which
     is what a live series should look like. */
  function openInstrumentStream(inst, interval) {
    stream.pollInst = inst;
    stream.pollInterval = interval;
    setState('connecting');

    var step = INTERVALS[interval].sec * 1000;
    var bar = { open: 0, high: 0, low: 0, close: 0, time: 0, volume: 0 };

    function tick() {
      quoteFor(inst).then(function (price) {
        price = num(price);
        if (!price) { setState('offline'); return; }
        var now = Date.now();
        var bucket = Math.floor(now / step) * step;
        if (!bar.close || bar.time !== bucket) {
          bar = { open: price, high: price, low: price, close: price, time: bucket, volume: 0 };
        } else {
          bar.close = price;
          bar.high = Math.max(bar.high, price);
          bar.low = Math.min(bar.low, price);
        }
        setState('live');
        if (stream.handlers && stream.handlers.onCandle) {
          stream.handlers.onCandle({ time: bucket / 1000, open: bar.open, high: bar.high, low: bar.low, close: price, volume: 0, closed: false });
        }
        if (stream.handlers && stream.handlers.onTrade) {
          stream.handlers.onTrade({ price: price, qty: 0, time: now / 1000, side: 'buy' });
        }
      }).catch(function () { setState('offline'); });
    }

    tick();
    var every = interval === '1d' || interval === '1w' ? 30000 : 8000;
    stream.pollTimer = setInterval(tick, every);
  }

  /* opts: { onCandle, onTrade, onTickers, onStatus, onMarkets } */
  function openStream(sym, interval, opts) {
    closeStream();
    stream.handlers = opts || {};
    stream.key = sym + ':' + interval;

    var inst = instrument(sym);
    if (inst && inst.group !== 'crypto') return openInstrumentStream(inst, interval);

    if (typeof global.WebSocket === 'undefined') { startFallbackPolling(); return; }

    var p = pair(sym).toLowerCase();
    var url = BINANCE_WS + [
      p + '@kline_' + interval,
      p + '@aggTrade',
      '!miniTicker@arr'
    ].join('/');

    var ws;
    try { ws = new global.WebSocket(url); } catch (e) { startFallbackPolling(); return; }
    stream.ws = ws;
    setState('connecting');

    ws.onopen = function () { stream.retry = 0; setState('live'); };

    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      var d = msg.data || msg;
      if (!d) return;

      if (d.e === 'kline' && stream.handlers.onCandle) {
        var k = d.k;
        stream.handlers.onCandle({
          time: k.t / 1000, open: num(k.o), high: num(k.h),
          low: num(k.l), close: num(k.c), volume: num(k.v),
          closed: !!k.x, trades: k.n
        });
      } else if (d.e === 'aggTrade' && stream.handlers.onTrade) {
        stream.handlers.onTrade({ price: num(d.p), qty: num(d.q), time: (d.T || Date.now()) / 1000, side: d.m ? 'sell' : 'buy' });
      } else if (Array.isArray(d) && stream.handlers.onTickers) {
        stream.handlers.onTickers(d);
      }
    };

    ws.onerror = function () { /* onclose handles recovery */ };

    ws.onclose = function () {
      stream.ws = null;
      if (stream.key !== sym + ':' + interval) return;   // superseded
      startFallbackPolling();
      var delay = Math.min(15000, 1500 * Math.pow(2, stream.retry++));
      setTimeout(function () { if (stream.key === sym + ':' + interval) openStream(sym, interval, opts); }, delay);
    };
  }

  /* =======================================================================
     NON-CRYPTO CLASSES – metals, forex, commodities
     Every price below comes from a live public feed. Where a provider does
     not publish a 24h change, the field is reported as null (rendered "—")
     rather than being invented.
     ==================================================================== */
  var GOLD_API = 'https://api.gold-api.com/price/';
  /* TradingView's public scanner is the only key-free feed that quotes oil, gas
     and grains with CORS headers, so a browser can read it directly. It serves
     front-month futures, which is why each contract carries its own decimals
     and unit: natural gas quotes to 3 places, copper to 4, grain in
     cents per bushel. */
  var TV_SCAN = 'https://scanner.tradingview.com/futures/scan';
  var TV_COLUMNS = ['close', 'change', 'change_abs', 'volume', 'high', 'low'];

  var GROUPS = {
    metals: [
      { sym: 'XAU',  name: 'Gold',          color: '#d4af37', kind: 'binance', pair: 'PAXGUSDT',  unit: 'troy oz', supply: 394000000 },
      { sym: 'XAUT', name: 'Tether Gold',   color: '#c9a961', kind: 'binance', pair: 'XAUTUSDT',  unit: 'troy oz', supply: 14000000 },
      { sym: 'XAG',  name: 'Silver',        color: '#c0c0c0', kind: 'gold',    ga: 'XAG',      unit: 'troy oz', supply: 1480000000 },
      { sym: 'XPT',  name: 'Platinum',      color: '#e5e4e2', kind: 'gold',    ga: 'XPT',      unit: 'troy oz', supply: 78000000 },
      { sym: 'XPD',  name: 'Palladium',     color: '#ced0dd', kind: 'gold',    ga: 'XPD',      unit: 'troy oz', supply: 80000000 }
    ],
    forex: [
      { sym: 'EURUSD', name: 'Euro / US Dollar',     color: '#2a5ada', kr: 'EURUSD' },
      { sym: 'GBPUSD', name: 'British Pound / Dollar', color: '#8b5cf6', kr: 'GBPUSD' },
      { sym: 'AUDUSD', name: 'Australian Dollar / Dollar', color: '#16c784', kr: 'AUDUSD' },
      { sym: 'USDCAD', name: 'US Dollar / Canadian Dollar', color: '#ea3943', kr: 'USDCAD' },
      { sym: 'USDCHF', name: 'US Dollar / Swiss Franc', color: '#f7931a', kr: 'USDCHF' },
      { sym: 'USDJPY', name: 'US Dollar / Japanese Yen', color: '#fdb022', kr: 'USDJPY' }
    ],
    commodities: [
      { sym: 'WTI',   name: 'WTI Crude Oil',   color: '#3b7dd8', kind: 'tv', tv: 'NYMEX:CL1!', unit: 'barrel', dec: 2 },
      { sym: 'BRENT', name: 'Brent Crude Oil', color: '#5b8c2a', kind: 'tv', tv: 'NYMEX:BZ1!', unit: 'barrel', dec: 2 },
      { sym: 'HG',    name: 'Copper',          color: '#b87333', kind: 'tv', tv: 'COMEX:HG1!', unit: 'lb',     dec: 4 },
      { sym: 'NG',    name: 'Natural Gas',     color: '#7a5af8', kind: 'tv', tv: 'NYMEX:NG1!', unit: 'MMBtu',  dec: 3 },
      { sym: 'CORN',  name: 'Corn',            color: '#eab308', kind: 'tv', tv: 'CBOT:ZC1!',  unit: 'bushel', dec: 2 }
    ]
  };

  /* =======================================================================
     TRADEABLE INSTRUMENTS
     Everything the trade screen can buy, sell and chart: crypto plus the
     metals / forex / commodities groups. `venue` decides where the candles
     and the live price come from, so a gold contract is not faked onto an
     exchange feed it does not exist on.
     ==================================================================== */
  var VENUE = { BINANCE: 'binance', KRAKEN: 'kraken', SPOT: 'spot', TV: 'tv' };

  var INSTRUMENTS = (function () {
    var out = [];
    COINS.forEach(function (c) {
      out.push({
        sym: c.sym, name: c.name, group: 'crypto',
        venue: VENUE.BINANCE, pair: pair(c.sym), decimals: null
      });
    });
    Object.keys(GROUPS).forEach(function (g) {
      GROUPS[g].forEach(function (m) {
        var venue, pr, dec;
        if (m.kind === 'binance') { venue = VENUE.BINANCE; pr = m.pair; dec = 2; }
        else if (m.kr) { venue = VENUE.KRAKEN; pr = m.kr; dec = 5; }
        else if (m.kind === 'tv') { venue = VENUE.TV; pr = m.tv; dec = m.dec || 2; }
        else { venue = VENUE.SPOT; pr = m.ga; dec = 3; }
        out.push({
          sym: m.sym, name: m.name, group: g,
          venue: venue, pair: pr, ga: m.ga || null,
          unit: m.unit || null, decimals: dec
        });
      });
    });
    return out;
  })();

  function instrument(sym) {
    for (var i = 0; i < INSTRUMENTS.length; i++) {
      if (INSTRUMENTS[i].sym === sym) return INSTRUMENTS[i];
    }
    return null;
  }

  /* Crypto and metals that list on Binance reuse the normal crypto path; the
     rest need their own venue. */
  function binanceSymOf(sym) {
    var i = instrument(sym);
    if (i && i.venue === VENUE.BINANCE) return i.pair.replace(/USDT$/, '');
    return null;
  }

  /* How a symbol should be written in a pair label: crypto settles in USDT,
     forex is quoted as XXX/YYY and every other group against the dollar. */
  function pairLabel(sym) {
    var i = instrument(sym);
    if (!i) return sym + '/USDT';
    if (i.group === 'forex') return i.sym.slice(0, 3) + '/' + i.sym.slice(3);
    if (i.group === 'crypto') return i.sym + '/USDT';
    return i.sym + '/USD';
  }

  function binanceOne(p) {
    return fetchJSON(BINANCE_REST + '/ticker/24hr?symbol=' + p, 9000).then(function (t) {
      return { price: num(t.lastPrice), change: num(t.priceChangePercent), volume: num(t.quoteVolume), high: num(t.highPrice), low: num(t.lowPrice) };
    });
  }

  /* `fresh` skips the response cache - a live tick must actually hit the
     provider, otherwise a poll just re-serves the value it already had. */
  function goldOne(code, fresh) {
    var p = fresh ? fetchJSON(GOLD_API + code) : cached(GOLD_API + code, 30000);
    return p.then(function (r) {
      if (!r || !r.price) throw new Error('no gold price');
      return { price: num(r.price), change: null, volume: null, high: null, low: null, updated: r.updatedAt };
    });
  }

  /* One POST covers every commodity, so the whole tab is one request rather
     than five. Returns a map keyed by the contract symbol. `fresh` bypasses
     the memo, because a live tick has to actually reach the exchange. */
  function tvBatch(tickers, fresh) {
    if (!tickers || !tickers.length) return Promise.resolve({});
    var body = JSON.stringify({
      symbols: { tickers: tickers, query: { types: [] } },
      columns: TV_COLUMNS
    });
    var run = fetchPOST(TV_SCAN, body, 12000).then(function (r) {
      var out = {};
      (r && r.data ? r.data : []).forEach(function (row) {
        var d = row.d || [];
        out[row.s] = {
          price: num(d[0]),
          change: (d[1] === null || d[1] === undefined) ? null : num(d[1]),
          volume: (d[3] === null || d[3] === undefined) ? null : num(d[3]),
          high: num(d[4]),
          low: num(d[5])
        };
      });
      if (!Object.keys(out).length) throw new Error('no commodity quotes');
      return out;
    });
    if (fresh) return run.catch(function () { return {}; });
    return memoPost('TV|' + tickers.join(','), run, 20000);
  }

  function tvOne(code, fresh) {
    return tvBatch([code], fresh).then(function (d) { return d[code] || null; });
  }

  /* Kraken rewrites pair keys with legacy X/Z markers, e.g. EURUSD -> ZEURZUSD
     and XBTUSD -> XXBTZUSD. Stripping those markers makes both sides compare
     equal without having to know each alias. */
  function canonPair(s) { return String(s || '').toUpperCase().replace(/[XZ]/g, ''); }

  /* One request for every forex pair – Kraken throttles parallel bursts. */
  function krakenBatch(pairs) {
    return cached(KR_REST + '/Ticker?pair=' + pairs.join(','), 10000).then(function (r) {
      if (!r || (r.error && r.error.length) || !r.result) throw new Error('kraken ' + JSON.stringify(r.error || ''));
      var byPair = {};
      Object.keys(r.result).forEach(function (k) {
        if (k === 'last') return;
        byPair[canonPair(k)] = r.result[k];
      });
      var out = {};
      pairs.forEach(function (p) {
        var d = byPair[canonPair(p)];
        if (!d) return;
        var last = num(d.c && d.c[0]);
        var vwap = num(d.p && d.p[1]);
        out[p] = {
          price: last,
          change: vwap ? ((last - vwap) / vwap) * 100 : 0,
          volume: last * num(d.v && d.v[1]),
          high: num(d.h && d.h[1]),
          low: num(d.l && d.l[1])
        };
      });
      if (!Object.keys(out).length) throw new Error('kraken empty');
      return out;
    });
  }

  /* Live state for the non-crypto classes. They have no shared socket, so the
     markets page polls this and patches rows in place. */
  var groupState = {};   // group -> sym -> row

  function rememberGroup(name, rows) {
    var bucket = groupState[name] || (groupState[name] = {});
    rows.forEach(function (r) {
      if (r && r.price !== null && r.price !== undefined) bucket[r.sym] = r;
    });
    return rows;
  }

  /* One price change for a group instrument, in the same shape applyTick
     returns, so a page can patch the row without re-rendering. */
  function applyGroupTick(group, sym, price, change) {
    var bucket = groupState[group];
    var r = bucket && bucket[sym];
    if (!r || !price) return null;
    var prev = r.price;
    r.price = price;
    if (change !== null && change !== undefined) r.change = change;
    else if (prev) r.change = ((price - prev) / prev) * 100;
    if (r.supply) r.cap = price * r.supply;
    return { sym: sym, price: price, prev: prev, change: r.change, cap: r.cap, volume: r.volume };
  }

  function loadGroup(name) {
    var list = GROUPS[name];
    if (!list) return Promise.resolve([]);
    if (name === 'commodities') {
      // One batched scanner request covers the whole tab.
      return tvBatch(list.map(function (m) { return m.tv; })).then(function (data) {
        return rememberGroup(name, list.map(function (m) {
          var d = data[m.tv];
          return {
            sym: m.sym, name: m.name, color: m.color, group: name, unit: m.unit,
            price: d ? d.price : null, change: d ? d.change : null,
            volume: d ? d.volume : null, high: d ? d.high : null, low: d ? d.low : null,
            // Futures have no circulating supply, so there is no market cap to
            // show. Rendered as an em dash rather than a made-up number.
            cap: null, spark: null, failed: !d
          };
        }));
      }).catch(function () {
        return list.map(function (m) {
          return { sym: m.sym, name: m.name, color: m.color, group: name, unit: m.unit, failed: true,
                   price: null, change: null, volume: null, cap: null, spark: null };
        });
      });
    }
    if (name === 'forex') {
      return krakenBatch(list.map(function (m) { return m.kr; })).then(function (data) {
        return rememberGroup(name, list.map(function (m) {
          var d = data[m.kr];
          return {
            sym: m.sym, name: m.name, color: m.color, group: name,
            price: d ? d.price : null, change: d ? d.change : null,
            volume: d ? d.volume : null, high: d ? d.high : null, low: d ? d.low : null,
            cap: null, spark: null, failed: !d
          };
        }));
      }).catch(function () {
        return list.map(function (m) {
          return { sym: m.sym, name: m.name, color: m.color, group: name, failed: true,
                   price: null, change: null, volume: null, cap: null, spark: null };
        });
      });
    }
    return Promise.all(list.map(function (m) {
      var p = m.kind === 'binance' ? binanceOne(m.pair) : goldOne(m.ga);
      return p.then(function (d) {
        return {
          sym: m.sym, name: m.name, color: m.color, group: name, supply: m.supply,
          price: d.price, change: d.change, volume: d.volume, high: d.high, low: d.low,
          cap: m.supply ? d.price * m.supply : null,
          spark: null
        };
      }).catch(function () {
        return { sym: m.sym, name: m.name, color: m.color, group: name, supply: m.supply, failed: true,
                 price: null, change: null, volume: null, cap: null, spark: null };
      });
    })).then(function (rows) { return rememberGroup(name, rows); });
  }

  /* Fresh prices for one group instrument only, for a cheap periodic tick.
     Returns an applyGroupTick-shaped update, or null when unavailable. */
  function tickGroup(name, sym) {
    var list = GROUPS[name] || [];
    var m = list.filter(function (x) { return x.sym === sym; })[0];
    if (!m) return Promise.resolve(null);
    if (name === 'commodities') {
      return tvOne(m.tv, true).then(function (d) {
        if (!d || !d.price) return null;
        return applyGroupTick(name, sym, d.price, d.change);
      }).catch(function () { return null; });
    }
    if (name === 'forex') {
      return krakenBatch([m.kr]).then(function (d) {
        var r = d[m.kr];
        if (!r || !r.price) return null;
        return applyGroupTick(name, sym, r.price, r.change);
      }).catch(function () { return null; });
    }
    var p = m.kind === 'binance' ? binanceOne(m.pair) : goldOne(m.ga, true);
    return p.then(function (d) {
      if (!d || !d.price) return null;
      return applyGroupTick(name, sym, d.price, d.change);
    }).catch(function () { return null; });
  }

  /* Tick several instruments of one class at once. Forex needs a single
     batched Kraken request; the others fetch per symbol in parallel. */
  function tickGroupSet(name, syms) {
    var list = GROUPS[name] || [];
    var picked = (syms || []).map(function (s) {
      return list.filter(function (x) { return x.sym === s; })[0];
    }).filter(Boolean);
    if (!picked.length) return Promise.resolve([]);

    if (name === 'commodities') {
      return tvBatch(picked.map(function (m) { return m.tv; }), true).then(function (data) {
        var out = [];
        picked.forEach(function (m) {
          var d = data[m.tv];
          if (d && d.price) {
            var u = applyGroupTick(name, m.sym, d.price, d.change);
            if (u) out.push(u);
          }
        });
        return out;
      }).catch(function () { return []; });
    }

    if (name === 'forex') {
      return krakenBatch(picked.map(function (m) { return m.kr; })).then(function (d) {
        var out = [];
        picked.forEach(function (m) {
          var r = d[m.kr];
          if (r && r.price) {
            var u = applyGroupTick(name, m.sym, r.price, r.change);
            if (u) out.push(u);
          }
        });
        return out;
      }).catch(function () { return []; });
    }

    return Promise.all(picked.map(function (m) {
      var p = m.kind === 'binance' ? binanceOne(m.pair) : goldOne(m.ga, true);
      return p.then(function (d) {
        if (!d || !d.price) return null;
        return applyGroupTick(name, m.sym, d.price, d.change);
      }).catch(function () { return null; });
    })).then(function (rs) { return rs.filter(Boolean); });
  }

  /* Sparkline history for the non-crypto tabs. */
  function groupSpark(name, sym, interval) {
    var m = (GROUPS[name] || []).filter(function (x) { return x.sym === sym; })[0];
    if (!m) return Promise.resolve(null);
    var intv = '1d';
    if (m.kind === 'binance') {
      return cached(BINANCE_REST + '/klines?symbol=' + m.pair + '&interval=' + intv + '&limit=14', 60000)
        .then(function (r) { return r.map(function (k) { return num(k[4]); }); });
    }
    if (m.kind === 'gold') return Promise.resolve(null);   // provider has no history endpoint
    if (m.kind === 'tv') return Promise.resolve(null);     // scanner serves quotes only
    return cached(KR_REST + '/OHLC?pair=' + m.kr + '&interval=1440', 300000).then(function (r) {
      if (!r || (r.error && r.error.length) || !r.result) return null;
      var key = Object.keys(r.result).filter(function (k) { return k !== 'last'; })[0];
      var rows = key ? r.result[key] : null;
      if (!rows || !rows.length) return null;
      return rows.slice(-14).map(function (x) { return num(x[4]); });
    }).catch(function () { return null; });
  }

  /* Poll cadence per tab – forex/metals tick faster than crypto snapshots. */
  function reloadGroup(name) {
    if (name === 'crypto') return pollMarkets();
    return loadGroup(name);
  }

  /* Ticker-only fallback: when a page has no market snapshot, poll one and
     reshape it into the miniTicker shape the stream would have delivered. */
  function pollTickers() {
    return binanceTickers().then(function (map) {
      marketState = map;
      return hydrate(map);
    }).then(function (rows) {
      if (!stream.handlers || !stream.handlers.onTickers) return;
      stream.handlers.onTickers(rows.map(function (r) {
        return { s: r.sym + 'USDT', c: String(r.price), o: String(r.price / (1 + r.change / 100)) };
      }));
    }).catch(function () {});
  }

  /* Ticker-only stream: no kline/aggTrade subscriptions, so it stays cheap
     for pages that just need live prices. */
  function openTickerStream(onTickers, onStatus) {
    closeStream();
    stream.handlers = { onTickers: onTickers, onStatus: onStatus };
    stream.key = 'tickers';

    if (typeof global.WebSocket === 'undefined') { startFallbackPolling(); return; }

    var ws;
    try { ws = new global.WebSocket(BINANCE_WS + '!miniTicker@arr'); } catch (e) { startFallbackPolling(); return; }
    stream.ws = ws;
    setState('connecting');

    ws.onopen = function () { stream.retry = 0; setState('live'); };
    ws.onmessage = function (ev) {
      var d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      // The combined endpoint wraps the payload as { stream, data: [...] };
      // only the raw endpoint sends a bare array. Handle both.
      var payload = (d && !Array.isArray(d) && Array.isArray(d.data)) ? d.data : d;
      if (Array.isArray(payload) && onTickers) onTickers(payload);
    };
    ws.onclose = function () {
      stream.ws = null;
      if (stream.key !== 'tickers') return;
      startFallbackPolling();
      var delay = Math.min(15000, 1500 * Math.pow(2, stream.retry++));
      setTimeout(function () { if (stream.key === 'tickers') openTickerStream(onTickers, onStatus); }, delay);
    };
  }

  /* ------------------------------------------------------------------ api */
  global.BitbaseFeed = {
    coins: COINS,
    instruments: INSTRUMENTS,
    instrument: instrument,
    pairLabel: pairLabel,
    quoteFor: function (sym) {
      var i = instrument(sym);
      return i ? quoteFor(i) : Promise.resolve(0);
    },
    groups: GROUPS,
    loadGroup: loadGroup,
    tickGroup: tickGroup,
    tickGroupSet: tickGroupSet,
    applyGroupTick: applyGroupTick,
    groupRow: function (name, sym) {
      var b = groupState[name];
      return (b && b[sym]) || null;
    },
    groupSpark: groupSpark,
    reloadGroup: reloadGroup,
    intervals: INTERVALS,
    get source() { return marketSource; },
    get state() { return stream.state; },
    closeStream: closeStream,

    fmtPrice: fmtPrice,
    fmtInstrumentPrice: fmtInstrumentPrice,
    fmtCompact: fmtCompact,
    fmtVolume: fmtVolume,
    fmtQty: fmtQty,
    decimalsFor: decimalsFor,

    loadMarkets: loadMarkets,
    pollMarkets: pollMarkets,
    applyTick: applyTick,
    loadSpark: loadSpark,
    totalVolume: totalVolume,
    loadGlobalVolume: loadGlobalVolume,
    pollTickers: pollTickers,
    changeOf: function (sym) {
      var r = marketState[sym];
      return r ? r.change : null;
    },

    loadCandles: loadCandles,
    openStream: openStream,
    openTickerStream: openTickerStream
  };
})(window);
