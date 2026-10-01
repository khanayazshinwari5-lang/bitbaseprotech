/* ==========================================================================
   Bitbase – trade / demo engine
   One implementation serves both pages; <body data-mode> picks the balance
   and storage keys. Trades are duration contracts: at expiry the position is
   settled against the real exit price, so a win means the market actually
   moved in your direction.
   ========================================================================== */
(function (global) {
  'use strict';

  var A = global.BitbaseAuth;
  var F = global.BitbaseFeed;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var MODE = document.body.getAttribute('data-mode') === 'demo' ? 'demo' : 'real';
  var DEMO_START = 100000;

  /* demo funds are kept out of the real account entirely */
  var K = MODE === 'demo'
    ? { bal: 'bb_demo_trades_bal', pos: 'bb_demo_trades_pos', hist: 'bb_demo_trades_hist', seq: 'bb_demo_trade_id_counter' }
    : { bal: A.KEYS.cash, pos: 'bb_trade_positions', hist: 'bb_trades_history', seq: 'bb_trade_id_counter' };



  var PAIRS = (F.instruments || F.coins.map(function (c) { return { sym: c.sym, name: c.name }; })).map(function (i) {
    return { sym: i.sym, name: i.name, group: i.group, venue: i.venue, label: F.pairLabel ? F.pairLabel(i.sym) : i.sym + '/USDT' };
  });

  var TF = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];
  var TF_LABEL = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1D', '1w': '1W' };

  var S = {
    idx: 0,
    tf: '1m',
    price: 0,
    prev: 0,
    ohlc: { open: 0, high: 0, low: 0, change: 0, volume: 0 },
    positions: [],
    activePanel: null,
    resultTimer: null,
    chart: null,
    streamKey: ''
  };

  /* ------------------------------------------------------------- storage */
  function balance() {
    if (MODE === 'demo') {
      var v = A.readJSON(K.bal, null);
      if (v === null || !isFinite(v)) { A.writeJSON(K.bal, DEMO_START); return DEMO_START; }
      return v;
    }
    return A.cash();
  }
  function setBalance(v) {
    if (MODE === 'demo') A.writeJSON(K.bal, v);
    else A.setCash(v);
    var b = $('#balance');
    if (b) b.textContent = fmtUSD(v).slice(1);
  }
  function loadPositions() { return A.readJSON(K.pos, []) || []; }
  function savePositions() { A.writeJSON(K.pos, S.positions.slice(0, 300)); }
  function nextId() {
    var n = parseInt(A.get(K.seq, '0'), 10) || (MODE === 'demo' ? 2000 : 1000);
    n += 1;
    A.set(K.seq, n);
    return 'T-' + n;
  }
  function saveTrade(rec) {
    var list = A.readJSON(K.hist, []) || [];
    var i = -1;
    for (var j = 0; j < list.length; j++) if (list[j] && list[j].id === rec.id) { i = j; break; }
    if (i >= 0) list[i] = rec; else list.unshift(rec);
    A.writeJSON(K.hist, list.slice(0, 400));
  }

  /* ----------------------------------------------------------- formatters */
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
  // Forex needs 5 decimals, metals 2-3, crypto follows its own price scale.
  function dec() {
    var inst = F.instrument(PAIRS[S.idx] && PAIRS[S.idx].sym);
    if (inst && inst.group !== 'crypto' && inst.decimals) return inst.decimals;
    return F.decimalsFor(S.price);
  }
  function fmtP(v) {
    return num(v).toLocaleString('en-US', { minimumFractionDigits: dec(), maximumFractionDigits: dec() });
  }
  function fmtUSD(v) {
    return '$' + num(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtQ(v) {
    v = num(v);
    if (v === 0) return '0';
    if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
    return v.toLocaleString('en-US', { maximumFractionDigits: 8 });
  }
  function durLabel(s) {
    s = num(s);
    if (s >= 86400) return (s / 86400) + 'd';
    if (s >= 3600) return Math.round(s / 3600) + 'h';
    if (s >= 60) return Math.round(s / 60) + 'm';
    return s + 's';
  }
  function countdown(ms) {
    if (ms <= 0) return '0s';
    var t = Math.ceil(ms / 1000);
    if (t >= 3600) return Math.floor(t / 3600) + 'h ' + Math.floor((t % 3600) / 60) + 'm';
    if (t >= 60) return Math.floor(t / 60) + 'm ' + (t % 60) + 's';
    return t + 's';
  }

  function toast(msg, color) {
    var old = document.querySelector('.trade-toast');
    if (old) old.remove();
    var t = document.createElement('div');
    t.className = 'trade-toast';
    t.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;background:' + (color || '#f7931a') + ';flex-shrink:0;"></span>' + global.BitbaseShell.esc(msg);
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3500);
  }

  /* ---------------------------------------------------------------- layout */
  function isMobile() { return global.innerWidth <= 768; }

  function layout() {
    var header = $('.dash-header'), nav = $('#tradeTopNav'), grid = $('#tradingLayout');
    if (!header || !nav || !grid) return;
    var hh = header.offsetHeight, nh = nav.offsetHeight;
    nav.style.top = hh + 'px';
    grid.style.marginTop = (hh + nh) + 'px';
    grid.style.height = 'calc(100vh - ' + (hh + nh + (isMobile() ? 60 : 0)) + 'px)';
  }

  /* ------------------------------------------------------------------ UI */
  function paintPrice(dir) {
    var up = S.price >= S.prev;
    var col = dir === 'up' ? 'var(--green)' : dir === 'down' ? 'var(--red)' : (up ? 'var(--green)' : 'var(--red)');
    ['tpPrice', 'tpPriceBig', 'navLatest', 'mbC'].forEach(function (id) {
      var e = document.getElementById(id);
      if (e) e.textContent = fmtP(S.price);
    });
    var big = document.getElementById('tpPriceBig');
    if (big) big.style.color = col;
    var pct = document.getElementById('mbPct');
    if (pct && isFinite(S.ohlc.change)) {
      pct.textContent = (S.ohlc.change >= 0 ? '+' : '') + S.ohlc.change.toFixed(2) + '%';
      pct.style.background = S.ohlc.change >= 0 ? 'rgba(0,192,135,.12)' : 'rgba(240,65,65,.12)';
      pct.style.color = S.ohlc.change >= 0 ? 'var(--green)' : 'var(--red)';
    }
    var chg = document.getElementById('navChg');
    if (chg && isFinite(S.ohlc.change)) {
      chg.textContent = (S.ohlc.change >= 0 ? '+' : '') + S.ohlc.change.toFixed(2) + '%';
      chg.style.color = S.ohlc.change >= 0 ? 'var(--green)' : 'var(--red)';
    }
    // The OHLC keys are open/high/low - the element ids are just O/H/L.
    var OHLC_MAP = { mbO: 'open', mbH: 'high', mbL: 'low', navLow: 'low', navHigh: 'high' };
    Object.keys(OHLC_MAP).forEach(function (id) {
      var e = document.getElementById(id);
      if (!e) return;
      var v = S.ohlc[OHLC_MAP[id]];
      e.textContent = isFinite(v) && v ? fmtP(v) : '\u2014';
    });
    var vol = document.getElementById('navVol');
    if (vol) vol.textContent = S.ohlc.volume ? F.fmtVolume(S.ohlc.volume) : '\u2014';
  }

  function buildPicker() {
    var host = $('#tfPicker');
    if (!host) return;
    host.innerHTML = TF.map(function (k) {
      return '<button class="tf-btn' + (k === S.tf ? ' active' : '') + '" data-tf="' + k + '">' + TF_LABEL[k] + '</button>';
    }).join('') +
      '<button class="nav-icon" id="chartTypeBtn" title="Toggle line / candles"><i data-lucide="chart-candlestick" style="width:16px;height:16px;"></i></button>';
    $$('#tfPicker .tf-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('#tfPicker .tf-btn').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        S.tf = b.dataset.tf;
        loadCandles();
      });
    });
    var typeBtn = document.getElementById('chartTypeBtn');
    if (typeBtn) {
      typeBtn.addEventListener('click', function () {
        var next = S.chart.type === 'candles' ? 'line' : 'candles';
        S.chart.setType(next);
        typeBtn.querySelector('svg, i').setAttribute('data-lucide', next === 'line' ? 'chart-line' : 'chart-candlestick');
        if (global.lucide) global.lucide.createIcons();
      });
    }
  }

  function buildPairDD() {
    var dd = $('#pairDD');
    if (!dd) return;
    dd.innerHTML = PAIRS.map(function (p, i) {
      var tag = p.group && p.group !== 'crypto' ? ' <span style="opacity:.55;font-size:10px;text-transform:uppercase;letter-spacing:.04em;">' + p.group + '</span>' : '';
      return '<div class="pair-opt' + (i === S.idx ? ' selected' : '') + '" data-i="' + i + '">' + p.label + tag + '</div>';
    }).join('');
    $$('.pair-opt', dd).forEach(function (el) {
      el.addEventListener('click', function () {
        selectPair(parseInt(el.dataset.i, 10));
        dd.style.display = 'none';
      });
    });
  }

  function selectPair(i) {
    if (!PAIRS[i]) return;
    S.idx = i;
    S.streamKey = '';
    loadCandles();
    buildPairDD();
    updateSummary();
  }

  function refreshQuote(sym) {
    var inst = F.instrument(sym);
    // Non-crypto instruments are not in the crypto market list; ask their venue.
    if (inst && inst.group !== 'crypto') {
      F.quoteFor(sym).then(function (p) {
        if (PAIRS[S.idx].sym !== sym || !p) return;
        S.price = p;
        paintPrice();
      });
      return;
    }
    F.loadMarkets().then(function (rows) {
      var r = rows.filter(function (x) { return x.sym === sym; })[0];
      if (!r || PAIRS[S.idx].sym !== sym) return;
      S.price = r.price;
      S.ohlc.change = r.change;
      S.ohlc.high = r.high || S.ohlc.high;
      S.ohlc.low = r.low || S.ohlc.low;
      S.ohlc.volume = r.volume;
      paintPrice();
    });
  }

  function openStream(sym) {
    S.streamKey = sym + ':' + S.tf;
    F.openStream(sym, S.tf, {
      onCandle: function (k) {
        S.chart.update(k);
        S.ohlc.open = k.open; S.ohlc.high = k.high; S.ohlc.low = k.low;
        S.price = k.close;
        paintPrice('flat');
      },
      onTrade: function (t) {
        S.price = t.price;
        S.prev = t.price;
        addTx(t);
        paintPrice(t.side === 'buy' ? 'up' : 'down');
      },
      onTickers: function (arr) {
        for (var i = 0; i < arr.length; i++) {
          var t = arr[i];
          if (!t || String(t.s) !== sym + 'USDT') continue;
          S.price = parseFloat(t.c);
        }
        refreshQuote(sym);
      }
    });
  }

  var txCount = 0;
  function addTx(t) {
    var list = $('#txList');
    if (!list) return;
    var empty = list.querySelector('div');
    if (empty && list.children.length === 1) list.innerHTML = '';
    var row = document.createElement('div');
    row.className = 'tx-row';
    row.style.animation = 'fadeIn .3s ease';
    var d = new Date();
    row.innerHTML = '<span>' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2) + '</span>' +
      '<span class="' + (t.side === 'buy' ? 'tx-price-g' : 'tx-price-r') + '">' + fmtP(t.price) + '</span>' +
      '<span>' + fmtQ(t.qty) + '</span>';
    list.insertBefore(row, list.firstChild);
    while (list.children.length > 15) list.removeChild(list.lastChild);
    if (++txCount % 5 === 0) F.loadMarkets();
  }

  /* ------------------------------------------------------------ trade form */
  function durInfo() {
    var sel = $('#durSelect');
    var opt = sel.options[sel.selectedIndex];
    return { seconds: parseInt(sel.value, 10), profitPct: parseInt(opt.dataset.profit, 10) };
  }

  function getAmount() {
    var v = String(($('#amtInput') || {}).value || '').replace(/[^0-9.\-]/g, '');
    return parseFloat(v) || 0;
  }

  function updateSummary() {
    var amt = getAmount();
    var d = durInfo();
    var a = document.getElementById('sumAmt');
    var u = document.getElementById('sumDur');
    var p = document.getElementById('sumProfit');
    if (amt > 0) {
      if (a) a.textContent = fmtUSD(amt);
      if (u) u.textContent = durLabel(d.seconds);
      if (p) p.textContent = '+' + fmtUSD(amt * d.profitPct / 100);
    } else {
      if (a) a.textContent = '\u2014';
      if (u) u.textContent = '\u2014';
      if (p) p.textContent = '\u2014';
    }
  }

  function setPct(pct) {
    var bal = balance();
    if (bal <= 0) { toast('Insufficient balance', 'var(--red)'); return; }
    var amt = Math.floor(bal * pct / 100 * 100) / 100;
    var input = $('#amtInput');
    if (input) input.value = amt;
    updateSummary();
  }

  function placeTrade(dir) {
    var amt = getAmount();
    var bal = balance();
    if (amt <= 0) { toast('Please enter a valid amount', 'var(--red)'); return; }
    if (amt > bal) { toast('Insufficient balance', 'var(--red)'); return; }
    if (!S.price) { toast('Waiting for a live price', 'var(--red)'); return; }

    var d = durInfo();
    setBalance(bal - amt);
    /* The symbol travels with the contract so any page can price it later,
       not just this one. */
    var sym = PAIRS[S.idx].sym;
    var inst = F.instrument ? F.instrument(sym) : null;
    var pos = {
      id: nextId(),
      pair: PAIRS[S.idx].label,
      sym: sym,
      group: (inst && inst.group) || 'crypto',
      uid: A.get(A.KEYS.uid, ''),
      dir: dir,
      amt: amt,
      dur: d.seconds,
      profit: Math.round(amt * d.profitPct / 100 * 100) / 100,
      entryPrice: S.price,
      exitPrice: 0,
      startTime: Date.now(),
      status: 'Active',
      mode: MODE
    };
    S.positions.unshift(pos);
    savePositions();
    saveTrade(pos);
    renderPositions();
    showPanel(pos);
    toast(dir + ' trade placed: ' + fmtUSD(amt) + ' on ' + pos.pair, 'var(--green)');
    var input = $('#amtInput');
    if (input) input.value = '';
    updateSummary();
  }

  function closePos(id) {
    var pos = S.positions.filter(function (p) { return p.id === id; })[0];
    if (!pos || pos.status !== 'Active') return;
    pos.status = 'Closed';
    pos.exitPrice = S.price;
    pos.refund = Math.round(pos.amt * 0.5 * 100) / 100;
    setBalance(balance() + pos.refund);
    savePositions();
    saveTrade(pos);
    renderPositions();
    if (S.activePanel && S.activePanel.id === id) removePanel();
    toast('Position ' + id + ' closed. Refunded ' + fmtUSD(pos.refund), 'var(--f7931a)');
  }

  /* Settle against the real exit price. */
  /* An admin can flag an account so every contract settles as a win. This is
     a demo affordance, not a market feature. The rule itself lives in
     trades.js, which every page loads: this page only decides what the user
     sees when it happens, using the price already on screen. */
  var settling = false;
  function settleExpired() {
    if (settling) return;
    var due = global.BitbaseTrades.due(MODE);
    if (!due.length) return;
    settling = true;
    /* The live price for the pair on screen, when there is one. Anything the
       page cannot price is left to trades.js, which will not settle it blind
       either. */
    global.BitbaseTrades.settleDue(MODE, function (p) {
      return (p.sym && p.sym === PAIRS[S.idx].sym && S.price) ? S.price : global.BitbaseTrades.pricer()(p);
    }).then(function (settled) {
      settling = false;
      if (!settled.length) return;
      S.positions = global.BitbaseTrades.open(MODE);
      setBalance(balance());
      renderPositions();
      updateSummary();
      settled.forEach(function (p) {
        showResult(p);
        toast(p.id + (p.won ? ' won +' : ' lost \u2212') + fmtUSD(Math.abs(p.net)),
          p.won ? 'var(--green)' : 'var(--red)');
      });
    }, function () { settling = false; });
  }

  function renderPositions() {
    var body = $('#posBody');
    if (!body) return;
    var all = A.readJSON(K.pos, []) || [];
    var count = document.getElementById('posCount');
    if (count) count.textContent = all.filter(function (p) { return p.status === 'Active'; }).length;

    if (!S.positions.length) {
      body.innerHTML = '<tr><td colspan="9" class="pos-empty">No open positions</td></tr>';
      return;
    }
    body.innerHTML = S.positions.map(function (p) {
      var left = Math.max(0, p.dur * 1000 - (Date.now() - p.startTime));
      return '<tr>' +
        '<td>' + p.id + '</td>' +
        '<td>' + p.pair + '</td>' +
        '<td class="' + (p.dir === 'UP' ? 'dir-up' : 'dir-down') + '">' + p.dir + '</td>' +
        '<td>' + fmtUSD(p.amt) + '</td>' +
        '<td>' + durLabel(p.dur) + '</td>' +
        '<td>' + countdown(left) + '</td>' +
        '<td style="color:var(--green);">+' + fmtUSD(p.profit) + '</td>' +
        '<td><span class="status-active">' + p.status + '</span></td>' +
        '<td><button data-close="' + p.id + '" style="font-size:11px;color:var(--red);background:none;border:none;cursor:pointer;">Close</button></td>' +
      '</tr>';
    }).join('');
    $$('[data-close]', body).forEach(function (b) {
      b.addEventListener('click', function () { closePos(b.dataset.close); });
    });
  }

  function tickTimers() {
    var body = $('#posBody');
    if (!body) return;
    S.positions.forEach(function (p, i) {
      var cell = body.querySelectorAll('tr')[i];
      if (!cell) return;
      var left = Math.max(0, p.dur * 1000 - (Date.now() - p.startTime));
      cell.children[5].textContent = countdown(left);
    });
    var panel = S.activePanel;
    if (panel) {
      var p = panel.pos;
      var ring = document.getElementById('tradeTimerRing');
      var text = document.getElementById('tradeTimerText');
      var ms = Math.max(0, p.dur * 1000 - (Date.now() - p.startTime));
      var frac = p.dur ? ms / (p.dur * 1000) : 0;
      if (ring) ring.style.strokeDashoffset = String(panel.circumference * (1 - frac));
      if (text) text.textContent = countdown(ms);
      /* At zero, hand over to settlement rather than closing: closing here
         would beat showResult() to the panel and the user would never see the
         outcome. Only tidy up if the trade is already gone and no result was
         rendered. */
      if (ms <= 0 && !panel.showedResult) {
        var stillOpen = S.positions.some(function (x) { return x.id === p.id && x.status === 'Active'; });
        if (!stillOpen) removePanel();
      }
    }
  }

  /* ---------------------------------------------------------- live panel */
  function panelHtml() {
    return '<div style="position:fixed;bottom:24px;left:24px;z-index:9500;width:340px;max-width:calc(100vw - 32px);border-radius:16px;background:#1a1a1a;border:1px solid rgba(255,255,255,.08);box-shadow:0 20px 60px rgba(0,0,0,.6);overflow:hidden;animation:slideUp .3s ease;font-family:Inter,sans-serif;color:#fff;">' +
      '<div id="tradePanelBody" style="padding:20px;"></div></div>';
  }

  function showPanel(pos) {
    removePanel();
    var isUp = pos.dir === 'UP';
    var dirColor = isUp ? '#16c784' : '#ea3943';
    var dirBg = isUp ? 'rgba(22,199,132,0.1)' : 'rgba(234,57,67,0.1)';
    var dirLabel = isUp ? 'BUY / UP' : 'SELL / DOWN';
    var circ = 2 * Math.PI * 52;

    var host = document.createElement('div');
    host.innerHTML = panelHtml();
    var el = host.firstChild;
    document.body.appendChild(el);
    S.activePanel = { id: pos.id, pos: pos, el: el, circumference: circ };

    document.getElementById('tradePanelBody').innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">' +
        '<div style="display:flex;align-items:center;gap:8px;">' +
          '<div style="width:10px;height:10px;border-radius:50%;background:' + dirColor + ';animation:livepulse 1.5s infinite;"></div>' +
          '<span style="font-size:13px;font-weight:600;">Live Trade</span>' +
          (MODE === 'demo' ? '<span style="font-size:9px;background:rgba(22,199,132,.15);color:#16c784;padding:1px 6px;border-radius:4px;">DEMO</span>' : '') +
        '</div>' +
        '<span style="font-size:11px;color:rgba(255,255,255,.4);">' + pos.id + '</span>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">' +
        '<div style="flex:1;"><div style="font-size:11px;color:rgba(255,255,255,.4);margin-bottom:2px;">Pair</div>' +
        '<div style="font-size:16px;font-weight:700;font-family:\'IBM Plex Mono\',monospace;">' + pos.pair + '</div></div>' +
        '<div style="padding:6px 14px;border-radius:8px;background:' + dirBg + ';border:1px solid ' + dirColor + '33;">' +
        '<span style="font-size:13px;font-weight:600;color:' + dirColor + ';">' + dirLabel + '</span></div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;justify-content:center;margin-bottom:16px;">' +
        '<div style="position:relative;width:120px;height:120px;">' +
          '<svg width="120" height="120" viewBox="0 0 120 120" style="transform:rotate(-90deg);">' +
            '<circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="6"/>' +
            '<circle id="tradeTimerRing" cx="60" cy="60" r="52" fill="none" stroke="' + dirColor + '" stroke-width="6" stroke-linecap="round" stroke-dasharray="' + circ + '" stroke-dashoffset="0" style="transition:stroke-dashoffset 1s linear;"/>' +
          '</svg>' +
          '<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;">' +
            '<div id="tradeTimerText" style="font-size:28px;font-weight:700;font-family:\'IBM Plex Mono\',monospace;">' + durLabel(pos.dur) + '</div>' +
            '<div style="font-size:10px;color:rgba(255,255,255,.4);">remaining</div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;">' +
        tile('Amount', fmtUSD(pos.amt)) +
        tile('Potential Profit', '+' + fmtUSD(pos.profit), '#16c784') +
        tile('Entry Price', fmtP(pos.entryPrice)) +
        tile('Duration', durLabel(pos.dur)) +
      '</div>' +
      '<div style="text-align:center;font-size:11px;color:rgba(255,255,255,.3);">Result will appear when trade closes...</div>';
  }

  function tile(label, value, color) {
    return '<div style="background:rgba(255,255,255,.03);border-radius:8px;padding:10px 12px;">' +
      '<div style="font-size:10px;color:rgba(255,255,255,.4);margin-bottom:2px;">' + label + '</div>' +
      '<div style="font-size:14px;font-weight:600;font-family:\'IBM Plex Mono\',monospace;' + (color ? 'color:' + color + ';' : '') + '">' + value + '</div></div>';
  }

  function showResult(pos) {
    if (!S.activePanel || S.activePanel.id !== pos.id) return;
    S.activePanel.showedResult = true;
    var won = pos.won;
    var color = won ? '#16c784' : '#ea3943';
    var bg = won ? 'rgba(22,199,132,.08)' : 'rgba(234,57,67,.08)';
    var icon = won
      ? '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#16c784" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>'
      : '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ea3943" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
    /* A win and a loss are mirror images of each other: the stake comes back
       either way and the profit percentage is what is gained or given up. */
    var net = Math.abs(pos.net !== undefined ? pos.net : (won ? pos.profit : -pos.profit));
    document.getElementById('tradePanelBody').innerHTML =
      '<div style="padding:24px 20px;text-align:center;">' +
        '<div style="margin-bottom:16px;">' + icon + '</div>' +
        '<div style="font-size:22px;font-weight:700;margin-bottom:4px;color:' + color + ';">' + (won ? 'Trade Won!' : 'Trade Lost') + '</div>' +
        '<div style="font-size:13px;color:rgba(255,255,255,.5);margin-bottom:20px;">' + pos.pair + ' &bull; ' + pos.dir + '</div>' +
        '<div style="background:' + bg + ';border:1px solid ' + color + '33;border-radius:12px;padding:16px;margin-bottom:16px;">' +
          '<div style="font-size:32px;font-weight:700;font-family:\'IBM Plex Mono\',monospace;color:' + color + ';margin-bottom:4px;">' + (won ? '+' : '-') + fmtUSD(net) + '</div>' +
          '<div style="font-size:12px;color:rgba(255,255,255,.5);">' + (won ? 'Profit earned' : 'Amount lost') + '</div>' +
        '</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:20px;">' +
          tile('Amount', fmtUSD(pos.amt)) + tile('Duration', durLabel(pos.dur)) +
          tile('Entry Price', fmtP(pos.entryPrice)) + tile('Exit Price', fmtP(pos.exitPrice)) +
        '</div>' +
        '<button id="panelClose" style="width:100%;padding:12px;border-radius:10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);color:#fff;font-size:13px;font-weight:600;cursor:pointer;">Close</button>' +
      '</div>';
    var b = document.getElementById('panelClose');
    if (b) b.addEventListener('click', removePanel);
    // The result stays up until it is dismissed, so the numbers can be read.
    // Auto-dismiss only as a backstop in case the user walks away.
    clearTimeout(S.resultTimer);
    S.resultTimer = setTimeout(function () {
      if (S.activePanel && S.activePanel.showedResult) removePanel();
    }, 45000);
  }

  function removePanel() {
    if (S.activePanel && S.activePanel.el) S.activePanel.el.remove();
    S.activePanel = null;
  }

  /* ------------------------------------------------------------- startup */
  function boot() {
  if (!global.BitbaseShell.mount({
    active: MODE === 'demo' ? 'demo' : 'trade',
    bottom: MODE === 'demo' ? '' : 'trade',
    badge: MODE === 'demo'
      ? '<span class="demo-badge" style="box-shadow:none;"><span class="dot"></span> Practice Mode</span>'
      : ''
  })) return;
    S.chart = new global.CandleChart($('#tradeChart'), $('#chartHost'));
    S.chart.resize();
    S.chart.setType('candles');

    buildPicker();
    buildPairDD();

    var pairBtn = $('#pairBtn');
    var dd = $('#pairDD');
    if (pairBtn && dd) {
      pairBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        dd.style.display = dd.style.display === 'block' ? 'none' : 'block';
      });
      document.addEventListener('click', function (e) {
        if (!e.target.closest('.pair-dd')) dd.style.display = 'none';
      });
    }

    var wanted = new URLSearchParams(global.location.search).get('pair');
    if (wanted) {
      var i = PAIRS.map(function (p) { return p.sym; }).indexOf(wanted.toUpperCase());
      if (i >= 0) S.idx = i;
    }

    S.positions = loadPositions().filter(function (p) { return p.status === 'Active'; });
    setBalance(balance());
    renderPositions();
    updateSummary();

    $('#durSelect').addEventListener('change', updateSummary);
    $('#amtInput').addEventListener('input', updateSummary);
    $$('.pct-btn').forEach(function (b) {
      b.addEventListener('click', function () { setPct(parseInt(b.dataset.pct, 10)); });
    });
    $('#btnUp').addEventListener('click', function () { placeTrade('UP'); });
    $('#btnDown').addEventListener('click', function () { placeTrade('DOWN'); });

    var reset = $('#resetDemoBtn');
    if (reset) {
      reset.addEventListener('click', function () {
        A.writeJSON(K.bal, DEMO_START);
        A.writeJSON(K.pos, []);
        S.positions = [];
        setBalance(DEMO_START);
        renderPositions();
        removePanel();
        updateSummary();
        toast('Demo reset to ' + fmtUSD(DEMO_START), 'var(--green)');
      });
    }

    layout();
    global.addEventListener('resize', layout);
    setTimeout(layout, 120);
    setTimeout(layout, 600);

    // The initial chart load shares the same path as a pair switch, so a
    // ?pair= deep link renders the right label, source and price.
    loadCandles();

    setInterval(settleExpired, 1000);
    setInterval(tickTimers, 1000);
    setInterval(renderPositions, 5000);

    /* trades.js watches every page, so a contract can also close from its own
       sweep while this tab is sitting here. Keep the table honest either way. */
    global.addEventListener('bitbase:settled', function (e) {
      var done = e && e.detail;
      if (done && S.activePanel && S.activePanel.id === done.id) { removePanel(); return; }
      S.positions = loadPositions().filter(function (p) { return p.status === 'Active'; });
      setBalance(balance());
      renderPositions();
      updateSummary();
    });
  }

  function loadCandles() {
    var sym = PAIRS[S.idx].sym;
    var t = $('#pairText');
    if (t) t.textContent = PAIRS[S.idx].label;
    var l = document.getElementById('chartLoader');
    if (l) l.style.display = 'flex';
    S.streamKey = '';
    F.loadCandles(sym, S.tf).then(function (r) {
      if (PAIRS[S.idx].sym !== sym) return;
      var src = document.getElementById('chartSource');
      if (src) src.textContent = r.source || '';
      S.chart.setData(r.candles, { symbol: sym, interval: S.tf });
      var last = r.candles[r.candles.length - 1];
      if (last) {
        if (!S.price) S.prev = last.close;
        S.price = last.close;
        S.ohlc = { open: last.open, high: last.high, low: last.low, change: 0, volume: last.volume };
        paintPrice();
      }
      if (l) l.style.display = 'none';
      openStream(sym);
      refreshQuote(sym);
    }).catch(function () {
      if (PAIRS[S.idx].sym !== sym) return;
      var src = document.getElementById('chartSource');
      if (src) src.textContent = 'No live quote available';
      if (l) l.style.display = 'none';
      S.price = 0;
      paintPrice();
    });
  }
// Nothing renders until the database mirror is filled, so the first
  // paint is already the user's own data rather than a blank frame.
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', function () { A.whenReady(boot); });
  else A.whenReady(boot);
})(window);
