/* ==========================================================================
   Bitbase – page wiring: markets table, live terminal, UI chrome
   ========================================================================== */
(function () {
  'use strict';

  var F = window.BitbaseFeed;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ======================================================== 1. STATIC UI */

  function initIcons() {
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
  }

  var PARTNERS = [
    { n: 'Norton', s: 'Security', bg: '#FFC400', size: 30, svg: '<path d="M12 3L4 7v5c0 4.42 3.4 8.56 8 9.5 4.6-.94 8-5.08 8-9.5V7l-8-4z" fill="#000" opacity="0.85"/><path d="M10.5 14.5l-2-2 1.06-1.06L10.5 12.38l3.94-3.94L15.5 9.5l-5 5z" fill="#FFC400"/>' },
    { n: 'McAfee', s: 'Threat Protection', bg: '#C01933', size: 30, svg: '<path d="M12 4C8 4 5 6.5 5 10c0 2.5 1.5 4.5 3 6l1 2h6l1-2c1.5-1.5 3-3.5 3-6 0-3.5-3-6-7-6z" fill="#fff" opacity="0.9"/><circle cx="12" cy="10" r="2.5" fill="#C01933"/>' },
    { n: 'Cloudflare', s: 'DDoS Protection', bg: '#F38020', size: 30, svg: '<path d="M6 12c0-3.3 2.7-6 6-6s6 2.7 6 6" stroke="#fff" stroke-width="2.5" fill="none" stroke-linecap="round"/><circle cx="12" cy="12" r="2" fill="#fff"/>' },
    { n: 'DigiCert', s: 'SSL Secured', bg: '#1a5276', size: 28, svg: '<rect x="3" y="6" width="18" height="12" rx="2" stroke="#fff" stroke-width="2"/><path d="M7 12l3 3 7-7" stroke="#4FC3F7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' },
    { n: 'Sectigo', s: 'Encryption', bg: '#2E7D32', size: 28, svg: '<rect x="3" y="6" width="18" height="12" rx="2" stroke="#fff" stroke-width="2"/><path d="M7 12l3 3 7-7" stroke="#81C784" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' },
    { n: 'Comodo', s: 'Web Security', bg: '#E65100', size: 28, svg: '<path d="M12 2L3 7v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-9-5z" stroke="#fff" stroke-width="2" fill="none"/><path d="M9 12l2 2 4-4" stroke="#FFB74D" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' },
    { n: 'GeoTrust', s: 'Trust Seal', bg: '#0D47A1', size: 28, svg: '<circle cx="12" cy="12" r="9" stroke="#fff" stroke-width="2"/><path d="M12 7v5l3 3" stroke="#64B5F6" stroke-width="2" stroke-linecap="round"/>' },
    { n: 'Thawte', s: 'Identity Verification', bg: '#6A1B9A', size: 28, svg: '<path d="M12 2l8 4v6c0 5.55-3.84 10.74-8 12-4.16-1.26-8-6.45-8-12V6l8-4z" stroke="#fff" stroke-width="2" fill="none"/><path d="M9 12l2 2 4-4" stroke="#CE93D8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>' }
  ];

  function buildPartnerTicker() {
    var host = $('#partnerTicker');
    if (!host) return;
    function card(p) {
      return '<div class="flex items-center gap-4 min-w-[240px] rounded-2xl border border-white/[0.1] bg-white/[0.03] px-7 py-4 backdrop-blur-md">' +
        '<div style="width:56px;height:56px;border-radius:12px;background:' + p.bg + ';display:flex;align-items:center;justify-content:center;flex-shrink:0;">' +
        '<svg width="' + p.size + '" height="' + p.size + '" viewBox="0 0 24 24" fill="none">' + p.svg + '</svg></div>' +
        '<div><div class="font-heading font-semibold text-[15px]">' + p.n + '</div>' +
        '<div class="text-[12px] text-text-tertiary">' + p.s + '</div></div></div>';
    }
    var set = '<div class="flex items-center gap-6 px-6">' + PARTNERS.map(card).join('') + '</div>';
    host.innerHTML = set + set;   // duplicated for a seamless -50% loop
  }

  var FOOTER = [
    { id: 'footerLinks',  items: ['Spot Trading', 'Margin Trading', 'Futures', 'Options', 'Staking', 'Savings', 'Launchpad', 'NFT Marketplace'] },
    { id: 'footerLinks2', items: ['Buy Crypto', 'P2P Trading', 'OTC Trading', 'Institutional', 'API', 'Affiliate Program', 'Referral Program', 'VIP Program'] },
    { id: 'footerLinks3', items: ['Contact Us', 'API Documentation'] },
    { id: 'footerLinks4', items: ['About Us', 'Careers', 'Press', 'Blog', 'Terms of Service', 'Privacy Policy', 'Cookie Policy', 'AML Policy'] }
  ];

  function buildFooter() {
    FOOTER.forEach(function (col) {
      var host = document.getElementById(col.id);
      if (!host) return;
      host.innerHTML = col.items.map(function (t) {
        var badge = t === 'Careers'
          ? ' <span class="inline-block ml-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-accent-green/15 text-accent-green">Hiring</span>'
          : '';
        return '<li><a href="#" class="text-[14px] text-text-secondary hover:text-white hover:translate-x-1 inline-block transition-all">' + t + badge + '</a></li>';
      }).join('');
    });
  }

  function initMobileMenu() {
    var btn = $('#mobileMenuBtn'), menu = $('#mobileMenu'), close = $('#mobileMenuClose');
    if (!btn || !menu) return;
    btn.addEventListener('click', function () { menu.classList.remove('hidden'); });
    close.addEventListener('click', function () { menu.classList.add('hidden'); });
    $$('.mobile-link', menu).forEach(function (l) {
      l.addEventListener('click', function () { menu.classList.add('hidden'); });
    });
    menu.addEventListener('click', function (e) {
      if (e.target === menu) menu.classList.add('hidden');
    });
  }

  /* Hotlinked art can fail to load – swap in a branded placeholder. */
  function initImageFallbacks() {
    var labels = {
      terminal: 'Trading terminal preview',
      phone: 'Mobile app',
      light: 'Light theme preview'
    };
    $$('img[data-fallback]').forEach(function (img) {
      img.addEventListener('error', function () {
        var d = document.createElement('div');
        d.className = 'img-fallback' + (img.dataset.fallback === 'phone' ? ' phone' : '') +
                      (img.dataset.fallback === 'light' ? ' light' : '');
        d.textContent = labels[img.dataset.fallback] || '';
        if (img.parentElement) img.parentElement.replaceChild(d, img);
      });
    });
  }

  /* When a session exists, the header offers the dashboard instead of auth. */
  function initAuthAwareHeader() {
    var A = window.BitbaseAuth;
    if (!A || !A.isAuthenticated()) return;
    $$('a[href="login.html"]').forEach(function (a) { a.textContent = 'Dashboard'; a.href = 'dashboard.html'; });
    $$('a[href="register.html"]').forEach(function (a) {
      if (a.classList.contains('h-9') || a.classList.contains('h-10')) a.textContent = 'Dashboard', a.href = 'dashboard.html';
    });
  }

  function initSmoothScroll() {
    $$('a[href^="#"]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        var t = document.querySelector(a.getAttribute('href'));
        if (!t) return;
        e.preventDefault();
        t.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  function initTestimonialDots() {
    var scroller = $('#testimonialScroll'), dots = $$('#testimonialDots span');
    if (!scroller || !dots.length) return;
    function sync() {
      var i = Math.round(scroller.scrollLeft / (scroller.firstElementChild.offsetWidth + 24));
      i = Math.max(0, Math.min(dots.length - 1, i));
      dots.forEach(function (d, di) {
        d.className = di === i
          ? 'w-6 h-2 rounded-full bg-accent-yellow transition-all'
          : 'w-2 h-2 rounded-full bg-white/20 transition-all';
      });
    }
    scroller.addEventListener('scroll', sync);
  }

  /* Feed status chip in the header. */
  var Feed = {
    dot: null, text: null,
    set: function (state) {
      if (!this.text) { this.dot = $('#feedDot'); this.text = $('#feedText'); }
      if (!this.text) return;
      var map = {
        live: ['LIVE', '#16c784'],
        connecting: ['CONNECTING', '#fdb022'],
        polling: ['POLLING', '#fdb022'],
        idle: ['CONNECTING', '#fdb022'],
        offline: ['OFFLINE', '#ea3943'],
        demo: ['DEMO DATA', '#8b5cf6']
      };
      var m = map[state] || map.connecting;
      this.text.textContent = m[0];
      if (this.dot) this.dot.style.background = m[1];
    }
  };

  /* ======================================================== 2. MARKETS */

  var Markets = {
    tab: 'crypto',
    rows: [],
    cells: {},        // sym -> {price, change, spark, row}
    body: null,

    init: function () {
      this.body = $('#marketTableBody');
      if (!this.body) return;
      var self = this;

      $$('.market-tab').forEach(function (t) {
        t.addEventListener('click', function () {
          $$('.market-tab').forEach(function (x) {
            x.classList.remove('active');
            x.style.background = '';
            x.style.borderColor = 'rgba(255,255,255,0.08)';
            x.style.color = '#b0b0b0';
          });
          t.classList.add('active');
          t.style.background = 'rgba(247,147,26,0.15)';
          t.style.borderColor = 'rgba(247,147,26,0.2)';
          t.style.color = '#fdb022';
          self.load(t.dataset.tab);
        });
      });

      // boot() kicks off the first load once the terminal is wired up

      // Refresh crypto snapshots on a slow cadence as a WS safety net.
      setInterval(function () {
        if (self.tab !== 'crypto' || F.state === 'live') return;
        F.pollMarkets().then(function (rows) { if (rows) self.render(rows); });
      }, 20000);
    },

    load: function (tab) {
      var self = this;
      this.tab = tab;
      this.cells = {};
      this.rows = [];
      this.loading();

      if (this.refresh) { clearInterval(this.refresh); this.refresh = null; }

      var p = tab === 'crypto' ? F.loadMarkets() : F.loadGroup(tab);
      p.then(function (rows) {
        self.render(rows);
        self.loadSparks(rows, tab);
      });

      // The crypto tab is fed by the shared websocket; the other classes have
      // no single stream, so refresh them on a timer while the tab is active.
      if (tab !== 'crypto') {
        this.refresh = setInterval(function () {
          if (self.tab !== tab) return;
          F.loadGroup(tab).then(function (rows) { if (self.tab === tab) self.render(rows); });
        }, 15000);
      }
    },

    loading: function () {
      this.body.innerHTML =
        '<tr><td colspan="8" class="text-center py-16 text-text-tertiary text-[14px]">' +
        '<div class="flex flex-col items-center gap-3">' +
        '<div class="w-8 h-8 border-2 border-accent-orange border-t-transparent rounded-full animate-spin"></div>' +
        'Loading real-time prices...</div></td></tr>';
    },

    render: function (rows) {
      this.rows = rows;
      this.body.innerHTML = rows.map(function (c) { return self_row(c); }).join('');
      this.rows.forEach(function (c) {
        self_bind(c);
      });
      this.updateNote();
    },

    /* Sparklines stream in after the table is already interactive. */
    loadSparks: function (rows, tab) {
      var self = this;
      var i = 0;
      (function next() {
        if (i >= rows.length) return;
        var c = rows[i++];
        var get = tab === 'crypto' ? F.loadSpark(c.sym) : F.groupSpark(tab, c.sym, '1d');
        get.then(function (pts) {
          if (pts && pts.length > 2) self.setSpark(c.sym, pts);
          else if (self.cells[c.sym] && self.cells[c.sym].spark) {
            self.cells[c.sym].spark.innerHTML = '<span class="text-[12px] text-text-tertiary">n/a</span>';
          }
          next();
        }).catch(next);
      })();
    },

    setSpark: function (sym, pts) {
      var cell = this.cells[sym];
      if (!cell || !cell.spark) return;
      var up = pts[pts.length - 1] >= pts[0];
      var color = up ? '#16c784' : '#ea3943';
      var min = Math.min.apply(null, pts), max = Math.max.apply(null, pts);
      var range = (max - min) || 1;
      var W = 80, H = 32, step = W / (pts.length - 1);
      var d = pts.map(function (v, i) {
        return (i * step).toFixed(1) + ',' + (H - 2 - ((v - min) / range) * (H - 4)).toFixed(1);
      }).join(' ');
      cell.spark.innerHTML =
        '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" class="inline-block">' +
        '<defs><linearGradient id="g-' + sym + '" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0%" stop-color="' + color + '" stop-opacity="0.28"/>' +
        '<stop offset="100%" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>' +
        '<polygon points="0,' + H + ' ' + d + ' ' + W + ',' + H + '" fill="url(#g-' + sym + ')"/>' +
        '<polyline points="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</svg>';
    },

    /* Live price tick – patches cells in place and flashes the direction. */
    tick: function (upd) {
      if (this.tab !== 'crypto') return;
      var cell = this.cells[upd.sym];
      if (!cell) return;
      var txt = '$' + F.fmtPrice(upd.price);
      if (cell.price.textContent !== txt) {
        cell.price.textContent = txt;
        var dir = upd.price > upd.prev ? 'flash-up' : 'flash-down';
        cell.price.classList.remove('flash-up', 'flash-down');
        void cell.price.offsetWidth;
        cell.price.classList.add(dir);
      }
      cell.cap.textContent = '$' + F.fmtCompact(upd.cap);
    },

    updateNote: function () {
      var note = $('#marketsNote');
      if (!note) return;
      var src = this.tab === 'crypto' ? F.source : (this.tab === 'forex' ? 'Kraken' : this.tab === 'metals' ? 'Binance + gold-api.com' : 'gold-api.com');
      note.textContent = this.tab === 'crypto'
        ? 'Live prices and 24h stats from ' + src + ' · charts are 7-day closes · market cap uses circulating supply.'
        : 'Live ' + this.tab + ' prices from ' + src + '. Market cap for metals uses above-ground supply; “—” marks fields the provider does not publish.';
    }
  };

  function self_row(c) {
    var change = c.change === null || c.change === undefined ? null : c.change;
    var color = change === null ? '#8a8a8a' : (change >= 0 ? '#16c784' : '#ea3943');
    var sign = change === null ? '' : (change >= 0 ? '+' : '');
    var price = c.price === null || c.price === undefined ? '—' : '$' + F.fmtPrice(c.price);
    var vol = c.volume === null || c.volume === undefined ? '—' : '$' + F.fmtVolume(c.volume);
    var cap = c.cap === null || c.cap === undefined ? '—' : '$' + F.fmtCompact(c.cap);
    var initials = c.sym.replace(/US(D|T)$/, '').slice(0, 3);

    return '<tr class="market-row border-b border-white/[0.04] transition-colors" data-sym="' + c.sym + '">' +
      '<td class="px-6 py-4 text-[14px] text-text-tertiary">' + (c.rank || '·') + '</td>' +
      '<td class="px-6 py-4">' +
        '<div class="flex items-center gap-3">' +
          '<div class="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0" style="background:' + c.color + '20;">' +
            '<span class="text-[11px] font-bold" style="color:' + c.color + ';">' + initials + '</span>' +
          '</div>' +
          '<div><div class="font-medium text-[14px]">' + c.name + '</div>' +
          '<div class="text-[12px] text-text-tertiary">' + c.sym + '</div></div>' +
        '</div>' +
      '</td>' +
      '<td class="px-6 py-4 text-right font-mono text-[14px] js-price">' + price + '</td>' +
      '<td class="px-6 py-4 text-right font-mono text-[14px]" style="color:' + color + ';">' +
        (change === null ? '—' : sign + change.toFixed(2) + '%') + '</td>' +
      '<td class="px-6 py-4 text-right font-mono text-[14px] text-text-secondary">' + vol + '</td>' +
      '<td class="px-6 py-4 text-right font-mono text-[14px] text-text-secondary js-cap">' + cap + '</td>' +
      '<td class="px-6 py-4 text-right js-spark"><span class="text-[12px] text-text-tertiary">…</span></td>' +
      '<td class="px-6 py-4 text-center">' +
        '<button class="px-4 py-1.5 rounded-lg text-[13px] font-medium text-white js-trade" style="background: linear-gradient(135deg, #F7931A 0%, #FDB022 100%);">Trade</button>' +
      '</td>' +
    '</tr>';
  }

  function self_bind(c) {
    var tr = document.querySelector('#marketTableBody tr[data-sym="' + c.sym + '"]');
    if (!tr) return;
    Markets.cells[c.sym] = {
      row: tr,
      price: $('.js-price', tr),
      cap: $('.js-cap', tr),
      spark: $('.js-spark', tr)
    };
    var btn = $('.js-trade', tr);
    if (btn && F.coins.some(function (x) { return x.sym === c.sym; })) {
      btn.addEventListener('click', function () { Terminal.select(c.sym); });
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', function (e) {
        if (e.target === btn) return;
        Terminal.select(c.sym);
      });
    }
  }

  /* ======================================================== 3. TERMINAL */

  var Terminal = {
    sym: 'BTC',
    interval: '1m',
    type: 'candles',
    chart: null,
    ticks: 0,
    tape: [],
    ready: false,

    init: function () {
      var canvas = $('#chartCanvas');
      if (!canvas) return;
      var self = this;
      this.chart = new window.CandleChart(canvas, $('#chartHost'));
      this.chart.resize();
      this.chart.setType(this.type);

      this.buildSymbolPicker();
      this.buildIntervalPicker();

      $$('#tfPicker ~ div button[data-type]').forEach(function (b) {
        b.addEventListener('click', function () {
          $$('button[data-type]').forEach(function (x) { x.classList.remove('active'); });
          b.classList.add('active');
          self.type = b.dataset.type;
          self.chart.setType(self.type);
        });
      });

      this.load();
    },

    buildSymbolPicker: function () {
      var host = $('#symbolPicker');
      if (!host) return;
      host.innerHTML = F.coins.map(function (c) {
        return '<button class="sym-btn' + (c.sym === 'BTC' ? ' active' : '') + '" data-sym="' + c.sym + '">' +
          '<span class="sym-dot" style="background:' + c.color + '"></span>' + c.sym +
          '<span class="sym-live">/USDT</span></button>';
      }).join('');
      var self = this;
      $$('.sym-btn', host).forEach(function (b) {
        b.addEventListener('click', function () { self.select(b.dataset.sym); });
      });
    },

    buildIntervalPicker: function () {
      var host = $('#tfPicker');
      if (!host) return;
      var keys = Object.keys(F.intervals);
      host.innerHTML = keys.map(function (k) {
        return '<button class="tf-btn' + (k === '1m' ? ' active' : '') + '" data-int="' + k + '">' + F.intervals[k].label + '</button>';
      }).join('');
      var self = this;
      $$('.tf-btn', host).forEach(function (b) {
        b.addEventListener('click', function () {
          $$('.tf-btn', host).forEach(function (x) { x.classList.remove('active'); });
          b.classList.add('active');
          self.interval = b.dataset.int;
          var iv = $('#tInterval'); if (iv) iv.textContent = self.interval;
          self.load();
        });
      });
    },

    select: function (sym) {
      if (!F.coins.some(function (c) { return c.sym === sym; })) return;
      this.sym = sym;
      $$('.sym-btn').forEach(function (b) { b.classList.toggle('active', b.dataset.sym === sym); });
      this.load();
      var t = $('#terminal');
      if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },

    load: function () {
      var self = this;
      var loader = $('#chartLoader');
      if (loader) loader.style.display = 'flex';
      this.tape = [];
      this.renderTape();

      var s = $('#tSymbol'); if (s) s.textContent = this.sym + '/USDT';
      var iv = $('#tInterval'); if (iv) iv.textContent = this.interval;

      F.loadCandles(this.sym, this.interval).then(function (res) {
        if (loader) loader.style.display = 'none';
        self.chart.setData(res.candles, { symbol: self.sym, interval: self.interval });
        self.ready = true;
        self.updateOhlc(res.candles[res.candles.length - 1]);
        var src = $('#dataSource'); if (src) src.textContent = res.source;

        F.openStream(self.sym, self.interval, {
          onCandle: function (k) { self.chart.update(k); self.updateOhlc(k); },
          onTrade: function (t) { self.pushTrade(t); },
          onTickers: function (arr) { self.onTickers(arr); },
          onStatus: function (s) { self.onStatus(s); }
        });
      });
    },
    updateOhlc: function (k) {
      if (!k) return;
      var set = function (id, v) { var e = $('#' + id); if (e) e.textContent = F.fmtPrice(v); };
      set('tOpen', k.open); set('tHigh', k.high); set('tLow', k.low); set('tClose', k.close);
      var v = $('#tVol'); if (v) v.textContent = F.fmtVolume(k.volume);
      this.updateChange();
    },

    /* The header chip shows the pair's 24h change, kept live off the stream. */
    updateChange: function () {
      var e = $('#tChange');
      if (!e) return;
      var ch = F.changeOf(this.sym);
      if (ch === null || ch === undefined) { e.textContent = ''; return; }
      e.textContent = (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%';
      e.style.color = ch >= 0 ? '#16c784' : '#ea3943';
    },

    onStatus: function (s) {
      var el = $('#wsState');
      if (!el) return;
      var map = { live: 'WebSocket · live', connecting: 'WebSocket · connecting', polling: 'REST polling', idle: 'Idle' };
      el.textContent = map[s] || s;
      el.style.color = s === 'live' ? '#16c784' : '#b0b0b0';
      Feed.set(s);
    },

    onTickers: function (arr) {
      this.ticks += arr.length;
      var tc = $('#tickCount');
      if (tc) tc.textContent = this.ticks.toLocaleString('en-US');
      for (var i = 0; i < arr.length; i++) {
        var t = arr[i];
        if (!t || !t.s) continue;
        var sym = String(t.s).replace(/USDT$/, '');
        var upd = F.applyTick(sym, parseFloat(t.c), parseFloat(t.o), parseFloat(t.v));
        if (upd) {
          Markets.tick(upd);
          if (sym === this.sym) this.updateChange();
        }
      }
      this.syncVolume();
    },

    syncVolume: function () {
      if (this._vAt && Date.now() - this._vAt < 45000) return;
      this._vAt = Date.now();
      var self = this;
      F.loadGlobalVolume().then(function (v) {
        if (!v) return;
        var txt = '$' + F.fmtCompact(v);
        ['#heroVolume', '#globalVolume'].forEach(function (sel) {
          var e = $(sel); if (e) e.textContent = txt;
        });
      });
    },

    pushTrade: function (t) {
      this.tape.unshift(t);
      if (this.tape.length > 14) this.tape.pop();
      var host = $('#tradeTape');
      if (host) this._prependTile(host, t);
      this._tickClock();
    },

    /* One node per trade, so each tile animates in once instead of restarting
       on every re-render. */
    _prependTile: function (host, t) {
      var empty = host.querySelector('.tape-empty');
      if (empty) host.removeChild(empty);

      var up = t.side !== 'sell';
      var el = document.createElement('div');
      el.className = 'tape-item tape-enter';
      el.innerHTML =
        '<span class="tape-px" style="color:' + (up ? '#16c784' : '#ea3943') + ';">' + F.fmtPrice(t.price) + '</span>' +
        '<span class="tape-meta">' + F.fmtQty(t.qty) + ' · ' + (up ? 'buy' : 'sell') + '</span>';
      host.insertBefore(el, host.firstChild);
      while (host.children.length > 14) host.removeChild(host.lastChild);
    },

    _tickClock: function () {
      var tt = $('#tapeTime');
      if (!tt) return;
      var d = new Date(), p2 = function (n) { return ('0' + n).slice(-2); };
      var tz = '';
      try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
      tt.textContent = p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()) + (tz ? ' · ' + tz : '');
    },

    renderTape: function () {
      var host = $('#tradeTape');
      if (!host) return;
      host.innerHTML = this.tape.length
        ? ''
        : '<div class="tape-empty w-full flex items-center justify-center text-[13px] text-text-tertiary">Waiting for trades…</div>';
      this.tape.slice().reverse().forEach(function (t) {
        var el = document.createElement('div');
        var up = t.side !== 'sell';
        el.className = 'tape-item';
        el.innerHTML =
          '<span class="tape-px" style="color:' + (up ? '#16c784' : '#ea3943') + ';">' + F.fmtPrice(t.price) + '</span>' +
          '<span class="tape-meta">' + F.fmtQty(t.qty) + ' · ' + (up ? 'buy' : 'sell') + '</span>';
        host.appendChild(el);
      });
      this._tickClock();
    }
  };

  /* ======================================================== 4. BOOT */

  function boot() {
    initIcons();
    buildPartnerTicker();
    buildFooter();
    initMobileMenu();
    initImageFallbacks();
    initAuthAwareHeader();
    initSmoothScroll();
    initTestimonialDots();

    Markets.init();
    Terminal.init();

    // Markets snapshot first, then the terminal opens the shared socket.
    Feed.set('connecting');
    F.loadMarkets().then(function (rows) {
      Markets.render(rows);
      Markets.loadSparks(rows, 'crypto');
      Terminal.syncVolume();
      if (F.source === 'demo') Feed.set('demo');
    });

    setInterval(function () { Terminal.syncVolume(); }, 30000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
