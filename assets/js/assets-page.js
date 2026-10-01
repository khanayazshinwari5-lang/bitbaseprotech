/* ==========================================================================
   Bitbase – assets page
   Two real wallets (spot + funding) so Transfer has actual meaning, live
   pricing for every row, an order-frozen column driven by open positions,
   and five working operations: deposit, withdraw, transfer, convert, loan.
   ========================================================================== */
(function (global) {
  'use strict';

  var A = global.BitbaseAuth;
  var F = global.BitbaseFeed;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };



  var HIDDEN_KEY = 'bb_assets_hide_zero';
  var DEPOSIT_KEY = 'bb_deposit_addresses';

  var COIN_META = {
    USDT: { color: '#26a17b', name: 'Tether',    net: 'ERC20',   min: 10,    label: 'Tether' },
    BTC:  { color: '#f7931a', name: 'Bitcoin',   net: 'Bitcoin', min: 0.001, label: 'Bitcoin' },
    ETH:  { color: '#627eea', name: 'Ethereum',  net: 'ERC20',   min: 0.01,  label: 'Ethereum' },
    SOL:  { color: '#9945ff', name: 'Solana',    net: 'SPL',     min: 0.1,   label: 'Solana' },
    BNB:  { color: '#f3ba2f', name: 'BNB',       net: 'BEP20',   min: 0.01,  label: 'BNB' },
    XRP:  { color: '#346aa9', name: 'XRP',       net: 'Ripple',  min: 10,    label: 'Ripple' },
    DOGE: { color: '#c2a633', name: 'Dogecoin',  net: 'DOGE',    min: 10,    label: 'Dogecoin' },
    ADA:  { color: '#0033ad', name: 'Cardano',   net: 'Cardano', min: 10,    label: 'Cardano' },
    DOT:  { color: '#e6007a', name: 'Polkadot',  net: 'Polkadot',min: 1,     label: 'Polkadot' },
    LTC:  { color: '#a6a9aa', name: 'Litecoin',  net: 'Litecoin',min: 0.01,  label: 'Litecoin' },
    LINK: { color: '#2a5ada', name: 'Chainlink', net: 'ERC20',   min: 1,     label: 'Ethereum' },
    AVAX: { color: '#e84142', name: 'Avalanche', net: 'AVAXC',   min: 0.1,   label: 'Avalanche' },
    TRX:  { color: '#eb0029', name: 'TRON',      net: 'TRC20',   min: 10,    label: 'TRON' }
  };

  var S = { tab: 'all', price: {}, chg: {}, hideZero: false, loan: { days: 7, rate: 0.05 } };

  /* ------------------------------------------------------------ helpers */
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
  function fmtUSD(v) { return '$' + num(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtQty(v) {
    v = num(v);
    if (!v) return '0';
    if (v >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
    return v.toLocaleString('en-US', { maximumFractionDigits: 8 });
  }
  function priceOf(sym) { return sym === 'USDT' ? 1 : (S.price[sym] || 0); }
  function meta(sym) { return COIN_META[sym] || { color: '#555', name: sym, net: 'ERC20', min: 0, label: 'ERC20' }; }

  function spotCash() { return A.cash(); }
  // Funding lives on the account record in auth.js, so it is per-user.
  function funding() { return A.funding(); }
  function setFunding(v) { return A.setFunding(v); }
  function coinQty(sym) {
    if (sym === 'USDT') return spotCash();
    var a = A.assets();
    return num(a[sym] && a[sym].qty);
  }
  function setCoinQty(sym, qty) {
    if (sym === 'USDT') { A.setCash(qty); return; }
    A.setAssetQty(sym, qty);
  }

  /* USD value locked in open duration trades. */
  function frozenByCoin() {
    var out = {};
    var pos = A.readJSON('bb_trade_positions', []) || [];
    pos.forEach(function (p) {
      if (!p || p.status !== 'Active') return;
      if (!p.pair) return;
      var sym = String(p.pair).replace('/USDT', '');
      out[sym] = (out[sym] || 0) + num(p.amt);
    });
    return out;
  }

  function toast(msg, kind) {
    var stack = $('#toastStack');
    if (!stack) return;
    var t = document.createElement('div');
    t.className = 'toast-item ' + (kind === 'err' ? 'err' : 'ok');
    t.textContent = (kind === 'err' ? '\u2715 ' : '\u2713 ') + msg;
    stack.appendChild(t);
    setTimeout(function () { t.remove(); }, 3000);
  }

  function openModal(id) {
    var m = document.getElementById(id);
    if (!m) return;
    m.classList.add('open');
    m.style.display = 'flex';
    if (global.lucide) global.lucide.createIcons();
  }
  function closeModal(m) {
    if (typeof m === 'string') m = document.getElementById(m);
    if (!m) return;
    m.classList.remove('open');
    m.style.display = 'none';
  }
  global.BitbaseAssetsModal = { open: openModal, close: closeModal, toast: toast };

  function setErr(sel, msg) {
    var e = $(sel);
    if (!e) return;
    if (msg) { e.textContent = msg; e.classList.remove('hidden'); }
    else e.classList.add('hidden');
  }

  /* ------------------------------------------------------------- render */
  function visibleRows() {
    var list = Object.keys(COIN_META).filter(function (sym) {
      if (S.tab === 'funding') return sym === 'USDT' && funding() > 0;
      if (S.hideZero && coinQty(sym) <= 0 && (sym !== 'USDT' || spotCash() <= 0)) return false;
      return true;
    });
    if (S.tab === 'funding') return ['USDT'];
    if (S.tab === 'spot') return list.filter(function (s) { return s !== 'USDT' || spotCash() > 0; });
    return list;
  }

  function render() {
    var body = $('#assetsTableBody');
    if (!body) return;
    var frozen = frozenByCoin();
    var rows = visibleRows();
    var total = spotCash() + funding();
    COIN_META && Object.keys(COIN_META).forEach(function (sym) {
      if (sym === 'USDT') return;
      total += coinQty(sym) * priceOf(sym);
    });

    if (!rows.length) {
      body.innerHTML = '<tr><td colspan="7" style="padding:40px;text-align:center;color:var(--text-tertiary);">No assets in this wallet yet.</td></tr>';
    } else {
      body.innerHTML = rows.map(function (sym) {
        var m = meta(sym);
        var qty = sym === 'USDT' && S.tab === 'funding' ? funding() : coinQty(sym);
        var price = priceOf(sym);
        var val = qty * price;
        var fr = frozen[sym] || 0;
        var chg = sym === 'USDT' ? 0 : num(S.chg[sym]);
        var isPos = chg >= 0;
        return '<tr data-sym="' + sym + '">' +
          '<td><div style="display:flex;align-items:center;gap:12px;">' +
            '<div class="coin-icon" style="background:' + m.color + ';">' + sym.slice(0, 3) + '</div>' +
            '<div><div style="font-weight:500;">' + m.name + '</div>' +
            '<div style="font-size:12px;color:var(--text-tertiary);">' + sym + '</div></div>' +
          '</div></td>' +
          '<td class="text-right font-mono js-qty" data-sym="' + sym + '">' + fmtQty(qty) + '</td>' +
          '<td class="text-right font-mono" style="color:var(--text-secondary);">' + fmtQty(Math.max(0, qty - fr)) + '</td>' +
          '<td class="text-right font-mono" style="color:' + (fr ? '#f59e0b' : 'var(--text-tertiary)') + ';">' + (fr ? fmtQty(fr) : '\u2014') + '</td>' +
          '<td class="text-right font-mono js-val" data-sym="' + sym + '">' + (price ? F.fmtCompact(val) : '\u2014') + '</td>' +
          '<td class="text-right"><span class="' + (isPos ? 'badge-green' : 'badge-red') + ' js-chg" data-sym="' + sym + '">' +
            (sym === 'USDT' ? '\u2014' : (isPos ? '+' : '') + Math.abs(chg).toFixed(2) + '%') + '</span></td>' +
          '<td class="text-center"><button class="px-3 py-1.5 rounded-lg text-[12px] font-medium" data-trade="' + sym + '" style="background:rgba(247,147,26,.12);border:1px solid rgba(247,147,26,.25);color:#f7931a;cursor:pointer;">Trade</button></td>' +
        '</tr>';
      }).join('');
      $$('[data-trade]', body).forEach(function (b) {
        b.addEventListener('click', function () {
          global.location.href = 'trade.html?pair=' + b.dataset.trade;
        });
      });
    }

    var tv = $('#assetsTotalValue');
    if (tv) tv.textContent = fmtUSD(total);

    var badge = $('#assetsChangeBadge');
    if (badge) {
      var trades = A.readJSON('bb_trades_history', []) || [];
      var pnl = 0;
      trades.forEach(function (t) {
        if (!t) return;
        if (t.status === 'Won') pnl += num(t.profit);
        else if (t.status === 'Lost') pnl -= num(t.profit);
      });
      var pct = total > 0 ? (pnl / total * 100) : 0;
      badge.textContent = (pnl >= 0 ? '+' : '') + fmtUSD(pnl) + ' (' + (pnl >= 0 ? '+' : '') + pct.toFixed(2) + '%)';
      badge.className = (pnl >= 0 ? 'badge-green' : 'badge-red');
    }

    renderDistribution();
  }

  function renderDistribution() {
    var bar = $('#distBar');
    var legend = $('#distLegend');
    if (!bar || !legend) return;
    var items = [];
    var total = spotCash() + funding();
    items.push({ sym: 'USDT', pct: total > 0 ? (spotCash() / total) * 100 : 0, color: '#26a17b' });
    Object.keys(COIN_META).forEach(function (sym) {
      if (sym === 'USDT') return;
      var v = coinQty(sym) * priceOf(sym);
      if (v > 0) items.push({ sym: sym, pct: total > 0 ? (v / total) * 100 : 0, color: meta(sym).color });
    });
    var keep = items.filter(function (i) { return i.pct >= 1; });
    var other = items.filter(function (i) { return i.pct < 1; })
      .reduce(function (s, i) { return s + i.pct; }, 0);
    if (other > 0.05) keep.push({ sym: 'Other', pct: other, color: '#555' });

    if (!keep.length) {
      bar.innerHTML = '<div style="width:100%;background:rgba(255,255,255,.05);"></div>';
      legend.innerHTML = '<div class="text-sm" style="color:var(--text-tertiary);">No funded assets to distribute yet.</div>';
      return;
    }
    bar.innerHTML = keep.map(function (i) {
      return '<div title="' + i.sym + ' ' + i.pct.toFixed(1) + '%" style="width:' + i.pct.toFixed(2) + '%;background:' + i.color + ';"></div>';
    }).join('');
    legend.innerHTML = keep.map(function (i) {
      return '<div class="flex items-center gap-2 text-sm">' +
        '<span style="width:10px;height:10px;border-radius:3px;background:' + i.color + ';"></span>' +
        '<span style="color:var(--text-secondary);">' + i.sym + '</span>' +
        '<span class="font-mono font-medium">' + i.pct.toFixed(1) + '%</span></div>';
    }).join('');
  }

  function patchPrices() {
    Object.keys(COIN_META).forEach(function (sym) {
      var v = $('#assetsTableBody .js-val[data-sym="' + sym + '"]');
      if (v && priceOf(sym)) v.textContent = F.fmtCompact(coinQty(sym) * priceOf(sym));
      var g = $('#assetsTableBody .js-chg[data-sym="' + sym + '"]');
      if (g && sym !== 'USDT') {
        var chg = num(S.chg[sym]);
        g.className = (chg >= 0 ? 'badge-green' : 'badge-red') + ' js-chg';
        g.setAttribute('data-sym', sym);
        g.textContent = (chg >= 0 ? '+' : '') + Math.abs(chg).toFixed(2) + '%';
      }
    });
    renderDistribution();
  }

  /* ------------------------------------------------------------ deposit */
  function depositAddress(sym) {
    var map = A.readJSON(DEPOSIT_KEY, {}) || {};
    if (!map[sym]) {
      var uid = A.get(A.KEYS.uid, 'user');
      var seed = 0, s = uid + sym;
      for (var i = 0; i < s.length; i++) seed = (seed * 31 + s.charCodeAt(i)) >>> 0;
      var hex = '';
      for (var j = 0; j < 64; j++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        hex += ('0' + ((seed >>> 16) & 0xf).toString(16)).slice(-1);
      }
      map[sym] = (sym === 'BTC' ? 'bc1q' : '0x') + hex;
      A.writeJSON(DEPOSIT_KEY, map);
    }
    return map[sym];
  }

  function coinOptions(select, coins) {
    if (!select) return;
    select.innerHTML = coins.map(function (c) { return '<option value="' + c + '">' + c + '</option>'; }).join('');
  }

  function initDeposit() {
    var coins = ['USDT', 'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'DOT', 'LTC', 'LINK', 'AVAX', 'TRX'];
    coinOptions($('#depositCoinSelect'), coins);
    var sel = $('#depositCoinSelect');
    var proof = null;
    var proofReading = 0;

    function info() {
      var sym = sel.value;
      var m = meta(sym);
      $('#depositNetworkDisplay').textContent = m.net;
      var addr = depositAddress(sym);
      $('#depositAddressText').textContent = addr;
      $('#depositMinAmount').textContent = F.fmtQty(m.min) + ' ' + sym;
      $('#depositWarnCoin').textContent = sym;
      $('#depositWarnNetwork').textContent = m.label;
      var c = $('#depositQR');
      if (c && global.QRCode) {
        try { global.QRCode.toCanvas(c, addr, { width: 144, margin: 1, color: { dark: '#000000ff', light: '#ffffffff' } }); } catch (e) {}
      }
    }
    sel.addEventListener('change', info);
    info();

    $('#copyAddrBtn').addEventListener('click', function () {
      var t = $('#depositAddressText').textContent;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).then(function () { toast('Address copied'); }, function () { toast('Copy failed', 'err'); });
      } else toast('Copy not available in this browser', 'err');
    });

    $('#attachProofBtn').addEventListener('click', function () { $('#depositProofInput').click(); });
    $('#depositProofInput').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      proof = null;
      proofReading++;
      var mine = proofReading;
      $('#depositProofPreview').style.display = 'flex';
      $('#depositProofName').textContent = 'Reading ' + f.name + '…';
      // The transfer receipt travels with the request as an inline image, so
      // the console can actually look at it instead of seeing a file name.
      global.BitbaseShell.readAttachment(f).then(function (rec) {
        if (mine !== proofReading) return;
        proof = rec;
        $('#depositProofName').textContent = rec.data ? rec.name : rec.name + ' — too large to attach';
      });
    });
    $('#removeDepositProof').addEventListener('click', function () {
      proof = null;
      proofReading++;
      $('#depositProofInput').value = '';
      $('#depositProofPreview').style.display = 'none';
    });

    $('#depositSubmitBtn').addEventListener('click', function () {
      setErr('#depositError', '');
      var sym = sel.value;
      var m = meta(sym);
      var amt = num($('#depositAmount').value);
      if (amt < m.min) { setErr('#depositError', 'Minimum deposit is ' + F.fmtQty(m.min) + ' ' + sym); return; }
      if (amt > 1e9) { setErr('#depositError', 'Amount is out of range'); return; }

      var btn = $('#depositSubmitBtn');
      btn.disabled = true;
      $('#depositSpinner').style.display = 'inline-block';

      setTimeout(async function () {
        try {
          // Deposits are a request: nothing is credited until an admin approves
          // it, so the console controls when funds actually land.
          if (!btn.dataset.pendingSave) {
          var uid = A.get(A.KEYS.uid, '');
          A.activity.add('deposit', {
            amount: amt, coin: sym, usd: amt * priceOf(sym),
            wallet: sym === 'USDT' ? 'funding' : 'spot',
            method: 'address', network: m.net,
            proof: proof, proofName: proof ? proof.name : null,
            status: 'pending'
          });
            btn.dataset.pendingSave = '1';
          }
          await A.flush();
          delete btn.dataset.pendingSave;
          toast('Deposit submitted for review');
          $('#depositAmount').value = '';
          proof = null;
          $('#depositProofInput').value = '';
          $('#depositProofPreview').style.display = 'none';
          closeModal('depositModal');
          render();
        } catch (e) {
          console.error('deposit submit failed', e);
          setErr('#depositError', 'Deposit is not confirmed as saved. Use Retry in the connection notice; do not submit it again.');
        } finally {
          btn.disabled = false;
          $('#depositSpinner').style.display = 'none';
        }
      }, 700);
    });
  }

  /* ----------------------------------------------------------- withdraw */
  function initWithdraw() {
    coinOptions($('#withdrawCoinSelect'), ['USDT', 'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'DOT', 'LTC', 'LINK', 'AVAX', 'TRX']);
    var sel = $('#withdrawCoinSelect');
    var FEES = { USDT: 1, BTC: 0.0002, ETH: 0.0005, SOL: 0.001, BNB: 0.001, XRP: 0.5, DOGE: 1, ADA: 0.5, DOT: 0.1, LTC: 0.001, LINK: 0.05, AVAX: 0.01, TRX: 1 };

    function info() {
      var sym = sel.value;
      var m = meta(sym);
      var net = $('#withdrawNetworkSelect');
      net.innerHTML = '<option value="' + m.net + '">' + m.net + '</option>';
      $('#withdrawAvailable').textContent = fmtQty(coinQty(sym)) + ' ' + sym;
      $('#withdrawFee').textContent = F.fmtQty(FEES[sym] || 0.0001) + ' ' + sym;
    }
    sel.addEventListener('change', info);
    info();

    $('#withdrawMaxBtn').addEventListener('click', function () {
      var sym = sel.value;
      var fee = num(FEES[sym] || 0.0001);
      var max = Math.max(0, coinQty(sym) - fee);
      $('#withdrawAmount').value = max > 0 ? String(Number(max.toFixed(8))) : '';
    });

    $('#withdrawSubmitBtn').addEventListener('click', function () {
      setErr('#withdrawError', '');
      var sym = sel.value;
      var addr = String($('#withdrawAddress').value || '').trim();
      var amt = num($('#withdrawAmount').value);
      var fee = num(FEES[sym] || 0.0001);
      var net = meta(sym).net;
      if (addr.length < 12) { setErr('#withdrawError', 'Enter a valid recipient address'); return; }
      if (amt <= 0) { setErr('#withdrawError', 'Enter an amount to withdraw'); return; }
      if (amt + fee > coinQty(sym)) { setErr('#withdrawError', 'Amount plus network fee exceeds your ' + sym + ' balance'); return; }

      var btn = $('#withdrawSubmitBtn');
      btn.disabled = true;
      $('#withdrawSpinner').style.display = 'inline-block';
      setTimeout(async function () {
        try {
          // A withdrawal is a request too. The amount plus fee is held now so
          // it cannot be spent twice, and released again if it is rejected.
          if (!btn.dataset.pendingSave) {
          setCoinQty(sym, coinQty(sym) - amt - fee);
          A.activity.add('withdrawal', {
            amount: amt, usd: amt * priceOf(sym), coin: sym,
            address: addr, fee: fee, network: net, status: 'pending'
          });
            btn.dataset.pendingSave = '1';
          }
          await A.flush();
          delete btn.dataset.pendingSave;
          toast('Withdrawal submitted for review');
          $('#withdrawAmount').value = '';
          $('#withdrawAddress').value = '';
          closeModal('withdrawModal');
          render();
        } catch (e) {
          console.error('withdraw submit failed', e);
          setErr('#withdrawError', 'Withdrawal is not confirmed as saved. Use Retry in the connection notice; do not submit it again.');
        } finally {
          btn.disabled = false;
          $('#withdrawSpinner').style.display = 'none';
        }
      }, 700);
    });
  }

  /* ----------------------------------------------------------- transfer */
  function initTransfer() {
    var coins = ['USDT', 'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE'];
    coinOptions($('#transferCoinSelect'), coins);
    var from = $('#transferFrom'), to = $('#transferTo'), coin = $('#transferCoinSelect');

    // Only USDT is wallet-native; crypto stays in spot.
    function available() {
      var sym = coin.value;
      if (from.value === 'funding') return sym === 'USDT' ? funding() : 0;
      return coinQty(sym);
    }
    function refresh() {
      var sym = coin.value;
      var label = from.value === 'funding' ? 'Funding Wallet' : 'Spot Wallet';
      if (sym !== 'USDT' && from.value === 'funding') {
        $('#transferAvailable').textContent = '0 \u2014 crypto is held in Spot';
      } else {
        $('#transferAvailable').textContent = fmtQty(available()) + ' ' + sym + ' (' + label + ')';
      }
    }
    from.addEventListener('change', refresh);
    to.addEventListener('change', refresh);
    coin.addEventListener('change', refresh);
    refresh();

    $('#transferSwapBtn').addEventListener('click', function () {
      var a = from.value;
      from.value = to.value;
      to.value = a;
      refresh();
    });

    $('#transferMaxBtn').addEventListener('click', function () {
      var a = available();
      $('#transferAmount').value = a > 0 ? String(Number(a.toFixed(8))) : '';
    });

    $('#transferSubmitBtn').addEventListener('click', function () {
      setErr('#transferError', '');
      var sym = coin.value;
      var amt = num($('#transferAmount').value);
      if (from.value === to.value) { setErr('#transferError', 'Choose two different wallets'); return; }
      if (sym !== 'USDT' && (from.value === 'funding' || to.value === 'funding')) {
        setErr('#transferError', 'Only USDT can be held in the Funding wallet');
        return;
      }
      if (amt <= 0) { setErr('#transferError', 'Enter an amount to transfer'); return; }
      if (amt > available()) { setErr('#transferError', 'Amount exceeds the source wallet balance'); return; }

      var btn = $('#transferSubmitBtn');
      btn.disabled = true;
      $('#transferSpinner').style.display = 'inline-block';
      setTimeout(async function () {
        try {
          if (from.value === 'funding') {
            setFunding(funding() - amt);
            A.setCash(A.cash() + amt);
          } else {
            A.setCash(A.cash() - amt);
            setFunding(funding() + amt);
          }
          A.activity.add('transfer', { amount: amt, coin: 'USDT', from: from.value, to: to.value });
          toast('Transferred ' + fmtQty(amt) + ' USDT to the ' + (to.value === 'funding' ? 'Funding' : 'Spot') + ' wallet');
          $('#transferAmount').value = '';
          closeModal('transferModal');
          render();
        } catch (e) {
          setErr('#transferError', 'Transfer failed. Please retry.');
        } finally {
          btn.disabled = false;
          $('#transferSpinner').style.display = 'none';
        }
      }, 600);
    });
  }

  /* ------------------------------------------------------------ convert */
  var refreshConvert = function () {};
  function initConvert() {
    var coins = ['USDT', 'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA'];
    coinOptions($('#convertFromCoin'), coins.filter(function (c) { return c !== 'USDT'; }));
    coinOptions($('#convertToCoin'), coins);
    $('#convertFromCoin').value = 'BTC';
    $('#convertToCoin').value = 'USDT';
    var from = $('#convertFromCoin'), to = $('#convertToCoin'), amt = $('#convertFromAmount'), out = $('#convertToAmount');

    function rate() {
      var a = priceOf(from.value);
      var b = priceOf(to.value);
      return a > 0 && b > 0 ? a / b : 0;
    }
    function update() {
      var r = rate();
      var a = num(amt.value);
      $('#convertRate').textContent = r
        ? '1 ' + from.value + ' = ' + r.toLocaleString('en-US', { maximumFractionDigits: 6 }) + ' ' + to.value
        : 'Waiting for a live price…';
      out.value = r && a ? String(Number((a * r).toFixed(8))) : '';
    }
    // Prices arrive after boot, so re-derive whenever they change.
    refreshConvert = update;
    from.addEventListener('change', update);
    to.addEventListener('change', update);
    amt.addEventListener('input', update);

    $('#convertMaxBtn').addEventListener('click', function () {
      var q = coinQty(from.value);
      amt.value = q > 0 ? String(Number(q.toFixed(8))) : '';
      update();
    });

    $('#convertSwapBtn').addEventListener('click', function () {
      var a = from.value;
      from.value = to.value;
      to.value = a;
      amt.value = '';
      out.value = '';
      update();
    });

    $('#convertSubmitBtn').addEventListener('click', function () {
      setErr('#convertError', '');
      var f = from.value, t = to.value;
      var a = num(amt.value);
      var r = rate();
      if (f === t) { setErr('#convertError', 'Choose two different coins'); return; }
      if (a <= 0) { setErr('#convertError', 'Enter an amount to convert'); return; }
      if (a > coinQty(f)) { setErr('#convertError', 'Amount exceeds your ' + f + ' balance'); return; }
      if (!r) { setErr('#convertError', 'No live price for that pair'); return; }

      var btn = $('#convertSubmitBtn');
      btn.disabled = true;
      $('#convertSpinner').style.display = 'inline-block';
      setTimeout(async function () {
        try {
          var got = a * r;
          setCoinQty(f, coinQty(f) - a);
          if (t === 'USDT') setFunding(funding() + got);
          else setCoinQty(t, coinQty(t) + got);
          A.activity.add('convert', { from: f, to: t, amount: a, received: got });
          toast('Converted ' + fmtQty(a) + ' ' + f + ' to ' + fmtQty(got) + ' ' + t);
          amt.value = '';
          out.value = '';
          closeModal('convertModal');
          render();
        } catch (e) {
          setErr('#convertError', 'Conversion failed. Please retry.');
        } finally {
          btn.disabled = false;
          $('#convertSpinner').style.display = 'none';
        }
      }, 600);
    });

    // A converted coin needs a price even before the ticker lands.
    update();
  }

  /* --------------------------------------------------------------- loan */
  function initLoan() {
    function durationButtons() {
      $$('#loanDurations .loan-duration-btn').forEach(function (b) {
        b.addEventListener('click', function () {
          $$('#loanDurations .loan-duration-btn').forEach(function (x) { x.classList.remove('active'); });
          b.classList.add('active');
          S.loan.days = parseInt(b.dataset.days, 10);
          S.loan.rate = parseFloat(b.dataset.rate);
          summary();
        });
      });
    }
    function summary() {
      var amt = num($('#loanBorrowAmt').value);
      var sec = $('#loanInterestSection');
      if (amt <= 0) { sec.style.display = 'none'; return; }
      sec.style.display = 'block';
      var interest = amt * S.loan.rate * (S.loan.days / 365);
      $('#loanSummaryBorrow').textContent = fmtUSD(amt);
      $('#loanSummaryDuration').textContent = S.loan.days + ' Days';
      $('#loanSummaryRate').textContent = (S.loan.rate * 100).toFixed(1) + '%';
      $('#loanSummaryInterest').textContent = '+' + fmtUSD(interest);
      $('#loanSummaryTotal').textContent = fmtUSD(amt + interest);
    }
    $('#loanBorrowAmt').addEventListener('input', summary);
    durationButtons();

    var area = $('#loanUploadArea');
    var input = $('#loanProofInput');
    area.addEventListener('click', function () { input.click(); });
    area.addEventListener('dragover', function (e) { e.preventDefault(); area.style.borderColor = '#8b5cf6'; });
    area.addEventListener('dragleave', function () { area.style.borderColor = ''; });
    area.addEventListener('drop', function (e) {
      e.preventDefault();
      area.style.borderColor = '';
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) showLoanProof(f);
    });
    input.addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) showLoanProof(f);
    });
    var loanProof = null;
    var proofReading = 0;

    function showLoanProof(f) {
      if (f.size > 5 * 1024 * 1024) { toast('File is larger than 5MB', 'err'); return; }
      $('#loanUploadPlaceholder').style.display = 'none';
      var pv = $('#loanUploadPreview');
      pv.style.display = 'block';
      loanProof = null;
      var mine = ++proofReading;
      pv.innerHTML = '<div style="display:flex;align-items:center;gap:10px;justify-content:center;">' +
        '<i data-lucide="file-check" style="width:20px;height:20px;color:#16c784;"></i>' +
        '<span style="font-size:13px;color:#16c784;">Reading ' + global.BitbaseShell.esc(f.name) + '</span></div>';
      if (global.lucide) global.lucide.createIcons();
      // Proof of income is carried inline so the console can open it as a
      // picture; only the name survives when the file cannot be inlined.
      global.BitbaseShell.readAttachment(f).then(function (rec) {
        if (mine !== proofReading) return;
        loanProof = rec;
        pv.innerHTML = '<div style="display:flex;align-items:center;gap:10px;justify-content:center;">' +
          '<i data-lucide="file-check" style="width:20px;height:20px;color:#16c784;"></i>' +
          '<span style="font-size:13px;color:#16c784;">' + global.BitbaseShell.esc(rec.name) +
          (rec.data ? '' : ' — stored by name only') + '</span></div>';
        if (global.lucide) global.lucide.createIcons();
      });
    }

    $('#loanSubmitBtn').addEventListener('click', function () {
      setErr('#loanError', '');
      var amt = num($('#loanBorrowAmt').value);
      var portfolio = spotCash() + funding();
      Object.keys(COIN_META).forEach(function (sym) {
        if (sym === 'USDT') return;
        portfolio += coinQty(sym) * priceOf(sym);
      });
      if (amt < 50) { setErr('#loanError', 'Minimum loan is $50'); return; }
      if (portfolio <= 0) { setErr('#loanError', 'Deposit assets before borrowing against them'); return; }
      if (amt > portfolio * 0.5) { setErr('#loanError', 'You can borrow at most 50% of your portfolio value'); return; }
      if (!$('#loanAgreeCheck').checked) { setErr('#loanError', 'You must accept the loan agreement'); return; }

      var btn = $('#loanSubmitBtn');
      btn.disabled = true;
      $('#loanSpinner').style.display = 'inline-block';
      setTimeout(async function () {
        try {
          // Loans are a request as well: the funds are only credited once an
          // admin approves the application.
          if (!btn.dataset.pendingSave) {
          var interest = amt * S.loan.rate * (S.loan.days / 365);
          A.activity.add('borrow', {
            amount: amt, interest: interest, days: S.loan.days,
            due: Date.now() + S.loan.days * 86400000, rate: S.loan.rate,
            proof: loanProof, proofName: loanProof ? loanProof.name : null,
            status: 'pending'
          });
            btn.dataset.pendingSave = '1';
          }
          await A.flush();
          delete btn.dataset.pendingSave;
          toast('Loan application submitted for review');
          $('#loanBorrowAmt').value = '';
          $('#loanAgreeCheck').checked = false;
          closeModal('loanModal');
          render();
        } catch (e) {
          console.error('loan submit failed', e);
          setErr('#loanError', 'Loan is not confirmed as saved. Use Retry in the connection notice; do not submit it again.');
        } finally {
          btn.disabled = false;
          $('#loanSpinner').style.display = 'none';
        }
      }, 700);
    });
  }

  /* ---------------------------------------------------- customer support
     Every line the user sends is written to bb_support_threads, which is the
     same store the admin console reads, and the panel is always re-rendered
     from that thread. That is what makes messages visible in both directions:
     the user reaches the agent queue, and agent replies come back here.

     There is no auto-responder. Nothing is written into the conversation
     except what a person typed, so the only replies are real agents. */
  var THREADS_KEY = 'bb_support_threads';

  function initSupport() {
    var panel = $('#supportPanel');
    var body = $('#supportBody');
    if (!panel || !body) return;

    var lastSig = '';

    function myUid() { return String(A.get(A.KEYS.uid, '')); }

    function allThreads() {
      var all = A.readJSON(THREADS_KEY, []) || [];
      return Array.isArray(all) ? all : [];
    }
    function myThreads() {
      var me = myUid();
      return allThreads().filter(function (t) {
        return String(t.uid || t.userId || '') === me;
      }).sort(function (a, b) { return num(b.updated) - num(a.updated); });
    }
    /* Prefer an unresolved ticket; fall back to the newest so a resolved
       thread can be reopened rather than silently replaced. */
    function myThread() {
      var list = myThreads();
      for (var i = 0; i < list.length; i++) {
        if (list[i].status !== 'resolved') return list[i];
      }
      return list[0] || null;
    }
    function signature() {
      var t = myThread();
      if (!t) return 'none';
      return t.id + '|' + (t.messages || []).length + '|' + num(t.updated) + '|' + t.status;
    }

    /* Pictures are downscaled before they are written. The whole thread lives
       in localStorage, and a modern phone photo base64-encoded would eat the
       quota on its own, so anything over 1000px is re-encoded as a modest JPEG.
       Compressed pictures are saved with the message in Supabase. */
    var MAX_EDGE = 1000;

    function shrink(src) {
      return new Promise(function (res, rej) {
        var img = new Image();
        img.onload = function () {
          try {
            var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
            var scale = Math.min(1, MAX_EDGE / Math.max(w, h));
            var c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(w * scale));
            c.height = Math.max(1, Math.round(h * scale));
            var ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0, c.width, c.height);
            res(c.toDataURL('image/jpeg', 0.72));
          } catch (e) { rej(e); }
        };
        img.onerror = function () { rej(new Error('unreadable image')); };
        img.src = src;
      });
    }

    function notice(text) {
      var d = document.createElement('div');
      d.className = 'support-hint';
      d.style.padding = '12px';
      d.textContent = text;
      body.appendChild(d);
      body.scrollTop = body.scrollHeight;
    }

    /* Click to enlarge, same as every other gallery on the platform. */
    function zoom(src) {
      var o = document.createElement('div');
      o.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.92);' +
        'display:flex;align-items:center;justify-content:center;padding:16px;cursor:zoom-out';
      var i = document.createElement('img');
      i.src = src;
      i.alt = 'Sent picture';
      i.style.cssText = 'max-width:100%;max-height:100%;border-radius:8px';
      o.appendChild(i);
      o.addEventListener('click', function () { o.remove(); });
      document.body.appendChild(o);
    }

    function say(text, who, name, time, image) {
      var d = document.createElement('div');
      d.className = 'support-msg ' + who;
      if (image) {
        var img = document.createElement('img');
        img.src = image;
        img.alt = 'Sent picture';
        img.style.cssText = 'display:block;width:100%;max-height:220px;object-fit:cover;' +
          'border-radius:8px;cursor:zoom-in;margin-bottom:' + (text ? '8px' : '0');
        img.addEventListener('click', function () { zoom(image); });
        d.appendChild(img);
      }
      if (text) {
        var bodyText = document.createElement('div');
        bodyText.style.whiteSpace = 'pre-wrap';
        bodyText.textContent = text;
        d.appendChild(bodyText);
      }
      if (name) {
        var who2 = document.createElement('div');
        who2.className = 'msg-who';
        who2.textContent = name;
        d.appendChild(who2);
      }
      var t = new Date(time || Date.now());
      var tm = document.createElement('div');
      tm.className = 'msg-time';
      tm.textContent = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2);
      d.appendChild(tm);
      body.appendChild(d);
    }

    function paint() {
      lastSig = signature();
      var t = myThread();
      var rows = (t && Array.isArray(t.messages) ? t.messages : []).map(function (m) {
        var fromAdmin = m.from === 'admin';
        return {
          time: num(m.time),
          who: fromAdmin ? 'agent' : 'user',
          text: m.body,
          image: m.image || '',
          // The stored name is the console operator's account, which is an
          // internal role. The customer only ever sees "Support".
          name: fromAdmin ? 'Support' : ''
        };
      });
      rows.sort(function (a, b) { return a.time - b.time; });

      body.innerHTML = '';
      if (!rows.length) {
        // A placeholder, not a message: nothing is ever auto-inserted here.
        var hint = document.createElement('div');
        hint.className = 'support-hint';
        hint.textContent = 'Send a message and our support team will reply here.';
        body.appendChild(hint);
        return;
      }
      rows.forEach(function (r) { say(r.text, r.who, r.name, r.time, r.image); });
      body.scrollTop = body.scrollHeight;
    }

    function toggle() {
      var open = panel.style.display === 'flex';
      panel.style.display = open ? 'none' : 'flex';
      $('#supportTrigger').style.display = open ? 'flex' : 'none';
      if (!open) paint();
    }
    $('#supportTrigger').addEventListener('click', toggle);
    $('#supportBtn').addEventListener('click', toggle);
    $('#supportClose').addEventListener('click', toggle);

    /* Writes one user line onto this user's ticket. This is the only path that
       creates a conversation, and it runs for every message and every picture -
       previously a thread was only opened when the user happened to type one of
       a few trigger words, so most questions never reached the console.
       Returns false when the browser refused the write, so a picture that will
       not fit is reported instead of silently vanishing. */
    function pushUserMessage(text, image) {
      var me = myUid();
      var rec = A.readJSON(A.KEYS.users, {})[me] || {};
      var all = allThreads();
      var mine = all.filter(function (t) { return String(t.uid || t.userId || '') === me; });
      var t = null;
      for (var i = 0; i < mine.length; i++) {
        if (mine[i].status !== 'resolved') { t = mine[i]; break; }
      }
      if (!t) t = mine[0];
      if (!t) {
        t = {
          id: 'SUP-' + me + '-' + Date.now(),
          uid: me,
          name: rec.name || 'User',
          email: rec.email || '',
          subject: 'Chat enquiry',
          status: 'open',
          created: Date.now(),
          updated: Date.now(),
          messages: []
        };
        all.unshift(t);
      }
      // Writing to a resolved ticket reopens it so it returns to the Open queue.
      t.status = 'open';
      t.updated = Date.now();
      t.name = rec.name || t.name;
      t.email = rec.email || t.email;
      t.messages = Array.isArray(t.messages) ? t.messages : [];
      t.messages.push({
        from: 'user', uid: me, name: rec.name || 'User',
        body: text || '',
        image: image || null,
        time: Date.now()
      });
      return A.writeJSON(THREADS_KEY, all.slice(0, 300));
    }

    /* One click, one message. Nothing is added on the user's behalf, so the
       thread contains only what people actually typed or attached. */
    async function send() {
      var input = $('#supportInput'), button = $('#supportSend');
      var v = String(input.value || '').trim();
      if (!v || button.disabled) return;
      button.disabled = true;
      if (!pushUserMessage(v)) { button.disabled = false; notice('Could not queue your message.'); return; }
      input.value = '';
      paint(); notice('Sending message…');
      try { await A.flush(); paint(); }
      catch (e) { notice('Message not delivered yet. Use Retry in the connection notice to send the saved message.'); }
      finally { button.disabled = false; }
    }
    $('#supportSend').addEventListener('click', send);
    $('#supportInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });

    /* Pictures: pick one, it is shrunk, attached to the same ticket and shown
       straight away. Anything typed but not yet sent rides along as a caption. */
    var picker = $('#supportAttach');
    var fileBox = $('#supportFile');
    if (picker && fileBox) {
      picker.addEventListener('click', function () {
        fileBox.value = '';       // so picking the same file twice still fires
        fileBox.click();
      });
      fileBox.addEventListener('change', function () {
        var f = fileBox.files && fileBox.files[0];
        if (!f) return;
        if (String(f.type).indexOf('image/') !== 0) {
          notice('Only image files can be sent here.');
          return;
        }
        var reader = new FileReader();
        reader.onload = function () {
          shrink(reader.result).then(async function (dataUrl) {
            var caption = String($('#supportInput').value || '').trim();
            $('#supportInput').value = '';
            if (!pushUserMessage(caption, dataUrl)) {
              notice('That picture was too large to save. Try a smaller image.');
              return;
            }
            paint(); notice('Sending picture…');
            try { await A.flush(); paint(); }
            catch (e) { notice('Picture not delivered yet. Use Retry in the connection notice.'); }
          }).catch(function () {
            notice('That picture could not be read.');
          });
        };
        reader.onerror = function () { notice('That picture could not be read.'); };
        reader.readAsDataURL(f);
      });
    }

    paint();
    // Database events update the open panel without replacing the input draft.
    global.addEventListener('bitbase:data', function () {
      if (panel.style.display === 'flex' && signature() !== lastSig) paint();
    });
    global.addEventListener('bitbase:saved', function () { if (panel.style.display === 'flex') paint(); });
    // Local demo tabs have no database channel.
    if (!A.isRemote()) setInterval(function () {
      if (panel.style.display === 'flex' && signature() !== lastSig) paint();
    }, 1000);
  }

  /* --------------------------------------------------------------- boot */
  function boot() {
  if (!global.BitbaseShell.mount({ active: 'assets' })) return;
    S.hideZero = A.get(HIDDEN_KEY, '0') === '1';
    var t = $('#hideZeroToggle');
    if (t) {
      t.checked = S.hideZero;
      t.addEventListener('change', function () {
        S.hideZero = t.checked;
        A.set(HIDDEN_KEY, t.checked ? '1' : '0');
        render();
      });
    }

    $$('[data-modal]').forEach(function (b) {
      b.addEventListener('click', function () { openModal(b.dataset.modal); });
    });
    // Any element marked [data-close] closes its own modal; overlays close on
    // a backdrop click, buttons close unconditionally.
    $$('[data-close]').forEach(function (el) {
      el.addEventListener('click', function (e) {
        var m = el.closest('.modal-overlay');
        if (!m) return;
        if (el === m && e.target !== m) return;
        closeModal(m.id);
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') $$('.modal-overlay.open').forEach(function (m) { closeModal(m.id); });
    });

    $$('.tab-btn[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('.tab-btn[data-tab]').forEach(function (x) { x.classList.remove('active'); });
        b.classList.add('active');
        S.tab = b.dataset.tab;
        render();
      });
    });

    initDeposit();
    initWithdraw();
    initTransfer();
    initConvert();
    initLoan();
    initSupport();
    global.addEventListener('bitbase:data', render);

    render();

    F.loadMarkets().then(function (rows) {
      rows.forEach(function (r) { S.price[r.sym] = r.price; S.chg[r.sym] = r.change; });
      render();
      refreshConvert();
    });

    F.openTickerStream(function (arr) {
      for (var i = 0; i < arr.length; i++) {
        var x = arr[i];
        if (!x || !x.s) continue;
        var sym = String(x.s).replace(/USDT$/, '');
        if (S.price[sym] === undefined) continue;
        S.price[sym] = parseFloat(x.c);
        if (x.o) S.chg[sym] = ((parseFloat(x.c) - parseFloat(x.o)) / parseFloat(x.o)) * 100;
      }
      patchPrices();
      refreshConvert();
    });
  }
// Nothing renders until the database mirror is filled, so the first
  // paint is already the user's own data rather than a blank frame.
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', function () { A.whenReady(boot); });
  else A.whenReady(boot);
})(window);
