/* ==========================================================================
   Bitbase – history page
   Normalises every ledger the app writes (real trades, demo trades,
   deposits, withdrawals, transfers, conversions, borrows) into one table
   with search, date range, CSV export, pagination and a detail modal.
   ========================================================================== */
(function (global) {
  'use strict';

  var A = global.BitbaseAuth;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  if (!global.BitbaseShell.mount({ active: 'history' })) return;

  var PER_PAGE = 10;
  var S = { filter: 'all', q: '', from: '', to: '', page: 1, rows: [] };

  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
  function fmtUSD(v) { return '$' + num(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function esc(s) { return global.BitbaseShell.esc(s); }

  function fmtWhen(t) {
    var d = new Date(num(t));
    if (!isFinite(d.getTime()) || !num(t)) return '\u2014';
    var M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var p2 = function (n) { return ('0' + n).slice(-2); };
    return M[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() + ' &middot; ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
  }

  function mine(r) {
    var uid = A.get(A.KEYS.uid, '');
    if (!r) return false;
    var id = r.userId || r.uid || '';
    return (!id && !uid) || String(id) === String(uid);
  }

  /* ------------------------------------------------------- normalisers */
  function realTrades() {
    return (A.readJSON('bb_trades_history', []) || []).filter(mine).map(function (t) {
      var won = t.status === 'Won';
      var payout = t.status === 'Closed' ? num(t.refund) : (won ? num(t.amt) + num(t.profit) : 0);
      return {
        kind: 'trade', source: 'Real trade', id: t.id,
        label: (t.dir || '') + ' ' + (t.pair || ''),
        amount: payout, sign: won || t.status === 'Closed' ? '+' : '-',
        time: t.time || t.startTime,
        status: t.status || 'Active',
        detail: [
          ['Trade ID', t.id || '\u2014'],
          ['Pair', t.pair || '\u2014'],
          ['Direction', t.dir || '\u2014'],
          ['Stake', fmtUSD(t.amt)],
          ['Duration', (num(t.dur) >= 60 ? Math.round(num(t.dur) / 60) + 'm' : num(t.dur) + 's')],
          ['Entry price', t.entryPrice ? num(t.entryPrice).toLocaleString('en-US') : '\u2014'],
          ['Exit price', t.exitPrice ? num(t.exitPrice).toLocaleString('en-US') : '\u2014'],
          ['Profit', fmtUSD(t.profit)],
          ['Result', won ? 'Won' : t.status === 'Closed' ? 'Closed early (50% refund)' : t.status === 'Lost' ? 'Lost' : 'In progress']
        ]
      };
    });
  }

  function demoTrades() {
    return (A.readJSON('bb_demo_trades_hist', []) || []).filter(mine).map(function (t) {
      var won = t.status === 'Won';
      var payout = t.status === 'Closed' ? num(t.refund) : (won ? num(t.amt) + num(t.profit) : 0);
      return {
        kind: 'demo', source: 'Demo trade', id: t.id,
        label: (t.dir || '') + ' ' + (t.pair || ''),
        amount: payout, sign: won || t.status === 'Closed' ? '+' : '-',
        time: t.time || t.startTime,
        status: t.status || 'Active',
        detail: [
          ['Trade ID', t.id || '\u2014'], ['Pair', t.pair || '\u2014'],
          ['Direction', t.dir || '\u2014'], ['Stake', fmtUSD(t.amt)],
          ['Profit', fmtUSD(t.profit)], ['Result', won ? 'Won' : t.status || '\u2014'],
          ['Account', 'Virtual demo funds']
        ]
      };
    });
  }

  function simple(kind, source, labelFn, detailFn) {
    return (A.readJSON('bb_' + kind + '_requests', []) || []).filter(mine).map(function (r) {
      var d = detailFn(r);
      return {
        kind: kind, source: source, id: r.id || (kind + '-' + num(r.time)),
        label: labelFn(r), amount: num(d.amount), sign: d.sign,
        time: r.time, status: d.status || 'Completed', detail: d.rows
      };
    });
  }

  function collect() {
  /* Deposits, withdrawals and loans are all approved by an admin now, so
     their status is the request's own state, not a flat "Completed". */
  function reqStatus(r) {
    var s = r.status || 'pending';
    if (s === 'approved') return 'Approved';
    if (s === 'rejected') return 'Rejected';
    if (s === 'pending') return 'Pending';
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

    return []
      .concat(realTrades())
      .concat(demoTrades())
      .concat(simple('deposit', 'Deposit',
        function (r) { return 'Deposit ' + (r.coin || 'USDT'); },
        function (r) { return { amount: num(r.amount), sign: '+', status: reqStatus(r), rows: [
          ['Coin', r.coin || 'USDT'], ['Amount', fmtUSD(r.amount)],
          ['Wallet', r.wallet === 'funding' ? 'Funding' : 'Spot'], ['Method', r.method || 'address']
        ] }; }))
      .concat(simple('withdrawal', 'Withdrawal',
        function (r) { return 'Withdraw ' + (r.coin || 'USDT'); },
        function (r) { return { amount: num(r.usd !== undefined ? r.usd : r.amount), sign: '-', status: reqStatus(r), rows: [
          ['Coin', r.coin || 'USDT'], ['Amount', fmtUSD(r.amount)],
          ['Value', fmtUSD(r.usd !== undefined ? r.usd : r.amount)],
          ['Network fee', r.fee ? String(r.fee) + ' ' + (r.coin || 'USDT') : '\u2014'],
          ['Address', r.address || '\u2014']
        ] }; }))
      .concat(simple('transfer', 'Transfer',
        function (r) { return 'Transfer ' + (r.coin || 'USDT'); },
        function (r) { return { amount: num(r.amount), sign: '\u2194', status: 'Completed', rows: [
          ['Coin', r.coin || 'USDT'], ['Amount', fmtUSD(r.amount)],
          ['From', r.from === 'funding' ? 'Funding Wallet' : 'Spot Wallet'],
          ['To', r.to === 'funding' ? 'Funding Wallet' : 'Spot Wallet']
        ] }; }))
      .concat(simple('convert', 'Conversion',
        function (r) { return r.from + ' \u2192 ' + r.to; },
        function (r) { return { amount: num(r.received), sign: '\u2194', status: 'Completed', rows: [
          ['From', r.from], ['Sent', String(r.amount) + ' ' + r.from],
          ['To', r.to], ['Received', String(r.received) + ' ' + r.to]
        ] }; }))
      .concat(simple('trade', 'Quick Trade',
        function (r) { return (r.side === 'buy' ? 'Buy ' : 'Sell ') + String(r.pair || '').replace('/USDT', ''); },
        function (r) { return { amount: num(r.value !== undefined ? r.value : (num(r.qty) * num(r.price))), sign: r.side === 'buy' ? '+' : '-', status: 'Completed', rows: [
          ['Pair', r.pair || '\u2014'], ['Side', (r.side || 'sell') === 'buy' ? 'Buy' : 'Sell'],
          ['Quantity', String(r.qty) + ' ' + String(r.pair || '').split('/')[0]],
          ['Price', fmtUSD(r.price)], ['Value', fmtUSD(r.value !== undefined ? r.value : (num(r.qty) * num(r.price)))]
        ] }; }))
      .concat(simple('borrow', 'Loan',
        function (r) { return 'Borrow USDT'; },
        function (r) { return { amount: num(r.amount), sign: '+', status: reqStatus(r) === 'Pending' ? 'Pending' : (r.status === 'paid' ? 'Paid' : (r.status === 'rejected' ? 'Rejected' : 'Outstanding')), rows: [
          ['Borrowed', fmtUSD(r.amount)],
          ['Interest rate', (num(r.rate) * 100).toFixed(1) + '%'],
          ['Term', r.days + ' days'],
          ['Interest', fmtUSD(r.interest)],
          ['Total due', fmtUSD(num(r.amount) + num(r.interest))],
          ['Due', r.due ? fmtWhen(r.due) : '\u2014']
        ] }; }))
      .sort(function (a, b) { return num(b.time) - num(a.time); });
  }

  /* ------------------------------------------------------------ filtering */
  function filtered() {
    var q = S.q.trim().toLowerCase();
    return S.rows.filter(function (r) {
      if (S.filter === 'trade' && r.kind !== 'trade') return false;
      if (S.filter === 'demo' && r.kind !== 'demo') return false;
      if (S.filter !== 'all' && S.filter !== 'demo' && r.kind !== S.filter) return false;

      var t = num(r.time);
      if (S.from) {
        var f = new Date(S.from + 'T00:00:00').getTime();
        if (t && t < f) return false;
      }
      if (S.to) {
        var to = new Date(S.to + 'T23:59:59').getTime();
        if (t && t > to) return false;
      }
      if (q) {
        var hay = (r.source + ' ' + r.label + ' ' + r.status + ' ' + (r.id || '')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  function badgeFor(r) {
    var s = String(r.status || '');
    if (s === 'Won' || s === 'Completed' || s === 'Closed') return 'badge-green';
    if (s === 'Lost') return 'badge-red';
    if (s === 'Active' || s === 'Outstanding') return 'badge-green';
    if (s === 'Pending') return 'badge-amber';
    if (s === 'Approved' || s === 'Paid') return 'badge-green';
    if (s === 'Rejected') return 'badge-red';
    return 'badge-red';
  }

  function render() {
    var list = filtered();
    var total = list.length;
    var pages = Math.max(1, Math.ceil(total / PER_PAGE));
    if (S.page > pages) S.page = pages;
    var start = (S.page - 1) * PER_PAGE;
    var slice = list.slice(start, start + PER_PAGE);

    var body = $('#tableBody');
    var empty = $('#emptyState');
    var card = $('#tableCard');
    var table = card.querySelector('table');

    if (!total) {
      body.innerHTML = '';
      table.style.display = 'none';
      empty.style.display = 'block';
    } else {
      table.style.display = '';
      empty.style.display = 'none';
      body.innerHTML = slice.map(function (r) {
        return '<tr>' +
          '<td><div style="font-weight:500;">' + esc(r.source) + '</div>' +
            '<div style="font-size:12px;color:var(--text-tertiary);">' + esc(r.label) + '</div></td>' +
          '<td class="text-right font-mono" style="color:' +
            (r.sign === '+' ? '#16c784' : r.sign === '-' ? '#ea3943' : 'var(--text-secondary)') + ';">' +
            r.sign + fmtUSD(r.amount) + '</td>' +
          '<td style="color:var(--text-secondary);">' + fmtWhen(r.time) + '</td>' +
          '<td><span class="' + badgeFor(r) + '">' + esc(r.status) + '</span></td>' +
          '<td class="text-right"><button data-detail="' + esc(r.id) + '" style="padding:5px 12px;border-radius:8px;border:1px solid var(--border-medium);background:rgba(255,255,255,.04);color:var(--text-secondary);font-size:12px;cursor:pointer;">View</button></td>' +
        '</tr>';
      }).join('');
      $$('[data-detail]', body).forEach(function (b) {
        b.addEventListener('click', function () { openDetail(b.dataset.detail); });
      });
    }

    var st = $('#showingText');
    if (st) {
      st.textContent = total
        ? 'Showing ' + (start + 1) + '-' + Math.min(start + PER_PAGE, total) + ' of ' + total + ' transaction' + (total === 1 ? '' : 's')
        : 'No transactions to show';
    }

    var pg = $('#pagination');
    if (pg) {
      if (pages <= 1) { pg.innerHTML = ''; return; }
      var html = '<button class="pager-btn" data-page="' + (S.page - 1) + '"' + (S.page === 1 ? ' disabled' : '') + '>Prev</button>';
      for (var i = 1; i <= pages; i++) {
        if (pages > 7 && i > 2 && i < pages - 1 && Math.abs(i - S.page) > 1) {
          if (i === 3) html += '<span style="padding:0 6px;color:var(--text-tertiary);">&hellip;</span>';
          continue;
        }
        html += '<button class="pager-btn' + (i === S.page ? ' active' : '') + '" data-page="' + i + '">' + i + '</button>';
      }
      html += '<button class="pager-btn" data-page="' + (S.page + 1) + '"' + (S.page === pages ? ' disabled' : '') + '>Next</button>';
      pg.innerHTML = html;
      $$('[data-page]', pg).forEach(function (b) {
        b.addEventListener('click', function () {
          S.page = parseInt(b.dataset.page, 10);
          render();
        });
      });
    }
  }

  function openDetail(id) {
    var r = S.rows.filter(function (x) { return String(x.id) === String(id); })[0];
    if (!r) return;
    $('#modalContent').innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:18px;">' +
        '<span class="' + badgeFor(r) + '">' + esc(r.status) + '</span>' +
        '<span style="font-size:12px;color:var(--text-tertiary);">' + esc(r.source) + '</span>' +
      '</div>' +
      (r.detail || []).map(function (d) {
        return '<div style="display:flex;justify-content:space-between;gap:16px;padding:8px 0;border-bottom:1px solid var(--border-subtle);">' +
          '<span style="font-size:13px;color:var(--text-secondary);">' + esc(d[0]) + '</span>' +
          '<span class="font-mono" style="font-size:13px;font-weight:500;text-align:right;">' + esc(d[1]) + '</span></div>';
      }).join('') +
      '<div style="display:flex;justify-content:space-between;padding:12px 0 0;">' +
        '<span style="font-size:13px;color:var(--text-secondary);">Time</span>' +
        '<span class="font-mono" style="font-size:13px;">' + fmtWhen(r.time) + '</span></div>';
    var m = $('#detailModal');
    m.classList.add('open');
    m.style.display = 'flex';
  }

  function toCsv(rows) {
    var head = ['id', 'type', 'label', 'amount_usd', 'direction', 'status', 'time'];
    var lines = [head.join(',')];
    rows.forEach(function (r) {
      lines.push([
        '"' + String(r.id || '').replace(/"/g, '""') + '"',
        '"' + r.source + '"',
        '"' + String(r.label).replace(/"/g, '""') + '"',
        r.amount.toFixed(2),
        r.sign,
        '"' + r.status + '"',
        new Date(num(r.time)).toISOString()
      ].join(','));
    });
    return lines.join('\n');
  }

  function boot() {
    S.rows = collect();
    render();

    $$('#filterTabs .tab-btn').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('#filterTabs .tab-btn').forEach(function (x) {
          x.classList.remove('active');
          x.style.background = '';
          x.style.borderColor = 'var(--border-medium)';
          x.style.color = 'var(--text-secondary)';
        });
        b.classList.add('active');
        b.style.background = 'rgba(247,147,26,0.15)';
        b.style.borderColor = 'rgba(247,147,26,0.2)';
        b.style.color = '#fdb022';
        S.filter = b.dataset.filter;
        S.page = 1;
        render();
      });
    });

    var search = $('#searchInput');
    search.addEventListener('input', function () { S.q = search.value; S.page = 1; render(); });
    $('#dateFrom').addEventListener('change', function () { S.from = this.value; S.page = 1; render(); });
    $('#dateTo').addEventListener('change', function () { S.to = this.value; S.page = 1; render(); });

    $('#clearFilters').addEventListener('click', function () {
      S.q = ''; S.from = ''; S.to = ''; S.filter = 'all'; S.page = 1;
      search.value = ''; $('#dateFrom').value = ''; $('#dateTo').value = '';
      $$('#filterTabs .tab-btn').forEach(function (x, i) {
        x.classList.toggle('active', i === 0);
        x.style.background = ''; x.style.borderColor = 'var(--border-medium)'; x.style.color = 'var(--text-secondary)';
      });
      this.classList.add('hidden');
      render();
    });
    [search, $('#dateFrom'), $('#dateTo')].forEach(function (el) {
      el.addEventListener('input', function () {
        if (S.q || S.from || S.to) $('#clearFilters').classList.remove('hidden');
      });
    });

    $('#exportBtn').addEventListener('click', function () {
      var list = filtered();
      if (!list.length) return;
      var blob = new Blob([toCsv(list)], { type: 'text/csv;charset=utf-8;' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'bitbase-history-' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });

    $('#detailClose').addEventListener('click', function () {
      var m = $('#detailModal');
      m.classList.remove('open');
      m.style.display = 'none';
    });
    $('#detailModal').addEventListener('click', function (e) {
      if (e.target === this) { this.classList.remove('open'); this.style.display = 'none'; }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { var m = $('#detailModal'); m.classList.remove('open'); m.style.display = 'none'; }
    });

    // Refresh when the tab regains focus so new trades appear.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) return;
      S.rows = collect();
      render();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
