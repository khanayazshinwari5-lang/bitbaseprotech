/* ==========================================================================
   Bitbase – canvas candlestick / line chart with live updates
   No dependencies. Renders to a single canvas with DPR-aware scaling.
   ========================================================================== */
(function (global) {
  'use strict';

  var COLORS = {
    up: '#16c784',
    down: '#ea3943',
    upFill: 'rgba(22,199,132,0.85)',
    downFill: 'rgba(234,57,67,0.85)',
    grid: 'rgba(255,255,255,0.045)',
    axis: 'rgba(255,255,255,0.22)',
    text: '#8a8a8a',
    line: '#f7931a',
    crosshair: 'rgba(255,255,255,0.35)',
    lastBg: '#f7931a'
  };

  var PAD = { top: 10, right: 74, bottom: 26, left: 8 };
  var VOL_RATIO = 0.22;     // share of the plot taken by the volume histogram
  var MIN_BARS = 20;

  function niceStep(range, count) {
    if (range <= 0) return 1;
    var raw = range / Math.max(1, count);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1;
    return step * mag;
  }

  function CandleChart(canvas, host) {
    this.canvas = canvas;
    this.host = host || canvas.parentElement;
    this.ctx = canvas.getContext('2d');
    this.candles = [];
    this.type = 'candles';
    this.visible = 90;      // bars shown
    this.offset = 0;        // bars scrolled back from the right edge
    this.mouse = null;
    this.dirty = true;
    this.symbol = '';
    this.interval = '1m';
    this.lastPrice = 0;
    this._raf = null;
    this._bind();
  }

  CandleChart.prototype._bind = function () {
    var self = this;
    var c = this.canvas;

    c.addEventListener('mousemove', function (e) {
      var r = c.getBoundingClientRect();
      self.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      self.dirty = true;
    });
    c.addEventListener('mouseleave', function () { self.mouse = null; self.dirty = true; });
    c.addEventListener('touchmove', function (e) {
      if (!e.touches.length) return;
      var r = c.getBoundingClientRect();
      self.mouse = { x: e.touches[0].clientX - r.left, y: e.touches[0].clientY - r.top };
      self.dirty = true;
    }, { passive: true });
    c.addEventListener('touchend', function () { self.mouse = null; self.dirty = true; });

    c.addEventListener('wheel', function (e) {
      e.preventDefault();
      var dir = e.deltaY > 0 ? 1 : -1;
      self.zoom(dir);
    }, { passive: false });

    var drag = null;
    c.addEventListener('mousedown', function (e) { drag = { x: e.clientX, offset: self.offset }; c.style.cursor = 'grabbing'; });
    global.addEventListener('mouseup', function () { drag = null; c.style.cursor = 'crosshair'; });
    c.addEventListener('mousemove', function (e) {
      if (!drag) return;
      var r = c.getBoundingClientRect();
      var perBar = self._plot().w / self.visible;
      var shift = Math.round((drag.x - e.clientX) / Math.max(1, perBar));
      self.setOffset(drag.offset + shift);
    });

    if (global.ResizeObserver) {
      this._ro = new global.ResizeObserver(function () { self.resize(); });
      this._ro.observe(this.host);
    } else {
      global.addEventListener('resize', function () { self.resize(); });
    }
  };

  CandleChart.prototype._plot = function () {
    var w = this.canvas.width / (this.dpr || 1);
    var h = this.canvas.height / (this.dpr || 1);
    return {
      w: Math.max(10, w - PAD.left - PAD.right),
      h: Math.max(10, h - PAD.top - PAD.bottom),
      x: PAD.left, y: PAD.top
    };
  };

  CandleChart.prototype.resize = function () {
    var r = this.host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.dpr = global.devicePixelRatio || 1;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    this.dirty = true;
    this._loop();
  };

  CandleChart.prototype.setData = function (candles, meta) {
    this.candles = (candles || []).slice();
    if (meta) {
      if (meta.symbol) this.symbol = meta.symbol;
      if (meta.interval) this.interval = meta.interval;
    }
    this.offset = 0;
    this.visible = Math.max(MIN_BARS, Math.min(this.candles.length, this.interval === '1m' ? 90 : 100));
    this.lastPrice = this.candles.length ? this.candles[this.candles.length - 1].close : 0;
    this.dirty = true;
    this._loop();
  };

  /* Live tick: mutate the forming candle, or append a new one. */
  CandleChart.prototype.update = function (k) {
    if (!k || !isFinite(k.close)) return;
    var last = this.candles[this.candles.length - 1];
    if (last && last.time === k.time) {
      last.open = k.open; last.high = Math.max(last.high, k.high);
      last.low = Math.min(last.low, k.low); last.close = k.close;
      last.volume = k.volume;
    } else if (!last || k.time > last.time) {
      this.candles.push({ time: k.time, open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume });
      if (this.candles.length > 400) this.candles.shift();
    }
    this.lastPrice = k.close;
    this.dirty = true;
    this._loop();
  };

  CandleChart.prototype.setType = function (t) { this.type = t; this.dirty = true; this._loop(); };

  CandleChart.prototype.zoom = function (dir) {
    var n = this.candles.length;
    if (!n) return;
    // Keep the centre of the view fixed while the bar count changes.
    var centre = n - this.offset - this.visible / 2;
    var next = dir > 0
      ? Math.min(n, Math.round(this.visible * 1.18) + 1)
      : Math.max(MIN_BARS, Math.round(this.visible / 1.18) - 1);
    this.visible = Math.max(MIN_BARS, next);
    this.setOffset(n - (centre + this.visible / 2));
  };

  CandleChart.prototype.setOffset = function (o) {
    var maxOff = Math.max(0, this.candles.length - this.visible);
    this.offset = Math.min(maxOff, Math.max(0, o));
    this.dirty = true;
    this._loop();
  };

  CandleChart.prototype._slice = function () {
    var end = Math.max(1, this.candles.length - this.offset);
    var start = Math.max(0, end - this.visible);
    return this.candles.slice(start, end);
  };

  CandleChart.prototype._loop = function () {
    if (this._raf) return;
    var self = this;
    this._raf = requestAnimationFrame(function () {
      self._raf = null;
      if (self.dirty) { self.dirty = false; self.draw(); }
      // Keep a light heartbeat so a stale canvas is never left on screen.
      if (self.dirty) self._loop();
    });
  };

  CandleChart.prototype.draw = function () {
    var ctx = this.ctx;
    var p = this._plot();
    var self = this;
    var W = this.canvas.width / (this.dpr || 1);
    var H = this.canvas.height / (this.dpr || 1);

    ctx.setTransform(this.dpr || 1, 0, 0, this.dpr || 1, 0, 0);
    ctx.clearRect(0, 0, W, H);

    var data = this._slice();
    if (!data.length) {
      ctx.fillStyle = COLORS.text;
      ctx.font = '13px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('No candle data', W / 2, H / 2);
      return;
    }

    /* ---- scale ---- */
    var hi = -Infinity, lo = Infinity, vmax = 0;
    for (var i = 0; i < data.length; i++) {
      if (data[i].high > hi) hi = data[i].high;
      if (data[i].low < lo) lo = data[i].low;
      if (data[i].volume > vmax) vmax = data[i].volume;
    }
    if (!isFinite(hi) || !isFinite(lo)) return;
    var span = (hi - lo) || hi * 0.01 || 1;
    var padY = span * 0.08;
    hi += padY; lo -= padY;

    var volH = p.h * VOL_RATIO;
    var priceH = p.h - volH - 6;
    var yOf = function (v) { return p.y + (hi - v) / (hi - lo) * priceH; };
    var visible = this.visible;
    var xOf = function (idx) {
      return p.x + (idx + 0.5) * (p.w / visible);
    };
    var bw = p.w / visible;
    var body = Math.max(1, Math.min(bw * 0.68, 18));
    this.visible = visible;

    /* ---- grid + price axis ---- */
    // The live price tag owns its slice of the axis, so remember where it sits
    // and drop any gridline label that would collide with it.
    var showTag = this.offset === 0 && this.lastPrice;
    var tagY = showTag ? yOf(this.lastPrice) : -999;
    var step = niceStep(hi - lo, 5);
    ctx.font = '11px "IBM Plex Mono", monospace';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (var v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      var y = Math.round(yOf(v)) + 0.5;
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath(); ctx.moveTo(p.x, y); ctx.lineTo(p.x + p.w, y); ctx.stroke();
      if (Math.abs(y - tagY) < 12) continue;
      ctx.fillStyle = COLORS.text;
      ctx.textAlign = 'left';
      ctx.fillText(global.BitbaseFeed.fmtPrice(v), p.x + p.w + 8, y);
    }

    /* ---- time axis ---- */
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var labels = Math.max(2, Math.min(8, Math.floor(p.w / 90)));
    var stride = Math.max(1, Math.floor(data.length / labels));
    for (var t = 0; t < data.length; t += stride) {
      var tx = xOf(t);
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath(); ctx.moveTo(Math.round(tx) + 0.5, p.y); ctx.lineTo(Math.round(tx) + 0.5, p.y + p.h); ctx.stroke();
      // Keep the first and last captions inside the plot instead of clipped.
      var lx = Math.max(p.x + 18, Math.min(p.x + p.w - 18, tx));
      ctx.fillStyle = COLORS.text;
      ctx.fillText(this._timeLabel(data[t].time), lx, p.y + p.h + 7);
    }

    /* ---- volume ---- */
    var volTop = p.y + priceH + 6;
    for (var vi = 0; vi < data.length; vi++) {
      var c = data[vi];
      var hgt = vmax ? (c.volume / vmax) * volH : 0;
      ctx.fillStyle = c.close >= c.open ? 'rgba(22,199,132,0.35)' : 'rgba(234,57,67,0.35)';
      ctx.fillRect(xOf(vi) - body / 2, volTop + (volH - hgt), body, hgt);
    }

    /* ---- series ---- */
    if (this.type === 'line') {
      ctx.beginPath();
      for (var li = 0; li < data.length; li++) {
        var lx = xOf(li), ly = yOf(data[li].close);
        if (li === 0) ctx.moveTo(lx, ly); else ctx.lineTo(lx, ly);
      }
      var lastY = yOf(data[data.length - 1].close);
      var grad = ctx.createLinearGradient(0, p.y, 0, p.y + priceH);
      grad.addColorStop(0, 'rgba(247,147,26,0.28)');
      grad.addColorStop(1, 'rgba(247,147,26,0)');
      ctx.save();
      ctx.lineTo(xOf(data.length - 1), p.y + priceH);
      ctx.lineTo(xOf(0), p.y + priceH);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      for (var li2 = 0; li2 < data.length; li2++) {
        var lx2 = xOf(li2), ly2 = yOf(data[li2].close);
        if (li2 === 0) ctx.moveTo(lx2, ly2); else ctx.lineTo(lx2, ly2);
      }
      ctx.strokeStyle = COLORS.line;
      ctx.lineWidth = 1.8;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(xOf(data.length - 1), lastY, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = COLORS.line;
      ctx.fill();
    } else {
      for (var i2 = 0; i2 < data.length; i2++) {
        var d = data[i2];
        var up = d.close >= d.open;
        var x = xOf(i2);
        ctx.strokeStyle = up ? COLORS.up : COLORS.down;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, yOf(d.high));
        ctx.lineTo(Math.round(x) + 0.5, yOf(d.low));
        ctx.stroke();

        var yo = yOf(d.open), yc = yOf(d.close);
        var top = Math.min(yo, yc);
        var h = Math.max(1, Math.abs(yc - yo));
        ctx.fillStyle = up ? COLORS.upFill : COLORS.downFill;
        ctx.fillRect(x - body / 2, top, body, h);
      }
    }

    /* ---- last price line ---- */
    if (showTag) {
      var y = Math.round(tagY) + 0.5;
      if (y > p.y && y < p.y + priceH) {
        var upNow = data[data.length - 1].close >= data[data.length - 1].open;
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = upNow ? 'rgba(22,199,132,0.7)' : 'rgba(234,57,67,0.7)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(p.x, y); ctx.lineTo(p.x + p.w, y); ctx.stroke();
        ctx.setLineDash([]);

        var lbl = global.BitbaseFeed.fmtPrice(this.lastPrice);
        ctx.font = '11px "IBM Plex Mono", monospace';
        var tw = ctx.measureText(lbl).width + 12;
        ctx.fillStyle = upNow ? COLORS.up : COLORS.down;
        ctx.fillRect(p.x + p.w + 4, y - 9, Math.min(tw, PAD.right - 6), 18);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(lbl, p.x + p.w + 10, y);
      }
    }

    /* ---- crosshair ---- */
    if (this.mouse && this.mouse.x > p.x && this.mouse.x < p.x + p.w &&
        this.mouse.y > p.y && this.mouse.y < p.y + p.h) {
      var idx = Math.min(data.length - 1, Math.max(0, Math.floor((this.mouse.x - p.x) / bw)));
      var cd = data[idx];
      var cx = Math.round(xOf(idx)) + 0.5;
      var cy = Math.round(this.mouse.y) + 0.5;

      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = COLORS.crosshair;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, p.y); ctx.lineTo(cx, p.y + p.h);
      ctx.moveTo(p.x, cy); ctx.lineTo(p.x + p.w, cy);
      ctx.stroke();
      ctx.setLineDash([]);

      // price tag on the right axis
      var pv = global.BitbaseFeed.fmtPrice(hi - (cy - p.y) / priceH * (hi - lo));
      ctx.font = '11px "IBM Plex Mono", monospace';
      ctx.fillStyle = '#3a3a3a';
      ctx.fillRect(p.x + p.w + 4, cy - 9, PAD.right - 6, 18);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(pv, p.x + p.w + 8, cy);

      // OHLC tooltip
      var F = global.BitbaseFeed;
      var lines = [
        this._fullTime(cd.time),
        'O ' + F.fmtPrice(cd.open) + '   H ' + F.fmtPrice(cd.high),
        'L ' + F.fmtPrice(cd.low) + '   C ' + F.fmtPrice(cd.close),
        'Vol ' + F.fmtVolume(cd.volume)
      ];
      ctx.font = '11px "IBM Plex Mono", monospace';
      var wMax = 0;
      lines.forEach(function (l) { wMax = Math.max(wMax, ctx.measureText(l).width); });
      var bwT = wMax + 20, bhT = lines.length * 15 + 12;
      var bx = cx + 14, by = cy + 14;
      if (bx + bwT > p.x + p.w) bx = cx - bwT - 14;
      if (by + bhT > p.y + p.h) by = cy - bhT - 14;
      ctx.fillStyle = 'rgba(18,18,18,0.94)';
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, bwT, bhT, 6); else ctx.rect(bx, by, bwT, bhT);
      ctx.fill(); ctx.stroke();

      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      lines.forEach(function (l, li) {
        ctx.fillStyle = li === 0 ? '#fdb022' : '#b0b0b0';
        ctx.fillText(l, bx + 10, by + 7 + li * 15);
      });
    }
  };

  CandleChart.prototype._timeLabel = function (sec) {
    var d = new Date(sec * 1000);
    var intraday = ['1m', '5m', '15m', '1h', '4h'].indexOf(this.interval) >= 0;
    if (intraday) {
      return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    }
    var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return d.getDate() + ' ' + M[d.getMonth()];
  };

  CandleChart.prototype._fullTime = function (sec) {
    var d = new Date(sec * 1000);
    var M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var p2 = function (n) { return ('0' + n).slice(-2); };
    return M[d.getMonth()] + ' ' + d.getDate() + '  ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  };

  global.CandleChart = CandleChart;
})(window);
