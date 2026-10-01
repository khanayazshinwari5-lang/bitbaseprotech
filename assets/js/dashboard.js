/* ==========================================================================
   Bitbase – dashboard
   Balances, holdings and the portfolio curve are priced from the same live
   exchange feed as the marketing site. The portfolio chart re-prices the
   account's current holdings with real historical closes, so the line is
   derived from actual market data rather than a decorative random walk.
   ========================================================================== */
(function (global) {
  'use strict';

  var A = global.BitbaseAuth;
  var F = global.BitbaseFeed;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ------------------------------------------------------ auth gate ---- */
  if (!A || !F) {
    document.body.innerHTML = '<div style="padding:60px;text-align:center;color:#b0b0b0;font-family:sans-serif">' +
      'Failed to load application scripts. <a href="index.html" style="color:#f7931a">Go home</a></div>';
    return;
  }
  if (!global.BitbaseShell.mount({ active: 'dashboard' })) return;

  /* ------------------------------------------------------ coin metadata - */
  var COINS = [
    { symbol: 'USDT', name: 'Tether',    color: '#26a17b' },
    { symbol: 'BTC',  name: 'Bitcoin',   color: '#f7931a' },
    { symbol: 'ETH',  name: 'Ethereum',  color: '#627eea' },
    { symbol: 'SOL',  name: 'Solana',    color: '#9945ff' },
    { symbol: 'BNB',  name: 'BNB',       color: '#f3ba2f' },
    { symbol: 'ADA',  name: 'Cardano',   color: '#0033ad' },
    { symbol: 'DOGE', name: 'Dogecoin',  color: '#c2a633' },
    { symbol: 'XRP',  name: 'XRP',       color: '#346aa9' },
    { symbol: 'DOT',  name: 'Polkadot',  color: '#e6007a' }
  ];

  /* Historical window per period tab. Real exchange candles, sized so each
     range spans the period it is labelled with. */
  var PERIODS = {
    '24H': { iv: '1h',  limit: 24,  label: 'the last 24 hours' },
    '7D':  { iv: '2h',  limit: 84,  label: 'the last 7 days' },
    '1M':  { iv: '12h', limit: 60,  label: 'the last 30 days' },
    '3M':  { iv: '1d',  limit: 90,  label: 'the last 90 days' },
    '1Y':  { iv: '1w',  limit: 52,  label: 'the last year' },
    'ALL': { iv: '1w',  limit: 104, label: 'all available history' }
  };

  var state = {
    period: '1M',
    qty: {},
    price: {},
    chg: {},
    series: null,       // { points:[{t,v}], source, cashOnly }
    chartTimer: null
  };

  /* ------------------------------------------------------------ helpers - */
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

  function fmtUSD(v) {
    v = num(v);
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtCompact(v) {
    v = num(v);
    if (Math.abs(v) >= 1000) return '$' + (v / 1000).toFixed(1) + 'K';
    return fmtUSD(v);
  }
  function fmtQty(n) {
    n = num(n);
    if (n === 0) return '0';
    if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 5 });
    return n.toLocaleString('en-US', { maximumFractionDigits: 8 });
  }
  function fmtAmt(n) { n = num(n); return n >= 100 ? n.toLocaleString('en-US') : n; }

  function toast(msg, ok) {
    var t = document.createElement('div');
    t.className = 'toast' + (ok ? ' ok' : '');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }

  function qtyOf(sym) { return num(state.qty[sym]); }
  function priceOf(sym) { return sym === 'USDT' ? 1 : num(state.price[sym]); }
  function holdingsValue() {
    var v = 0;
    COINS.forEach(function (c) {
      if (c.symbol === 'USDT') return;
      v += qtyOf(c.symbol) * priceOf(c.symbol);
    });
    return v;
  }
  function totalValue() { return holdingsValue() + A.cash(); }
  function cryptoQty() {
    var n = 0;
    COINS.forEach(function (c) { if (c.symbol !== 'USDT' && qtyOf(c.symbol) > 0) n++; });
    return n;
  }

  function loadQuantities() {
    var a = A.assets();
    state.qty = {};
    COINS.forEach(function (c) {
      state.qty[c.symbol] = c.symbol === 'USDT' ? A.cash() : num(a[c.symbol] && a[c.symbol].qty);
    });
  }

  function tradePnL() {
    var uid = A.get(A.KEYS.uid, '');
    var trades = A.readJSON('bb_trades_history', []) || [];
    var pnl = 0;
    trades.forEach(function (t) {
      if (!t) return;
      if (t.uid && String(t.uid) !== String(uid)) return;
      if (t.status === 'Won') pnl += num(t.profit);
      else if (t.status === 'Lost') pnl -= num(t.profit);
    });
    return pnl;
  }

  /* --------------------------------------------------------------- logos - */
  var LOGOS = {
    BTC:  '<circle cx="16" cy="16" r="16" fill="#f7931a"/><text x="16" y="22" text-anchor="middle" fill="white" font-size="16" font-weight="bold" font-family="Arial">₿</text>',
    ETH:  '<circle cx="16" cy="16" r="16" fill="#627eea"/><polygon points="16,7 23,18 16,25 9,18" fill="white"/>',
    SOL:  '<circle cx="16" cy="16" r="16" fill="#9945ff"/><text x="16" y="22" text-anchor="middle" fill="white" font-size="14" font-weight="bold" font-family="Arial">S</text>',
    BNB:  '<circle cx="16" cy="16" r="16" fill="#f3ba2f"/><text x="16" y="22" text-anchor="middle" fill="#1a1a1a" font-size="15" font-weight="bold" font-family="Arial">B</text>',
    ADA:  '<circle cx="16" cy="16" r="16" fill="#0033ad"/><text x="16" y="22" text-anchor="middle" fill="white" font-size="14" font-weight="bold" font-family="Arial">A</text>',
    DOGE: '<circle cx="16" cy="16" r="16" fill="#c2a633"/><text x="16" y="22" text-anchor="middle" fill="white" font-size="14" font-weight="bold" font-family="Arial">D</text>',
    XRP:  '<circle cx="16" cy="16" r="16" fill="#346aa9"/><text x="16" y="22" text-anchor="middle" fill="white" font-size="13" font-weight="bold" font-family="Arial">X</text>',
    DOT:  '<circle cx="16" cy="16" r="16" fill="#e6007a"/><text x="16" y="22" text-anchor="middle" fill="white" font-size="13" font-weight="bold" font-family="Arial">●</text>',
    USDT: '<circle cx="16" cy="16" r="16" fill="#26a17b"/><text x="16" y="22" text-anchor="middle" fill="white" font-size="14" font-weight="bold" font-family="Arial">₮</text>'
  };
  function coinLogo(sym) {
    return '<svg width="38" height="38" viewBox="0 0 32 32">' + (LOGOS[sym] || '') + '</svg>';
  }

  /* ------------------------------------------------------ render holdings */
  function renderHoldings() {
    var el = $('#holdingsList');
    if (!el) return;
    var html = '';
    COINS.forEach(function (c) {
      var qty = qtyOf(c.symbol);
      var price = priceOf(c.symbol);
      var val = qty * price;
      var chg = c.symbol === 'USDT' ? 0 : num(state.chg[c.symbol]);
      var badge = chg >= 0 ? 'badge-green' : 'badge-red';
      html +=
        '<div class="holding-row" data-sym="' + c.symbol + '">' +
          '<div class="holding-coin">' +
            '<div style="flex-shrink:0;width:38px;height:38px;line-height:0;">' + coinLogo(c.symbol) + '</div>' +
            '<div style="min-width:0;">' +
              '<div class="font-medium text-sm" style="color:var(--text-primary);">' + c.name + '</div>' +
              '<div class="text-xs text-secondary">' + c.symbol + (c.symbol === 'USDT' ? ' · Cash' : '') + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="font-mono text-sm js-holdings-qty" style="color:var(--text-secondary);text-align:right;">' + fmtQty(qty) + '</div>' +
          '<div class="font-mono text-sm js-holdings-val" style="color:var(--text-primary);text-align:right;min-width:82px;">' + fmtCompact(val) + '</div>' +
          '<div class="' + badge + ' js-holdings-chg" style="min-width:72px;justify-content:center;">' +
            (c.symbol === 'USDT' ? '—' : (chg >= 0 ? '+' : '') + Math.abs(chg).toFixed(2) + '%') +
          '</div>' +
        '</div>';
    });
    el.innerHTML = html;
  }

  /* Patch the two volatile cells in place so the row never re-animates. */
  function patchHoldings() {
    COINS.forEach(function (c) {
      var row = document.querySelector('#holdingsList .holding-row[data-sym="' + c.symbol + '"]');
      if (!row) return;
      var q = row.querySelector('.js-holdings-qty');
      var v = row.querySelector('.js-holdings-val');
      var g = row.querySelector('.js-holdings-chg');
      if (q) q.textContent = fmtQty(qtyOf(c.symbol));
      if (v) v.textContent = fmtCompact(qtyOf(c.symbol) * priceOf(c.symbol));
      if (g && c.symbol !== 'USDT') {
        var chg = num(state.chg[c.symbol]);
        g.className = (chg >= 0 ? 'badge-green' : 'badge-red') + ' js-holdings-chg';
        g.style.minWidth = '72px';
        g.style.justifyContent = 'center';
        g.textContent = (chg >= 0 ? '+' : '') + Math.abs(chg).toFixed(2) + '%';
      }
    });
  }

  /* --------------------------------------------------------- render stats */
  function renderStats() {
    var held = holdingsValue();
    var total = held + A.cash();
    var pnl = tradePnL();
    var pct = total > 0 ? (pnl / total * 100) : 0;
    var pos = pnl >= 0;
    var sign = pos ? '+' : '';
    var clr = pos ? 'var(--accent-green)' : 'var(--accent-red)';

    var elB = $('#statTotalBalance');
    var elC = $('#statTotalChange');
    var elP = $('#statPnL');
    var elA = $('#statAvailable');
    var elH = $('#statHoldings');
    var elHN = $('#statHoldingsCount');
    if (elB) elB.textContent = fmtUSD(total);
    if (elC) { elC.textContent = sign + fmtUSD(pnl) + ' (' + sign + pct.toFixed(1) + '%) from trades'; elC.style.color = clr; }
    if (elP) { elP.textContent = sign + fmtUSD(pnl); elP.style.color = clr; }
    if (elA) elA.textContent = fmtUSD(A.cash());
    if (elH) elH.textContent = fmtUSD(held);
    if (elHN) {
      var n = cryptoQty();
      elHN.textContent = n ? 'Across ' + n + ' asset' + (n === 1 ? '' : 's') : 'No crypto yet';
    }
  }

  /* -------------------------------------------------------- portfolio series */
  function alignTo(candles, times) {
    var map = {};
    candles.forEach(function (k) { map[k.time] = k.close; });
    var out = [], last = null;
    for (var i = 0; i < times.length; i++) {
      if (map[times[i]] !== undefined) last = map[times[i]];
      out.push(last);
    }
    return out;
  }

  function buildSeries(period) {
    var p = PERIODS[period];
    var cash = A.cash();
    var held = COINS.filter(function (c) { return c.symbol !== 'USDT' && qtyOf(c.symbol) > 0; });

    if (!held.length) {
      var n = 30, flat = [], now = Date.now();
      for (var i = 0; i < n; i++) flat.push({ t: now - (n - i) * 60000, v: cash });
      return Promise.resolve({ points: flat, source: 'Cash only', cashOnly: true });
    }

    return Promise.all(held.map(function (c) {
      return F.loadCandles(c.symbol, p.iv).then(function (r) {
        return { sym: c.symbol, candles: r.candles, source: r.source };
      }).catch(function () { return null; });
    })).then(function (all) {
      var series = all.filter(function (s) { return s && s.candles && s.candles.length > 1; });
      if (!series.length) {
        var pts = [], t0 = Date.now();
        for (var j = 0; j < 20; j++) pts.push({ t: t0 - (20 - j) * 60000, v: cash });
        return { points: pts, source: 'Unavailable', cashOnly: true };
      }

      var times = series[0].candles.map(function (k) { return k.time; });
      var aligned = series.map(function (s) { return alignTo(s.candles, times); });

      var points = times.map(function (t, i) {
        var v = cash;
        for (var s = 0; s < series.length; s++) {
          var px = aligned[s][i];
          if (px) v += qtyOf(series[s].sym) * px;
        }
        return { t: t, v: v };
      });

      // Anchor the final point to the live portfolio value so the chart always
      // agrees with the Total Balance tile.
      points[points.length - 1].v = totalValue();

      return { points: points, source: series[0].source, cashOnly: false };
    });
  }

  /* ------------------------------------------------------- render chart -- */
  function renderChart(series) {
    var svg = $('#portfolioChart');
    var empty = $('#chartEmpty');
    var loader = $('#chartLoader');
    if (!svg) return;
    // These overlays carry inline display values, so the hidden class alone
    // will not hide them.
    if (loader) { loader.classList.add('hidden'); loader.style.display = 'none'; }

    var total = totalValue();
    if (!series || !series.points || series.points.length < 2 || total <= 0) {
      svg.innerHTML = '';
      if (empty) {
        empty.classList.remove('hidden');
        empty.style.display = 'flex';
      }
      var vb = $('#chartValueBox'); if (vb) vb.classList.add('hidden');
      var ch = $('#chartChange'); if (ch) ch.textContent = '';
      var src = $('#chartSource');
      if (src) src.textContent = 'Deposit funds to start tracking your portfolio over time.';
      return;
    }
    if (empty) { empty.classList.add('hidden'); empty.style.display = 'none'; }
    var vbox = $('#chartValueBox'); if (vbox) vbox.classList.remove('hidden');

    var pts = series.points.map(function (p) { return p.v; });
    var w = 800, h = 300, pad = 20;
    var min = Math.min.apply(null, pts);
    var max = Math.max.apply(null, pts);
    if (max - min < 0.005) { min -= 0.5; max += 0.5; }      // guard a dead-flat line
    var range = max - min;

    var coords = pts.map(function (v, i) {
      return {
        x: pad + (i / (pts.length - 1)) * (w - pad * 2),
        y: pad + (1 - (v - min) / range) * (h - pad * 2)
      };
    });

    var linePath = 'M' + coords.map(function (c) { return c.x + ',' + c.y; }).join(' L');
    var areaPath = linePath + ' L' + coords[coords.length - 1].x + ',' + h + ' L' + coords[0].x + ',' + h + ' Z';
    var last = coords[coords.length - 1];
    var up = total >= pts[0];

    svg.innerHTML =
      '<defs>' +
        '<linearGradient id="lineGrad" x1="0%" y1="0%" x2="100%" y2="0%">' +
          '<stop offset="0%" stop-color="#f7931a"/><stop offset="100%" stop-color="#fdb022"/>' +
        '</linearGradient>' +
        '<linearGradient id="areaGrad" x1="0%" y1="0%" x2="0%" y2="100%">' +
          '<stop offset="0%" stop-color="#f7931a" stop-opacity="0.2"/>' +
          '<stop offset="100%" stop-color="#f7931a" stop-opacity="0"/>' +
        '</linearGradient>' +
      '</defs>' +
      '<path d="' + areaPath + '" fill="url(#areaGrad)"/>' +
      '<path d="' + linePath + '" fill="none" stroke="url(#lineGrad)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>' +
      '<circle cx="' + last.x + '" cy="' + last.y + '" r="5" fill="#fdb022"/>' +
      '<circle cx="' + last.x + '" cy="' + last.y + '" r="10" fill="#fdb022" opacity="0.2">' +
        '<animate attributeName="r" values="8;14;8" dur="2s" repeatCount="indefinite"/>' +
        '<animate attributeName="opacity" values="0.3;0.05;0.3" dur="2s" repeatCount="indefinite"/>' +
      '</circle>';

    var cv = $('#chartValue');
    var cc = $('#chartChange');
    if (cv) cv.textContent = fmtUSD(total);
    if (cc) {
      var change = total - pts[0];
      var pct = pts[0] > 0 ? (change / pts[0] * 100) : 0;
      var sign = change >= 0 ? '+' : '';
      cc.textContent = sign + fmtUSD(change) + ' (' + sign + pct.toFixed(1) + '%)';
      cc.style.color = change >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
    }

    var src = $('#chartSource');
    if (src) {
      src.textContent = series.cashOnly
        ? 'No crypto positions yet — the line tracks your cash balance over ' + PERIODS[state.period].label + '.'
        : 'Valued over ' + PERIODS[state.period].label + ' using ' + series.source +
          ' historical closes for your ' + cryptoQty() + ' current holding' + (cryptoQty() === 1 ? '' : 's') + '.';
    }
    void up;
  }

  function loadChart(showLoader) {
    var loader = $('#chartLoader');
    if (loader) { loader.classList.remove('hidden'); loader.style.display = 'flex'; }
    return buildSeries(state.period).then(function (series) {
      state.series = series;
      renderChart(series);
    }).catch(function () {
      renderChart(null);
    });
  }

  global.switchPeriod = function (period, btn) {
    if (!PERIODS[period]) return;
    $$('#periodTabs .tab-btn').forEach(function (b) { b.classList.remove('active'); });
    if (btn) btn.classList.add('active');
    state.period = period;
    loadChart(true);
  };

  /* --------------------------------------------------- recent activity --- */
  function renderRecentActivity() {
    var list = $('#recentActivityList');
    if (!list) return;
    var uid = A.get(A.KEYS.uid, '');
    var cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    var items = [];
    var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    function mine(row) {
      return (!row.userId && !row.uid && !uid) || String(row.userId || row.uid || '') === String(uid);
    }

    (A.readJSON('bb_trades_history', []) || []).forEach(function (t) {
      if (!t || !mine(t) || num(t.time) < cutoff) return;
      var won = t.status === 'Won';
      var amt = won ? num(t.profit) : -num(t.amount);
      items.push({
        time: num(t.time),
        label: (won ? 'Won ' : 'Lost ') + fmtAmt(t.amount) + ' USDT · ' + String(t.pair || '').replace('/USDT', ''),
        icon: won ? 'trending-up' : 'trending-down',
        color: won ? 'var(--accent-green)' : 'var(--accent-red)',
        bg: won ? 'rgba(22,199,132,0.1)' : 'rgba(234,57,67,0.1)',
        amount: (amt >= 0 ? '+' : '-') + fmtUSD(Math.abs(amt))
      });
    });

    A.activity.list('deposit').forEach(function (d) {
      if (num(d.time) < cutoff) return;
      var amt = num(d.amount);
      items.push({
        time: num(d.time), label: 'Deposited ' + fmtUSD(amt),
        icon: 'arrow-down-left', color: 'var(--accent-blue)', bg: 'rgba(65,105,225,0.1)',
        amount: '+' + fmtUSD(amt)
      });
    });

    A.activity.list('withdrawal').forEach(function (w) {
      if (num(w.time) < cutoff) return;
      var amt = num(w.amount);
      items.push({
        time: num(w.time), label: 'Withdrew ' + fmtUSD(amt) + ' ' + (w.coin || 'USDT'),
        icon: 'arrow-up-right', color: 'var(--accent-orange)', bg: 'rgba(247,147,26,0.1)',
        amount: '-' + fmtUSD(amt)
      });
    });

    items.sort(function (a, b) { return b.time - a.time; });
    items = items.slice(0, 6);

    if (!items.length) {
      list.innerHTML = '<div class="text-secondary text-sm py-4" style="text-align:center;">No recent activity</div>';
      return;
    }

    list.innerHTML = items.map(function (it) {
      var dt = new Date(it.time);
      var p2 = function (n) { return ('0' + n).slice(-2); };
      var dateStr = MONTHS[dt.getMonth()] + ' ' + dt.getDate() + ', ' + dt.getFullYear() + ' · ' + p2(dt.getHours()) + ':' + p2(dt.getMinutes());
      return '<div class="flex items-start gap-3 py-3" style="border-bottom:1px solid var(--border-subtle);">' +
        '<div style="width:36px;height:36px;border-radius:10px;background:' + it.bg + ';display:flex;align-items:center;justify-content:center;flex-shrink:0;">' +
          '<i data-lucide="' + it.icon + '" style="width:16px;height:16px;color:' + it.color + ';"></i>' +
        '</div>' +
        '<div style="flex:1;min-width:0;">' +
          '<div class="font-medium text-sm" style="color:var(--text-primary);">' + it.label + '</div>' +
          '<div class="text-xs text-secondary">' + dateStr + '</div>' +
        '</div>' +
        '<div class="font-mono text-sm font-medium" style="color:' + it.color + ';white-space:nowrap;">' + it.amount + '</div>' +
      '</div>';
    }).join('');

    if (global.lucide) global.lucide.createIcons();
  }

  /* --------------------------------------------------------- deposit links
     Deposits are a real request that an admin has to approve, so there is no
     way to add money from here. Every Deposit button hands off to the Assets
     page, which is the only place the request can be raised. The markup is
     plain anchors, so this only guards the two ids the shell does not own. */
  function wireDeposit() {
    ['#depositBtn2', '#chartEmptyBtn'].forEach(function (sel) {
      var el = $(sel);
      if (el && el.tagName !== 'A') {
        el.addEventListener('click', function () { global.location.href = 'assets.html'; });
      }
    });
  }

  /* -------------------------------------------------------------- logout - */
  function doLogout() {
    A.logout();
    global.location.href = 'login.html';
  }

  /* ------------------------------------------------------ identity block - */
  function paintIdentity() {
    var user = A.currentUser() || {};
    var first = String(user.name || 'User').split(' ')[0] || 'User';
    var dn = $('#dashUserName');
    if (dn) dn.textContent = first;
    $$('.user-avatar').forEach(function (a) { a.textContent = first.charAt(0).toUpperCase(); });
    $$('.user-name').forEach(function (d) { d.textContent = first; });
    $$('.user-email').forEach(function (d) { d.textContent = user.email || 'user@email.com'; });
  }


  /* ---------------------------------------------------------------- boot - */
  function boot() {
    if (global.lucide) global.lucide.createIcons();
    paintIdentity();

    loadQuantities();

    // Seed prices instantly from the static list so nothing renders as blank.
    COINS.forEach(function (c) { if (c.symbol !== 'USDT') state.price[c.symbol] = 0; });

    renderHoldings();
    renderStats();
    renderRecentActivity();
    wireDeposit();

    var lo = $('#logoutBtn'); if (lo) lo.addEventListener('click', doLogout);
    var ll = $('#logoutLink'); if (ll) ll.addEventListener('click', function (e) { e.preventDefault(); doLogout(); });

    // Live prices.
    F.loadMarkets().then(function (rows) {
      rows.forEach(function (r) {
        state.price[r.sym] = r.price;
        state.chg[r.sym] = r.change;
      });
      patchHoldings();
      renderStats();
      loadChart(true);
    });

    F.openTickerStream(function (arr) {
      for (var i = 0; i < arr.length; i++) {
        var t = arr[i];
        if (!t || !t.s) continue;
        var sym = String(t.s).replace(/USDT$/, '');
        if (state.price[sym] === undefined) continue;
        state.price[sym] = num(t.c);
        if (t.o) state.chg[sym] = ((num(t.c) - num(t.o)) / num(t.o)) * 100;
      }
      patchHoldings();
      renderStats();
    });

    // Re-price the pinned final point on a slow cadence.
    state.chartTimer = setInterval(function () { loadChart(false); }, 30000);

    // Another tab changing the balance should be reflected here.
    global.addEventListener('storage', function (e) {
      if (e.key === A.KEYS.cash || e.key === A.KEYS.assets) {
        loadQuantities();
        patchHoldings();
        renderStats();
        renderRecentActivity();
        loadChart(false);
      }
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      loadQuantities();
      patchHoldings();
      renderStats();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);