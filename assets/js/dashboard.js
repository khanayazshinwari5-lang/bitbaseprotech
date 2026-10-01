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
    chartTimer: null,
    chartDrawn: 0       // when the curve was last rebuilt, to rate limit redraws
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
  function reservedCash() { return (A.readJSON('bb_trade_positions',[]) || []).reduce(function(sum,p){return sum+(p.status==='Active'?num(p.amt):0);},0); }
  function totalValue() { return holdingsValue() + A.cash() + reservedCash(); }
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
    var total = held + A.cash() + reservedCash();
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

  /* Every dated record that moved the cash balance, oldest first.
     There is no server-side balance history to ask for, so the past is
     reconstructed by walking these backwards from the live balance. Only settled
     movements count: a deposit that was never approved, or a contract still
     running, did not change what the account owned. */
  function balanceEvents() {
    var uid = A.get(A.KEYS.uid, '');
    var out = [];
    function mine(r) {
      if (!r) return false;
      if (!r.uid && !r.userId) return true;                 // a record with no owner is this account's
      return String(r.uid || r.userId) === String(uid);
    }
    function at(r) { return num(r.settledAt || r.time || r.created || r.decidedAt); }

    (A.readJSON('bb_trades_history', []) || []).forEach(function (t) {
      if (!mine(t) || t.status === 'Active' || t.status === 'Review') return;
      /* The server settles against a recorded exit price, so net is the figure
         to use. Older local records carry only a status, and the payout rules
         are the same ones the console's P/L column reads. */
      var v = (t.net !== undefined && t.net !== null && isFinite(t.net)) ? num(t.net)
        : t.status === 'Won' ? num(t.profit)
        : t.status === 'Lost' ? -num(t.profit)
        : t.status === 'Closed' ? (num(t.refund) ? num(t.refund) - num(t.amt) : -num(t.amt) * 0.5)
        : 0;                                              // Draw and Cancelled net nothing
      if (v) out.push({ t: at(t), v: v });
    });
    (A.readJSON('bb_deposit_requests', []) || []).forEach(function (d) {
      if (mine(d) && d.status === 'approved') out.push({ t: at(d), v: Math.abs(num(d.amount)) });
    });
    (A.readJSON('bb_withdrawal_requests', []) || []).forEach(function (w) {
      if (mine(w) && w.status === 'approved') out.push({ t: at(w), v: -Math.abs(num(w.amount)) });
    });
    return out.filter(function (e) { return e.t > 0; }).sort(function (a, b) { return a.t - b.t; });
  }

  /* How far back each tab actually reaches. */
  var PERIOD_MS = {
    '24H': 24 * 3600e3,
    '7D': 7 * 24 * 3600e3,
    '1M': 30 * 24 * 3600e3,
    '3M': 90 * 24 * 3600e3,
    '1Y': 365 * 24 * 3600e3,
    'ALL': 5 * 365 * 24 * 3600e3
  };

  /* The cash balance as it stood at each step across the chosen window. The
     balance is walked backwards from the live figure through the recorded
     movements, then forwards again, so the first point is the balance at the
     start of the window and the last one is the balance now. */
  function cashHistory(period, cash, note) {
    var p = PERIODS[period];
    var n = Math.max(2, p.limit || 30);
    var span = PERIOD_MS[period] || PERIOD_MS['1M'];
    var now = Date.now(), from = now - span;
    var events = balanceEvents().filter(function (e) { return e.t > from; });

    var start = cash;
    events.forEach(function (e) { start -= e.v; });

    var points = [], step = span / (n - 1), i = 0, running = start;
    for (var k = 0; k < n; k++) {
      var t = from + step * k;
      while (i < events.length && events[i].t <= t) { running += events[i].v; i++; }
      points.push({ t: t, v: running });
    }
    // The last point is the live figure, so the line always agrees with the tile.
    points[points.length - 1].v = cash;

    var source = events.length
      ? 'your balance history (' + events.length + ' recorded ' +
        (events.length === 1 ? 'movement' : 'movements') + ')'
      : 'no recorded movements in this period';
    return {
      points: points, source: source, cashOnly: true, events: events.length,
      note: (note ? note + ' ' : '') + (events.length
        ? 'Built from ' + source + ' over ' + p.label + '.'
        : 'Nothing in the ledger changed the balance over ' + p.label + ', so the line stays at your current balance. It moves as soon as a trade settles or a transfer is approved.')
    };
  }

  function buildSeries(period) {
    var p = PERIODS[period];
    var cash = A.cash();
    var held = COINS.filter(function (c) { return c.symbol !== 'USDT' && qtyOf(c.symbol) > 0; });

    /* Nothing to re-price against the market, so the line follows the cash
       balance over the window the tab actually names. It used to be thirty
       identical points a minute apart whatever the tab said, which is why the
       curve never moved and 24H/7D/1M/3M/1Y/ALL all drew the same flat line. */
    if (!held.length) return Promise.resolve(cashHistory(period, cash, 'No crypto positions yet.'));

    return Promise.all(held.map(function (c) {
      return F.loadCandles(c.symbol, p.iv).then(function (r) {
        return { sym: c.symbol, candles: r.candles, source: r.source };
      }).catch(function () { return null; });
    })).then(function (all) {
      var series = all.filter(function (s) { return s && s.candles && s.candles.length > 1; });
      /* Holdings exist but no historical closes came back. The cash part of the
         portfolio is still real and dated, so show that and say the holdings
         are missing rather than drawing a flat line across the whole value. */
      if (!series.length) {
        return cashHistory(period, cash, 'Historical prices for your holdings are unavailable right now, so only the cash balance is plotted.');
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

    if (!series || !series.points || series.points.length < 2) {
      svg.innerHTML = '';
      if (empty) {
        empty.classList.remove('hidden');
        empty.style.display = 'flex';
      }
      var vb = $('#chartValueBox'); if (vb) vb.classList.add('hidden');
      var ch = $('#chartChange'); if (ch) ch.textContent = '';
      var none = $('#chartSource');
      if (none) none.textContent = 'Deposit funds to start tracking your portfolio over time.';
      return;
    }
    if (empty) { empty.classList.add('hidden'); empty.style.display = 'none'; }
    var vbox = $('#chartValueBox'); if (vbox) vbox.classList.remove('hidden');

    var pts = series.points.map(function (p) { return p.v; });
    /* The headline has to describe the line that is actually drawn. The tile
       above reports the whole portfolio including a stake held in an open
       contract, which the cash line deliberately excludes, so reading the total
       here made the number and the curve disagree whenever a trade was open. */
    var total = pts[pts.length - 1];
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
      src.textContent = series.note
        ? series.note
        : (series.cashOnly
          ? 'No crypto positions yet — the line tracks your cash balance over ' + PERIODS[state.period].label + '.'
          : 'Valued over ' + PERIODS[state.period].label + ' using ' + series.source +
            ' historical closes for your ' + cryptoQty() + ' current holding' + (cryptoQty() === 1 ? '' : 's') + '.');
    }
  }

  function loadChart(showLoader) {
    var loader = $('#chartLoader');
    if (loader && showLoader) { loader.classList.remove('hidden'); loader.style.display = 'flex'; }
    state.chartDrawn = Date.now();
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
      /* A loss gives up the profit percentage, not the stake, so the feed has to
         read the same figure the balance did. `t.amount` is not even a field a
         contract has - it is `amt` - so this was always reading nothing. */
      var amt = (t.net !== undefined && t.net !== null && isFinite(t.net))
        ? num(t.net)
        : (won ? num(t.profit) : -num(t.profit));
      items.push({
        time: num(t.time),
        label: (won ? 'Won ' : 'Lost ') + fmtAmt(t.amt) + ' USDT · ' + String(t.pair || '').replace('/USDT', ''),
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
    A.logout().then(function () { global.location.href = 'login.html'; }).catch(function (e) { if (global.BitbaseDB) global.BitbaseDB.warn(e); });
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
  if (!global.BitbaseShell.mount({ active: 'dashboard' })) return;
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

    // Live prices. A snapshot kept from the last visit paints the numbers now,
    // so the page is never a table of dashes waiting on a round trip.
    var warm = F.snapshot ? F.snapshot() : null;
    if (warm && warm.length) {
      warm.forEach(function (r) {
        state.price[r.sym] = r.price;
        state.chg[r.sym] = r.change;
      });
      patchHoldings();
      renderStats();
    }

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

    /* Re-price the pinned final point on a slow cadence, and redraw at once when
       something actually changed. The cash line is a local reconstruction, so
       it can be rebuilt without a network round trip; when holdings exist the
       rebuild needs historical candles, so that one stays on the slow timer.
       bitbase:data fires on every realtime change, so it is rate limited. */
    state.chartTimer = setInterval(function () { loadChart(false); }, 30000);

    function redrawChart() {
      var held = COINS.some(function (c) { return c.symbol !== 'USDT' && qtyOf(c.symbol) > 0; });
      if (held) return;
      if (state.chartDrawn && Date.now() - state.chartDrawn < 5000) return;
      loadChart(false);
    }

    global.addEventListener('bitbase:data', function () {
      loadQuantities(); patchHoldings(); renderStats(); renderRecentActivity(); paintIdentity();
      redrawChart();
    });

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
      // A tab left open overnight was showing yesterday's curve.
      loadChart(false);
    });
  }
// Nothing renders until the database mirror is filled, so the first
  // paint is already the user's own data rather than a blank frame.
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', function () { A.whenReady(boot); });
  else A.whenReady(boot);
})(window);