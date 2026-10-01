/* ==========================================================================
   Bitbase - admin console
   Fixed sidebar shell, one view per module. Reads and writes the account
   records, balances, ledgers and market feed state that live in this
   browser's localStorage.

   Everything here is browser-local: with no backend this cannot govern
   another person's account or any real funds, and the UI says so on the gate
   screen. The approval lifecycles it exposes (loans, KYC, support) are real
   state in this build; deposits and withdrawals settle instantly in the app,
   so those panels report the true settled state rather than inventing a queue.
   ========================================================================== */
(function (global) {
  'use strict';

  var A = global.BitbaseAuth;
  var F = global.BitbaseFeed;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var num = function (v) { var n = parseFloat(v); return isFinite(n) ? n : 0; };

  /* ------------------------------------------------------------ format */
  function money(v) {
    return '$' + num(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function moneyPlain(v) {
    return num(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function qty(v, d) {
    return num(v).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d === undefined ? 4 : d });
  }
  function when(ts) {
    if (!ts) return '\u2014';
    return new Date(ts).toLocaleString('en-US', {
      month: 'short', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  }
  function whenShort(ts) {
    if (!ts) return '\u2014';
    return new Date(ts).toLocaleString('en-US', {
      month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  }
  function ago(ts) {
    if (!ts) return '\u2014';
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }
  /* Every reference to a person goes through here, so making it answer with the
     six digit code puts the friendly number everywhere at once - tables, toasts,
     search and the generated request ids. The UUID behind it stays internal. */
  function shortId(uid) {
    var rec = users()[uid];
    var code = rec && rec.code != null ? String(rec.code).trim() : '';
    if (/^\d{6}$/.test(code)) return code;
    var m = String(uid || '').match(/(\d+)/);
    return m ? m[1] : String(uid || '').slice(0, 6);
  }
  function token() { return Date.now().toString(36).toUpperCase(); }

  /* The code for one account, straight off the account row when there is one. */
  function codeOf(uid) {
    var rec = users()[uid] || {};
    var code = String(rec.code == null ? '' : rec.code).trim();
    if (/^\d{6}$/.test(code)) return code;
    return shortId(uid);
  }

  /* -------------------------------------------------------------- store */
  function list(key) { return A.readJSON(key, []) || []; }
  function save(key, v) { A.writeJSON(key, v); }
  function users() { return A.readJSON(A.KEYS.users, {}) || {}; }

  function nameOf(uid) {
    var u = users()[uid];
    return (u && u.name) || uid || '\u2014';
  }

  /* How a contract ended, in one place.
     The trade engine settles a position by writing `won` plus a status of
     'Won', 'Lost' or 'Closed'; older records carry `result` instead. An admin
     can also flag an account so every contract settles as a win, and that flag
     sets the same fields the market normally sets. Reading only one of those
     spellings is what made a forced win show up here as a loss, so every view
     below asks this function instead of guessing. */
  function outcomeOf(t) {
    if (!t) return 'active';
    var status = String(t.status || '');
    var result = String(t.result || '').toLowerCase();
    if (status === 'Active') return 'active';
    if (status === 'Won' || t.won === true || result === 'won') return 'won';
    if (status === 'Lost' || t.won === false || result === 'lost') return 'lost';
    if (status === 'Closed' || status === 'Cancelled') return 'refunded';
    // No verdict was recorded at all, so read the move itself.
    var dir = t.dir === 'UP' ? 1 : -1;
    if (num(t.exitPrice) && num(t.entryPrice)) {
      return (num(t.exitPrice) - num(t.entryPrice)) * dir >= 0 ? 'won' : 'lost';
    }
    return 'lost';
  }
  /* A contract closed by hand refunded the stake at half, so half of it is the
     loss - the price move never settled. */
  function outcomeLabel(outcome) {
    return outcome === 'won' ? ['Won', 'green']
      : outcome === 'lost' ? ['Lost', 'red']
      : outcome === 'refunded' ? ['Closed', 'grey']
      : ['Open', 'orange'];
  }

  /* Net effect of one settled contract, as the app recorded it. */
  function pnlOf(t) {
    if (t.pnl !== undefined && t.pnl !== null && isFinite(t.pnl)) return num(t.pnl);
    var outcome = outcomeOf(t);
    if (outcome === 'active') return 0;
    if (outcome === 'won') return num(t.profit);
    if (outcome === 'lost') return -num(t.profit);
    var refund = num(t.refund);
    return refund
      ? Math.round((refund - num(t.amt)) * 100) / 100
      : -Math.round(num(t.amt) * 50) / 100;
  }

  /* Realised P/L per user across real and demo books. */
  function profitByUser() {
    var out = {};
    function take(listKey) {
      list(listKey).forEach(function (t) {
        var uid = t.uid || '';
        if (!uid) return;
        if (out[uid] === undefined) out[uid] = 0;
        if (t.status === 'Active') return;
        out[uid] += pnlOf(t);
      });
    }
    take('bb_trades_history');
    take('bb_demo_trades_hist');
    return out;
  }


  function accounts() {
    var map = users();
    var profit = profitByUser();
    return Object.keys(map).map(function (k) {
      var u = map[k];
      var assets = (u.assets && typeof u.assets === 'object') ? u.assets : {};
      var holdings = 0, coinCount = 0;
      Object.keys(assets).forEach(function (c) {
        if (c === 'USDT') return;
        var p = c === 'XAU' || c === 'XAG' ? 0 : F.changeOf ? 0 : 0;
        var px = livePrice(c);
        if (px > 0) holdings += num(assets[c].qty) * px;
        if (num(assets[c].qty) > 0) coinCount++;
      });
      var cash = num(u.cash);
      var funding = num(u.funding);
      return {
        uid: k,
        code: String(u.code == null ? '' : u.code).trim(),
        name: u.name || 'Unnamed',
        email: u.email || '',
        country: u.country || '\u2014',
        created: u.created || 0,
        admin: u.admin === true,
        owner: u.owner === true,
        disabled: u.disabled === true,
        cash: cash, funding: funding,
        holdings: holdings,
        total: cash + funding + holdings,
        coinCount: coinCount,
        profit: profit[k] || 0,
        kyc: u.kyc_status || u.kyc || 'none',
        profitMode: u.profitMode === true,
        phone: u.phone_verified ? 'verified' : (u.phone ? 'set' : 'none'),
        lastLogin: u.loginAt || 0,
        assets: assets,
        rec: u
      };
    }).sort(function (a, b) { return (b.created || 0) - (a.created || 0); });
  }

  var priceCache = {};
  function livePrice(sym) {
    if (priceCache[sym]) return priceCache[sym];
    var i = F.instrument && F.instrument(sym);
    if (i && i.group === 'crypto' && F.changeOf) {
      // changeOf only exposes the 24h change; the snapshot price is cheaper to
      // keep from the last loadMarkets().
      return priceCache[sym] || 0;
    }
    return priceCache[sym] || 0;
  }
  function primePrices(rows) {
    (rows || []).forEach(function (r) { if (r.sym) priceCache[r.sym] = num(r.price); });
  }

  /* ---------------------------------------------------------- fragments */
  function pill(text, tone) {
    var t = { green: 'p-green', red: 'p-red', orange: 'p-orange', blue: 'p-blue', grey: 'p-grey', dark: 'p-dark' };
    return '<span class="am-pill ' + (t[tone] || 'p-grey') + '">' + esc(text) + '</span>';
  }
  function card(k, v, sub, tone) {
    return '<div class="am-card"><div class="k">' + esc(k) + '</div>' +
      '<div class="v">' + esc(v) + '</div>' +
      '<div class="s ' + (tone ? 's-' + tone : 's-mute') + '">' + esc(sub) + '</div></div>';
  }
  function table(headers, rows, emptyMsg) {
    if (!rows.length) {
      return '<div class="am-panel"><div class="am-empty">' + esc(emptyMsg || 'Nothing to show yet.') + '</div></div>';
    }
    return '<div class="am-panel"><div class="am-tablewrap"><table class="am-table"><thead><tr>' +
      headers.map(function (h, i) {
        return '<th' + (i ? '' : '') + '>' + esc(h) + '</th>';
      }).join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div></div>';
  }
  function filterRow(filters, active, attr) {
    return '<div class="am-filters">' + filters.map(function (f) {
      return '<button class="am-f' + (f[1] === active ? ' on' : '') + (f[2] ? ' ghost' : '') + '" ' +
        (attr || 'data-filter') + '="' + esc(f[0]) + '">' + esc(f[1]) + '</button>';
    }).join('') + '</div>';
  }
  /* `locked` renders the switch without the data attribute, so it cannot be
     pressed. Used for a first admin, who cannot be turned into a second admin
     from the table. */
  function toggle(on, attr, uid, locked) {
    return '<span class="am-togwrap">' +
      '<button class="am-toggle' + (on ? ' on' : '') + '" ' +
        (locked ? 'disabled title="A first admin is always an admin"' : attr + '="' + esc(uid) + '" ') +
        'aria-label="Toggle admin"></button>' +
      '<span class="lab">' + (on ? 'ON' : 'OFF') + '</span></span>';
  }

  /* ============================================================ VIEWS */

  /* ------------------------------------------------------------ dashboard */
  function viewDashboard() {
    var acc = accounts();
    var trades = list('bb_trades_history');
    var deposits = list('bb_deposit_requests');
    var withdrawals = list('bb_withdrawal_requests');
    var loans = list('bb_borrow_requests');
    var kyc = list('bb_kyc_requests');
    var threads = supportThreads();
    var balance = acc.reduce(function (s, a) { return s + a.total; }, 0);
    var openPos = trades.filter(function (t) { return t.status === 'Active'; });
    var openTickets = threads.filter(function (t) { return t.status === 'open'; });
    var pendingWd = withdrawals.filter(function (w) { return w.status === 'pending'; });
    var pendingKyc = kyc.filter(function (k) { return (k.status || 'pending') === 'pending'; });
    var pendingDep = deposits.filter(function (d) { return (d.status || 'pending') === 'pending'; });
    var pendingLoans = loans.filter(function (l) { return (l.status || 'pending') === 'pending'; });

    var stats = [
      card('Total Users', String(acc.length), acc.length + ' registered account' + (acc.length === 1 ? '' : 's'), 'green'),
      card('Total Balance (USDT)', money(balance), 'Combined user funds', 'green'),
      card('Open Positions', String(openPos.length), 'Active trades', 'orange'),
      card('Open Tickets', String(openTickets.length), 'Pending support', 'red'),
      card('Pending Withdrawals', String(pendingWd.length), 'Awaiting approval', 'orange'),
      card('Pending KYC', String(pendingKyc.length), 'Awaiting verification', 'orange'),
      card('Pending Deposits', String(pendingDep.length), 'Awaiting confirmation', 'orange'),
      card('Pending Loans', String(pendingLoans.length), 'Awaiting approval', 'purple')
    ].join('');

    var recent = trades.slice().sort(function (a, b) {
      return num(b.startTime) - num(a.startTime);
    }).slice(0, 15).map(function (t) {
      var status = outcomeLabel(outcomeOf(t));
      return '<tr>' +
        '<td><span class="am-id">' + esc(t.id || '\u2014') + '</span></td>' +
        '<td class="am-mono">' + esc(t.pair || '\u2014') + '</td>' +
        '<td>' + esc(t.dir === 'UP' ? 'Buy' : 'Sell') + '</td>' +
        '<td class="am-mono">' + money(t.amt) + '</td>' +
        '<td>' + pill(status[0], status[1]) + (t.forced ? ' ' + pill('Profit mode', 'blue') : '') + '</td>' +
        '<td class="am-mono">' + esc(t.mode === 'demo' ? 'demo' : 'real') + '</td>' +
        '<td style="color:#7a7a7a;">' + when(t.startTime) + '</td>' +
        '</tr>';
    });

    return '<div class="am-stats">' + stats + '</div>' +
      '<h2 class="am-h2">Recent Trades</h2>' +
      table(['ID', 'Pair', 'Side', 'Amount', 'Status', 'Source', 'Time'], recent, 'No trades recorded yet.');
  }

  /* --------------------------------------------------------------- users */
  var userFilter = 'all';
  var userQuery = '';

  function viewUsers() {
    var acc = accounts();
    var out = acc.filter(function (a) {
      /* The six digit code is searchable, and so is the raw id for anyone who
         has it from somewhere else. */
      if (userQuery && (a.name + ' ' + a.email + ' ' + a.uid + ' ' + a.code).toLowerCase().indexOf(userQuery) < 0) return false;
      if (userFilter === 'admin') return a.admin;
      if (userFilter === 'disabled') return a.disabled;
      if (userFilter === 'kyc') return kycApproved(a.kyc);
      if (userFilter === 'funded') return a.total > 0;
      return true;
    });

    var rows = out.map(function (a) {
      var kycTone = kycApproved(a.kyc) ? 'green' : (a.kyc === 'pending' ? 'orange' : 'grey');
      var statusPills = (a.disabled ? pill('Inactive', 'red') : pill('Active', 'green'));
      var code = shortId(a.uid);
      return '<tr data-uid="' + esc(a.uid) + '">' +
        '<td><span class="am-id" style="font-size:14px;letter-spacing:.06em;" title="' + esc(a.uid) + '">' +
          esc(code) + '</span>' +
          '<button class="am-btn" data-act="copy-code" data-code="' + esc(code) + '" ' +
            'style="margin-top:6px;padding:3px 8px;font-size:10px;">Copy</button></td>' +
        '<td>' + esc(a.name) + '</td>' +
        '<td style="color:#9a9a9a;">' + esc(a.email) + '</td>' +
        '<td class="am-mono">' + money(a.cash) + '</td>' +
        '<td class="am-mono">' + money(a.total) + '</td>' +
        '<td>' + (a.owner === true
          ? '<div style="display:flex;align-items:center;gap:8px;">' +
              toggle(a.admin, 'data-admin', a.uid, true) +
              '<span class="am-pill orange" title="First admin - holds every permission">1st admin</span></div>'
          : toggle(a.admin, 'data-admin', a.uid)) + '</td>' +
        /* The switch governs this account's own trades, real and practice alike.
           With a database the real verdict is forced by the settlement worker;
           without one, by this browser. Either way the recorded price is kept. */
        '<td><div style="display:flex;flex-direction:column;gap:5px;">' +
          '<span class="am-togwrap" title="Every contract for this account settles as a win">' +
            '<button class="am-toggle' + (a.profitMode ? ' on' : '') + '" data-profit="' + esc(a.uid) + '" ' +
              'aria-label="Toggle profit mode"></button>' +
            '<span class="lab">' + (a.profitMode ? 'ON' : 'OFF') + '</span>' +
          '</span>' +
          '<span class="am-mono ' + (a.profit >= 0 ? 'am-num-green' : 'am-num-red') + '">' +
            (a.profit === 0 ? '\u2014' : (a.profit > 0 ? '+' : '') + money(a.profit)) + '</span>' +
        '</div></td>' +
        '<td>' + pill(kycLabel(a.kyc), kycTone) + '</td>' +
        '<td>' + statusPills + '</td>' +
        '<td style="white-space:nowrap;">' +
          '<button class="am-btn primary" data-act="edit" data-uid="' + esc(a.uid) + '"' +
            lockEdit(a.uid) + '>Edit</button>' +
          '<button class="am-btn ok" data-act="verify" data-uid="' + esc(a.uid) + '"' + lock('reviewKyc') + '>Verify</button>' +
          '<button class="am-btn no" data-act="toggle-status" data-uid="' + esc(a.uid) + '"' + lock('editUsers') + '>' +
            (a.disabled ? 'Activate' : 'Deactivate') + '</button>' +
          (a.owner === true
            ? '<span class="am-pill orange" title="A first admin cannot be turned off">1st admin</span>'
            : '<button class="am-btn no" data-act="del" data-uid="' + esc(a.uid) + '"' + lock('deleteRecords') + '>Delete</button>') +
        '</td></tr>';
    });

    var live = '<span class="am-live"><span class="d"></span>' +
      '<span id="amLiveText">' + (A.isRemote() ? (global.BitbaseDB.realtime() ? 'Live user list' : 'Auto-refreshing user list') : 'Local user list') + ' \u00b7 ' + out.length + ' shown</span></span>';
    var search = '<input class="am-input" id="amUserSearch" placeholder="Search name, email or 6-digit ID" ' +
      'style="max-width:280px;" value="' + esc(userQuery) + '">';

    return '<div class="am-filters left" style="align-items:center;">' + live +
        '<div style="flex:1"></div>' +
        filterRow([['all', 'All'], ['admin', 'Admins'], ['verified', 'KYC verified'],
          ['funded', 'Funded'], ['disabled', 'Deactivated']], userFilter, 'data-ufilter') +
        search +
        '<button class="am-btn primary" id="amUserRefresh">Refresh now</button>' +
      '</div>' +
      table(['UID', 'Name', 'Email', 'Cash Balance', 'Total Assets', 'Admin', 'Profit Mode', 'KYC', 'Status', 'Actions'],
        rows, 'No accounts match this filter.');
  }
  /* 'approved' is what a decided submission writes; 'verified' is the older
     spelling and still appears on accounts decided before the review panel. */
  function kycApproved(s) { return ['approved', 'verified'].indexOf(String(s || '').toLowerCase()) >= 0; }
  function kycLabel(s) {
    s = String(s || 'none').toLowerCase();
    if (kycApproved(s)) return 'Verified';
    return s === 'pending' ? 'Pending' : (s === 'rejected' ? 'Rejected' : 'None');
  }

  /* ------------------------------------------------------------- admin team
     First-admin only. That row is fixed: it cannot be locked down and cannot be removed.
     Every second admin gets a switch per action, all off until the first admin
     turns them on, so a new admin starts as read-only. */
  function viewAdmins() {
    if (!owner()) {
      return '<div class="am-panel"><div class="am-empty">' +
        'Only the first admin can manage the admin team.</div></div>';
    }
    var map = users();
    var admins = Object.keys(map).filter(function (k) { return map[k].admin === true; })
      .sort(function (a, b) {
        var oa = map[a].owner === true ? 0 : 1, ob = map[b].owner === true ? 0 : 1;
        return oa - ob || (map[a].created || 0) - (map[b].created || 0);
      });
    if (!admins.length) return '<div class="am-panel"><div class="am-empty">No admins yet.</div></div>';

    var perms = A.PERMISSIONS || [];
    var cards = admins.map(function (uid) {
      var a = map[uid];
      var isOwn = a.owner === true;
      var granted = A.adminPerms(uid) || {};
      var count = isOwn ? perms.length : perms.filter(function (p) { return granted[p.key]; }).length;

      var head =
        '<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">' +
          '<div style="width:38px;height:38px;border-radius:50%;background:' +
            (isOwn ? 'linear-gradient(135deg,#F7931A,#FDB022)' : 'rgba(255,255,255,.08)') +
            ';display:flex;align-items:center;justify-content:center;flex-shrink:0;">' +
            '<i data-lucide="' + (isOwn ? 'crown' : 'user-cog') + '" style="width:17px;height:17px;color:' +
            (isOwn ? '#fff' : '#9a9a9a') + ';"></i></div>' +
          '<div style="flex:1;min-width:0;">' +
            '<div style="font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px;">' +
              esc(a.name || 'User') +
              (isOwn ? '<span class="am-pill orange">First admin \u00b7 full access</span>'
                      : '<span class="am-pill">' + count + ' of ' + perms.length + ' allowed</span>') +
            '</div>' +
            '<div style="font-size:12px;color:#7a7a7a;margin-top:3px;">' +
              esc(a.email || '') + ' \u00b7 UID ' + esc(shortId(uid)) +
              (isOwn ? ' \u00b7 ' + when(a.created) : '') +
            '</div>' +
          '</div>' +
          (isOwn ? ''
            : '<button class="am-btn no" data-revoke="' + esc(uid) + '">Remove admin</button>') +
        '</div>';

      var grid = isOwn
        ? '<div class="am-note">This account is the first admin. It holds every ' +
            'permission permanently and cannot be deleted. To hand the console over, open that ' +
            'user under Users &rarr; Edit and turn on <strong>First Admin</strong> - both sides ' +
            'of that switch ask for the admin password.</div>'
        : '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:8px;">' +
            perms.map(function (p) {
              var on = granted[p.key] === true;
              return '<label class="am-perm' + (on ? ' on' : '') + '" title="' + esc(p.hint) + '">' +
                '<button type="button" class="am-switch' + (on ? ' on' : '') + '" data-perm-toggle="' +
                  esc(uid) + '" data-perm="' + esc(p.key) + '" role="switch" aria-checked="' + on + '"></button>' +
                '<span style="flex:1;min-width:0;">' +
                  '<span style="display:block;font-size:13px;font-weight:500;">' + esc(p.label) + '</span>' +
                  '<span style="display:block;font-size:11px;color:#7a7a7a;line-height:1.45;margin-top:2px;">' + esc(p.hint) + '</span>' +
                '</span></label>';
            }).join('') +
          '</div>';

      return '<div class="am-card" style="margin-bottom:14px;' + (isOwn ? 'border-color:rgba(247,147,26,.35);' : '') + '">' +
        head + grid + '</div>';
    }).join('');

    return '<div class="am-panel"><div class="am-panel-head"><div>' +
        '<h3>Admin team</h3><p>You are the first admin. Choose what each second admin may change. ' +
        'They can read every screen either way.</p></div></div>' +
      cards + '</div>';
  }

  /* ------------------------------------------------------------- support */
  var supportFilter = 'all';
  var supportOpen = null;

  function initials(name) {
    var parts = String(name || 'User').trim().split(/\s+/).slice(0, 2);
    return parts.map(function (p) { return p.charAt(0).toUpperCase(); }).join('') || 'U';
  }
  /* A conversation only exists once somebody actually typed. Threads with no
     messages are rows left behind by an earlier build and are not shown. */
  function supportThreads() {
    return list('bb_support_threads').filter(function (t) {
      return Array.isArray(t.messages) && t.messages.length > 0;
    }).sort(function (a, b) { return num(b.updated) - num(a.updated); });
  }
  /* True when the newest line in the thread came from the user, so the
     conversation is still waiting on an agent. */
  function waitingOnAdmin(t) {
    var msgs = t.messages || [];
    if (!msgs.length) return false;
    return msgs[msgs.length - 1].from !== 'admin';
  }

  /* Only real image data URLs are ever put in an attribute - a stored thread is
     browser data, so it is not trusted to hold a javascript: or remote URL. */
  function imgSrc(v) {
    var s = String(v || '');
    return /^data:image\/(png|jpe?g|gif|webp|bmp);/i.test(s) ? s : '';
  }

  function viewSupport() {
    var threads = supportThreads();
    var out = threads.filter(function (t) {
      if (supportFilter === 'all') return true;
      return t.status === supportFilter;
    });
    if (!threads.length) {
      return '<div class="am-panel"><div class="am-empty">' +
        'No support conversations yet. A conversation appears here the moment a user ' +
        'sends a message from the help panel in Assets.</div></div>';
    }
    // Nothing is opened on arrival: the list is the inbox, and the messages are
    // only rendered once an agent picks one. Switching filter closes whatever
    // was open, so the thread pane never disagrees with the list beside it.
    if (supportOpen && !out.some(function (t) { return t.id === supportOpen; })) {
      supportOpen = null;
    }
    var thread = supportOpen
      ? threads.filter(function (t) { return t.id === supportOpen; })[0] : null;

    var waiting = out.filter(waitingOnAdmin).length;
    var items = out.map(function (t) {
      var msgs = t.messages || [];
      var last = msgs[msgs.length - 1];
      var on = t.id === supportOpen;
      var fromUser = last && last.from !== 'admin';
      var status = t.status === 'resolved'
        ? '<span class="am-conv-tag done">Resolved</span>'
        : '<span class="am-conv-tag">Open</span>';
      return '<div class="am-conv-item' + (on ? ' on' : '') + '" role="button" tabindex="0" ' +
          'data-thread="' + esc(t.id) + '">' +
        '<span class="am-conv-av">' + esc(initials(t.name)) + '</span>' +
        '<span class="am-conv-body">' +
          '<span class="am-conv-top">' +
            '<span class="am-conv-name">' + esc(t.name || 'User') + '</span>' +
            '<span class="am-conv-time">' + whenShort(t.updated) + '</span>' +
          '</span>' +
          '<span class="am-conv-sub">UID ' + esc(shortId(t.uid)) + status +
            (waitingOnAdmin(t) ? '<span class="am-conv-new">new</span>' : '') +
          '</span>' +
          '<span class="am-conv-prev">' +
            (fromUser ? '<span class="am-dot"></span>' : '<span class="am-dot admin"></span>') +
            '<span class="am-conv-snip">' +
              esc((last && last.body ? last.body : '').slice(0, 54) ||
                (last && imgSrc(last.image) ? 'Picture sent' : '')) +
            '</span>' +
          '</span>' +
        '</span></div>';
    }).join('');

    var head;
    if (thread) {
      var ordered = (thread.messages || []).slice().sort(function (a, b) {
        return num(a.time) - num(b.time);
      });
      var msgsHtml = ordered.map(function (m, i) {
        var isAdmin = m.from === 'admin';
        var src = imgSrc(m.image);
        return '<div class="am-msg ' + (isAdmin ? 'a' : 'u') + '">' +
          '<div class="who">' + esc(isAdmin ? 'Admin' : (m.name || 'User')) + '</div>' +
          (src ? '<img class="am-msg-img" src="' + esc(src) + '" alt="Picture from ' +
            esc(m.name || 'the user') + '" data-msgimg="' + esc(thread.id) + ':' + i + '">' : '') +
          (m.body ? '<div class="bd">' + esc(m.body) + '</div>' : '') +
          '<div class="tm">' + when(m.time) + '</div></div>';
      }).join('');

      var actions = thread.status === 'open'
        ? '<button class="am-btn primary" data-th="' + esc(thread.id) + '" data-sact="open"' + lock('replySupport') + '>Open</button>' +
          '<button class="am-btn ok" data-th="' + esc(thread.id) + '" data-sact="resolve"' + lock('replySupport') + '>Resolve</button>'
        : '<button class="am-btn primary" data-th="' + esc(thread.id) + '" data-sact="open"' + lock('replySupport') + '>Reopen</button>';
      actions += '<button class="am-btn no" data-th="' + esc(thread.id) + '" data-sact="delete"' + lock('deleteRecords') + '>Delete</button>';

      head =
        '<div class="am-thread-head">' +
          '<div style="min-width:0;">' +
            '<button class="am-btn am-back" id="amConvBack">Back</button>' +
            '<div style="font-weight:700;font-size:15px;margin-top:' + (thread.status === 'open' ? '0' : '2px') + ';">' +
              esc(thread.name || 'User') + ' (' + esc(shortId(thread.uid)) + ')</div>' +
            '<div style="font-size:12px;color:#7a7a7a;margin-top:3px;">' + esc(thread.email || '') +
              ' &middot; started ' + when(thread.created) +
              ' &middot; ' + (thread.messages || []).length + ' message' +
              ((thread.messages || []).length === 1 ? '' : 's') + '</div>' +
          '</div>' +
          '<div style="display:flex;gap:8px;flex:0 0 auto;">' + actions + '</div>' +
        '</div>' +
        '<div class="am-msgs" id="amMsgs">' +
          (msgsHtml || '<div class="am-thread-none">No messages in this conversation.</div>') +
        '</div>' +
        '<div class="am-reply">' +
          '<input class="am-input" id="amReply" placeholder="Type your reply..."' + (can('replySupport') ? '' : ' disabled') + '>' +
          '<button class="am-btn primary" data-th="' + esc(thread.id) + '" data-sact="send" ' +
            'style="padding:11px 20px;"' + lock('replySupport') + '>Send</button>' +
        '</div>';
    } else {
      head = '<div class="am-thread-idle">' +
        '<i data-lucide="message-circle" style="width:26px;height:26px;"></i>' +
        '<div>Pick a conversation to read it</div>' +
        '<span>The ' + out.length + ' conversation' + (out.length === 1 ? '' : 's') + ' on the left are ' +
          'preview only until you open one' + (waiting ? ', ' + waiting + ' waiting on you' : '') + '.</span>' +
      '</div>';
    }

    return '<div class="am-filters left">' +
        filterRow([['all', 'All'], ['open', 'Open'], ['resolved', 'Resolved']], supportFilter, 'data-sfilter') +
        (waiting ? '<span class="am-live"><span class="d"></span>' + waiting + ' waiting on you</span>' : '') +
      '</div>' +
      '<div class="am-panel am-conv-panel' + (thread ? ' open' : '') + '"><div class="am-conv">' +
        '<div class="am-conv-list">' + items + '</div>' +
        '<div class="am-thread">' + head + '</div>' +
      '</div></div>';
  }

  /* -------------------------------------------------------------- trades */
  var tradeFilter = 'all';

  function viewTrades() {
    var trades = list('bb_trades_history').concat(list('bb_demo_trades_hist'))
      .sort(function (a, b) { return num(b.startTime) - num(a.startTime); });
    var out = trades.filter(function (t) {
      if (tradeFilter === 'all') return true;
      if (tradeFilter === 'active') return outcomeOf(t) === 'active';
      if (tradeFilter === 'refunded') return outcomeOf(t) === 'refunded';
      return outcomeOf(t) === tradeFilter;
    });
    var rows = out.map(function (t) {
      var outcome = outcomeOf(t);
      var pnl = pnlOf(t);
      var st = outcomeLabel(outcome);
      return '<tr>' +
        '<td><span class="am-id">' + esc(t.id || '\u2014') + '</span></td>' +
        '<td class="am-mono">' + esc(t.pair || '\u2014') + '</td>' +
        '<td>' + esc(t.dir === 'UP' ? 'Buy' : 'Sell') + '</td>' +
        '<td class="am-mono">' + money(t.amt) + '</td>' +
        '<td class="am-mono ' + (outcome === 'active' ? '' : (pnl >= 0 ? 'am-num-green' : 'am-num-red')) + '">' +
          (outcome === 'active' ? '\u2014' : (pnl >= 0 ? '+' : '') + money(pnl)) + '</td>' +
        '<td>' + pill(st[0], st[1]) + (t.forced ? ' ' + pill('Profit mode', 'blue') : '') + '</td>' +
        '<td class="am-mono">' + esc(t.mode === 'demo' ? 'demo' : 'real') + '</td>' +
        '<td style="color:#7a7a7a;">' + when(t.startTime) + '</td>' +
        /* A running contract belongs to the settlement worker, which owns its
           row until it settles. Offering Delete there only produced a refusal
           from the database, so the button is shown once there is a result. */
        '<td class="am-right">' + (outcome === 'active'
          ? '<span style="color:#5a5a5a;font-size:11px;">Running</span>'
          : '<button class="am-btn no" data-act="del-trade" data-id="' + esc(t.id) + '"' + lock('deleteRecords') + '>Delete</button>') + '</td>' +
        '</tr>';
    });
    return filterRow([['all', 'All'], ['active', 'Active'], ['won', 'Won'], ['lost', 'Lost'], ['refunded', 'Closed']],
      tradeFilter, 'data-tfilter') +
      table(['ID', 'Pair', 'Side', 'Amount', 'Profit', 'Status', 'Source', 'Time', 'Actions'],
        rows, 'No trades match this filter.');
  }

  /* ------------------------------------------------------- attachments
     A proof of payment, a payslip and an identity scan all arrive the same
     way: as an inline data: URL when the file fitted, and as a bare file name
     when it did not. Older records hold the data URL as a plain string, newer
     ones a { name, type, data } record, so both shapes are read here and
     neither ever ends up printed as text in a table cell. */
  function attachSrc(v) {
    if (v == null) return '';
    if (typeof v === 'string') {
      var s = v.trim();
      return /^data:(image\/|application\/pdf)/i.test(s) ? s : '';
    }
    if (typeof v === 'object') {
      var d = v.data || v.url || '';
      return /^data:(image\/|application\/pdf)/i.test(String(d)) ? String(d) : '';
    }
    return '';
  }
  function attachName(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    return v.name || v.fileName || '';
  }
  function isImageSrc(s) { return /^data:image\//i.test(String(s || '')); }

  /* The bytes behind an attachment are stored apart from the request so that
     ordinary pages do not have to download every picture anybody ever uploaded
     (see BitbaseDB). Fetch this one, on demand, when it is about to be shown. */
  function attachReady(value, field) {
    var ref = value && typeof value === 'object' ? value.ref : '';
    if (!ref || !field || !global.BitbaseDB) return Promise.resolve(value);
    return Promise.resolve(global.BitbaseDB.attachment(ref)).then(function (bag) {
      var v = bag && bag[field];
      if (!v) return value;
      return (v && typeof v === 'object')
        ? Object.assign({}, v, { name: v.name || (value.name || 'attachment') })
        : v;
    }).catch(function () { return value; });
  }

  /* One table cell: a thumbnail where the file is a picture, then a button
     that opens the whole thing. A file that could not be inlined says so by
     name instead of pretending there is nothing attached. */
  function attachCell(value, act, id, label) {
    var src = attachSrc(value);
    var name = attachName(value);
    if (!src) {
      return name ? '<span class="am-file" title="' + esc(name) + '">' + esc(name) + '</span>' : '\u2014';
    }
    var thumb = isImageSrc(src)
      ? '<img class="am-thumb" src="' + esc(src) + '" alt="' + esc(name || 'attachment') + '">'
      : '<span class="am-thumb doc">PDF</span>';
    return '<div class="am-attach">' + thumb +
      '<button class="am-btn info" data-act="' + esc(act) + '" data-id="' + esc(id) + '">' + esc(label || 'View') + '</button></div>';
  }

  /* Open an attachment on its own. Images fill the wide box, a PDF gets a
     built-in viewer, and a name-only record says plainly that the picture was
     never stored rather than showing an empty frame. */
  function showAttachment(title, subtitle, value) {
    var src = attachSrc(value);
    var name = attachName(value);
    var body = '';
    if (subtitle) {
      body += '<p style="color:#7a7a7a;font-size:12.5px;margin:0 0 16px;">' + esc(subtitle) + '</p>';
    }
    if (!src) {
      body += '<p style="color:#9a9a9a;font-size:13.5px;line-height:1.7;">Only the file name was saved with this request, ' +
        'so there is nothing to open.<br><span class="am-file" style="max-width:none;">' + esc(name || '\u2014') + '</span></p>';
    } else if (isImageSrc(src)) {
      body += '<img src="' + esc(src) + '" alt="' + esc(title) + '" ' +
        'style="display:block;width:100%;height:auto;border-radius:10px;border:1px solid #2a2a2a;">';
    } else {
      body += '<iframe src="' + esc(src) + '" title="' + esc(title) + '" ' +
        'style="display:block;width:100%;height:68vh;border:1px solid #2a2a2a;border-radius:10px;background:#fff;"></iframe>';
    }
    if (src && name) {
      body += '<p style="color:#5a5a5a;font-size:11px;margin:14px 0 0;' +
        'font-family:\'IBM Plex Mono\',monospace;word-break:break-all;">' + esc(name) + '</p>';
    }
    modal(title, body, function () {}, true);
  }

  /* The display id a request row is keyed by. Deposits, withdrawals and loans

     are stored without one, so it is derived here and both the table and the
     buttons below go through the same function - that is what lets a View
     button find the record it was rendered from. */
  function requestId(kind, r) {
    var uid = r.uid || r.userId || '';
    var prefix = kind === 'withdrawal' ? 'WD' : (kind === 'deposit' ? 'DEP' : 'LOAN');
    return prefix + '-' + (kind === 'borrow' ? '' : shortId(uid) + '-') + (r.time || 0);
  }
  function findRequest(kind, id) {
    var arr = list('bb_' + kind + '_requests');
    for (var i = 0; i < arr.length; i++) {
      if (requestId(kind, arr[i]) === id) return arr[i];
    }
    return null;
  }

  /* --------------------------------------------------------- withdrawals */
  var wdFilter = 'all';

  function viewWithdrawals() {
    var acc = accounts();
    var byUid = {};
    acc.forEach(function (a) { byUid[a.uid] = a; });
    var reqs = list('bb_withdrawal_requests').map(function (r) {
      var uid = r.uid || r.userId || '';
      return {
        id: requestId('withdrawal', r),
        uid: uid, name: byUid[uid] ? byUid[uid].name : nameOf(uid),
        coin: r.coin || 'USDT',
        amount: num(r.amount),
        usd: num(r.usd !== undefined ? r.usd : r.amount * num(r.price)),
        fee: num(r.fee),
        network: r.network || netOf(r.coin),
        address: String(r.address == null || r.address === '' ? '\u2014' : r.address).trim() || '\u2014',
        status: r.status || 'pending',
        time: r.time
      };
    }).sort(function (a, b) { return num(b.time) - num(a.time); });

    var out = reqs.filter(function (r) {
      if (wdFilter === 'all') return true;
      return r.status === wdFilter;
    });
    var rows = out.map(function (r) {
      var tone = r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : 'orange';
      return '<tr>' +
        '<td><span class="am-id">' + esc(r.id) + '</span></td>' +
        '<td>' + esc(r.name) + ' (' + esc(shortId(r.uid)) + ')</td>' +
        '<td class="am-mono">' + esc(r.coin) + '</td>' +
        '<td class="am-num-orange">' + qty(r.amount, 4) + '</td>' +
        '<td class="am-mono">' + qty(r.fee, 4) + '</td>' +
        '<td class="am-mono">' + esc(r.network) + '</td>' +
        /* The whole address, wrapped. It is the instruction for sending real
           money, so clipping it is not an option. */
        '<td><span class="am-addr-wrap" title="' + esc(r.address) + '">' + esc(r.address) + '</span>' +
          '<span class="am-addr-actions">' +
            '<button class="am-btn info" data-act="wd-copy" data-addr="' + esc(r.address) + '">Copy</button>' +
            '<button class="am-btn" data-act="wd-view" data-id="' + esc(r.id) + '">Full</button>' +
          '</span></td>' +
        '<td>' + pill(cap(r.status), tone) + '</td>' +
        '<td style="color:#7a7a7a;">' + when(r.time) + '</td>' +
        '<td class="am-right">' + withdrawalAction(r) + '</td>' +
        '</tr>';
    });
    return filterRow([['all', 'All'], ['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected']],
      wdFilter, 'data-wfilter') +
      table(['ID', 'User', 'Coin', 'Amount', 'Fee', 'Network', 'Address', 'Status', 'Time', 'Actions'],
        rows, 'No withdrawal requests recorded.');
  }
  function withdrawalAction(r) {
    if (r.status === 'pending') {
      return '<button class="am-btn ok" data-act="wd-approve" data-id="' + esc(r.id) + '"' + lock('approveWithdrawals') + '>Approve</button>' +
        '<button class="am-btn no" data-act="wd-reject" data-id="' + esc(r.id) + '"' + lock('approveWithdrawals') + '>Reject</button>';
    }
    return '<button class="am-btn" data-act="noop">\u2014</button>';
  }
  function cap(s) { return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1); }
  function netOf(coin) {
    return ({ BTC: 'Bitcoin', ETH: 'ERC20', USDT: 'ERC20', SOL: 'Solana', XRP: 'XRP',
      BNB: 'BEP20', LTC: 'Litecoin', DOGE: 'Dogecoin', ADA: 'Cardano', TRX: 'TRC20',
      AVAX: 'AVAXC', LINK: 'ERC20', DOT: 'Polkadot' })[coin] || 'ERC20';
  }

  /* --------------------------------------------------------------- loans */
  var loanFilter = 'all';

  function viewLoans() {
    var acc = accounts();
    var byUid = {};
    acc.forEach(function (a) { byUid[a.uid] = a; });
    var reqs = list('bb_borrow_requests').map(function (r) {
      var uid = r.uid || r.userId || '';
      var rate = num(r.rate);
      var interest = num(r.interest) || num(r.amount) * rate;
      return {
        id: requestId('borrow', r),
        uid: uid, name: byUid[uid] ? byUid[uid].name : nameOf(uid),
        amount: num(r.amount), days: num(r.days),
        rate: rate > 1 ? rate / 100 : rate,
        interest: interest,
        total: num(r.amount) + interest,
        due: num(r.due),
        proof: r.proof || r.proofName || null,
        status: r.status || 'pending',
        time: r.time
      };
    }).sort(function (a, b) { return num(b.time) - num(a.time); });

    var out = reqs.filter(function (r) {
      if (loanFilter === 'all') return true;
      if (loanFilter === 'active') return r.status === 'active' && r.due > Date.now();
      return r.status === loanFilter;
    });
    var rows = out.map(function (r) {
      var overdue = r.status === 'active' && r.due && r.due < Date.now();
      var st = r.status === 'paid' ? ['Paid', 'blue']
        : r.status === 'rejected' ? ['Rejected', 'red']
        : r.status === 'pending' ? ['Pending', 'orange']
        : overdue ? ['Overdue', 'red'] : ['Active', 'green'];
      return '<tr>' +
        '<td><span class="am-id">' + esc(r.id) + '</span></td>' +
        '<td>' + esc(r.name) + ' (' + esc(shortId(r.uid)) + ')</td>' +
        '<td class="am-num-purple">' + money(r.amount) + '</td>' +
        '<td>' + (r.days >= 360 ? (r.days / 365).toFixed(1).replace(/\.0$/, '') + ' Year' : r.days + ' Days') + '</td>' +
        '<td class="am-mono">' + (r.rate * 100).toFixed(1) + '%</td>' +
        '<td class="am-num-orange">' + money(r.interest) + '</td>' +
        '<td class="am-mono">' + money(r.total) + '</td>' +
        '<td>' + attachCell(r.proof, 'loan-proof', r.id) + '</td>' +
        '<td>' + pill(st[0], st[1]) + '</td>' +
        '<td style="color:#7a7a7a;">' + when(r.time) + '</td>' +
        '<td style="white-space:nowrap;">' + loanAction(r) + '</td>' +
        '</tr>';
    });
    return '<div class="am-filters" style="justify-content:space-between;">' +
        filterRow([['all', 'All'], ['pending', 'Pending'], ['active', 'Active'], ['paid', 'Paid'], ['rejected', 'Rejected']],
          loanFilter, 'data-lfilter').replace('class="am-filters"', 'class="am-filters" style="margin:0"') +
      '</div>' +
      table(['ID', 'User', 'Borrow', 'Duration', 'Rate', 'Interest', 'Total Owed', 'Proof', 'Status', 'Time', 'Actions'],
        rows, 'No loan requests recorded.');
  }
  function loanAction(r) {
    var id = esc(r.id);
    if (r.status === 'pending') {
      return '<button class="am-btn ok" data-act="loan-approve" data-id="' + id + '"' + lock('approveLoans') + '>Approve</button>' +
        '<button class="am-btn no" data-act="loan-reject" data-id="' + id + '"' + lock('approveLoans') + '>Reject</button>';
    }
    if (r.status === 'active') {
      return '<button class="am-btn info" data-act="loan-paid" data-id="' + id + '"' + lock('approveLoans') + '>Mark Paid</button>';
    }
    return '<button class="am-btn" data-act="noop">\u2014</button>';
  }

  /* ----------------------------------------------------------------- kyc */
  var kycFilter = 'all';

  /* Everything a submission is made of, in one shape.
     A queued request and a profile that merely says "pending" are two different
     stores, so they are merged here rather than in the view - the table, the
     review panel and the approve/reject buttons all read the same row, and the
     answer the user typed on the KYC form is carried on the request itself
     rather than left on a profile column nobody syncs. */
  function kycRows() {
    var acc = accounts();
    var byUid = {};
    acc.forEach(function (a) { byUid[a.uid] = a; });

    function build(r) {
      var uid = r.uid || r.userId || '';
      var a = byUid[uid] || {};
      var rec = a.rec || {};
      var legal = String(r.legalName || '').trim();
      if (!legal) {
        var parts = [r.firstName || r.first_name || rec.kyc_first,
                     r.lastName || r.last_name || rec.kyc_last];
        legal = parts.filter(Boolean).join(' ').trim();
      }
      var docs = r.docs && typeof r.docs === 'object' ? r.docs : {};
      return {
        id: r.id || ('KYC-' + shortId(uid) + '-' + (r.time || 0)),
        uid: uid,
        code: shortId(uid),
        account: r.name || a.name || '',
        legalName: legal,
        firstName: r.firstName || r.first_name || rec.kyc_first || '',
        lastName: r.lastName || r.last_name || rec.kyc_last || '',
        dob: r.dob || r.dateOfBirth || rec.kyc_dob || '',
        email: r.email || a.email || '',
        phone: r.phone || rec.phone || '',
        country: r.country || a.country || '',
        nationality: r.nationality || r.nationalityCountry || rec.kyc_country || a.country || '',
        address: r.address || r.street || rec.kyc_address || '',
        city: r.city || rec.kyc_city || '',
        postal: r.postal || r.postalCode || r.zip || rec.kyc_postal || '',
        docType: r.docType || rec.kyc_doc_type || 'Passport',
        docs: docs,
        front: docs.front || null,
        back: docs.back || null,
        docCount: (docs.front ? 1 : 0) + (docs.back ? 1 : 0),
        status: r.status || 'pending',
        time: r.time || 0,
        decidedAt: r.decidedAt || 0
      };
    }

    var rows = list('bb_kyc_requests').map(build);
    // An account whose record says pending but has no queued request is still
    // waiting on a decision; fold it in rather than dropping it silently.
    acc.forEach(function (a) {
      if (a.kyc !== 'pending') return;
      if (rows.some(function (r) { return r.uid === a.uid; })) return;
      rows.push(build({
        uid: a.uid, name: a.name, email: a.email,
        time: a.rec.kyc_submitted || a.created || 0,
        status: 'pending'
      }));
    });
    rows.sort(function (x, y) { return num(y.time) - num(x.time); });
    return rows;
  }
  function findKyc(id) {
    return kycRows().filter(function (r) { return r.id === id; })[0] || null;
  }

  function viewKyc() {
    var out = kycRows().filter(function (r) {
      if (kycFilter === 'all') return true;
      return r.status === kycFilter;
    });
    var rows = out.map(function (r) {
      var st = r.status === 'approved' ? ['Approved', 'green']
        : r.status === 'rejected' ? ['Rejected', 'red'] : ['Pending', 'orange'];
      return '<tr>' +
        '<td><span class="am-id">' + esc(r.id) + '</span></td>' +
        '<td>' + esc(r.account || 'User') + ' (' + esc(shortId(r.uid)) + ')</td>' +
        '<td>' + esc(r.legalName || '\u2014') + '</td>' +
        '<td>' + esc(r.email || '\u2014') + '</td>' +
        '<td>' + esc(r.docType) + '</td>' +
        '<td>' + (r.docCount
          ? '<button class="am-btn info" data-act="kyc-review" data-id="' + esc(r.id) + '">Review (' + r.docCount + ')</button>'
          : '<button class="am-btn info" data-act="kyc-review" data-id="' + esc(r.id) + '">Review</button>') + '</td>' +
        '<td>' + pill(st[0], st[1]) + '</td>' +
        '<td style="color:#7a7a7a;">' + when(r.time) + '</td>' +
        '<td class="am-right" style="white-space:nowrap;">' + kycAction(r) + '</td>' +
        '</tr>';
    });
    return filterRow([['all', 'All'], ['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected']],
      kycFilter, 'data-kfilter') +
      table(['ID', 'User', 'Legal Name', 'Email', 'Doc Type', 'Submission', 'Status', 'Submitted', 'Actions'],
        rows, 'No KYC submissions yet.');
  }
  function kycAction(r) {
    var s = r.status || 'pending';
    if (s === 'approved') return '<button class="am-btn no" data-act="kyc-reject" data-id="' + esc(r.id) + '"' + lock('reviewKyc') + '>Revoke</button>';
    if (s === 'rejected') return '<button class="am-btn ok" data-act="kyc-approve" data-id="' + esc(r.id) + '"' + lock('reviewKyc') + '>Approve</button>';
    return '<button class="am-btn ok" data-act="kyc-approve" data-id="' + esc(r.id) + '"' + lock('reviewKyc') + '>Approve</button>' +
      '<button class="am-btn no" data-act="kyc-reject" data-id="' + esc(r.id) + '"' + lock('reviewKyc') + '>Reject</button>';
  }

  /* One field of the submission, or an honest "not provided". */
  function kycField(label, value, wide) {
    var v = String(value == null ? '' : value).trim();
    return '<div class="kv' + (wide ? ' wide' : '') + '"><div class="k">' + esc(label) + '</div>' +
      '<div class="v' + (v ? '' : ' empty') + '">' + (v ? esc(v) : 'Not provided') + '</div></div>';
  }
  function kycDocBlock(label, value) {
    var src = attachSrc(value);
    var name = attachName(value);
    var cap = '<div class="cap"><span>' + esc(label) + '</span>' +
      '<span>' + esc(name || (src ? 'inline' : 'nothing attached')) + '</span></div>';
    var inner = src
      ? (isImageSrc(src)
        ? '<img src="' + esc(src) + '" alt="' + esc(label) + '">'
        : '<iframe src="' + esc(src) + '" title="' + esc(label) + '"></iframe>')
      : '<div class="none">No ' + esc(label.toLowerCase()) + ' was attached to this submission.</div>';
    return '<div class="am-doc">' + cap + inner + '</div>';
  }

  /* The whole submission on one screen: every answer the applicant gave, both
     scans, and the decision buttons. */
  function kycReview(id) {
    var r = findKyc(id);
    if (!r) { toast('Could not find that submission', 'bad'); return; }
    var front = r.front, back = r.back;
    /* Only wait when a side is genuinely stored apart. A side that is already
       inline, or simply absent, has nothing to fetch. */
    var pending = [front, back].filter(function (v) {
      return !attachSrc(v) && v && typeof v === 'object' && typeof v.ref === 'string';
    });
    var answers =
      '<div class="am-kv">' +
        kycField('Account name', r.account) +
        kycField('Account email', r.email) +
        kycField('Phone', r.phone) +
        kycField('User ID', r.code || shortId(r.uid), true) +
        kycField('Legal name', r.legalName) +
        kycField('Date of birth', r.dob) +
        kycField('Nationality', r.nationality) +
        kycField('Residence', r.country) +
        kycField('Street address', r.address, true) +
        kycField('City', r.city) +
        kycField('Postal code', r.postal) +
        kycField('Document type', r.docType) +
      '</div>';
    function panel(f, b) {
      return answers +
        '<div class="am-label" style="margin-bottom:10px;">Documents</div>' +
        kycDocBlock('Front of document', f) +
        kycDocBlock('Back of document', b) +
        '<div style="display:flex;gap:10px;margin-top:22px;">' + kycAction(r) + '</div>';
    }
    if (!pending.length) { modal(kycTitle(r), panel(front, back), kycMount(id), true); return; }
    modal(kycTitle(r), answers + '<p style="color:#8a8a8a;font-size:13px;">Fetching the documents\u2026</p>', function () {}, true);
    Promise.all([attachReady(front, 'front'), attachReady(back, 'back')]).then(function (both) {
      modal(kycTitle(r), panel(both[0], both[1]), kycMount(id), true);
    }).catch(function () {
      modal(kycTitle(r), panel(front, back), kycMount(id), true);
    });
  }
  function kycTitle(r) { return 'KYC submission \u00b7 ' + (r.account || shortId(r.uid)); }
  function kycMount(id) {
    return function () {
      $$('#amModalBody [data-act]').forEach(function (b) {
        b.addEventListener('click', function () {
          var act = b.dataset.act;
          if (act !== 'kyc-approve' && act !== 'kyc-reject') return;
          if (!can('reviewKyc')) { denied('reviewKyc'); return; }
          if (setKyc(id, act === 'kyc-approve' ? 'approved' : 'rejected')) closeModal();
        });
      });
    };
  }

  /* ------------------------------------------------------------ balances */
  function viewBalances() {
    var acc = accounts().slice().sort(function (a, b) { return b.total - a.total; });
    var options = acc.map(function (a) {
      return '<option value="' + esc(a.uid) + '">' + esc(a.name) + ' (' + esc(shortId(a.uid)) + ') \u2014 ' + money(a.cash) + '</option>';
    }).join('');

    var hist = list('bb_admin_adjustments').slice().sort(function (a, b) { return num(b.time) - num(a.time); })
      .slice(0, 80).map(function (h) {
        var cls = h.delta >= 0 ? 'am-num-green' : 'am-num-red';
        var op = h.mode === 'set' ? 'set' : (h.delta >= 0 ? '+' : '\u2212');
        var label = h.mode === 'set' ? 'set \u2192' : op;
        return '<div class="am-hist-item">' +
          '<span class="w">' + whenShort(h.time) + '</span>' +
          '<div class="d ' + cls + '">' + label + money(Math.abs(h.delta)).replace('$', '$') +
            ' \u2192 ' + esc(shortId(h.uid)) + ' (bal ' + money(h.after) + ')</div>' +
          '<div class="m">' + esc(h.reason || 'Manual adjustment') + '</div>' +
          '</div>';
      }).join('');

    return '<div class="am-split">' +
      '<div class="am-panel"><div style="padding:22px;">' +
        '<h3 style="font-family:\'Space Grotesk\',sans-serif;font-size:17px;margin:0 0 18px;">Adjust Cash Balance</h3>' +
        '<div class="am-field"><label class="am-label">Search User by ID</label>' +
          '<input class="am-input" id="amBalSearch" placeholder="Type the 6-digit ID..."></div>' +
        '<div class="am-field"><label class="am-label">Selected User (ID)</label>' +
          '<select class="am-select" id="amBalUser">' + options + '</select></div>' +
        '<div class="am-field"><label class="am-label">Current Cash Balance</label>' +
          '<input class="am-input" id="amBalCurrent" readonly value="$0.00"></div>' +
        '<div class="am-field"><label class="am-label">Adjustment Amount (USDT)</label>' +
          '<input class="am-input" id="amBalAmount" placeholder="Enter amount to credit/debit" inputmode="decimal"></div>' +
        '<div class="am-field"><label class="am-label">Reason (optional)</label>' +
          '<input class="am-input" id="amBalReason" placeholder="e.g. Manual correction"></div>' +
        '<div style="display:flex;gap:10px;margin-bottom:10px;">' +
          '<button class="am-btn block ok" id="amBalCredit" style="margin:0;">+ Credit (Add)</button>' +
          '<button class="am-btn block no" id="amBalDebit" style="margin:0;">\u2212 Debit (Subtract)</button>' +
        '</div>' +
        '<button class="am-btn block primary" id="amBalSet">Set Exact Balance</button>' +
      '</div></div>' +
      '<div class="am-panel"><div style="padding:22px 0 0;">' +
        '<h3 style="font-family:\'Space Grotesk\',sans-serif;font-size:17px;margin:0 0 6px;padding:0 22px;">Balance History</h3>' +
        '<div class="am-hist">' + (hist || '<div class="am-empty">No adjustments recorded yet.</div>') + '</div>' +
      '</div></div>' +
    '</div>';
  }

  /* ------------------------------------------------------------ deposits */
  var DEPOSIT_COINS = [
    { coin: 'USDT', net: 'ERC20' }, { coin: 'BTC', net: 'Bitcoin' }, { coin: 'ETH', net: 'ERC20' },
    { coin: 'SOL', net: 'Solana' }, { coin: 'XRP', net: 'XRPL' }, { coin: 'DOGE', net: 'Dogecoin' },
    { coin: 'BNB', net: 'BEP20' }, { coin: 'LTC', net: 'Litecoin' }, { coin: 'TRX', net: 'TRC20' }
  ];
  var depCoin = 'USDT';
  var depFilter = 'all';

  function viewDeposits() {
    var addrs = A.readJSON('bb_deposit_addresses', {}) || {};
    var meta = {};
    DEPOSIT_COINS.forEach(function (c) { meta[c.coin] = c; });
    var entry = addrs[depCoin] || {};
    var net = (meta[depCoin] || {}).net || 'ERC20';

    var current = DEPOSIT_COINS.map(function (c) {
      var a = addrs[c.coin];
      return '<div class="am-addrrow">' +
        '<div><div style="font-weight:600;font-size:14px;">' + esc(c.coin) + '</div>' +
        '<div class="a">' + esc(a ? (a.address || '\u2014') : 'not set') + '</div></div>' +
        pill(c.net, 'grey') + '</div>';
    }).join('');

    var acc = accounts();
    var byUid = {};
    acc.forEach(function (a) { byUid[a.uid] = a; });
    var reqs = list('bb_deposit_requests').map(function (r) {
      var uid = r.uid || r.userId || '';
      return {
        id: requestId('deposit', r),
        uid: uid, name: byUid[uid] ? byUid[uid].name : nameOf(uid),
        coin: r.coin || 'USDT', amount: num(r.amount),
        usd: num(r.usd !== undefined ? r.usd : r.amount),
        net: (meta[r.coin] || {}).net || 'ERC20',
        status: r.status || 'pending',
        proof: r.proof || r.proofName || null,
        time: r.time
      };
    }).sort(function (a, b) { return num(b.time) - num(a.time); });
    var out = reqs.filter(function (r) { return depFilter === 'all' || r.status === depFilter; });

    var depRows = out.map(function (r) {
      var tone = r.status === 'approved' ? 'green' : r.status === 'rejected' ? 'red' : 'orange';
      return '<tr>' +
        '<td><span class="am-id">' + esc(r.id) + '</span></td>' +
        '<td>' + esc(r.name) + ' (' + esc(shortId(r.uid)) + ')</td>' +
        '<td class="am-mono">' + esc(r.coin) + '</td>' +
        '<td class="am-mono">' + qty(r.amount, 6) + '</td>' +
        '<td class="am-num-green">\u2248 ' + money(r.usd) + '</td>' +
        '<td class="am-mono">' + esc(r.net) + '</td>' +
        '<td>' + attachCell(r.proof, 'dep-proof', r.id) + '</td>' +
        '<td>' + pill(cap(r.status), tone) + '</td>' +
        '<td style="color:#7a7a7a;">' + when(r.time) + '</td>' +
        '<td class="am-right" style="white-space:nowrap;">' + depositAction(r) + '</td>' +
        '</tr>';
    });

    // The address editor decides where real money is sent, so it is console
    // configuration: locked unless this admin may change console settings.
    var depEditable = can('consoleSettings');
    var ro = depEditable ? '' : ' disabled title="Your admin role does not allow editing deposit addresses"';
    return '<div class="am-split even">' +
      '<div class="am-panel"><div style="padding:22px;">' +
        '<h3 style="font-family:\'Space Grotesk\',sans-serif;font-size:17px;margin:0 0 18px;">Edit Deposit Address</h3>' +
        (depEditable ? '' : '<div class="am-note" style="margin-bottom:18px;">These addresses are the ones users are shown when they deposit. ' +
          'Only an admin with console settings permission can change them.</div>') +
        '<div class="am-field"><label class="am-label">Select Coin</label>' +
          '<select class="am-select" id="amDepCoin"' + ro + '>' + DEPOSIT_COINS.map(function (c) {
            return '<option value="' + c.coin + '"' + (c.coin === depCoin ? ' selected' : '') + '>' + c.coin + '</option>';
          }).join('') + '</select></div>' +
        '<div class="am-field"><label class="am-label">Network</label>' +
          '<input class="am-input" id="amDepNet" value="' + esc(net) + '"' + ro + '></div>' +
        '<div class="am-field"><label class="am-label">Deposit Address</label>' +
          '<input class="am-input" id="amDepAddr" value="' + esc(entry.address || '') + '"' + ro + '></div>' +
        '<div class="am-field"><label class="am-label">QR Code (optional)</label>' +
          '<div style="display:flex;gap:14px;align-items:flex-start;">' +
            '<div class="am-qr" id="amDepQr">' + (entry.qr ? '<img src="' + esc(entry.qr) + '" alt="qr">' : 'No QR') + '</div>' +
            '<div><div style="display:flex;flex-direction:column;gap:8px;">' +
              '<button class="am-btn info" id="amQrUpload"' + ro + '>Upload QR Image</button>' +
              '<button class="am-btn primary" id="amQrGen"' + ro + '>Generate from Address</button>' +
              (entry.qr ? '<button class="am-btn no" id="amQrDel"' + ro + '>Remove QR</button>' : '') +
            '</div><div class="am-hint">Upload an image or auto-generate</div></div>' +
          '</div>' +
        '</div>' +
        '<button class="am-btn block primary" id="amDepSave"' + ro + '>Save Address</button>' +
      '</div></div>' +
      '<div class="am-panel"><div style="padding:22px 0 0;">' +
        '<h3 style="font-family:\'Space Grotesk\',sans-serif;font-size:17px;margin:0 0 18px;padding:0 22px;">Current Deposit Addresses</h3>' +
        '<div class="am-addrlist">' + current + '</div>' +
      '</div></div>' +
    '</div>' +
    '<h2 class="am-h2" style="margin-top:34px;">Deposit Requests</h2>' +
    filterRow([['all', 'All'], ['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected']],
      depFilter, 'data-depfilter') +
    table(['ID', 'User', 'Coin', 'Amount', 'Value', 'Network', 'Proof', 'Status', 'Time', 'Actions'],
      depRows, 'No deposit requests recorded.');
  }

  function depositAction(r) {
    if (r.status === 'pending') {
      return '<button class="am-btn ok" data-act="dep-approve" data-id="' + esc(r.id) + '"' + lock('approveDeposits') + '>Approve</button>' +
        '<button class="am-btn no" data-act="dep-reject" data-id="' + esc(r.id) + '"' + lock('approveDeposits') + '>Reject</button>';
    }
    return '<button class="am-btn" data-act="noop">\u2014</button>';
  }

  function byUidName(r) {
    var uid = (r && (r.uid || r.userId)) || '';
    var a = accounts().filter(function (x) { return x.uid === uid; })[0];
    return a ? a.name : nameOf(uid);
  }

  function showDepositProof(id) {
    var r = findRequest('deposit', id);
    if (!r) { toast('Could not find that request', 'bad'); return; }
    var proof = r.proof || r.proofName;
    if (!proof) { toast('No proof was attached to that request', 'bad'); return; }
    var sub = [byUidName(r), r.coin || '', qty(r.amount, 6), r.network || netOf(r.coin)]
      .filter(Boolean).join(' \u00b7 ');
    openWith('Deposit proof', sub, 'proof', proof);
  }

  function showLoanProof(id) {
    var r = findRequest('borrow', id);
    if (!r) { toast('Could not find that request', 'bad'); return; }
    var proof = r.proof || r.proofName;
    if (!proof) { toast('No proof was attached to that request', 'bad'); return; }
    var sub = [byUidName(r), money(r.amount), (r.days || 0) + ' days'].filter(Boolean).join(' \u00b7 ');
    openWith('Loan proof of income', sub, 'proof', proof);
  }

  /* A picture is fetched on demand, so say so while it is on its way rather
     than leaving a button that looks like it did nothing. */
  function openWith(title, sub, field, value) {
    var ready = attachSrc(value) ? Promise.resolve(value) : attachReady(value, field);
    modal(title, '<p style="color:#8a8a8a;font-size:13px;">Fetching the file\u2026</p>', function () {}, true);
    ready.then(function (v) { showAttachment(title, sub, v); })
      .catch(function () { closeModal(); toast('That file could not be loaded', 'bad'); });
  }

  /* The whole withdrawal instruction on one screen, unabridged. */
  function showWithdrawal(id) {
    var r = findRequest('withdrawal', id);
    if (!r) { toast('Could not find that request', 'bad'); return; }
    var uid = r.uid || r.userId || '';
    var address = String(r.address == null ? '' : r.address).trim() || '\u2014';
    var html =
      '<div class="am-kv" style="margin-bottom:18px;">' +
        kycField('Recipient', byUidName(r) || nameOf(uid)) +
        kycField('Coin', r.coin || 'USDT') +
        kycField('Amount', qty(r.amount, 8) + ' ' + (r.coin || 'USDT')) +
        kycField('Network', r.network || netOf(r.coin)) +
        kycField('Network fee', qty(r.fee, 8) + ' ' + (r.coin || 'USDT')) +
        kycField('Approximate value', money(r.usd !== undefined ? r.usd : num(r.amount))) +
        '<div class="kv wide"><div class="k">Recipient address</div>' +
          '<div class="v" style="word-break:break-all;line-height:1.7;">' + esc(address) + '</div></div>' +
      '</div>' +
      '<div style="display:flex;gap:10px;">' +
        '<button class="am-btn info" data-act="wd-copy" data-addr="' + esc(address) + '">Copy address</button>' +
      '</div>';
    modal('Withdrawal address', html, function () {
      var b = $('#amModalBody [data-act="wd-copy"]');
      if (b) b.addEventListener('click', function () { copyText(b.dataset.addr); });
    });
  }
  function copyText(text) {
    var s = String(text || '');
    if (!s) { toast('Nothing to copy', 'bad'); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s).then(function () { toast('Address copied', 'ok'); },
        function () { toast('Copy failed', 'bad'); });
    } else {
      toast('Copy not available in this browser', 'bad');
    }
  }

  /* ----------------------------------------------------------- analytics */
  function viewAnalytics() {
    var acc = accounts();
    var trades = list('bb_trades_history');
    var settled = trades.filter(function (t) { return t.status !== 'Active'; });
    var won = settled.filter(function (t) { return pnlOf(t) > 0; });
    var staked = trades.reduce(function (s, t) { return s + num(t.amt); }, 0);
    var pnl = settled.reduce(function (s, t) { return s + pnlOf(t); }, 0);

    var byPair = {};
    settled.forEach(function (t) {
      var k = t.pair || '\u2014';
      byPair[k] = byPair[k] || { n: 0, pnl: 0, won: 0 };
      byPair[k].n++;
      byPair[k].pnl += pnlOf(t);
      if (pnlOf(t) > 0) byPair[k].won++;
    });
    var pairRows = Object.keys(byPair).sort(function (a, b) { return byPair[b].n - byPair[a].n; })
      .map(function (k) {
        var d = byPair[k];
        return '<tr><td class="am-mono">' + esc(k) + '</td>' +
          '<td class="am-mono">' + d.n + '</td>' +
          '<td class="am-mono">' + (d.n ? Math.round(d.won / d.n * 100) + '%' : '\u2014') + '</td>' +
          '<td class="am-mono ' + (d.pnl >= 0 ? 'am-num-green' : 'am-num-red') + '">' +
            (d.pnl >= 0 ? '+' : '') + money(d.pnl) + '</td></tr>';
      });

    var inst = F.instruments || [];
    var liveRows = inst.map(function (i) {
      return '<tr data-amsym="' + esc(i.sym) + '">' +
        '<td class="am-mono"><strong>' + esc(i.sym) + '</strong></td>' +
        '<td style="font-size:12px;color:#7a7a7a;">' + esc(i.group) + '</td>' +
        '<td>' + (i.group === 'forex' ? 'Kraken' : i.group === 'crypto' ? 'Binance' : 'Binance / gold-api') + '</td>' +
        '<td class="am-mono am-js-price" style="color:#9a9a9a;">\u2014</td></tr>';
    }).join('');

    var stats = [
      card('Registered Users', String(acc.length), 'all accounts', 'green'),
      card('Contracts', String(trades.length), settled.length + ' settled', 'blue'),
      card('Win Rate', settled.length ? Math.round(won.length / settled.length * 100) + '%' : '\u2014',
        won.length + ' of ' + settled.length, won.length >= settled.length / 2 ? 'green' : 'orange'),
      card('Total Staked', money(staked), 'across all contracts', 'orange'),
      card('Platform P/L', (pnl >= 0 ? '+' : '') + money(pnl), 'realised on settlement',
        pnl >= 0 ? 'green' : 'red')
    ].join('');

    // Quote every instrument without disturbing the shared crypto stream.
    F.loadMarkets().then(function (rows) {
      primePrices(rows);
      (rows || []).forEach(function (r) {
        var c = document.querySelector('tr[data-amsym="' + r.sym + '"] .am-js-price');
        if (c) c.textContent = F.fmtPrice(r.price);
      });
    }).catch(function () {});
    inst.forEach(function (i) {
      if (i.group === 'crypto') return;
      F.quoteFor(i.sym).then(function (p) {
        var c = document.querySelector('tr[data-amsym="' + i.sym + '"] .am-js-price');
        if (c && p) c.textContent = F.fmtInstrumentPrice ? F.fmtInstrumentPrice(i.sym, p) : F.fmtPrice(p);
      }).catch(function () {});
    });

    return '<div class="am-stats">' + stats + '</div>' +
      '<div class="am-split">' +
        '<div><h2 class="am-h2">Performance by Pair</h2>' +
          table(['Pair', 'Contracts', 'Win rate', 'Net P/L'], pairRows, 'No settled contracts yet.') + '</div>' +
        '<div><h2 class="am-h2">Live Market Feed</h2>' +
          table(['Symbol', 'Class', 'Venue', 'Price'], [liveRows], 'No instruments.') + '</div>' +
      '</div>';
  }

  /* ------------------------------------------------------------ settings
     Only the console's own access password lives here. The signed-in admin's
     sign-in password belongs to their account, so it is changed from the
     platform's Settings page, not from the console. */
  function viewSettings() {
    return '<div class="am-panel" style="max-width:470px;"><div style="padding:26px;">' +
      '<h3 style="font-family:\'Space Grotesk\',sans-serif;font-size:17px;margin:0 0 6px;">Admin Access Password</h3>' +
      '<p style="font-size:12.5px;color:#7a7a7a;line-height:1.6;margin:0 0 18px;">' +
      'The password an account without admin access is asked for before it can ' +
      'open this console, and the one a secondary admin must enter to become the ' +
      'first admin. Accounts already flagged admin never see the prompt.</p>' +
      '<div class="am-field"><label class="am-label">Current admin password</label>' +
        '<input class="am-input" type="password" id="amApCur" placeholder="Enter current password"></div>' +
      '<div class="am-field"><label class="am-label">New admin password</label>' +
        '<input class="am-input" type="password" id="amApNew" placeholder="Enter new password (min 6 characters)"></div>' +
      '<button class="am-btn block primary" id="amApSave"' + lock('consoleSettings') + '>Update Admin Password</button>' +
      '<div id="amApMsg" style="font-size:13px;margin-top:14px;"></div>' +
      '<p style="font-size:11.5px;color:#5a5a5a;line-height:1.6;margin-top:16px;">' +
      'Stored in this browser as a salted hash. Only a server could make this a ' +
      'real boundary.</p>' +
      '<p style="font-size:12.5px;color:#7a7a7a;line-height:1.6;margin:16px 0 0;">' +
      'To change your own sign-in password, use ' +
      '<a href="settings.html" style="color:#f7931a;">Settings</a> on the platform.</p>' +
      '</div></div>' +
      '<div class="am-panel" style="max-width:470px;margin-top:22px;"><div style="padding:22px;">' +
        '<h3 style="font-family:\'Space Grotesk\',sans-serif;font-size:16px;margin:0 0 10px;">Storage</h3>' +
        '<p style="font-size:12.5px;color:#7a7a7a;line-height:1.6;margin:0 0 16px;">' +
        'This console reads and writes this browser\'s localStorage only. There is no server, ' +
        'so it cannot reach another person\'s account, and the admin flag is client-side.</p>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
          '<button class="am-btn" id="amExport"' + lock('exportData') + '>Export all data (JSON)</button>' +
          '<button class="am-btn no" id="amWipeDemo"' + lock('consoleSettings') + '>Reset demo data</button>' +
        '</div></div></div>';
  }

  /* ========================================================== NAV + VIEWS */

  /* Which permission each console action needs. Anything not listed here is
     read-only and needs no permission. A secondary admin sees every view but
     can only act on the rows their owner unlocked for them. */
  var ACT_PERM = {
    'dep-approve': 'approveDeposits', 'dep-reject': 'approveDeposits',
    'wd-approve': 'approveWithdrawals', 'wd-reject': 'approveWithdrawals',
    'loan-approve': 'approveLoans', 'loan-reject': 'approveLoans', 'loan-paid': 'approveLoans',
    'loan-del': 'deleteRecords',
    'kyc-approve': 'reviewKyc', 'kyc-reject': 'reviewKyc',
    'edit': 'editUsers', 'toggle-status': 'editUsers', 'profit': 'editUsers',
    'verify': 'editUsers', 'admin': 'manageAdmins',
    'del': 'deleteRecords', 'del-trade': 'deleteRecords',
    'balance-set': 'adjustBalances', 'balance-credit': 'adjustBalances', 'balance-debit': 'adjustBalances'
  };
  var SACT_PERM = { open: 'replySupport', resolve: 'replySupport', send: 'replySupport', delete: 'deleteRecords' };

  function can(key) {
    // Managing the admin team is not a toggle: it belongs to the first admin alone.
    if (key === 'manageAdmins') return owner();
    return A.adminCan ? A.adminCan(key) : true;
  }
  function owner() { return A.isOwner ? A.isOwner() : false; }

  /* Rendered on a button the signed-in admin may not press. Keeping the
     control visible and explaining why beats hiding it, so a secondary admin
     can see what exists and who to ask about it. */
  function lock(perm) {
    if (!perm || can(perm)) return '';
    return ' disabled title="Your admin role does not allow this - ask the first admin"';
  }
  /* Same, for the Edit button. A secondary admin keeps it on their own row so
     they can reach the first-admin switch; on every other row it stays locked. */
  function lockEdit(uid) {
    if (can('editUsers')) return '';
    if (String(uid) === String(A.get(A.KEYS.uid, ''))) return '';
    return ' disabled title="Your admin role does not allow this - ask the first admin"';
  }
  function denied(perm) {
    var p = (A.PERMISSIONS || []).filter(function (x) { return x.key === perm; })[0];
    toast('Not allowed: ' + (p ? p.label : perm), 'bad');
  }

  var NAV = [
    { id: 'dashboard', label: 'Dashboard', icon: 'layout-dashboard', title: 'Dashboard' },
    { id: 'users', label: 'Users', icon: 'users', title: 'User Management',
      sub: 'Accounts, balances and access' },
    { id: 'support', label: 'Support', icon: 'headphones', title: 'Support', sub: 'Conversations' },
    { id: 'trades', label: 'Trades', icon: 'activity', title: 'Trade Management' },
    { id: 'withdrawals', label: 'Withdrawals', icon: 'trending-up', title: 'Withdrawal Requests' },
    { id: 'loans', label: 'Loans', icon: 'landmark', title: 'Loan Requests' },
    { id: 'kyc', label: 'KYC', icon: 'shield-check', title: 'KYC Verification' },
    { id: 'balances', label: 'Balances', icon: 'wallet', title: 'Balance Adjustment' },
    { id: 'deposits', label: 'Deposits', icon: 'layout-grid', title: 'Deposit Addresses',
      sub: 'Edit deposit addresses and QR codes shown to users' },
    { id: 'analytics', label: 'Analytics', icon: 'bar-chart-3', title: 'Analytics' },
    { id: 'admins', label: 'Admins', icon: 'shield', title: 'Admin Team', ownerOnly: true,
      sub: 'Decide what each admin may do' },
    { id: 'settings', label: 'Settings', icon: 'settings', title: 'Admin Settings' }
  ];

  function navFor() { return NAV.filter(function (n) { return !n.ownerOnly || owner(); }); }

  var VIEWS = {
    dashboard: viewDashboard,
    users: viewUsers,
    support: viewSupport,
    trades: viewTrades,
    withdrawals: viewWithdrawals,
    loans: viewLoans,
    kyc: viewKyc,
    balances: viewBalances,
    deposits: viewDeposits,
    analytics: viewAnalytics,
    admins: viewAdmins,
    settings: viewSettings
  };

  function soon(title, msg) {
    return '<div class="am-soon"><h2>' + esc(title) + '</h2><p>' + esc(msg) + '</p></div>';
  }

  /* ------------------------------------------------------- console lock */
  /* Only non-admins ever see the prompt; an admin account goes straight in. */
  function showGate() {
    var gate = $('#amGate');
    gate.style.display = '';
    $('#amGateMsg').textContent = '';
    if (global.lucide) global.lucide.createIcons();
    setTimeout(function () {
      var f = $('#amGatePw');
      if (f) f.focus();
    }, 60);
  }

  function wireGate() {
    function attempt() {
      var pw = $('#amGatePw').value;
      A.unlockAsAdmin(pw).then(function () {
        $('#amGate').style.display = 'none';
        enter();
      }).catch(function (e) {
        var m = $('#amGateMsg');
        m.textContent = e.message || 'Incorrect admin password';
        $('#amGatePw').select();
      });
    }
    $('#amGateGo').addEventListener('click', attempt);
    $('#amGatePw').addEventListener('keydown', function (e) { if (e.key === 'Enter') attempt(); });
  }

  var current = 'dashboard';

  function render() {
    // A second admin can never be left on the first-admin-only screen, and must
    // not be stranded on a view that no longer exists.
    var nav = navFor();
    if (!nav.some(function (n) { return n.id === current; })) current = 'dashboard';
    var item = nav.filter(function (n) { return n.id === current; })[0] || nav[0];
    $('#amTitle').textContent = item.title;
    $('#amSub').textContent = item.sub || '';
    $('#amStamp').textContent = 'Last updated: ' + new Date().toLocaleString('en-US', {
      year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    $$('#amNav a').forEach(function (a) { a.classList.toggle('on', a.dataset.view === current); });
    var view = VIEWS[current];
    var role = owner() ? '' :
      '<div class="am-rolebar"><i data-lucide="shield-alert" style="width:15px;height:15px;flex-shrink:0;"></i>' +
        '<span>You are a <strong>secondary admin</strong>. You can read every screen, but only the ' +
        'first admin decides which actions you may take. To take that role yourself, open your own ' +
        'row under Users &rarr; Edit and turn on <strong>First Admin</strong> - it asks for the ' +
        'admin password.</span></div>';
    /* A view that throws used to leave the previous screen on screen with nothing
       in the console, which looks exactly like "the new thing is not working".
       Say what broke instead. */
    var html;
    try {
      html = view ? view() : '';
    } catch (err) {
      html = '<div class="am-panel"><div class="am-empty">' +
        'This view failed to render.<br><span style="font-family:\'IBM Plex Mono\',monospace;' +
        'font-size:11.5px;color:#7a7a7a;">' + esc(err && err.message ? err.message : err) +
        '</span></div></div>';
    }
    $('#amView').innerHTML = role + html;
    // On a phone an open conversation owns the whole screen height, so the CSS
    // can make the message list the only thing that scrolls.
    document.body.classList.toggle('am-conv-open', current === 'support' && !!supportOpen);
    if (global.lucide) global.lucide.createIcons();
    wire();
  }

  function counts() {
    var out = {};
    function count(key, pred) { return list(key).filter(pred).length; }
    out.support = count('bb_support_threads', function (t) {
      return t.status === 'open' && Array.isArray(t.messages) && t.messages.length > 0;
    });
    out.withdrawals = count('bb_withdrawal_requests', function (r) { return r.status === 'pending'; });
    out.kyc = count('bb_kyc_requests', function (r) { return (r.status || 'pending') === 'pending'; });
    out.loans = count('bb_borrow_requests', function (r) { return (r.status || 'pending') === 'pending'; });
    out.deposits = count('bb_deposit_requests', function (r) { return (r.status || 'pending') === 'pending'; });
    return out;
  }

  function buildNav() {
    var c = counts();
    var badgeFor = { support: c.support, withdrawals: c.withdrawals, kyc: c.kyc, loans: c.loans, deposits: c.deposits };
    $('#amNav').innerHTML = navFor().map(function (n) {
      var b = badgeFor[n.id];
      return '<a href="#" data-view="' + n.id + '"' + (n.id === current ? ' class="on"' : '') + '>' +
        '<i data-lucide="' + n.icon + '"></i>' + esc(n.label) +
        (b ? '<span class="count">' + b + '</span>' : '') + '</a>';
    }).join('');
    if (global.lucide) global.lucide.createIcons();
  }

  /* ------------------------------------------------------------- actions */
  function toast(msg, tone) {
    var host = $('#amToast');
    var d = document.createElement('div');
    d.style.borderLeftColor = tone === 'ok' ? '#16c784' : tone === 'bad' ? '#ea3943' : '#f7931a';
    d.textContent = msg;
    host.appendChild(d);
    setTimeout(function () { d.remove(); }, 3400);
  }

  function modal(title, html, onMount, wide) {
    $('#amModalTitle').textContent = title;
    $('#amModalBody').innerHTML = html;
    var box = $('#amModal .box');
    if (box) box.classList.toggle('wide', !!wide);
    $('#amModal').classList.add('open');
    if (global.lucide) global.lucide.createIcons();
    if (onMount) onMount();
  }
  function closeModal() {
    var box = $('#amModal .box');
    if (box) box.classList.remove('wide');
    $('#amModal').classList.remove('open');
  }

  /* A switch row: label, on/off state and a plain-language explanation. */
  /* `locked` renders the row read-only, for a switch whose value is forced by
     the account's role and so cannot be changed from this form. */
  function switchRow(id, on, title, hint, locked) {
    return '<div style="margin-top:18px;">' +
      '<div style="font-size:12px;color:#8a8a8a;margin-bottom:8px;">' + esc(title) + '</div>' +
      '<button type="button" class="switch-row' + (on ? ' on' : '') + '" id="' + id + '" ' +
        (locked ? 'disabled title="A first admin is always an admin, so this stays on"' : '') +
        'style="display:flex;align-items:center;gap:14px;width:100%;text-align:left;background:#1c1c1c;' +
        'border:1px solid #2a2a2a;border-radius:12px;padding:14px 16px;font-family:inherit;' +
        (locked ? 'opacity:.55;cursor:not-allowed;' : 'cursor:pointer;') + '">' +
        '<span class="am-toggle' + (on ? ' on' : '') + '" style="position:relative;width:42px;height:24px;' +
          'border-radius:999px;background:' + (on ? '#16c784' : '#3a3a3a') + ';flex:0 0 42px;transition:background .2s;"></span>' +
        '<span style="min-width:0;">' +
          '<span style="display:block;font-size:14px;font-weight:700;color:#fff;font-family:\'IBM Plex Mono\',monospace;">' +
            (on ? 'ON' : 'OFF') + '</span>' +
          '<span style="display:block;font-size:12px;color:#8a8a8a;margin-top:3px;">' + esc(hint) + '</span>' +
        '</span>' +
      '</button></div>';
  }

  function editUser(uid) {
    var a = accounts().filter(function (x) { return x.uid === uid; })[0];
    if (!a) return;
    var me = A.get(A.KEYS.uid, '');
    var isSelf = String(a.uid) === String(me);
    // A secondary admin may open their own row even without editUsers, so the
    // first-admin switch below is always reachable. Their own fields stay
    // read-only: without that permission they change nothing but their role.
    var mayEdit = can('editUsers');
    var html =
      '<div class="am-field"><label class="am-label">User ID</label>' +
        '<input class="am-input" value="' + esc(shortId(a.uid)) + '" readonly ' +
          'style="background:#161616;color:#f7931a;font-family:\'IBM Plex Mono\',monospace;letter-spacing:.2em;"></div>' +
      '<div class="am-field"><label class="am-label">Internal ID</label>' +
        '<input class="am-input" value="' + esc(a.uid) + '" readonly ' +
          'style="background:#161616;color:#5a5a5a;font-size:11px;"></div>' +
      '<div class="am-field"><label class="am-label">Name</label>' +
        '<input class="am-input" id="edName" value="' + esc(a.name) + '"' + (mayEdit ? '' : ' disabled') + '></div>' +
      '<div class="am-field"><label class="am-label">Email</label>' +
        '<input class="am-input" id="edEmail" value="' + esc(a.email) + '"' + (mayEdit ? '' : ' disabled') + '></div>' +
      '<div class="am-field"><label class="am-label">Cash Balance (USDT)</label>' +
        '<input class="am-input" id="edCash" inputmode="decimal" value="' + a.cash + '"' +
          (can('adjustBalances') ? '' : ' disabled title="Your admin role does not allow balance changes"') + '></div>' +
      /* Second admin: a real admin login, but every action stays off until a
         first admin switches it on from the Admin Team screen. Locked on for a
         first admin, because that role is an admin by definition. */
      (can('manageAdmins')
        ? switchRow('edSecond', a.admin, 'Second Admin',
            a.owner === true
              ? 'A first admin is always an admin, so this stays on.'
              : 'Give this user an admin login. They can read every screen, and you decide what they are allowed to change from the Admin Team screen.',
            a.owner === true)
        : '<div class="am-note">Only a first admin can grant or revoke admin access.</div>') +
      /* First admin. Unlike the switch above this is not permission based:
         anybody signed into the console may ask for it, and the admin password
         is what actually decides. */
      switchRow('edOwner', a.owner === true, 'First Admin (full access)',
        a.owner === true
          ? 'This account is the first admin. Turn it off to hand the role to somebody else.'
          : 'Make this account a first admin: every permission, and the only role that can hand out admin access. Needs the admin password.') +
      '<div id="edOwnerPwWrap" style="display:none;">' +
        '<div class="am-field"><label class="am-label">Admin password to confirm</label>' +
          '<input class="am-input" id="edOwnerPw" type="password" autocomplete="off" ' +
            'placeholder="Asked for on every change"></div>' +
      '</div>' +
      (mayEdit
        ? switchRow('edProfit', !!a.rec.profitMode, 'Profit Mode',
            'Every contract for this account settles as a win, real trades included. ' +
            'The market price is still fetched and recorded; only the result is forced. ' +
            'A contract still has to reach its expiry before it settles.')
        : (isSelf
            ? '<div class="am-note">These are your own account details. Changing them, and ' +
                'everything else on this form, needs the first admin - the switch below is the ' +
                'one thing you can do here.</div>'
            : '')) +
      '<button class="am-btn primary block" id="edSave" style="margin-top:22px;">' +
        (mayEdit ? 'Save Changes' : 'Apply') + '</button>' +
      '<div class="am-err" id="edErr" style="display:none;"></div>';

    modal('Edit User', html, function () {
      var state = { second: a.admin, profit: !!a.rec.profitMode, owner: a.owner === true };
      var err = $('#edErr');
      function fail(t) { err.textContent = t; err.style.display = ''; }
      function paint(id, on) {
        var row = document.getElementById(id);
        if (!row) return;
        row.querySelector('.am-toggle').classList.toggle('on', on);
        row.querySelector('.am-toggle').style.background = on ? '#16c784' : '#3a3a3a';
        row.querySelector('span span').textContent = on ? 'ON' : 'OFF';
      }
      function bind(id, key, after) {
        var btn = document.getElementById(id);
        if (!btn) return;
        var knob = btn.querySelector('.am-toggle');
        var lab = btn.querySelector('span span');
        btn.addEventListener('click', function () {
          state[key] = !state[key];
          knob.classList.toggle('on', state[key]);
          knob.style.background = state[key] ? '#16c784' : '#3a3a3a';
          lab.textContent = state[key] ? 'ON' : 'OFF';
          err.style.display = 'none';
          if (after) after(state[key]);
        });
      }
      // The password box follows the switch, and starts empty every time: the
      // admin password is asked for on each change, never remembered.
      var pwWrap = $('#edOwnerPwWrap');
      /* A first admin is an admin, so the two switches cannot disagree: making
         this a first admin turns Second Admin on with it, and turning Second
         Admin off steps the first admin role down instead of leaving a
         half-state where the account is a first admin but not an admin. */
      bind('edSecond', 'second', function (on) {
        if (!on && state.owner) {
          state.owner = false;
          paint('edOwner', false);
          pwWrap.style.display = 'none';
          $('#edOwnerPw').value = '';
        }
      });
      bind('edProfit', 'profit');
      bind('edOwner', 'owner', function (on) {
        pwWrap.style.display = on ? '' : 'none';
        $('#edOwnerPw').value = '';
        if (on) { state.second = true; paint('edSecond', true); }
      });
      pwWrap.style.display = state.owner ? '' : 'none';

      $('#edSave').addEventListener('click', function () {
        var btn = this;
        var cash = parseFloat($('#edCash').value);
        if (!isFinite(cash) || cash < 0) { fail('Balance must be a non-negative number.'); return; }
        var ownerChanged = state.owner !== (a.owner === true);
        // Read the permissions of whoever is clicking now: a handover changes
        // them mid-save, and this save was authorised by the role they had.
        var mayManage = can('manageAdmins');
        var mayBalance = can('adjustBalances');

        var commit = function () {
          var map = users();
          if (mayEdit) {
            map[uid].name = $('#edName').value.trim() || map[uid].name;
            map[uid].email = $('#edEmail').value.trim() || map[uid].email;
          }
          if (state.profit) map[uid].profitMode = true; else delete map[uid].profitMode;
          A.writeJSON(A.KEYS.users, map);
          // Admin access goes through setAdmin so the first-admin rule still
          // applies, rather than writing the flag straight onto the record.
          // setOwnerAs below has already made this a first admin by the time we
          // get here, so the switch does not touch the flag for that account.
          var wantAdmin = state.owner ? true : state.second;
          if (mayManage && !state.owner && wantAdmin !== (map[uid].admin === true)) {
            if (!A.setAdmin(uid, wantAdmin)) {
              toast('Only a first admin can change admin access', 'bad');
            }
          }
          if (mayBalance) A.adminSetCash(uid, cash);
          closeModal();
          render();
          buildNav();
          toast(ownerChanged ? 'First admin updated' : 'Account updated', 'ok');
        };

        if (!ownerChanged) { commit(); return; }
        var pw = $('#edOwnerPw').value;
        if (!pw) { fail('Enter the admin password to confirm'); $('#edOwnerPw').focus(); return; }
        btn.disabled = true;
        btn.textContent = 'Checking password\u2026';
        A.setOwnerAs(uid, state.owner, pw).then(commit).catch(function (e) {
          btn.disabled = false;
          btn.textContent = mayEdit ? 'Save Changes' : 'Apply';
          fail(e.message || 'Incorrect admin password');
          $('#edOwnerPw').select();
        });
      });
    });
  }

  function confirmDeleteUser(uid) {
    var a = accounts().filter(function (x) { return x.uid === uid; })[0];
    var withDb = A.isRemote();
    modal('Delete account', a ? a.name : uid,
      '<p style="font-size:13.5px;line-height:1.65;color:#9a9a9a;">This permanently removes ' +
      (withDb
        ? 'the sign-in, the profile, and every balance, holding, contract, ledger, chat and setting ' +
          'the account owns. It cannot be undone.'
        : 'the account, its balances, holdings, ledgers and positions from this browser. It cannot be ' +
          'undone and there is no server copy.') + '</p>' +
      (withDb
        ? '<p style="font-size:12.5px;line-height:1.6;color:#7a7a7a;margin:10px 0 0;">Any open contract is ' +
          'removed with the account. Real cash already credited stays credited.</p>'
        : '') +
      '<div style="display:flex;gap:8px;margin-top:20px;">' +
      '<button class="am-btn" id="dNo" style="flex:1;">Cancel</button>' +
      '<button class="am-btn no" id="dYes" style="flex:1;">Delete permanently</button></div>' +
      '<div id="dErr"></div>',
      function () {
        $('#dNo').addEventListener('click', closeModal);
        var yes = $('#dYes');
        yes.addEventListener('click', function () {
          // Held until the round trip finishes, so a second click cannot send a
          // second delete and land on a row that no longer exists.
          yes.disabled = true;
          yes.textContent = 'Deleting…';
          A.deleteAccount(uid).then(function (out) {
            closeModal(); render(); buildNav();
            /* The two outcomes are not the same promise to the operator: without
               the database function the profile is gone but the person can still
               sign in and be rebuilt, which is not what Delete means. */
            if (out && out.signinRemoved === false) {
              toast('Profile removed, but the sign-in still works', 'bad');
              modal('Sign-in still active', esc(a ? a.name : uid),
                '<p style="font-size:13.5px;line-height:1.65;color:#9a9a9a;">The profile and all of its ' +
                'records are gone, but this account can still sign in, and signing in rebuilds it.</p>' +
                '<p style="font-size:13.5px;line-height:1.65;color:#9a9a9a;">Run ' +
                '<strong>supabase/INSTALL.sql</strong> in the Supabase SQL editor. It adds ' +
                '<strong>bb_delete_account</strong>, which removes the sign-in itself. Then delete the ' +
                'account again from here.</p>' +
                '<div style="display:flex;gap:8px;margin-top:20px;">' +
                '<button class="am-btn primary" id="dOk" style="flex:1;">Close</button></div>',
                function () { $('#dOk').addEventListener('click', closeModal); });
              return;
            }
            toast('Account deleted', 'bad');
          }).catch(function (e) {
            yes.disabled = false;
            yes.textContent = 'Delete permanently';
            var box = $('#dErr') || $('#amModalBody');
            if (!box) return;
            var d = document.createElement('div');
            d.className = 'am-err';
            d.style.marginTop = '14px';
            d.textContent = e.message || 'Could not delete';
            box.appendChild(d);
          });
        });
      });
  }

  function verifyUser(uid) {
    var map = users();
    if (!map[uid]) return;
    map[uid].kyc_status = 'approved';
    map[uid].kyc = 'approved';
    map[uid].kyc_verified = true;
    A.writeJSON(A.KEYS.users, map);
    // Any queued submission for this user follows, matched on either id field
    // because a request read back from the database carries userId.
    var reqs = list('bb_kyc_requests').map(function (r) {
      if ((r.uid || r.userId) === uid) {
        r.status = 'approved';
        r.decidedAt = Date.now();
      }
      return r;
    });
    save('bb_kyc_requests', reqs);
    render();
    toast('KYC verified for ' + shortId(uid), 'ok');
  }

  function recordAdjust(uid, before, after, reason, mode) {
    var hist = list('bb_admin_adjustments');
    hist.unshift({
      uid: uid, before: before, after: after,
      delta: after - before, reason: reason, mode: mode || 'delta', time: Date.now()
    });
    save('bb_admin_adjustments', hist.slice(0, 200));
  }

  function doAdjust(mode) {
    if (!can('adjustBalances')) { denied('adjustBalances'); return; }
    var uid = $('#amBalUser').value;
    var amount = parseFloat($('#amBalAmount').value);
    var reason = $('#amBalReason').value.trim();
    if (!uid) return;
    if (!isFinite(amount)) { toast('Enter a valid amount', 'bad'); return; }
    var map = users();
    var rec = map[uid];
    if (!rec) return;
    var before = num(rec.cash);
    var after = mode === 'set' ? Math.max(0, amount)
      : mode === 'credit' ? before + Math.abs(amount)
      : Math.max(0, before - Math.abs(amount));
    A.adminSetCash(uid, after);
    recordAdjust(uid, before, after, reason, mode);
    $('#amBalAmount').value = '';
    $('#amBalReason').value = '';
    render();
    toast(cap(mode) + ' \u2014 ' + shortId(uid) + ' is now ' + money(after), 'ok');
  }

  /* Decide a submission. The profile row is updated alongside the queued
     request so the applicant sees the same verdict on their settings page, and
     both stores are written from the same read - re-reading inside save() would
     throw the status change away. */
  function setKyc(id, status) {
    var row = findKyc(id);
    if (!row) { toast('Could not find that submission', 'bad'); return false; }
    var reqs = list('bb_kyc_requests');
    var target = reqs.filter(function (x) {
      return (x.id || ('KYC-' + shortId(x.uid || x.userId || '') + '-' + (x.time || 0))) === id;
    })[0];
    if (target) {
      target.status = status;
      target.decidedAt = Date.now();
      target.decidedBy = A.get(A.KEYS.uid, '');
      save('bb_kyc_requests', reqs);
    }
    var map = users();
    if (row.uid && map[row.uid]) {
      map[row.uid].kyc_status = status;
      map[row.uid].kyc = status;
      if (status === 'approved') map[row.uid].kyc_verified = true;
      else delete map[row.uid].kyc_verified;
      A.writeJSON(A.KEYS.users, map);
    }
    render(); buildNav();
    toast('KYC ' + status, status === 'approved' ? 'ok' : 'bad');
    return true;
  }

  /* ===================================================== approval actions
     Each of these changes the request record AND moves the money, so an
     approval is not just a label. A rejection undoes any hold taken when the
     user first asked.

     Read the list once, mutate that array, then write the same array back -
     re-reading inside save() would silently discard the status change. */
  function updateRequest(kind, id, fn) {
    var key = 'bb_' + kind + '_requests';
    var arr = list(key);
    var rec = null;
    arr.forEach(function (r) { if (requestId(kind, r) === id) rec = r; });
    if (!rec) return null;
    fn(rec);
    save(key, arr);
    return rec;
  }

  /* Approving a deposit credits the account. Every asset except USDT is
     converted to its USDT value and credited as USDT, so the user ends up with
     one spendable balance instead of a mixed one. The rate is the live price
     captured when the request was raised (recorded as `usd`), falling back to
     the current feed price if that is missing. */
  function approveDeposit(id) {
    return updateRequest('deposit', id, function (r) {
      var uid = r.uid || r.userId;
      var amt = num(r.amount);
      var coin = r.coin || 'USDT';
      var credited = amt;
      if (coin !== 'USDT') {
        var rate = amt > 0 ? num(r.usd) / amt : 0;
        if (!rate) rate = num(priceCache[coin]);
        credited = amt * rate;
        r.convertedFrom = coin;
        r.conversionRate = rate;
      }
      r.credited = credited;
      r.status = 'approved';
      r.decidedAt = Date.now();
      r.decidedBy = A.get(A.KEYS.uid, '');
      A.adminSetCash(uid, num((users()[uid] || {}).cash) + credited);
    });
  }

  function rejectDeposit(id) {
    return updateRequest('deposit', id, function (rec) {
      rec.status = 'rejected';
      rec.decidedAt = Date.now();
      rec.decidedBy = A.get(A.KEYS.uid, '');
    });
  }

  /* The amount plus fee was already taken when the request was raised, so
     approving changes nothing but the status; rejecting hands it back. */
  function approveWithdraw(id) {
    return updateRequest('withdrawal', id, function (rec) {
      rec.status = 'approved';
      rec.decidedAt = Date.now();
      rec.decidedBy = A.get(A.KEYS.uid, '');
    });
  }

  function rejectWithdraw(id) {
    return updateRequest('withdrawal', id, function (rec) {
      var uid = rec.uid || rec.userId;
      var coin = rec.coin || 'USDT';
      var back = num(rec.amount) + num(rec.fee);
      if (coin === 'USDT') A.adminSetCash(uid, num((users()[uid] || {}).cash) + back);
      else A.adminAddAsset(uid, coin, back);
      rec.status = 'rejected';
      rec.decidedAt = Date.now();
      rec.decidedBy = A.get(A.KEYS.uid, '');
    });
  }

  /* An approved loan lands in the USDT balance. */
  function approveLoan(id) {
    return updateRequest('borrow', id, function (rec) {
      var uid = rec.uid || rec.userId;
      A.adminSetCash(uid, num((users()[uid] || {}).cash) + num(rec.amount));
      rec.status = 'active';
      rec.decidedAt = Date.now();
      rec.decidedBy = A.get(A.KEYS.uid, '');
      if (!rec.due) rec.due = Date.now() + num(rec.days || 30) * 86400000;
    });
  }

  function rejectLoan(id) {
    return updateRequest('borrow', id, function (rec) {
      rec.status = 'rejected';
      rec.decidedAt = Date.now();
      rec.decidedBy = A.get(A.KEYS.uid, '');
    });
  }

  /* Settling clears principal plus interest from the USDT balance. Balances
     floor at zero, so an under-funded account simply has the rest written off
     rather than going negative. */
  function payLoan(id) {
    return updateRequest('borrow', id, function (rec) {
      var uid = rec.uid || rec.userId;
      var due = num(rec.amount) + num(rec.interest);
      A.adminSetCash(uid, num((users()[uid] || {}).cash) - due);
      rec.status = 'paid';
      rec.paidAt = Date.now();
      rec.paidAmount = due;
    });
  }

  function wire() {
    /* ---- view filters ---- */
    $$('[data-ufilter]').forEach(function (b) { b.addEventListener('click', function () { userFilter = b.dataset.ufilter; render(); }); });
    $$('[data-sfilter]').forEach(function (b) { b.addEventListener('click', function () { supportFilter = b.dataset.sfilter; render(); }); });
    $$('[data-tfilter]').forEach(function (b) { b.addEventListener('click', function () { tradeFilter = b.dataset.tfilter; render(); }); });
    $$('[data-wfilter]').forEach(function (b) { b.addEventListener('click', function () { wdFilter = b.dataset.wfilter; render(); }); });
    $$('[data-lfilter]').forEach(function (b) { b.addEventListener('click', function () { loanFilter = b.dataset.lfilter; render(); }); });
    $$('[data-kfilter]').forEach(function (b) { b.addEventListener('click', function () { kycFilter = b.dataset.kfilter; render(); }); });
    $$('[data-depfilter]').forEach(function (b) { b.addEventListener('click', function () { depFilter = b.dataset.depfilter; render(); }); });

    var search = $('#amUserSearch');
    if (search) search.addEventListener('input', function () {
      userQuery = search.value.trim().toLowerCase();
      var pos = search.selectionStart;
      render();
      var again = $('#amUserSearch');
      if (again) { again.focus(); again.setSelectionRange(pos, pos); }
    });
    var refreshBtn = $('#amUserRefresh');
    if (refreshBtn) refreshBtn.addEventListener('click', function () {
      var job=global.BitbaseDB && A.isRemote() ? global.BitbaseDB.refresh() : Promise.resolve();
      job.then(function () { render(); toast('User list refreshed', 'ok'); }).catch(function () { toast('Could not refresh users', 'bad'); });
    });

    /* ---- users ---- */
    $$('[data-act]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        var act = b.dataset.act;
        var uid = b.dataset.uid;
        // One gate for every mutating control. The first admin passes everything;
        // a secondary admin only passes the actions their owner enabled.
        // Opening your own row is exempt: that is where the first-admin switch
        // lives, and it is gated on the admin password instead.
        var need = ACT_PERM[act];
        var selfEdit = act === 'edit' && uid === A.get(A.KEYS.uid, '');
        if (need && !can(need) && !selfEdit) { denied(need); return; }
        if (act === 'edit') editUser(uid);
        else if (act === 'verify') verifyUser(uid);
        else if (act === 'del') confirmDeleteUser(uid);
        else if (act === 'toggle-status') {
          A.setDisabled(uid, b.textContent.trim() === 'Activate');
          render();
          toast(b.textContent.trim() + 'd ' + shortId(uid), b.textContent.trim() === 'Activate' ? 'ok' : 'bad');
        }
        else if (act === 'del-trade') {
          ['bb_trades_history', 'bb_demo_trades_hist'].forEach(function (k) {
            save(k, list(k).filter(function (t) { return t.id !== b.dataset.id; }));
          });
          render();
          toast('Trade deleted', 'bad');
        }
        else if (act === 'wd-approve') {
          if (approveWithdraw(b.dataset.id)) { render(); buildNav(); toast('Withdrawal approved', 'ok'); }
          else toast('Could not find that request', 'bad');
        }
        else if (act === 'wd-reject') {
          if (rejectWithdraw(b.dataset.id)) { render(); buildNav(); toast('Withdrawal rejected \u00b7 funds returned', 'bad'); }
          else toast('Could not find that request', 'bad');
        }
        else if (act === 'dep-approve') {
          if (approveDeposit(b.dataset.id)) { render(); buildNav(); toast('Deposit credited', 'ok'); }
          else toast('Could not find that request', 'bad');
        }
        else if (act === 'dep-reject') {
          if (rejectDeposit(b.dataset.id)) { render(); buildNav(); toast('Deposit rejected', 'bad'); }
          else toast('Could not find that request', 'bad');
        }
        else if (act === 'loan-approve') {
          if (approveLoan(b.dataset.id)) { render(); buildNav(); toast('Loan approved \u00b7 funds released', 'ok'); }
          else toast('Could not find that request', 'bad');
        }
        else if (act === 'loan-reject') {
          if (rejectLoan(b.dataset.id)) { render(); buildNav(); toast('Loan rejected', 'bad'); }
          else toast('Could not find that request', 'bad');
        }
        else if (act === 'loan-paid') {
          if (payLoan(b.dataset.id)) { render(); buildNav(); toast('Loan settled', 'ok'); }
          else toast('Could not find that request', 'bad');
        }
        else if (act === 'loan-del') {
          save('bb_borrow_requests', list('bb_borrow_requests').filter(function (r) {
            return requestId('borrow', r) !== b.dataset.id;
          }));
          render(); buildNav();
          toast('Loan removed', 'bad');
        }
        else if (act === 'kyc-review') kycReview(b.dataset.id);
        else if (act === 'dep-proof') showDepositProof(b.dataset.id);
        else if (act === 'loan-proof') showLoanProof(b.dataset.id);
        else if (act === 'wd-view') showWithdrawal(b.dataset.id);
        else if (act === 'wd-copy') copyText(b.dataset.addr);
        else if (act === 'copy-code') copyText(b.dataset.code);
        else if (act === 'kyc-approve') setKyc(b.dataset.id, 'approved');
        else if (act === 'kyc-reject') setKyc(b.dataset.id, 'rejected');
      });
    });
    $$('[data-admin]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        var uid = btn.dataset.admin;
        var on = !btn.classList.contains('on');
        if (!can('manageAdmins')) { denied('manageAdmins'); return; }
        if (!A.setAdmin(uid, on)) {
          toast('Only the first admin can change admin access', 'bad');
          return;
        }
        render();
        toast(shortId(uid) + (on ? ' promoted to admin' : ' admin revoked'), on ? 'ok' : 'bad');
      });
    });
    /* Profit Mode straight from the table, like the Admin switch. It covers this
       account's real and practice trades alike, so the toast says so. */
    $$('[data-profit]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        if (!can('editUsers')) { denied('editUsers'); return; }
        var uid = btn.dataset.profit;
        var map = users();
        if (!map[uid]) return;
        var on = !(map[uid].profitMode === true);
        if (on) map[uid].profitMode = true; else delete map[uid].profitMode;
        A.writeJSON(A.KEYS.users, map);
        render();
        toast(shortId(uid) + (on ? ' set to profit mode - every contract wins' : ' removed from profit mode'), on ? 'ok' : 'bad');
      });
    });

    /* ---- support ---- */
    $$('[data-thread]').forEach(function (el) {
      if (el.tagName === 'BUTTON') return;
      var open = function () {
        supportOpen = el.dataset.thread;
        render();
        // Open on the newest message, the way a chat should read.
        var m = $('#amMsgs');
        if (m) m.scrollTop = m.scrollHeight;
      };
      el.addEventListener('click', open);
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
    var back = $('#amConvBack');
    if (back) back.addEventListener('click', function () { supportOpen = null; render(); });
    /* A picture opens full size rather than cropped to the bubble. */
    $$('[data-msgimg]').forEach(function (img) {
      img.addEventListener('click', function () {
        var parts = String(img.dataset.msgimg).split(':');
        var t = list('bb_support_threads').filter(function (x) { return x.id === parts[0]; })[0];
        if (!t) return;
        var ordered = (t.messages || []).slice().sort(function (a, b) { return num(a.time) - num(b.time); });
        var m = ordered[parseInt(parts[1], 10)];
        var src = imgSrc(m && m.image);
        if (!src) return;
        modal('Picture from ' + (nameOf(t.uid) || 'user'),
          '<img src="' + esc(src) + '" alt="Sent picture" ' +
          'style="display:block;width:100%;border-radius:8px;">' +
          (m.body ? '<p style="font-size:13px;color:#9a9a9a;margin:14px 0 0;">' + esc(m.body) + '</p>' : ''),
          function () {});
      });
    });
    $$('[data-sact]').forEach(function (b) {
      b.addEventListener('click', async function () {
        if (b.disabled) return;
        var id = b.dataset.th;
        var act = b.dataset.sact;
        var need = SACT_PERM[act];
        if (need && !can(need)) { denied(need); return; }
        var threads = list('bb_support_threads');
        var t = threads.filter(function (x) { return x.id === id; })[0];
        if (!t) return;
        if (act === 'open') { t.status = 'open'; }
        else if (act === 'resolve') { t.status = 'resolved'; }
        else if (act === 'delete') {
          save('bb_support_threads', threads.filter(function (x) { return x.id !== id; }));
          supportOpen = null;
          render(); buildNav();
          toast('Conversation deleted', 'bad');
          return;
        } else if (act === 'send') {
          var input = $('#amReply');
          var body = String(input.value || '').trim();
          if (!body) return;
          t.messages = t.messages || [];
          t.messages.push({ from: 'admin', uid: A.get(A.KEYS.uid, ''), name: 'Admin', body: body, time: Date.now() });
          t.updated = Date.now();
          b.disabled = true;
          save('bb_support_threads', threads);
          try { await A.flush(); }
          catch (e) { toast('Reply not delivered yet. Use Retry in the connection notice.', 'bad'); }
          render();
          var m = $('#amMsgs');
          if (m) m.scrollTop = m.scrollHeight;
          return;
        }
        t.updated = Date.now();
        save('bb_support_threads', threads);
        render(); buildNav();
        toast(act === 'resolve' ? 'Conversation resolved' : 'Conversation reopened', 'ok');
      });
    });
    var reply = $('#amReply');
    if (reply) reply.addEventListener('keydown', function (e) { if (e.key === 'Enter') $('[data-sact="send"]').click(); });

    /* ---- balances ---- */
    var sel = $('#amBalUser');
    if (sel) {
      var syncCurrent = function () {
        var uid = sel.value;
        var a = accounts().filter(function (x) { return x.uid === uid; })[0];
        var box = $('#amBalCurrent');
        if (box) box.value = a ? money(a.cash) : '$0.00';
      };
      sel.addEventListener('change', syncCurrent);
      syncCurrent();
      var searchBal = $('#amBalSearch');
      if (searchBal) searchBal.addEventListener('input', function () {
        var q = searchBal.value.trim().toLowerCase();
        if (!q) return;
        var hit = accounts().filter(function (a) {
          /* Exact six digit ID wins outright; the rest match loosely. */
          if (shortId(a.uid) === q) return true;
          return shortId(a.uid).indexOf(q) === 0 || a.email.toLowerCase().indexOf(q) === 0 || a.name.toLowerCase().indexOf(q) === 0;
        })[0];
        if (hit) { sel.value = hit.uid; syncCurrent(); }
      });
      var cr = $('#amBalCredit'), db = $('#amBalDebit'), st = $('#amBalSet');
      if (cr) cr.addEventListener('click', function () { doAdjust('credit'); });
      if (db) db.addEventListener('click', function () { doAdjust('debit'); });
      if (st) st.addEventListener('click', function () { doAdjust('set'); });
    }

    /* ---- deposits ---- */
    var depSel = $('#amDepCoin');
    if (depSel) {
      depSel.addEventListener('change', function () { depCoin = depSel.value; render(); });
      var addr = $('#amDepAddr'), net = $('#amDepNet');
      var qr = $('#amDepQr');
      if (!can('consoleSettings')) { addr = null; net = null; }
      $('#amDepSave').addEventListener('click', function () {
        if (!can('consoleSettings')) { denied('consoleSettings'); return; }
        var map = A.readJSON('bb_deposit_addresses', {}) || {};
        map[depCoin] = { address: addr.value.trim(), network: net.value.trim(), qr: map[depCoin] ? map[depCoin].qr : null };
        A.writeJSON('bb_deposit_addresses', map);
        render();
        toast('Saved ' + depCoin + ' deposit address', 'ok');
      });
      $('#amQrGen').addEventListener('click', function () {
        if (!can('consoleSettings')) { denied('consoleSettings'); return; }
        if (!addr) return;
        var a = addr.value.trim();
        if (!a) { toast('Enter a deposit address first', 'bad'); return; }
        // Deterministic block pattern derived from the address, so the same
        // address always renders the same placeholder QR.
        var h = 0;
        for (var i = 0; i < a.length; i++) h = (h * 31 + a.charCodeAt(i)) >>> 0;
        var cells = '';
        for (var y = 0; y < 21; y++) {
          for (var x = 0; x < 21; x++) {
            h = (h * 1664525 + 1013904223) >>> 0;
            var corner = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
            if (corner || (h >>> 8) % 100 < 46) {
              cells += '<rect x="' + x * 5 + '" y="' + y * 5 + '" width="5" height="5" fill="#fff"/>';
            }
          }
        }
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 105 105">' + cells + '</svg>';
        var map = A.readJSON('bb_deposit_addresses', {}) || {};
        map[depCoin] = map[depCoin] || {};
        map[depCoin].qr = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
        A.writeJSON('bb_deposit_addresses', map);
        render();
        toast('QR generated for ' + depCoin, 'ok');
      });
      var del = $('#amQrDel');
      if (del) del.addEventListener('click', function () {
        if (!can('consoleSettings')) { denied('consoleSettings'); return; }
        var map = A.readJSON('bb_deposit_addresses', {}) || {};
        if (map[depCoin]) map[depCoin].qr = null;
        A.writeJSON('bb_deposit_addresses', map);
        render();
        toast('QR removed', 'ok');
      });
      var up = $('#amQrUpload');
      if (up) {
        var picker = document.createElement('input');
        picker.type = 'file';
        picker.accept = 'image/*';
        up.addEventListener('click', function () {
          if (!can('consoleSettings')) { denied('consoleSettings'); return; }
          picker.click();
        });
        picker.addEventListener('change', function () {
          var f = picker.files && picker.files[0];
          if (!f) return;
          var reader = new FileReader();
          reader.onload = function () {
            var map = A.readJSON('bb_deposit_addresses', {}) || {};
            map[depCoin] = map[depCoin] || {};
            map[depCoin].qr = reader.result;
            A.writeJSON('bb_deposit_addresses', map);
            render();
            toast('QR image uploaded', 'ok');
          };
          reader.readAsDataURL(f);
        });
      }
    }

    /* ---- settings ---- */
    var ex = $('#amExport');
    if (ex) ex.addEventListener('click', function () {
      var dump = {};
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k.indexOf('bb_') !== 0) continue;
        try { dump[k] = JSON.parse(localStorage.getItem(k)); } catch (e) { dump[k] = localStorage.getItem(k); }
      }
      var blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'bitbase-store-' + new Date().toISOString().slice(0, 10) + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      toast('Exported ' + Object.keys(dump).length + ' keys', 'ok');
    });
    /* ---- admin access password ---- */
    var ap = $('#amApSave');
    if (ap) {
      ap.addEventListener('click', function () {
        if (!can('consoleSettings')) { denied('consoleSettings'); return; }
        var msg = $('#amApMsg');
        function fail(t) { msg.className = 'am-err'; msg.textContent = t; }
        var next = $('#amApNew').value;
        if (next.length < 6) return fail('New admin password must be at least 6 characters');
        A.changeAdminPassword($('#amApCur').value, next).then(function () {
          msg.className = 'am-ok';
          msg.textContent = 'Admin password updated';
          $('#amApCur').value = $('#amApNew').value = '';
        }).catch(function (e) { fail(e.message || 'Could not update the admin password'); });
      });
    }

    var wd = $('#amWipeDemo');
    if (wd) wd.addEventListener('click', function () {
      if (!can('consoleSettings')) { denied('consoleSettings'); return; }
      A.writeJSON('bb_demo_trades_bal', 100000);
      A.writeJSON('bb_demo_trades_pos', []);
      A.writeJSON('bb_demo_trades_hist', []);
      A.del('bb_demo_trade_id_counter');
      toast('Demo data reset', 'ok');
    });

    /* ---- admin team: per-action permission switches ---- */
    $$('[data-perm-toggle]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        if (!owner()) { toast('Only the console owner can change permissions', 'bad'); return; }
        var uid = b.dataset.permToggle;
        var key = b.dataset.perm;
        var next = {};
        (A.PERM_KEYS || []).forEach(function (k) { next[k] = false; });
        var cur = A.adminPerms(uid) || {};
        (A.PERM_KEYS || []).forEach(function (k) { next[k] = cur[k] === true; });
        next[key] = !next[key];
        if (!A.setAdminPerms(uid, next)) { toast('Could not save those permissions', 'bad'); return; }
        render();
        var p = (A.PERMISSIONS || []).filter(function (x) { return x.key === key; })[0];
        toast((next[key] ? 'Allowed: ' : 'Blocked: ') + (p ? p.label : key), next[key] ? 'ok' : 'bad');
      });
    });
    $$('[data-revoke]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.preventDefault();
        var uid = b.dataset.revoke;
        if (!owner()) { toast('Only the first admin can change admin access', 'bad'); return; }
        if (!A.setAdmin(uid, false)) { toast('Could not remove that admin', 'bad'); return; }
        render(); buildNav();
        toast(shortId(uid) + ' is no longer an admin', 'bad');
      });
    });
  }

  /* ---------------------------------------------------------------- boot */
  /* On a phone the sidebar is a drawer: these three close it again. The burger
     and the scrim are inert above the breakpoint because the drawer CSS only
     exists there, but they stay wired so resizing across it never strands the
     menu open. */
  function setNav(open) {
    document.body.classList.toggle('am-nav-open', open);
    var burger = $('#amBurger');
    if (burger) burger.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  function wireDrawer() {
    var burger = $('#amBurger');
    if (!burger) return;
    burger.addEventListener('click', function () {
      setNav(!document.body.classList.contains('am-nav-open'));
    });
    var scrim = $('#amScrim');
    if (scrim) scrim.addEventListener('click', function () { setNav(false); });
    var close = $('#amSideClose');
    if (close) close.addEventListener('click', function () { setNav(false); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setNav(false);
    });
    global.addEventListener('resize', function () {
      if (global.innerWidth > 860) setNav(false);
    });
  }

  /* An account flagged admin opens the console with no prompt. Everyone else
     is asked for the admin password, and the right answer promotes them. */
  function enter() {
    $('#amApp').style.display = '';
    $('#amGate').style.display = 'none';
    wireDrawer();
    $('#amLogout').addEventListener('click', function (e) {
      e.preventDefault();
      A.logout().then(function () { global.location.href = 'login.html'; }).catch(function (e) { if (global.BitbaseDB) global.BitbaseDB.warn(e); });
    });
    $('#amModalClose').addEventListener('click', closeModal);
    $('#amModal').addEventListener('click', function (e) { if (e.target === $('#amModal')) closeModal(); });

    // Delegated so it survives buildNav() replacing the sidebar markup.
    $('#amNav').addEventListener('click', function (e) {
      var a = e.target.closest('a[data-view]');
      if (!a) return;
      e.preventDefault();
      current = a.dataset.view;
      supportOpen = null;
      setNav(false);
      render();
      buildNav();
    });

    global.addEventListener('bitbase:session', function (e) { if (!e.detail.signedIn) global.location.replace('login.html'); });

    // Prime crypto prices so Total Assets and Analytics are not blank.
    F.loadMarkets().then(function (rows) { primePrices(rows); render(); }).catch(function () { render(); });
    // Open the shared feed once, and repaint the live numbers on a timer.
    F.openTickerStream(function () {}, function () {});
    setInterval(function () {
      F.loadMarkets().then(function (rows) { primePrices(rows); paintLive(); }).catch(function () {});
    }, 45000);

    // Refresh all admin queues when Supabase changes, preserving draft inputs.
    function paintLive() {
      buildNav();
      var draft = [];
      $$('#amView input[id], #amView textarea[id], #amView select[id]').forEach(function (el) {
        draft.push({ id:el.id, value:el.value, checked:el.checked, focus:document.activeElement===el,
          start:el.selectionStart, end:el.selectionEnd });
      });
      render();
      draft.forEach(function (d) {
        var el = document.getElementById(d.id); if (!el) return;
        el.value=d.value; if (typeof d.checked==='boolean') el.checked=d.checked;
        if (d.focus) {
          el.focus();
          if (el.setSelectionRange && typeof d.start==='number') el.setSelectionRange(d.start,d.end);
        }
      });
      var messages=$('#amMsgs'); if (messages) messages.scrollTop=messages.scrollHeight;
    }
    global.addEventListener('bitbase:data', paintLive);
    global.addEventListener('bitbase:connection', paintLive);
    if (!A.isRemote()) setInterval(paintLive, 2000);

    buildNav();
    render();
  }

  function boot() {
    if (!A || !A.isAuthenticated()) { global.location.replace('login.html'); return; }

    if (!A.isAdmin()) {
      if (A.isRemote()) {
        showGate();
        $('#amGate p').textContent = 'This account has no admin access. Ask the project owner to grant access to your account.';
        $('#amGatePw').style.display = 'none';
        $('#amGateGo').style.display = 'none';
        return;
      }
      wireGate();
      showGate();
      if (global.lucide) global.lucide.createIcons();
      return;
    }
    enter();
  }
// Nothing renders until the database mirror is filled, so the first
  // paint is already the user's own data rather than a blank frame.
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', function () { A.whenReady(boot); });
  else A.whenReady(boot);
})(window);
