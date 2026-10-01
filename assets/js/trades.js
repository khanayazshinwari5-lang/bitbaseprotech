/* Real contracts: PostgreSQL owns placement, expiry and payout after all browsers close.
   This module observes their result. Local/demo arithmetic is retained for practice only.
   A win returns stake + profit; a loss returns stake - profit; an equal price returns the stake. */
(function (global) {
  'use strict';

  var A = global.BitbaseAuth;
  var DEMO_BAL = 'bb_demo_trades_bal';
  var DEMO_START = 100000;

  var BOOK = {
    real: { pos: 'bb_trade_positions', hist: 'bb_trades_history', live: true },
    demo: { pos: 'bb_demo_trades_pos', hist: 'bb_demo_trades_hist', live: false }
  };

  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
  function book(mode) { return BOOK[mode === 'demo' ? 'demo' : 'real']; }
  function serverMode(mode) { return mode!=='demo' && A.isRemote && A.isRemote(); }

  /* ------------------------------------------------------------- balances */
  function balance(b) {
    if (b.live) return A.cash();
    var v = A.readJSON(DEMO_BAL, null);
    if (v === null || v === undefined || !isFinite(v)) { A.writeJSON(DEMO_BAL, DEMO_START); return DEMO_START; }
    return v;
  }
  function addToBalance(b, delta) {
    if (b.live) A.setCash(balance(b) + delta);
    else A.writeJSON(DEMO_BAL, Math.max(0, balance(b) + delta));
  }

  /* ------------------------------------------------------------ positions */
  function openPositions(mode) {
    return (A.readJSON(book(mode).pos, []) || []).filter(function (p) { return p && p.status === 'Active'; });
  }
  function isDue(p, now) { return now - num(p.startTime) >= num(p.dur) * 1000; }
  function duePositions(mode, now) {
    var t = now || Date.now();
    return openPositions(mode).filter(function (p) { return isDue(p, t); });
  }

  /* Practice-only override. The server never uses this flag for real outcomes. */
  function forcedWin() {
    var rec = A.currentUser() || {};
    return rec.profitMode === true;
  }

  /* What the contract pays out on the balance. The stake always comes back and
     the profit percentage is the whole of the win and the whole of the loss,
     clamped so no contract can pay out below nothing or above double. */
  function payout(p, won) {
    var amt = num(p.amt);
    var profit = Math.min(Math.max(num(p.profit), 0), amt);
    return Math.max(0, Math.min(amt + (won ? profit : -profit), amt * 2));
  }
  /* The net effect on the balance compared with before the trade was placed,
     which is what a person reads as "I won" or "I lost". */
  function netOf(p) { if(p.net!=null)return num(p.net);if(['Active','Review','Draw','Cancelled'].indexOf(p.status)!==-1)return 0;return payout(p,p.status==='Won' || p.won===true)-num(p.amt); }

  /* -------------------------------------------------------------- history */
  function saveTrade(mode, rec) {
    var list = A.readJSON(book(mode).hist, []) || [];
    var i = -1;
    for (var j = 0; j < list.length; j++) { if (list[j] && list[j].id === rec.id) { i = j; break; } }
    if (i >= 0) list[i] = rec; else list.unshift(rec);
    A.writeJSON(book(mode).hist, list.slice(0, 400));
  }

  /* Settle one contract. Returns the settled record, or null when there was
     nothing to settle - no stake, or no real price to judge it against. */
  function settleOne(mode, p, price) {
    if (serverMode(mode) || !isDue(p,Date.now())) return null;
    var b = book(mode);
    var amt = num(p.amt);
    if (!(amt > 0)) return null;
    if (!(num(price) > 0)) return null;
    /* Re-read before paying anything. Fetching the price takes a round trip, and
       in that window another tab - or the trade page's own faster sweep - may
       already have closed this contract. Paying twice would invent money. */
    var stillOpen = (A.readJSON(b.pos, []) || []).some(function (x) {
      return x && x.id === p.id && x.status === 'Active';
    });
    if (!stillOpen) return null;

    var forced = mode==='demo' && forcedWin();
    var rise = num(price) > num(p.entryPrice);
    var won = forced ? true : (p.dir === 'UP' ? rise : !rise);
    var draw = !forced && num(price) === num(p.entryPrice);
    var pay = draw ? amt : payout(p, won);

    var done = {};
    Object.keys(p).forEach(function (k) { done[k] = p[k]; });
    done.exitPrice = num(price);
    done.won = !draw && won;
    done.status = draw ? 'Draw' : won ? 'Won' : 'Lost';
    done.payout = pay;
    done.net = pay - amt;
    done.settledAt = Date.now();
    if (forced) done.forced = true;

    addToBalance(b, pay);
    saveTrade(mode, done);
    // It is no longer open, so it must not be settled twice.
    A.writeJSON(b.pos, (A.readJSON(b.pos, []) || []).filter(function (x) { return x && x.id !== p.id; }));
    return done;
  }

  /* Settle everything that is due. `priceFor` is (position) => number |
     Promise<number>; returning 0 leaves that contract open for the next sweep.
     Sequential on purpose: the balance is read and written once per contract. */
  function settleDue(mode, priceFor) {
    if (serverMode(mode)) return Promise.resolve([]);
    var due = duePositions(mode);
    if (!due.length) return Promise.resolve([]);
    var settled = [];
    var step = Promise.resolve();
    due.forEach(function (p) {
      step = step.then(function () {
        /* A pricer that throws must not abandon the contracts behind it: each
           one is independent, so a failure here just leaves that contract open
           for the next sweep. */
        var priced;
        try { priced = Promise.resolve(priceFor(p)); }
        catch (e) { priced = Promise.resolve(0); }
        return priced.then(function (price) {
          var done = settleOne(mode, p, price);
          if (done) settled.push(done);
        }, function () { /* no price this time round */ });
      });
    });
    return step.then(function () {
      if (settled.length && A.flush) return A.flush().catch(function () { return false; });
      return true;
    }).then(function () { return settled; });
  }

  /* -------------------------------------------------------------- pricing */
  /* A contract records the symbol it was opened on. Records written before
     that only carry a display label, so the feed is asked to match it back. */
  function symFor(p) {
    if (p.sym) return p.sym;
    var F = global.BitbaseFeed, label = String(p.pair || '');
    if (F && F.instruments) {
      for (var i = 0; i < F.instruments.length; i++) {
        var inst = F.instruments[i];
        if (F.pairLabel && F.pairLabel(inst.sym) === label) return inst.sym;
      }
    }
    return label.split('/')[0] || '';
  }
  function pick(rows, sym) {
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i];
      if (!r) continue;
      if (r.sym === sym || r.name === sym) return num(r.price);
    }
    return 0;
  }
  /* One market snapshot per sweep, not one request per contract. */
  function feedPricer() {
    var snapshot = null;
    return function (p) {
      var F = global.BitbaseFeed;
      if (!F) return 0;
      var sym = symFor(p);
      var inst = F.instrument ? F.instrument(sym) : null;
      var group = p.group || (inst && inst.group) || 'crypto';
      if (snapshot && snapshot.group === group) return pick(snapshot.rows, sym);
      var job;
      try { job = group === 'crypto' ? F.loadMarkets() : F.loadGroup(group); }
      catch (e) { return 0; }
      if (!job || typeof job.then !== 'function') return 0;
      return job.then(function (rows) {
        snapshot = { group: group, rows: rows || [] };
        return pick(snapshot.rows, sym);
      }, function () { return 0; });
    };
  }

  /* Watch for contracts running out and close them wherever the user is.
     `onSettled` is called with each settled record so a page can say so. */
  function watch(mode, opts) {
    opts = opts || {};
    if (serverMode(mode)) return watchServer(opts);
    var running = false, timer = null;
    function sweep() {
      if (running) return;
      var due = duePositions(mode);
      if (!due.length) return;
      running = true;
      settleDue(mode, feedPricer()).then(function (list) {
        running = false;
        if (opts.onSettled) list.forEach(function (d) { opts.onSettled(d); });
      }, function () { running = false; });
    }
    sweep();
    timer = setInterval(sweep, 2000);
    global.addEventListener('focus', sweep);
    global.addEventListener('pagehide', sweep);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) sweep(); });
    return { sweep: sweep, stop: function () { if (timer) clearInterval(timer); timer = null; } };
  }

  function watchServer(opts) {
    var active={}, stopped=false, lastPoll=0;
    function observe() {
      if (stopped) return;
      var history=A.readJSON(BOOK.real.hist,[]) || [];
      history.forEach(function (p) {
        if (active[p.id] && p.status!=='Active' && p.status!=='Review') {
          delete active[p.id];
          if (opts.onSettled) opts.onSettled(p);
        }
      });
      openPositions('real').forEach(function (p) { active[p.id]=true; });
    }
    function sweep() {
      if (stopped || document.hidden || Date.now()-lastPoll<5000 || !duePositions('real').length) return;
      lastPoll=Date.now();
      if (global.BitbaseDB) global.BitbaseDB.refresh().catch(function () {});
    }
    observe();
    global.addEventListener('bitbase:data',observe);
    var timer=setInterval(sweep,5000);
    return {sweep:sweep,stop:function(){stopped=true;clearInterval(timer);global.removeEventListener('bitbase:data',observe);}};
  }

  global.BitbaseTrades = {
    BOOK: BOOK,
    open: openPositions,
    due: duePositions,
    isDue: isDue,
    payout: payout,
    netOf: netOf,
    settleOne: settleOne,
    settleDue: settleDue,
    watch: watch,
    forcedWin: forcedWin,
    pricer: feedPricer
  };

  /* ------------------------------------------------------------- autostart
     Settlement runs on every page, not just the trade screen. A user who opens
     a contract and then navigates away or refreshes used to leave the stake
     held with nothing left to close it, and a contract that expired while a
     page was still loading got decided against a price of zero. Starting here
     means one place owns that, rather than seven pages each remembering to. */
  var started = false;
  function announce(done) {
    // Balances moved, so anything reading them should repaint.
    global.dispatchEvent(new global.CustomEvent('bitbase:settled', { detail: done }));
    global.dispatchEvent(new global.CustomEvent('bitbase:data', { detail: { settled: done } }));
  }
  function start() {
    if (started) return;
    started = true;
    watch('real', { onSettled: announce });
    var onDemo = document.body && document.body.getAttribute &&
      document.body.getAttribute('data-mode') === 'demo';
    if (onDemo) watch('demo', { onSettled: announce });
  }
  if (A && A.whenReady) A.whenReady(start);
  else if (document.readyState !== 'loading') start();
  else document.addEventListener('DOMContentLoaded', start);
})(window);
