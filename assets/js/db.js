/* ==========================================================================
   Bitbase – Supabase data layer

   The app was written against a synchronous browser store: pages call
   A.get / A.set / A.writeJSON and expect the value back immediately. Rewriting
   twelve pages to await every read would be a large and pointless change, so
   this layer keeps that API and makes it honest:

     - The mirror. Everything lives in memory (`BB.mirror`) under the same
       bb_* keys the app already uses. Reads hit the mirror and stay
       synchronous.
     - Boot. `BB.ready` loads the signed-in user's rows from Postgres into the
       mirror before any page renders, so the first paint is already correct.
     - Writes. set/writeJSON update the mirror immediately and queue the same
       change for the database. The UI never waits on the network.

   Every collection the app stores is mapped to a table here. Admin rows live in
   one envelope table (`request_rows`) keyed by `kind`, which is why a new
   feature only needs a line in MAP, not a migration.

   With no Supabase configured, or the network down, this degrades to the
   previous localStorage behaviour rather than breaking the page.
   ========================================================================== */
(function (global) {
  'use strict';

  var CFG = global.BITBASE_CONFIG || {};
  var SDK = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';

  var mirror = {};            // bb_* key -> value
  var pending = {};           // bb_* key -> debounce timer
  var client = null;
  var session = null;
  var profile = null;         // the signed-in profiles row
  var status = 'booting';     // booting | ready | local | error
  var lastError = null;
  var waiters = [];
  var saved = {};             // server ids per key, so writes stay idempotent
  var inflight = 0;

  /* ---------------------------------------------------------------- mapping
     table      - target table
     kind       - request_rows discriminator (list collections)
     key        - app_settings / user_settings discriminator
     list       - the mirror holds an array of rows
     global     - not user scoped (admin console settings, deposit addresses)
     admin      - only an admin may write it
  */
  var MAP = {
    bb_deposit_requests:      { table: 'request_rows', kind: 'deposit',        list: true },
    bb_withdrawal_requests:   { table: 'request_rows', kind: 'withdrawal',     list: true },
    bb_borrow_requests:       { table: 'request_rows', kind: 'borrow',         list: true },
    bb_kyc_requests:          { table: 'request_rows', kind: 'kyc',            list: true },
    bb_transfer_requests:     { table: 'request_rows', kind: 'transfer',       list: true },
    bb_convert_requests:      { table: 'request_rows', kind: 'convert',        list: true },
    bb_trade_requests:        { table: 'request_rows', kind: 'trade_request',  list: true },
    bb_activity:              { table: 'request_rows', kind: 'activity',       list: true },
    bb_trades_history:        { table: 'request_rows', kind: 'trade',          list: true },
    bb_trade_positions:       { table: 'request_rows', kind: 'position',       list: true },
    bb_admin_adjustments:     { table: 'request_rows', kind: 'adjustment',     list: true },
    bb_login_log:             { table: 'request_rows', kind: 'login',          list: true },
    bb_notifications:         { table: 'request_rows', kind: 'notification',   list: true },

    bb_support_threads:       { table: 'support_threads', list: true, admin: true },

    bb_preferences:           { table: 'user_settings', key: 'preferences' },
    bb_notification_prefs:    { table: 'user_settings', key: 'notification_prefs' },
    bb_assets_hide_zero:      { table: 'user_settings', key: 'assets_hide_zero' },
    bb_demo_trades_bal:       { table: 'user_settings', key: 'demo_trades_bal' },
    bb_demo_trade_id_counter: { table: 'user_settings', key: 'demo_trade_id_counter' },
    bb_trade_id_counter:      { table: 'user_settings', key: 'trade_id_counter' },

    bb_deposit_addresses:     { table: 'app_settings', key: 'deposit_addresses', global: true },
    bb_admin_password:        { table: 'app_settings', key: 'admin_password', global: true, admin: true },

    // These live on the profile row itself.
    bb_cash_balance:          { profile: 'cash' },
    bb_funding_balance:       { profile: 'funding' },
    bb_asset_balances:        { profile: 'assets' },
    bb_kyc_status:            { profile: 'kyc_status' }
  };

  var KINDS = [];
  Object.keys(MAP).forEach(function (k) { if (MAP[k].kind) KINDS.push(MAP[k].kind); });

  /* ------------------------------------------------------------- utilities */
  function uid() { return session && session.user ? session.user.id : ''; }
  function isOn() { return !!(client && session); }

  function clone(v) {
    if (v === null || typeof v !== 'object') return v;
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
  }

  function ok(res) {
    if (res && res.error) { fail(res.error); return null; }
    return res;
  }
  function fail(err) {
    lastError = (err && (err.message || err)) || 'Database error';
    if (global.console && console.warn) console.warn('[bitbase-db]', lastError);
    // Keep a copy so a failed sign-in can report something useful.
    throw err;
  }

  /* RLS refuses writes from an admin acting on someone else's behalf only if
     the policy says so; surfacing it here means the UI can tell the difference
     between "not allowed" and "offline". */
  function canWrite(spec) {
    if (!spec || !spec.admin) return true;
    return !!(profile && profile.admin);
  }

  /* ------------------------------------------------------------------ auth */
  function loadSdk() {
    if (global.supabase && global.supabase.createClient) return Promise.resolve();
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = SDK;
      s.onload = function () { global.supabase ? res() : rej(new Error('supabase-js did not load')); };
      s.onerror = function () { rej(new Error('Could not reach the Supabase CDN')); };
      document.head.appendChild(s);
    });
  }

  /* Supabase's client appends /rest/v1 and /auth/v1 itself. Pasting the REST
     path out of the dashboard instead of the project URL is the single easiest
     mistake to make here, and it fails silently - every request 404s and the
     site quietly carries on with no database. So strip it. */
  function normaliseUrl(raw) {
    var u = String(raw || '').trim();
    u = u.replace(/\/+$/, '');
    u = u.replace(/\/rest\/v1$/i, '');
    u = u.replace(/\/auth\/v1$/i, '');
    return u;
  }

  function connect() {
    var url = normaliseUrl(CFG.supabaseUrl);
    if (!url || url.indexOf('YOUR-PROJECT') > -1) {
      return Promise.reject(new Error('supabaseUrl is not set in supabase-config.js'));
    }
    if (!CFG.supabaseAnonKey || String(CFG.supabaseAnonKey).indexOf('YOUR-ANON') > -1) {
      return Promise.reject(new Error('supabaseAnonKey is not set in supabase-config.js'));
    }
    if (CFG.useSupabase === false) return Promise.reject(new Error('Supabase disabled in config'));
    return loadSdk().then(function () {
      client = global.supabase.createClient(url, CFG.supabaseAnonKey);
      // Prove the project is actually reachable before the app trusts it.
      return fetch(url + '/auth/v1/settings', { headers: { apikey: CFG.supabaseAnonKey } })
        .then(function (r) {
          if (!r.ok) throw new Error('Supabase answered ' + r.status + ' for ' + url);
          return client.auth.getSession();
        });
    });
  }

  function onSession(next) {
    session = next && next.session ? next.session : null;
    if (!session) { profile = null; }
  }

  /* ------------------------------------------------------------- hydration */
  /* Pull this user's whole world into the mirror. Four queries: one per table
     family, regardless of how many collections are mapped. */
  function hydrate() {
    if (!isOn()) { status = 'local'; return Promise.resolve(); }
    var jobs = [];

    jobs.push(
      ok(client.from('profiles').select('*').eq('id', uid()).limit(1)).then(function (r) {
        profile = (r.data && r.data[0]) || null;
        if (profile) {
          mirror.bb_uid = profile.id;
          mirror.bb_name = profile.name || '';
          mirror.bb_email = profile.email || '';
          mirror.bb_registered_at = profile.created;
          mirror.bb_cash_balance = Number(profile.cash || 0);
          mirror.bb_funding_balance = Number(profile.funding || 0);
          mirror.bb_asset_balances = profile.assets || {};
          mirror.bb_kyc_status = profile.kyc_status || 'none';
        }
      })
    );

    // One query for every mapped collection in request_rows.
    jobs.push(
      ok(client.from('request_rows').select('*').in('kind', KINDS).order('created', { ascending: false }).limit(2000))
        .then(function (r) {
          var rows = (r.data || []);
          KINDS.forEach(function (kind) {
            var mine = rows.filter(function (x) { return x.kind === kind; });
            var key = keyForKind(kind);
            if (!key) return;
            saved[key] = {};
            mirror[key] = mine.map(function (row) {
              saved[key][row.id] = true;
              return unrow(row);
            });
          });
        })
    );

    jobs.push(
      ok(client.from('support_threads').select('*').order('updated', { ascending: false }).limit(300))
        .then(function (r) { return { threads: r.data || [] }; })
        .then(function (res) {
          var threads = res.threads;
          if (!threads.length) return { threads: threads, msgs: [] };
          return ok(client.from('support_messages').select('*').in('thread_id', threads.map(function (t) { return t.id; }))
            .order('created', { ascending: true }).limit(3000))
            .then(function (m) { return { threads: threads, msgs: (m && m.data) || [] }; });
        })
        .then(function (res) {
          saved.bb_support_threads = {};
          mirror.bb_support_threads = res.threads.map(function (t) {
            saved.bb_support_threads[t.id] = true;
            return {
              _sid: t.id, id: 'SUP-' + t.id.slice(0, 8),
              uid: t.user_id || '', name: t.name, email: t.email,
              subject: t.subject, status: t.status,
              created: new Date(t.created).getTime(),
              updated: new Date(t.updated).getTime(),
              messages: res.msgs.filter(function (m) { return m.thread_id === t.id; }).map(unmsg)
            };
          });
        })
    );

    jobs.push(
      ok(client.from('user_settings').select('*').eq('user_id', uid()).limit(200))
        .then(function (r) {
          (r.data || []).forEach(function (row) {
            var key = keyForSetting(row.key);
            if (key) mirror[key] = row.value;
          });
        })
    );

    jobs.push(
      ok(client.from('app_settings').select('*').in('key', ['deposit_addresses', 'admin_password']))
        .then(function (r) {
          (r.data || []).forEach(function (row) {
            var key = row.key === 'admin_password' ? 'bb_admin_password' : 'bb_deposit_addresses';
            mirror[key] = row.value;
          });
        })
    );

    return Promise.all(jobs).then(function () { status = 'ready'; });
  }

  function unrow(row) {
    var data = clone(row.data) || {};
    data._sid = row.id;
    if (data.userId === undefined) data.userId = row.user_id || '';
    if (data.status === undefined) data.status = row.status;
    return data;
  }
  function unmsg(m) {
    return { _mid: m.id, from: m.sender, body: m.body, image: m.image, time: new Date(m.created).getTime() };
  }

  function keyForKind(kind) {
    var found = null;
    Object.keys(MAP).forEach(function (k) { if (MAP[k].kind === kind) found = k; });
    return found;
  }
  function keyForSetting(name) {
    var found = null;
    Object.keys(MAP).forEach(function (k) {
      if (MAP[k].table === 'user_settings' && MAP[k].key === name) found = k;
    });
    return found;
  }

  /* ---------------------------------------------------------------- writes */
  /* set() is synchronous and optimistic; this is the part that catches up. */
  function persist(key) {
    var spec = MAP[key];
    if (!spec || !isOn() || !profile) return Promise.resolve(false);
    if (spec.admin && !profile.admin) return Promise.resolve(false);
    if (inflight > 6) return Promise.resolve(false);      // stop a runaway queue

    if (spec.profile) return writeProfile(key, spec, mirror[key]);
    if (spec.table === 'request_rows') return writeRows(key, spec, mirror[key]);
    if (spec.table === 'user_settings') return writeSetting(key, spec, mirror[key]);
    if (spec.table === 'app_settings') return writeAppSetting(key, spec, mirror[key]);
    if (spec.table === 'support_threads') return writeThreads(key, mirror[key]);
    return Promise.resolve(false);
  }

  function writeProfile(key, spec, value) {
    var patch = {};
    patch[spec.profile] = (spec.profile === 'assets')
      ? (value || {})
      : (spec.profile === 'kyc_status' ? String(value || 'none') : Number(value || 0));
    inflight++;
    return client.from('profiles').update(patch).eq('id', uid())
      .then(function (r) { inflight--; return ok(r); })
      .catch(function (e) { inflight--; return fail(e); });
  }

  /* Diff against what the server already has: insert the new, update the
     changed, delete what the app removed. _sid is what makes it idempotent. */
  function writeRows(key, spec, rows) {
    rows = Array.isArray(rows) ? rows : [];
    inflight++;
    return ok(client.from('request_rows').select('id').eq('kind', spec.kind))
      .then(function (r) {
        var server = {};
        (r.data || []).forEach(function (row) { server[row.id] = true; });
        var known = saved[key] || {};
        var mine = {};
        var ops = [];
        rows.forEach(function (row) {
          var clean = clone(row);
          var sid = clean._sid;
          delete clean._sid;
          if (sid && server[sid]) {
            mine[sid] = true;
            ops.push(client.from('request_rows').update({
              data: clean, status: clean.status || 'pending',
              amount: numv(clean.amount), ref: clean.id || null
            }).eq('id', sid));
          } else {
            ops.push(client.from('request_rows').insert({
              kind: spec.kind, user_id: uid(), data: clean,
              status: clean.status || 'pending', amount: numv(clean.amount),
              ref: clean.id || null
            }).select('id').single().then(function (res) {
              var id = res && res.data ? res.data.id : null;
              if (id) { clean._sid = id; mine[id] = true; row._sid = id; }
              return res;
            }));
          }
        });
        Object.keys(server).forEach(function (id) {
          if (!mine[id] && !known[id]) ops.push(client.from('request_rows').delete().eq('id', id));
        });
        return Promise.all(ops.map(function (p) { return p.then(ok, function (e) { return fail(e); }); }));
      })
      .then(function () { inflight--; saved[key] = {}; })
      .catch(function (e) { inflight--; return fail(e); });
  }

  function writeSetting(key, spec, value) {
    if (value === undefined || value === null) {
      inflight++;
      return client.from('user_settings').delete().eq('user_id', uid()).eq('key', spec.key)
        .then(function (r) { inflight--; return ok(r); })
        .catch(function (e) { inflight--; return fail(e); });
    }
    inflight++;
    return ok(client.from('user_settings').upsert(
      { user_id: uid(), key: spec.key, value: value }, { onConflict: 'user_id,key' }))
      .then(function (r) { inflight--; return r; })
      .catch(function (e) { inflight--; return fail(e); });
  }

  function writeAppSetting(key, spec, value) {
    if (value === undefined || value === null) {
      inflight++;
      return client.from('app_settings').delete().eq('key', spec.key)
        .then(function (r) { inflight--; return ok(r); })
        .catch(function (e) { inflight--; return fail(e); });
    }
    inflight++;
    return ok(client.from('app_settings').upsert(
      { key: spec.key, value: value }, { onConflict: 'key' }))
      .then(function (r) { inflight--; return r; })
      .catch(function (e) { inflight--; return fail(e); });
  }

  function writeThreads(key, threads) {
    threads = Array.isArray(threads) ? threads : [];
    inflight++;
    return ok(client.from('support_threads').select('id, updated').limit(500))
      .then(function (r) {
        var server = {};
        (r.data || []).forEach(function (row) { server[row.id] = true; });
        var mine = {};
        var ops = [];
        var follow = [];
        threads.forEach(function (t) {
          var clean = {
            user_id: uid(), name: t.name || '', email: t.email || '',
            subject: t.subject || 'Chat enquiry', status: t.status || 'open'
          };
          if (t._sid && server[t._sid]) {
            mine[t._sid] = true;
            ops.push(client.from('support_threads').update(clean).eq('id', t._sid).then(function (res) {
              follow.push(t._sid);
              return res;
            }));
          } else {
            ops.push(client.from('support_threads').insert(clean).select('id').single().then(function (res) {
              if (res && res.data) { t._sid = res.data.id; mine[res.data.id] = true; follow.push(res.data.id); }
              return res;
            }));
          }
        });
        Object.keys(server).forEach(function (id) { if (!mine[id]) ops.push(client.from('support_threads').delete().eq('id', id)); });
        return Promise.all(ops).then(function () { return follow; });
      })
      .then(function (ids) { return writeMessages(threads, ids || []); })
      .then(function () { inflight--; })
      .catch(function (e) { inflight--; return fail(e); });
  }

  /* Messages are append-only: anything the app holds that the server has not
     seen (_mid missing) is new. Deletions are handled by deleting the thread,
     which cascades. */
  function writeMessages(threads, ids) {
    if (!ids.length) return Promise.resolve();
    return ok(client.from('support_messages').select('id, thread_id').in('thread_id', ids).limit(3000))
      .then(function (r) {
        var server = {};
        (r.data || []).forEach(function (m) { server[m.id] = true; });
        var rows = [];
        threads.forEach(function (t, i) {
          var tid = ids.indexOf(t._sid) > -1 ? t._sid : ids[i];
          if (!tid) return;
          (t.messages || []).forEach(function (m) {
            if (m._mid && server[m._mid]) return;
            rows.push({
              thread_id: tid, sender: m.from === 'admin' ? 'admin' : 'user',
              body: String(m.body || ''), image: m.image || null,
              meta: { name: m.name || '' }
            });
          });
        });
        if (!rows.length) return null;
        return client.from('support_messages').insert(rows).then(function (res) {
          (res.data || []).forEach(function (savedRow) { server[savedRow.id] = true; });
          return res;
        });
      }).then(ok);
  }

  /* Belt and braces for the profile row. The schema has an AFTER INSERT trigger on
     auth.users that creates it, which is the right place for it - but if that
     trigger was never created, or an older account predates it, the user is
     signed in with no profile and every page reads as empty. A user may insert
     and edit only their own row, so this cannot touch anybody else, and the
     role columns are left to the trigger and to the admin console. */
  function randomCode() {
    var n = Math.floor(Math.random() * 900000) + 100000;
    return String(n);
  }

  function ensureProfile(meta) {
    if (!isOn() || !session || !session.user) return Promise.resolve(null);
    var user = session.user;
    var metaIn = user.user_metadata || {};
    var wanted = {
      name: (meta && meta.name) || metaIn.name || '',
      country: (meta && meta.country) || metaIn.country || 'other'
    };
    return client.from('profiles').select('*').eq('id', uid()).limit(1).maybeSingle()
      .then(function (r) {
        if (r && r.data) {
          profile = r.data;
          mirrorAccounts();
          return profile;
        }
        // RLS allows this: a row with your own id, and no role columns set.
        return ok(client.from('profiles').insert({
          id: uid(), code: randomCode(),
          email: user.email || '', name: wanted.name, country: wanted.country
        }).select('*').single())
          .then(function (made) {
            if (made && made.data) { profile = made.data; mirrorAccounts(); }
            return profile;
          });
      })
      .catch(function (e) {
        if (global.console && console.warn) console.warn('[bitbase-db] ensureProfile:', e && e.message);
        return null;
      });
  }

  /* ------------------------------------------------------------- accounts */
  /* The profile row is the account. Admin edits go through here so RLS and the
     role guard in the schema decide what is allowed, not the browser. */
  function saveProfile(patch) {
    return saveProfileFor(profile ? profile.id : '', patch);
  }

  /* An admin editing somebody else's account needs to name the row explicitly;
     RLS and the trigger guard in the schema decide whether it is allowed. */
  function saveProfileFor(id, patch) {
    if (!isOn() || !id) return Promise.resolve(false);
    inflight++;
    return ok(client.from('profiles').update(patch).eq('id', id).select('*').maybeSingle())
      .then(function (r) {
        inflight--;
        if (r && r.data && profile && r.data.id === profile.id) { profile = r.data; mirrorAccounts(); }
        else if (r && r.data) {
          var map = mirror.bb_accounts || {};
          map[r.data.id] = toAccount(r.data);
          mirror.bb_accounts = map;
        }
        return r;
      })
      .catch(function (e) { inflight--; return fail(e); });
  }

  /* Removing an account here drops its profile, and every table cascades from
     it - ledgers, threads, settings. The row in auth.users has to be deleted
     from the Supabase dashboard (or an Edge Function holding the service key);
     the anon key cannot do it, by design. */
  function deleteAccountFor(id) {
    if (!isOn() || !id) return Promise.reject({ message: 'Not signed in to the database' });
    return ok(client.from('profiles').delete().eq('id', id))
      .then(function () {
        var map = mirror.bb_accounts || {};
        delete map[id];
        mirror.bb_accounts = map;
        return true;
      })
      .catch(function (e) { return Promise.reject({ message: (e && e.message) || 'Could not delete' }); });
  }

  /* Called after sign-up or sign-in: the session changed, so the mirror has to
     be rebuilt from the new user before any page reads it. */
  function refreshSession() {
    if (!client) return Promise.resolve(null);
    return client.auth.getSession().then(function (res) {
      onSession(res);
      return ensureProfile().then(function () { return hydrate(); });
    });
  }

  /* Pull the account map the console renders from. An admin needs every user,
     an ordinary user only themselves - RLS decides, we just ask. */
  function loadAccounts() {
    if (!isOn()) return Promise.resolve(mirror.bb_accounts || {});
    return ok(client.from('profiles').select('*').order('created', { ascending: false }).limit(1000))
      .then(function (r) {
        var map = {};
        (r.data || []).forEach(function (row) { map[row.id] = toAccount(row); });
        if (profile) map[profile.id] = toAccount(profile);
        mirror.bb_accounts = map;
        // Snapshot of what the server already has, so the first save after boot
        // only pushes rows that genuinely changed.
        var snap = {};
        Object.keys(map).forEach(function (id) { snap[id] = clone(map[id]); });
        mirror['bb_accounts:snapshot'] = snap;
        return map;
      })
      .catch(function () { return mirror.bb_accounts || {}; });
  }

  /* admin-page.js still expects the app's own account shape. */
  function toAccount(row) {
    return {
      uid: row.id,
      code: row.code,
      name: row.name || '',
      email: row.email || '',
      country: row.country || 'other',
      created: row.created ? new Date(row.created).getTime() : 0,
      loginAt: row.login_at ? new Date(row.login_at).getTime() : 0,
      cash: Number(row.cash || 0),
      funding: Number(row.funding || 0),
      assets: row.assets || {},
      kyc_status: row.kyc_status || 'none',
      phone: row.phone || '',
      phone_verified: !!row.phone_verified,
      profitMode: !!row.profit_mode,
      disabled: !!row.disabled,
      admin: row.admin === true,
      owner: row.is_owner === true,
      perms: row.perms || {},
      salt: null
    };
  }

  function mirrorAccounts() {
    var map = mirror.bb_accounts || {};
    if (profile) map[profile.id] = toAccount(profile);
    mirror.bb_accounts = map;
  }

  function audit(action, target, detail) {
    if (!isOn() || !profile || !profile.admin) return Promise.resolve(false);
    return client.from('admin_log').insert({
      actor: uid(), actor_name: profile.name || '', action: action,
      target: target || null, detail: detail || {}
    }).then(ok);
  }

  function numv(v) { var n = parseFloat(v); return isFinite(n) ? n : null; }

  /* ----------------------------------------------------------------- boot */
  /* A silent fallback is the worst outcome: the site looks fine and nothing is
     being saved. So when a database was configured but is not answering, say so
     on the page instead of in the console only. */
  function warnBanner(text) {
    if (!document.body) return;
    if (document.getElementById('bbDbWarn')) return;
    var el = document.createElement('div');
    el.id = 'bbDbWarn';
    el.setAttribute('role', 'alert');
    el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99999;' +
      'display:flex;gap:10px;align-items:center;justify-content:space-between;' +
      'padding:11px 14px;background:#3a1416;border-top:1px solid #7a2b31;' +
      'color:#ffd9d9;font:12.5px/1.5 Inter,system-ui,sans-serif';
    var msg = document.createElement('span');
    msg.textContent = text;
    var close = document.createElement('button');
    close.textContent = 'Dismiss';
    close.style.cssText = 'background:none;border:1px solid #7a2b31;color:#ffd9d9;' +
      'border-radius:6px;padding:5px 10px;cursor:pointer;font:inherit';
    close.addEventListener('click', function () { el.remove(); });
    el.appendChild(msg);
    el.appendChild(close);
    document.body.appendChild(el);
  }

  var ready = connect()
    .then(function (res) { onSession(res); return ensureProfile(); })
    .then(function () { return hydrate(); })
    .then(function () {
      status = 'ready';
      return null;
    })
    .catch(function (err) {
      lastError = (err && err.message) || String(err);
      // No client at all means "not configured" - that is a deliberate mode and
      // stays quiet. A client that exists but cannot reach the project is a
      // misconfiguration and gets said out loud.
      status = client ? 'error' : 'local';
      if (client) {
        if (global.console && console.warn) console.warn('[bitbase-db]', lastError);
        warnBanner('Database not connected - nothing you do here will be saved. ' + lastError);
      }
      return null;
    })
    .then(function () {
      // Keep the session live across tabs and refreshes.
      if (client) client.auth.onAuthStateChange(function (next) { onSession(next); });
      return null;
    });

  /* --------------------------------------------------------------- exports */
  global.BitbaseDB = {
    MAP: MAP,
    status: function () { return status; },
    error: function () { return lastError; },
    isOn: isOn,
    uid: uid,
    profile: function () { return profile; },
    mirror: mirror,
    ready: ready,
    hydrate: hydrate,
    loadAccounts: loadAccounts,
    saveProfile: saveProfile,
    saveProfileFor: saveProfileFor,
    deleteAccountFor: deleteAccountFor,
    refreshSession: refreshSession,
    ensureProfile: ensureProfile,
    audit: audit,
    toAccount: toAccount,
    /* Queue a key for the database. Debounced so a screen that saves five rows
       in a row sends one batch, and failures are retried on the next save. */
    persist: function (key) {
      var spec = MAP[key];
      if (!spec || !isOn() || !profile) return;
      if (spec.admin && !profile.admin) return;
      if (pending[key]) clearTimeout(pending[key]);
      pending[key] = setTimeout(function () {
        delete pending[key];
        persist(key).catch(function () { /* reported through BB.error */ });
      }, 220);
    },
    /* Force everything pending out now - used on unload and after login. */
    flush: function () {
      Object.keys(pending).forEach(function (key) {
        clearTimeout(pending[key]);
        delete pending[key];
      });
      return ready;
    },
    client: function () { return client; }
  };
})(window);