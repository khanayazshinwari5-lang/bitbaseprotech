/* Bitbase database bridge. Supabase is authoritative unless useSupabase=false.
   Reads use a typed mirror; writes are acknowledged, serialized and retryable.
   RLS remains the authority for every read, write and realtime notification. */
(function (global) {
  'use strict';
  var CFG = global.BITBASE_CONFIG || {};
  var configured = CFG.useSupabase !== false;
  var mirror = {}, snapshots = {}, versions = {}, dirty = {}, timers = {}, running = {};
  var attachmentCache = {};
  var client = null, session = null, profile = null, status = 'booting';
  var lastError = null, profileError = null, generation = 0, mutation = 0;
  var external = new Set(), channel = null, channelUid = '', live = false;
  var refreshJob = null, refreshTimer = null, authTimer = null;
  var sessionJob = null, profileVersions = {}, lastRefresh = 0;
  var page = String((global.location || {}).pathname || '').split('/').pop().replace('.html','');
  // Only the console needs everybody's profiles and every collection.
  var SCOPES = {
    dashboard: ['trade','position','deposit','withdrawal'],
    assets: ['trade','position','deposit','withdrawal','borrow','transfer','convert','notification'],
    markets: [], index: [], login: [], register: [], trade: ['position','trade'], demo: [], settings: ['kyc'],
    history: ['trade','deposit','withdrawal','borrow','transfer','convert','adjustment']
  };
  var kinds = SCOPES[page];
  var fullRead = kinds === undefined;
  var needsChat = fullRead || page === 'assets';
  var needsSettings = fullRead || ['assets','settings','demo','history'].indexOf(page) !== -1;
  var needsAppSettings = fullRead || page === 'assets';
  /* A request that carries an uploaded picture is answered by a fresh read, and
     a cold connection on a phone is not fast. The old 15s ceiling aborted
     perfectly healthy reads and turned them into an error banner. */
  var READ_TIMEOUT_MS = 45000;
  var MAP = {
    bb_accounts: { accounts: true },
    bb_deposit_requests: { table: 'request_rows', kind: 'deposit', list: true },
    bb_withdrawal_requests: { table: 'request_rows', kind: 'withdrawal', list: true },
    bb_borrow_requests: { table: 'request_rows', kind: 'borrow', list: true },
    bb_kyc_requests: { table: 'request_rows', kind: 'kyc', list: true },
    bb_transfer_requests: { table: 'request_rows', kind: 'transfer', list: true },
    bb_convert_requests: { table: 'request_rows', kind: 'convert', list: true },
    bb_trade_requests: { table: 'request_rows', kind: 'trade_request', list: true },
    bb_activity: { table: 'request_rows', kind: 'activity', list: true },
    bb_trades_history: { table: 'request_rows', kind: 'trade', list: true },
    bb_trade_positions: { table: 'request_rows', kind: 'position', list: true },
    bb_admin_adjustments: { table: 'request_rows', kind: 'adjustment', list: true },
    bb_login_log: { table: 'request_rows', kind: 'login', list: true },
    bb_notifications: { table: 'request_rows', kind: 'notification', list: true },
    bb_support_threads: { table: 'support_threads', list: true },
    bb_preferences: { table: 'user_settings', key: 'preferences' },
    bb_notification_prefs: { table: 'user_settings', key: 'notification_prefs' },
    bb_assets_hide_zero: { table: 'user_settings', key: 'assets_hide_zero' },
    bb_demo_trades_bal: { table: 'user_settings', key: 'demo_trades_bal' },
    bb_demo_trades_pos: { table: 'user_settings', key: 'demo_trades_pos' },
    bb_demo_trades_hist: { table: 'user_settings', key: 'demo_trades_hist' },
    bb_demo_trade_id_counter: { table: 'user_settings', key: 'demo_trade_id_counter' },
    bb_trade_id_counter: { table: 'user_settings', key: 'trade_id_counter' },
    bb_deposit_addresses: { table: 'app_settings', key: 'deposit_addresses', admin: true },
    bb_admin_password: { table: 'app_settings', key: 'admin_password', admin: true },
    bb_cash_balance: { profile: 'cash' },
    bb_funding_balance: { profile: 'funding' },
    bb_asset_balances: { profile: 'assets' },
    bb_kyc_status: { profile: 'kyc_status' }
  };
  var clone = function (v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); };
  var equal = function (a, b) { return JSON.stringify(a) === JSON.stringify(b); };
  var uid = function () { return session && session.user ? session.user.id : ''; };
  var isOn = function () { return !!(client && uid()); };
  var busy = function () { return Object.keys(dirty).length > 0 || external.size > 0; };
  function emit(name, detail) { global.dispatchEvent(new CustomEvent(name, { detail: detail || {} })); }
  function describe(e) { return (e && e.code ? e.code + ': ' : '') + ((e && e.message) || String(e)); }
  /* An abort is somebody pulling the plug, not a failure: supabase-js cancels
     in-flight requests when it retries, when a query is superseded, and on
     sign-out. Reporting one told the user their data could not be saved when
     nothing had actually gone wrong. */
  function isAbort(e) {
    if (!e || e.__bbTimeout) return false;
    var n = e.name || '';
    return n === 'AbortError' || n === 'CanceledError' || /aborted|cancell?ed/i.test(e.message || '');
  }
  function report(e) {
    if (isAbort(e)) { lastError = null; return e; }
    lastError = describe(e);
    console.warn('[bitbase-db]', lastError);
    warnBanner('Changes could not be saved or loaded. ' + lastError);
    emit('bitbase:sync-error', { message: lastError });
    return e;
  }
  async function checked(query) {
    var r = await query;
    if (r && r.error) throw r.error;
    return r || {};
  }
  function uuid() {
    if (global.crypto.randomUUID) return global.crypto.randomUUID();
    var a = global.crypto.getRandomValues(new Uint8Array(16));
    a[6] = (a[6] & 15) | 64; a[8] = (a[8] & 63) | 128;
    var h = Array.from(a, function (n) { return n.toString(16).padStart(2, '0'); }).join('');
    return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
  }
  function parsed(v) {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch (_) { return v; }
  }
  function stopLive() {
    if (channel && client) client.removeChannel(channel);
    channel = null; channelUid = ''; live = false;
  }
  function acceptSession(next) {
    var old = uid(), id = next && next.user ? next.user.id : '';
    if (old !== id) {
      generation++; stopLive();
      Object.keys(timers).forEach(function (k) { clearTimeout(timers[k]); });
      timers = {}; dirty = {}; snapshots = {}; versions = {}; running = {}; profile = null;
      Object.keys(mirror).forEach(function (k) { delete mirror[k]; });
    }
    session = next || null;
    if (!id) profile = null;
  }
  function toAccount(p) {
    return { uid:p.id, code:p.code, name:p.name || '', email:p.email || '', country:p.country || 'other',
      created:new Date(p.created || 0).getTime(), loginAt:new Date(p.login_at || 0).getTime(),
      cash:Number(p.cash || 0), funding:Number(p.funding || 0), assets:p.assets || {},
      kyc_status:p.kyc_status || 'none', phone:p.phone || '', phone_verified:!!p.phone_verified,
      profitMode:!!p.profit_mode, disabled:!!p.disabled, admin:p.admin === true, owner:p.is_owner === true,
      perms:p.perms || {}, salt:null };
  }
  function mirrorProfile(p) {
    profile = p;
    if (!p) return;
    profileVersions[p.id] = p.updated;
    mirror.bb_uid=p.id; mirror.bb_name=p.name; mirror.bb_email=p.email;
    mirror.bb_registered_at=new Date(p.created).getTime(); mirror.bb_login_time=new Date(p.login_at || 0).getTime();
    mirror.bb_cash_balance=Number(p.cash || 0); mirror.bb_funding_balance=Number(p.funding || 0);
    mirror.bb_asset_balances=p.assets || {}; mirror.bb_kyc_status=p.kyc_status || 'none';
    var accounts = mirror.bb_accounts || {}; accounts[p.id]=toAccount(p); mirror.bb_accounts=accounts;
  }
  async function ensureProfile() {
    if (!isOn()) return null;
    var g = generation, id = uid();
    profileError = null;
    try {
      var r = await checked(client.from('profiles').select('*').eq('id', id).maybeSingle());
      if (!r.data) {
        // Only this authenticated account can be repaired. Roles are server defaults.
        r = await checked(client.rpc('ensure_my_profile'));
        if (Array.isArray(r.data)) r.data = r.data[0];
      }
      if (!r.data) throw new Error('Account profile is missing. Run supabase/repair-auth-realtime.sql.');
      if (g !== generation) return null;
      mirrorProfile(r.data);
      return profile;
    } catch (e) {
      profileError = describe(e);
      throw new Error('Could not load the account profile. ' + profileError + ' Apply supabase/repair-auth-realtime.sql if database setup is incomplete.');
    }
  }
  async function allRows(makeQuery) {
    var out = [], offset = 0, size = 500;
    for (;;) {
      var r = await checked(makeQuery().range(offset, offset + size - 1));
      var rows = r.data || []; out = out.concat(rows);
      if (rows.length < size) return out;
      offset += size;
    }
  }
  function requestData(r) {
    var data = clone(r.data) || {};
    data._sid = r.id; data.userId = r.user_id; data.status = r.status;
    if (data.time === undefined) data.time = new Date(r.created).getTime();
    return data;
  }
  /* ------------------------------------------------------------ attachments
     A proof of payment, a payslip and an identity scan can each be a few
     hundred kilobytes of base64. request_rows is re-read by every page, on a
     timer, forever - so leaving those bytes inside `data` made every visitor
     download every picture anybody ever uploaded, on every page, until the
     reads timed out.

     Each attachment therefore travels on its own user_settings row and the
     request keeps a small reference to it. Nothing but the console ever opens
     a proof, and it fetches that one row on demand. RLS already permits a
     user to write their own settings row and an admin to read anyone's, which
     is exactly the two parties involved, so no schema change is needed.

     Rows written before this split still hold their bytes inline and are read
     exactly as they always were. */
  var DOC_PREFIX = 'bb_doc_';
  var HEAVY_FIELDS = { deposit: ['proof'], borrow: ['proof'], kyc: ['docs'] };
  function docKey(sid) { return DOC_PREFIX + sid; }
  function hasBytes(v) {
    if (typeof v === 'string') return /^data:/.test(v);
    return !!(v && typeof v === 'object' && Object.keys(v).some(function(k){return hasBytes(v[k]);}));
  }
  /* What stays on the request: enough to label the attachment in a table. */
  function docStub(v, ref) {
    var src = (v && typeof v === 'object') ? v : null;
    var name = src ? (src.name || src.fileName || '') : String(v || '');
    var type = src ? (src.type || '') : (((/^data:([^;,]+)/.exec(String(v || '')) || [])[1]) || '');
    return { name: name || 'attachment', type: type || '', size: (src && src.size) || 0,
             truncated: !!(src && src.truncated), ref: ref };
  }
  function docRefOf(v) { return (v && typeof v === 'object' && typeof v.ref === 'string') ? v.ref : ''; }
  function threadData(t, messages) {
    return { _sid:t.id, id:'SUP-'+t.id, uid:t.user_id, name:t.name, email:t.email,
      subject:t.subject, status:t.status, created:new Date(t.created).getTime(), updated:new Date(t.updated).getTime(),
      messages:messages.filter(function (m) { return m.thread_id === t.id; }).map(function (m) {
        return { _mid:m.id, from:m.sender, body:m.body, image:m.image, name:(m.meta || {}).name || '', time:new Date(m.created).getTime() };
      }) };
  }
  function snapshot(key, rows) {
    snapshots[key] = {};
    rows.forEach(function (r) { snapshots[key][r._sid] = clone(r); });
  }
  async function hydrate(reuseProfile) {
    if (!isOn() || busy()) return false;
    var g = generation, m = mutation, id = uid();
    // Paginated reads avoid the server's default 1,000-row cap. RLS scopes them.
    var r = await Promise.all([
      reuseProfile && !fullRead && profile ? Promise.resolve([profile]) : allRows(function () { var q=client.from('profiles').select('*'); return (fullRead ? q : q.eq('id',id)).order('id'); }),
      !fullRead && !kinds.length ? Promise.resolve([]) : allRows(function () {
        var q=client.from('request_rows').select('*');
        return (fullRead ? q : q.eq('user_id',id).in('kind',kinds)).order('id');
      }),
      needsChat ? allRows(function () { var q=client.from('support_threads').select('*'); return (fullRead ? q : q.eq('user_id',id)).order('id'); }) : Promise.resolve([]),
      needsChat ? allRows(function () { var q=client.from('support_messages').select(fullRead ? '*' : '*,support_threads!inner(user_id)');return (fullRead ? q : q.eq('support_threads.user_id',id)).order('created').order('id'); }) : Promise.resolve([]),
      // Attachment rows are excluded here on purpose: they are the heavy ones,
      // and nothing in the settings screen needs them.
      needsSettings ? allRows(function () { return client.from('user_settings').select('*').eq('user_id', id)
        .not('key', 'like', DOC_PREFIX + '%').order('key'); }) : Promise.resolve([]),
      needsAppSettings ? allRows(function () { return client.from('app_settings').select('*').order('key'); }) : Promise.resolve([])
    ]);
    if (g !== generation || m !== mutation || busy()) { scheduleRefresh(); return false; }
    var own = r[0].find(function (p) { return p.id === id; });
    if (!own) throw new Error('Your account profile is not readable. Apply the database repair script.');
    var before = JSON.stringify(mirror);
    var accounts = {};
    r[0].forEach(function (p) { accounts[p.id]=toAccount(p); profileVersions[p.id]=p.updated; });
    mirror.bb_accounts=accounts; mirror['bb_accounts:snapshot']=clone(accounts); mirrorProfile(own);
    Object.keys(MAP).forEach(function (key) {
      var spec=MAP[key];
      if (spec.kind && !fullRead && kinds.indexOf(spec.kind) === -1) return;
      if (spec.table==='user_settings' && !needsSettings) return;
      if (spec.table==='app_settings' && !needsAppSettings) return;
      if (spec.kind) {
        mirror[key]=r[1].filter(function (row) { return row.kind===spec.kind; })
          .sort(function (a,b) { return new Date(b.created)-new Date(a.created); }).map(requestData);
        snapshot(key, mirror[key]);
      } else if (spec.table==='user_settings' || spec.table==='app_settings') {
        var found=r[spec.table==='user_settings' ? 4 : 5].find(function (row) { return row.key===spec.key; });
        if (found) mirror[key]=found.value; else delete mirror[key];
      }
    });
    r[1].concat(r[2]).forEach(function (row) { versions[row.id]=row.updated; });
    if (needsChat) mirror.bb_support_threads=r[2].sort(function (a,b) { return new Date(b.updated)-new Date(a.updated); })
      .map(function (t) { return threadData(t,r[3]); });
    if (needsChat) snapshot('bb_support_threads', mirror.bb_support_threads);
    lastRefresh=Date.now();
    status='ready'; lastError=null;
    var banner=document.getElementById('bbDbWarn'); if (banner) banner.remove();
    if (before !== JSON.stringify(mirror)) emit('bitbase:data');
    return true;
  }
  function scheduleRefresh() {
    if (refreshTimer || !isOn()) return;
    refreshTimer=setTimeout(function () { refreshTimer=null; refresh().catch(function () {}); }, 60);
  }
  async function refresh(reuseProfile) {
    if (!isOn() || busy()) return false;
    if (refreshJob) return refreshJob;
    refreshJob=hydrate(reuseProfile===true).catch(function (e) { report(e); throw e; }).finally(function () { refreshJob=null; });
    return refreshJob;
  }
  function startLive() {
    if (!isOn() || !profile || channelUid===uid()) return;
    stopLive(); channelUid=uid();
    channel=client.channel('bitbase-'+uid());
    ['profiles','request_rows','support_threads','support_messages','user_settings','app_settings'].forEach(function (table) {
      if (!needsChat && /^support_/.test(table)) return;
      if (!fullRead && !kinds.length && table==='request_rows') return;
      if (!needsSettings && table==='user_settings') return;
      if (!needsAppSettings && table==='app_settings') return;
      var filter={ event:'*', schema:'public', table:table };
      if (!fullRead && table==='profiles') filter.filter='id=eq.'+uid();
      if (!fullRead && ['request_rows','support_threads','user_settings'].indexOf(table)!==-1) filter.filter='user_id=eq.'+uid();
      channel.on('postgres_changes', filter, scheduleRefresh);
    });
    channel.subscribe(function (state) {
      live=state==='SUBSCRIBED';
      emit('bitbase:connection', { realtime:live, state:state });
      if (live && Date.now()-lastRefresh > 3000) scheduleRefresh();
    });
  }
  function refreshSession() {
    if (sessionJob) return sessionJob;
    sessionJob=restoreSession().finally(function () { sessionJob=null; });
    return sessionJob;
  }
  async function restoreSession() {
    if (!client) throw new Error(lastError || 'The sign-in service is unavailable. Reload and try again.');
    var r=await checked(client.auth.getSession());
    acceptSession(r.data && r.data.session);
    if (!isOn()) return null;
    await ensureProfile();
    if (profile.disabled) {
      await client.auth.signOut(); acceptSession(null);
      throw new Error('This account has been deactivated. Please contact support.');
    }
    await refresh(true); startLive();
    return profile;
  }
  function prepare(key) {
    var spec=MAP[key];
    if (!spec) return;
    var value=parsed(mirror[key]); mirror[key]=value;
    if (spec.list && Array.isArray(value)) value.forEach(function (row) {
      row._sid=row._sid || uuid();
      if (spec.table==='support_threads') (row.messages || []).forEach(function (msg) { msg._mid=msg._mid || uuid(); });
    });
  }
  async function insertOnce(table, payload) {
    var r=await checked(client.from(table).upsert(payload, { onConflict:'id', ignoreDuplicates:true }).select('*'));
    if (r.data && r.data[0]) return r.data[0];
    r=await checked(client.from(table).select('*').eq('id',payload.id).single());
    if (!r.data) throw new Error('The saved record could not be confirmed.');
    return r.data;
  }
  function cleanRequest(row) { var r=clone(row); delete r._sid; return r; }
  /* Move any inline attachment on this row onto its own settings row and leave a
     reference behind. Returns the row as it should be stored. */
  async function detachDocs(clean, kind, sid, owner) {
    var fields=HEAVY_FIELDS[kind] || [];
    var payload={}, lean=clone(clean), touched=false;
    fields.forEach(function (f) {
      var v=lean[f];
      if (v==null) return;
      if (hasBytes(v)) { payload[f]=v; touched=true; }
      else if (docRefOf(v)) touched=true;   // already split: keep the reference
    });
    if (!touched) return clean;
    var userId=clean.userId || clean.uid || owner;
    if (!userId) return clean;             // unattributable: store it inline
    var key=docKey(sid);
    if (Object.keys(payload).length) {
      await checked(client.from('user_settings').upsert({ user_id:userId, key:key, value:payload },
        { onConflict:'user_id,key' }));
      rememberAttachment(key, clone(payload));
    }
    fields.forEach(function (f) {
      if (lean[f]!=null) lean[f]=docStub(payload[f]!==undefined?payload[f]:lean[f], key);
    });
    return lean;
  }
  /* Fetch the bytes behind a reference, once per session. */
  var ATTACH_CACHE_MAX = 12;
  async function loadAttachment(ref) {
    if (typeof ref!=='string' || ref.indexOf(DOC_PREFIX)!==0) return null;
    if (attachmentCache[ref]!==undefined) return attachmentCache[ref];
    if (!isOn()) return null;
    try {
      var r=await checked(client.from('user_settings').select('value').eq('key',ref).limit(1));
      var value=r.data && r.data[0] ? r.data[0].value : null;
      rememberAttachment(ref, value || null);
      return attachmentCache[ref];
    } catch (e) {
      rememberAttachment(ref, null);
      if (!isAbort(e)) report(e);
      return null;
    }
  }
  /* Each entry is a picture, so the cache is bounded: a console left open all
     day must not grow into a second copy of everything ever uploaded. */
  function rememberAttachment(ref, value) {
    var keys=Object.keys(attachmentCache);
    while (keys.length>=ATTACH_CACHE_MAX) delete attachmentCache[keys.shift()];
    attachmentCache[ref]=value;
  }
  async function writeRows(key, spec, rows, owner, g) {
    var known=snapshots[key] || {};
    for (var row of rows || []) {
      if (g!==generation) throw new Error('Session changed before saving.');
      var old=known[row._sid];
      var clean=await detachDocs(cleanRequest(row), spec.kind, row._sid, owner);
      if (old && equal(cleanRequest(old),clean)) continue;
      var record;
      if (old) {
        var q=client.from('request_rows').update({ data:clean, status:clean.status || 'pending', amount:Number(clean.amount) || null, ref:clean.id || null }).eq('id',row._sid);
        if (versions[row._sid]) q=q.eq('updated',versions[row._sid]);
        var res=await checked(q.select('*').maybeSingle()); record=res.data;
        if (!record) throw new Error('This request changed in another session. Reload before editing it again.');
      } else {
        record=await insertOnce('request_rows', { id:row._sid, kind:spec.kind, user_id:clean.userId || clean.uid || owner,
          data:clean, status:clean.status || 'pending', amount:Number(clean.amount) || null, ref:clean.id || null });
      }
      if (g!==generation) return;
      known[row._sid]=Object.assign(clone(row),clean); versions[row._sid]=record.updated; snapshots[key]=known;
    }
    // Only a deliberate admin removal of a previously loaded row can delete it.
    // Unseen rows and customer history trimmed from a display are never deleted.
    if (profile && profile.admin) for (var id of Object.keys(known)) {
      if (!(rows || []).some(function (r) { return r._sid===id; })) {
        var gone=known[id], ownerOf=(gone && (gone.userId||gone.uid)) || uid();
        await checked(client.from('request_rows').delete().eq('id',id));
        await checked(client.from('user_settings').delete().eq('user_id',ownerOf).eq('key',docKey(id)));
        delete attachmentCache[docKey(id)];
        delete known[id];
      }
    }
  }
  async function writeThreads(key, threads, owner, g) {
    var known=snapshots[key] || {};
    for (var t of threads || []) {
      if (g!==generation) throw new Error('Session changed before saving.');
      var old=known[t._sid], meta={ name:t.name || '', email:t.email || '', subject:t.subject || 'Chat enquiry', status:t.status || 'open' };
      if (!old) {
        await insertOnce('support_threads', Object.assign({ id:t._sid, user_id:t.uid || owner },meta));
        old=clone(t); old.messages=[]; known[t._sid]=old; snapshots[key]=known;
      } else {
        var patch={};
        Object.keys(meta).forEach(function (k) { if (old[k]!==meta[k]) patch[k]=meta[k]; });
        // Ownership is immutable here; admin replies keep the customer's user_id.
        if (Object.keys(patch).length) {
          var updated=await checked(client.from('support_threads').update(patch).eq('id',t._sid).select('id').maybeSingle());
          if (!updated.data) throw new Error('The support conversation is no longer available.');
          Object.assign(old,patch);
        }
      }
      var existing=new Set((old.messages || []).map(function (msg) { return msg._mid; }));
      for (var msg of t.messages || []) {
        if (existing.has(msg._mid)) continue;
        await insertOnce('support_messages', { id:msg._mid, thread_id:t._sid, sender:msg.from==='admin' ? 'admin' : 'user',
          body:String(msg.body || ''), image:msg.image || null, meta:{ name:msg.name || '' } });
        old.messages.push(clone(msg)); existing.add(msg._mid);
      }
    }
    if (profile && profile.admin) for (var id of Object.keys(known)) {
      if (!(threads || []).some(function (t) { return t._sid===id; })) {
        await checked(client.from('support_threads').delete().eq('id',id)); delete known[id];
      }
    }
  }
  async function persistValue(key, value, owner, g) {
    var spec=MAP[key];
    if (!isOn() || !profile || g!==generation) throw new Error('Please sign in before saving.');
    if (spec.admin && !profile.admin) throw new Error('Administrator access is required.');
    if (spec.accounts) {
      var columns={name:'name',email:'email',country:'country',cash:'cash',funding:'funding',assets:'assets',
        kyc_status:'kyc_status',phone:'phone',phone_verified:'phone_verified',profitMode:'profit_mode',
        disabled:'disabled',admin:'admin',owner:'is_owner',perms:'perms'};
      var before=mirror['bb_accounts:snapshot'] || {};
      for (var id of Object.keys(value || {})) {
        var record=value[id], previous=before[id] || {}, changes={};
        Object.keys(columns).forEach(function (field) {
          var next=record[field];
          if (next===undefined && ['admin','owner','disabled'].includes(field)) next=false;
          if (next===undefined && field==='perms') next={};
          if (next!==undefined && !equal(next,previous[field])) changes[columns[field]]=next;
        });
        if (Object.keys(changes).length) await saveProfileFor(id,changes);
      }
    } else if (spec.profile) {
      var patch={}; patch[spec.profile]=value;
      await saveProfileFor(owner,patch);
    } else if (spec.table==='request_rows') await writeRows(key,spec,value,owner,g);
    else if (spec.table==='support_threads') await writeThreads(key,value,owner,g);
    else {
      var row={ key:spec.key, value:value }, q;
      if (spec.table==='user_settings') row.user_id=owner;
      if (value===undefined || value===null) {
        q=client.from(spec.table).delete().eq('key',spec.key);
        if (row.user_id) q=q.eq('user_id',owner);
      } else q=client.from(spec.table).upsert(row,{ onConflict:row.user_id ? 'user_id,key' : 'key' });
      await checked(q);
    }
  }
  function drain(key) {
    if (running[key]) return running[key];
    clearTimeout(timers[key]); delete timers[key];
    var g=generation, owner=uid();
    var job=(async function () {
      while (dirty[key] && g===generation) {
        var rev=dirty[key], value=clone(parsed(mirror[key]));
        await persistValue(key,value,owner,g);
        if (g===generation && dirty[key]===rev) delete dirty[key];
      }
    })().catch(function (e) { report(e); throw e; }).finally(function () {
      if (running[key]===job) delete running[key];
    });
    running[key]=job;
    return job;
  }
  function queue(key) {
    if (!MAP[key]) return;
    prepare(key); dirty[key]=++mutation;
    clearTimeout(timers[key]);
    timers[key]=setTimeout(function () { drain(key).then(scheduleRefresh).catch(function () {}); },80);
  }
  async function flush() {
    await ready;
    if (!configured) return true;
    if (!isOn() || !profile) throw new Error('Please sign in before saving.');
    do {
      await Promise.all(Object.keys(dirty).map(drain).concat(Array.from(external)));
    } while (busy());
    lastError=null;
    var banner=document.getElementById('bbDbWarn'); if (banner) banner.remove();
    scheduleRefresh(); emit('bitbase:saved');
    return true;
  }
  var profileWrites = Promise.resolve();
  function saveProfileFor(id, patch) {
    if (!isOn() || !id) return Promise.reject(new Error('Please sign in before saving.'));
    var g=generation; mutation++;
    var p=profileWrites.catch(function () {}).then(function () {
      if (g!==generation) throw new Error('Session changed before saving.');
      var q=client.from('profiles').update(patch).eq('id',id);
      // A page with an old balance must never overwrite a background credit.
      if (profileVersions[id]) q=q.eq('updated',profileVersions[id]);
      return checked(q.select('*').maybeSingle());
    })
      .then(function (r) {
        if (!r.data) throw new Error('Your balance or profile changed in another session. Reload before retrying this change.');
        if (g===generation) {
          profileVersions[id]=r.data.updated;
          var map=mirror.bb_accounts || {}, snap=mirror['bb_accounts:snapshot'] || {};
          // Update only the acknowledged fields; a second pending edit may exist.
          var server=toAccount(r.data); snap[id]=clone(server); mirror['bb_accounts:snapshot']=snap;
          if (!map[id]) map[id]=server;
        }
        return r;
      }).catch(function (e) { report(e); throw e; }).finally(function () { external.delete(p); scheduleRefresh(); });
    profileWrites=p; external.add(p); return p;
  }
  async function tradeRpc(name, args) {
    await ready;
    if (!isOn()) throw new Error('Please sign in before trading.');
    await flush();
    var g=generation;
    var job=checked(client.rpc(name,args));
    external.add(job);
    try {
      var r=await job, d=r.data;
      if (!d || !d.contractId) throw new Error('The trade acknowledgement was incomplete. Retry the same order.');
      if (g===generation) {
        mutation++;
        ['bb_trade_positions','bb_trades_history'].forEach(function (key) {
          var rows=(mirror[key] || []).filter(function (x) { return x.contractId!==d.contractId; });
          if (key==='bb_trades_history' || d.status==='Active' || d.status==='Review') rows.unshift(d);
          mirror[key]=rows;
        });
        if (d.balance!==undefined && profile) {
          var p=clone(profile); p.cash=Number(d.balance);p.updated=d.balanceVersion || p.updated;
          p.assets=Object.assign({},p.assets,{USDT:{balance:p.cash,qty:p.cash}});
          mirrorProfile(p);
          var snap=mirror['bb_accounts:snapshot'] || {};snap[p.id]=toAccount(p);mirror['bb_accounts:snapshot']=snap;
        }
        emit('bitbase:data');
      }
      return d;
    } finally { external.delete(job); scheduleRefresh(); }
  }
  async function loadAccounts() { await refresh(); return mirror.bb_accounts || {}; }
  /* Postgres answers 42883 for a missing function and PostgREST answers PGRST202.
     Both mean the schema predates the website, which must not be reported as
     "that account is gone". */
  function missingFunction(e) {
    var code = e && e.code ? String(e.code) : '';
    return code === '42883' || code === 'PGRST202' ||
      /function .* does not exist|could not find the function/i.test((e && e.message) || '');
  }
  /* Forget one account everywhere it is cached. Without this the console keeps
     showing the row until the next full read - and that read is skipped while
     anything is still in flight, so the button could look like it did nothing. */
  function forgetUser(id) {
    if (!id) return;
    if (mirror.bb_accounts) delete mirror.bb_accounts[id];
    if (mirror['bb_accounts:snapshot']) delete mirror['bb_accounts:snapshot'][id];
    delete profileVersions[id];
    var drop = function (key) {
      var rows = mirror[key];
      if (Array.isArray(rows)) {
        mirror[key] = rows.filter(function (r) { return r && (r.uid || r.userId) !== id; });
      }
      var known = snapshots[key];
      if (known) Object.keys(known).forEach(function (sid) {
        var row = known[sid];
        if (row && (row.uid || row.userId) === id) { delete known[sid]; delete versions[sid]; }
      });
    };
    Object.keys(MAP).forEach(function (key) { if (MAP[key].list) drop(key); });
    // Chat threads live outside the request_rows mapping, keyed the same way.
    drop('bb_support_threads');
  }
  /* Removes an account for good. bb_delete_account starts at the auth login, so
     the sign-in goes too - deleting only the profiles row left the account able
     to sign in again and be rebuilt from scratch, which is what made the console
     report a deletion that had not happened. Falls back to the profile row on a
     schema that predates the function, and says so. */
  async function deleteAccountFor(id) {
    if (!isOn() || !id) throw new Error('Please sign in before removing an account.');
    // A queued account write that lands after the delete would try to write the
    // row back, so everything pending is pushed to the database first. If that
    // cannot be done the account is left alone: removing it now would throw away
    // the edits the console still holds for it.
    try { await flush(); }
    catch (e) { throw new Error('Could not save the pending changes first, so nothing was removed. ' + ((e && e.message) || '')); }
    var out = null, signinRemoved = true;
    try { out = await checked(client.rpc('bb_delete_account', { p_id: id })); }
    catch (e) {
      if (!missingFunction(e)) throw e;
      await checked(client.from('profiles').delete().eq('id', id));
      signinRemoved = false;
    }
    forgetUser(id);
    emit('bitbase:data');
    // Best effort: the row is already gone from the mirror, so a failed re-read
    // costs nothing but a later refresh.
    await refresh().catch(function () {});
    var result = out && typeof out === 'object' ? clone(out) : {};
    result.ok = true;
    result.signinRemoved = result.signinRemoved === undefined ? signinRemoved : result.signinRemoved === true;
    return result;
  }
  async function audit(action,target,detail) {
    if (!isOn() || !profile || !profile.admin) return false;
    return checked(client.from('admin_log').insert({ actor:uid(),actor_name:profile.name || '',action:action,target:target || null,detail:detail || {} }));
  }
  function warnBanner(text) {
    if (!document.body) { document.addEventListener('DOMContentLoaded',function () { warnBanner(text); },{once:true}); return; }
    var el=document.getElementById('bbDbWarn');
    if (!el) {
      el=document.createElement('div'); el.id='bbDbWarn'; el.setAttribute('role','alert');
      el.style.cssText='position:fixed;left:0;right:0;bottom:0;z-index:99999;padding:12px;background:#3a1416;color:#ffd9d9;font:13px/1.5 system-ui;display:flex;gap:12px;justify-content:space-between';
      el.appendChild(document.createElement('span'));
      var retry=document.createElement('button'); retry.textContent='Retry';
      retry.addEventListener('click',function () { (busy() ? flush() : refreshSession()).catch(report); });
      el.appendChild(retry); document.body.appendChild(el);
    }
    el.firstChild.textContent=text;
  }
  async function loadSdk() {
    if (global.supabase && global.supabase.createClient) return;
    await new Promise(function (resolve,reject) {
      var done=false,backup=false,errors=0;
      var timer=setTimeout(function () { done=true;reject(new Error('Sign-in service took too long to load. Check your connection and reload.')); },15000);
      function add(src) {
        var script=document.createElement('script');script.async=true;script.src=src;
        script.onload=function () { if(!done && global.supabase){done=true;clearTimeout(timer);clearTimeout(fallback);resolve();} };
        script.onerror=function () { if(++errors>=2&&!done){done=true;clearTimeout(timer);reject(new Error('Could not load the sign-in service. Reload and try again.'));}else second(); };
        document.head.appendChild(script);
      }
      function second(){if(done||backup)return;backup=true;add('https://unpkg.com/@supabase/supabase-js@2/dist/umd/supabase.min.js');}
      var fallback=setTimeout(second,2500);
      add('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js');
    });
  }
  var ready=(async function () {
    if (!configured) { status='local'; return; }
    var url=String(CFG.supabaseUrl || '').trim().replace(/\/+$/,'').replace(/\/(rest|auth)\/v1$/i,'');
    if (!url || !CFG.supabaseAnonKey) throw new Error('Supabase connection settings are missing.');
    await loadSdk();
    // Bound network waits so a broken connection cannot leave the login spinner stuck.
    client=global.supabase.createClient(url,CFG.supabaseAnonKey,{global:{fetch:async function (url,options) {
      var controller=new AbortController(), original=options && options.signal;
      var timedOut=false;
      var cancel=function () { controller.abort(); };
      if (original) { if (original.aborted) cancel(); else original.addEventListener('abort',cancel,{once:true}); }
      var timer=setTimeout(function () { timedOut=true; cancel(); },READ_TIMEOUT_MS);
      try { return await fetch(url,Object.assign({},options,{signal:controller.signal})); }
      catch (e) {
        /* Only a cancel this wrapper started is a real problem, and it is
           reported as the timeout it is. A cancel supabase-js asked for is
           passed through untouched so it is not mistaken for a failure. */
        if (timedOut) { var err=new Error('The request timed out after ' + Math.round(READ_TIMEOUT_MS/1000) + 's. Check your connection and retry.'); err.__bbTimeout=true; throw err; }
        throw e;
      }
      finally { clearTimeout(timer); if (original) original.removeEventListener('abort',cancel); }
    }}});
    client.auth.onAuthStateChange(function (event,next) {
      // Supabase calls this under its auth lock: never await another auth call here.
      var old=uid(); acceptSession(next);
      if (event==='SIGNED_OUT') { status='ready'; emit('bitbase:session',{signedIn:false}); return; }
      if (next && (old!==uid() || !profile || event==='USER_UPDATED')) {
        clearTimeout(authTimer);
        authTimer=setTimeout(function () { refreshSession().catch(report); },0);
      }
    });
    await refreshSession(); status='ready';
  })().catch(function (e) { status='error'; report(e); });
  global.addEventListener('online',function () { (busy() ? flush() : refresh()).catch(function () {}); });
  global.addEventListener('focus',scheduleRefresh);
  document.addEventListener('visibilitychange',function () { if (!document.hidden) scheduleRefresh(); });
  global.addEventListener('beforeunload',function (e) { if (busy()) { e.preventDefault(); e.returnValue=''; } });
  /* A safety net for when realtime never arrives: a blocked socket, a proxy that
     eats websockets, a sleeping laptop. Realtime covers the normal case within
     milliseconds, so re-reading every table every few seconds on top of it was
     pure overhead - six queries a minute, forever, competing with the page for
     whatever connection the user has. */
  var FALLBACK_POLL_MS = 15000;
  setInterval(function () { if (!document.hidden && isOn() && Date.now()-lastRefresh > (live ? 60000 : FALLBACK_POLL_MS-100)) scheduleRefresh(); }, FALLBACK_POLL_MS);
  global.BitbaseDB={ MAP:MAP, mirror:mirror, ready:ready, configured:function () { return configured; },
    status:function () { return status; }, error:function () { return lastError; }, isOn:isOn, uid:uid,
    profile:function () { return profile; }, profileError:function () { return profileError; },
    client:function () { return client; }, toAccount:toAccount, hydrate:refresh, refresh:refresh,
    refreshSession:refreshSession, ensureProfile:ensureProfile, loadAccounts:loadAccounts, tradeRpc:tradeRpc,
    persist:queue, flush:flush, hasPending:busy, realtime:function () { return live; },
    saveProfileFor:saveProfileFor, saveProfile:function (patch) { return saveProfileFor(uid(),patch); },
    deleteAccountFor:deleteAccountFor, audit:audit, warn:report,
    // Uploaded pictures live apart from the request so ordinary pages stay
    // small; this puts them back together where they are actually opened.
    attachment:loadAttachment, docKey:docKey };
})(window);
