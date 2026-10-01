/* ==========================================================================
   Bitbase – markets page
   Four live asset classes over one table, with a search box and a ticker
   stream that patches prices in place.
   ========================================================================== */
(function (global) {
  'use strict';

  var A = global.BitbaseAuth;
  var F = global.BitbaseFeed;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };



  var state = { tab: 'crypto', rows: [], cells: {}, query: '', stale: false, staleNote: null };

  function badge(state) {
    var map = {
      live: ['&#9679; LIVE', 'rgba(22,199,132,.35)'],
      connecting: ['&#9679; CONNECTING', 'rgba(253,176,34,.35)'],
      polling: ['&#9679; POLLING', 'rgba(253,176,34,.35)'],
      idle: ['&#9679; CONNECTING', 'rgba(253,176,34,.35)'],
      offline: ['&#9679; OFFLINE', 'rgba(234,57,67,.35)'],
      demo: ['&#9679; DEMO DATA', 'rgba(139,92,246,.35)']
    };
    var m = map[state] || map.connecting;
    var b = $('#liveBadge');
    if (!b) return;
    b.innerHTML = m[0];
    b.style.color = m[1];
  }

  function visible() {
    var q = state.query.trim().toLowerCase();
    if (!q) return state.rows;
    return state.rows.filter(function (r) {
      return (r.name + ' ' + r.sym).toLowerCase().indexOf(q) >= 0;
    });
  }

  function loading(text) {
    $('#marketBody').innerHTML =
      '<tr><td colspan="8" class="text-center" style="padding:56px;color:var(--text-tertiary);font-size:14px;">' +
      '<div style="display:flex;flex-direction:column;align-items:center;gap:12px;">' +
      '<div style="width:28px;height:28px;border:2px solid #f7931a;border-top-color:transparent;border-radius:50%;animation:tsp .7s linear infinite;"></div>' +
      (text || 'Loading real-time prices...') + '</div></td></tr>';
  }

  /* Price with the precision that class actually trades at. */
  function priceText(sym, p) {
    return F.fmtInstrumentPrice ? F.fmtInstrumentPrice(sym, p) : F.fmtPrice(p);
  }

  function rowHtml(c, i) {
    var chg = c.change === null || c.change === undefined ? null : c.change;
    var color = chg === null ? '#8a8a8a' : (chg >= 0 ? '#16c784' : '#ea3943');
    var sign = chg === null ? '' : (chg >= 0 ? '+' : '');
    var price = c.price === null || c.price === undefined ? '&mdash;' : '$' + priceText(c.sym, c.price);
    var vol = c.volume === null || c.volume === undefined ? '&mdash;' : '$' + F.fmtVolume(c.volume);
    var cap = c.cap === null || c.cap === undefined ? '&mdash;' : '$' + F.fmtCompact(c.cap);
    var label = String(c.sym).replace(/US(D|T)$/, '').slice(0, 3);
    // Every listed instrument - crypto, metals, forex and commodities - can be
    // traded, so link them all into the trade screen.
    var tradable = !!(F.instrument && F.instrument(c.sym));

    return '<tr data-sym="' + c.sym + '">' +
      '<td style="color:var(--text-tertiary);">' + (c.rank || i + 1) + '</td>' +
      '<td><div style="display:flex;align-items:center;gap:12px;">' +
        '<div style="width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:' + c.color + '20;flex-shrink:0;">' +
          '<span style="font-size:11px;font-weight:700;color:' + c.color + ';">' + label + '</span></div>' +
        '<div><div style="font-weight:500;">' + c.name + '</div>' +
        '<div style="font-size:12px;color:var(--text-tertiary);">' + c.sym + '</div></div>' +
      '</div></td>' +
      '<td class="text-right font-mono js-price">' + price + '</td>' +
      '<td class="text-right font-mono js-chg" style="color:' + color + ';">' +
        (chg === null ? '&mdash;' : sign + chg.toFixed(2) + '%') + '</td>' +
      '<td class="text-right font-mono" style="color:var(--text-secondary);">' + vol + '</td>' +
      '<td class="text-right font-mono js-cap" style="color:var(--text-secondary);">' + cap + '</td>' +
      '<td class="text-center js-spark"><span style="font-size:12px;color:var(--text-tertiary);">&hellip;</span></td>' +
      '<td class="text-right">' + (tradable
        ? '<a href="trade.html?pair=' + c.sym + '" class="px-4 py-1.5 rounded-lg text-[13px] font-medium text-white" style="background:linear-gradient(135deg,#F7931A,#FDB022);text-decoration:none;">Trade</a>'
        : '<span style="font-size:12px;color:var(--text-tertiary);">&mdash;</span>') + '</td>' +
    '</tr>';
  }

  function render(rows) {
    state.rows = rows;
    var list = visible();
    var body = $('#marketBody');
    if (!list.length) {
      body.innerHTML = '<tr><td colspan="8" class="text-center" style="padding:56px;color:var(--text-tertiary);">No markets match "' +
        state.query.replace(/[<>&]/g, '') + '"</td></tr>';
      return;
    }
    body.innerHTML = list.map(rowHtml).join('');
    state.cells = {};
    list.forEach(function (c) {
      var tr = body.querySelector('tr[data-sym="' + c.sym + '"]');
      if (tr) state.cells[c.sym] = { price: $('.js-price', tr), chg: $('.js-chg', tr), cap: $('.js-cap', tr), spark: $('.js-spark', tr) };
    });
    loadSparks(list);
  }

  function loadSparks(list) {
    var i = 0;
    (function next() {
      if (i >= list.length) return;
      var c = list[i++];
      var get = state.tab === 'crypto' ? F.loadSpark(c.sym) : F.groupSpark(state.tab, c.sym, '1d');
      get.then(function (pts) {
        var cell = state.cells[c.sym];
        if (cell && cell.spark) {
          if (pts && pts.length > 2) cell.spark.innerHTML = sparkSvg(c.sym, pts);
          // No history from this feed. An em dash matches how the other
          // unavailable columns read, and "n/a" looked like an error.
          else cell.spark.innerHTML = '<span style="font-size:12px;color:var(--text-tertiary);">&mdash;</span>';
        }
        next();
      }).catch(next);
    })();
  }

  function sparkSvg(sym, pts) {
    var up = pts[pts.length - 1] >= pts[0];
    var color = up ? '#16c784' : '#ea3943';
    var min = Math.min.apply(null, pts), max = Math.max.apply(null, pts);
    var range = (max - min) || 1;
    var W = 80, H = 32, step = W / (pts.length - 1);
    var d = pts.map(function (v, i) {
      return (i * step).toFixed(1) + ',' + (H - 2 - ((v - min) / range) * (H - 4)).toFixed(1);
    }).join(' ');
    return '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" style="display:inline-block;vertical-align:middle;">' +
      '<defs><linearGradient id="msp-' + sym + '" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.28"/>' +
      '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>' +
      '<polygon points="0,' + H + ' ' + d + ' ' + W + ',' + H + '" fill="url(#msp-' + sym + ')"/>' +
      '<polyline points="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';
  }

  function loadTab(tab) {
    state.tab = tab;
    state.cells = {};
    state.stale = false;
    if (state.staleNote) { state.staleNote.remove(); state.staleNote = null; }
    loading(tab === 'crypto' ? 'Loading real-time crypto prices...' : 'Loading live ' + tab + ' prices...');
    var p = tab === 'crypto' ? F.loadMarkets() : F.loadGroup(tab);
    p.then(function (rows) {
      render(rows);
      note(tab);
    }).catch(function () {
      $('#marketBody').innerHTML =
        '<tr><td colspan="8" class="text-center" style="padding:56px;color:var(--ea3943);">Could not reach the ' + tab + ' feed. Please retry.</td></tr>';
    });
  }

  function note(tab) {
    var n = $('#marketsNote');
    if (!n) return;
    var src = tab === 'crypto' ? F.source
      : tab === 'forex' ? 'Kraken'
      : tab === 'metals' ? 'Binance + gold-api.com'
      : 'TradingView front-month futures';
    var text = tab === 'crypto'
      ? 'Live prices and 24h stats from ' + src + ' \u00b7 charts are 7-day closes \u00b7 market cap uses circulating supply.'
      : tab === 'commodities'
      // Futures have no circulating supply and the scanner serves quotes only,
      // so no cap and no 7-day closes are shown rather than inventing either.
      ? 'Live commodity prices and 24h stats from ' + src + '. Futures carry no market cap, and this feed publishes no daily history, so both show \u201c\u2014\u201d.'
      : 'Live ' + tab + ' prices from ' + src + '. Metal caps use above-ground supply; \u201c\u2014\u201d marks fields the provider does not publish.';
    // Freshness is its own line so it never runs into the note text.
    n.textContent = '';
    var f = document.createElement('span');
    f.id = 'freshness';
    f.style.cssText = 'display:block;margin-bottom:2px;font-weight:600;';
    n.appendChild(f);
    n.appendChild(document.createTextNode(text));
    if (state.staleNote) state.staleNote = null;
    updateFreshness();
  }

  /* Live price patch so rows never re-render. */
  function tick(upd) {
    var cell = state.cells[upd.sym];
    if (!cell || !upd.price) return;
    var txt = '$' + priceText(upd.sym, upd.price);
    if (cell.price.textContent !== txt) {
      var was = parseFloat(String(cell.price.textContent).replace(/[^0-9.]/g, ''));
      cell.price.textContent = txt;
      if (isFinite(was)) {
        var cls = upd.price > was ? 'flash-up' : 'flash-down';
        cell.price.classList.remove('flash-up', 'flash-down');
        void cell.price.offsetWidth;
        cell.price.classList.add(cls);
      }
    }
    if (cell.chg && upd.change !== null && upd.change !== undefined) {
      cell.chg.textContent = (upd.change >= 0 ? '+' : '') + upd.change.toFixed(2) + '%';
      cell.chg.style.color = upd.change >= 0 ? '#16c784' : '#ea3943';
    }
    if (cell.cap && upd.cap !== null && upd.cap !== undefined) {
      cell.cap.textContent = '$' + F.fmtCompact(upd.cap);
    }
    state.stale = false;
    if (state.staleNote) state.staleNote.remove(), state.staleNote = null;
  }

  // Poll cadence per class: Kraken batches all six FX pairs into one request,
  // metals mix Binance and the free gold-api endpoint, and commodities are a
  // single slow-moving reference price, so each gets its own rhythm.
  var POLL_MS = { forex: 10000, metals: 20000, commodities: 30000 };
  var lastPoll = {};
  var lastTickAt = 0;

  /* Crypto rides the shared miniTicker socket; the other classes have no
     socket, so poll only the rows currently on screen. */
  function pollGroup() {
    var tab = state.tab;
    if (tab === 'crypto') return;
    var syms = Object.keys(state.cells);
    if (!syms.length) return;
    var now = Date.now();
    if (now - (lastPoll[tab] || 0) < (POLL_MS[tab] || 30000)) return;
    lastPoll[tab] = now;

    var got = 0;
    // One batched call per cycle - forex in particular must not fan out into
    // six separate Kraken requests.
    F.tickGroupSet(tab, syms).then(function (updates) {
      if (state.tab !== tab) return;
      got = updates.length;
      updates.forEach(function (u) { tick(u); });
      setTimeout(function () {
        if (state.tab !== tab) return;
        if (got) { lastTickAt = Date.now(); clearStale(); }
        else markStale(tab);
      }, 800);
    });
  }

  function clearStale() {
    state.stale = false;
    if (state.staleNote) { state.staleNote.remove(); state.staleNote = null; }
    updateFreshness();
  }

  function markStale(tab) {
    state.stale = true;
    if (state.staleNote) return;
    var n = $('#marketsNote');
    if (!n) return;
    var s = document.createElement('span');
    s.id = 'staleNote';
    s.style.color = '#fdb022';
    s.textContent = '  \u00b7  no ' + tab + ' quote on the last attempt';
    n.appendChild(s);
    state.staleNote = s;
  }

  /* Show how long ago the last price actually landed, so a class whose
     provider publishes slowly never looks frozen. */
  function updateFreshness() {
    var el = $('#freshness');
    if (!el) return;
    if (state.tab === 'crypto') { el.textContent = 'streaming'; el.style.color = 'var(--green)'; return; }
    if (!lastTickAt) { el.textContent = 'awaiting first tick'; el.style.color = '#b0b0b0'; return; }
    var s = Math.max(0, Math.round((Date.now() - lastTickAt) / 1000));
    el.textContent = 'updated ' + s + 's ago';
    el.style.color = s > 90 ? '#fdb022' : 'var(--green)';
  }

  function boot() {
  if (!global.BitbaseShell.mount({ active: 'markets' })) return;
    badge('connecting');

    $$('.tab-btn[data-tab]').forEach(function (t) {
      t.addEventListener('click', function () {
        $$('.tab-btn[data-tab]').forEach(function (x) {
          x.classList.remove('active');
          x.style.background = '';
          x.style.borderColor = 'rgba(255,255,255,0.08)';
          x.style.color = '#b0b0b0';
        });
        t.classList.add('active');
        t.style.background = 'rgba(247,147,26,0.15)';
        t.style.borderColor = 'rgba(247,147,26,0.2)';
        t.style.color = '#fdb022';
        loadTab(t.dataset.tab);
      });
    });

    var search = $('#searchInput');
    search.addEventListener('input', function () {
      state.query = search.value;
      if (state.rows.length) render(state.rows);
    });

    loadTab('crypto');

    F.openTickerStream(function (arr) {
      for (var i = 0; i < arr.length; i++) {
        var t = arr[i];
        if (!t || !t.s) continue;
        var sym = String(t.s).replace(/USDT$/, '');
        var u = F.applyTick(sym, parseFloat(t.c), parseFloat(t.o), parseFloat(t.v));
        if (u) tick(u);
      }
    }, badge);

    // The socket only carries crypto, so keep the other tabs moving too.
    setInterval(pollGroup, 5000);
    setInterval(updateFreshness, 1000);
    updateFreshness();
  }
// Nothing renders until the database mirror is filled, so the first
  // paint is already the user's own data rather than a blank frame.
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', function () { A.whenReady(boot); });
  else A.whenReady(boot);
})(window);
