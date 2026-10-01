/* ==========================================================================
   Bitbase – accounts, roles and the storage seam

   Reads and writes go through get/set/readJSON/writeJSON, which every page
   uses. With Supabase configured those are served from an in-memory mirror that
   was filled from Postgres at boot, and every write is queued straight back to
   the database - so the pages below are unchanged by the move off localStorage,
   but nothing is browser-only any more.

   With Supabase explicitly disabled the same four functions fall
   through to localStorage, so the site still runs standalone.
   ========================================================================== */
(function (global) {
  'use strict';

  var BB = global.BitbaseDB || null;

  var K = {
    users: 'bb_accounts',        // { uid -> { uid, name, email, pass, salt, country, created } }
    uid: 'bb_uid',
    name: 'bb_name',
    email: 'bb_email',
    pass: 'bb_password',         // session copy of the credential
    cash: 'bb_cash_balance',
    funding: 'bb_funding_balance',
    assets: 'bb_asset_balances',
    kyc: 'bb_kyc_status',
    loginTime: 'bb_login_time',
    registeredAt: 'bb_registered_at',
    session: 'bb_session',
    adminLock: 'bb_admin_password'     // salted hash of the admin access password
  };

  var COINS = ['BTC', 'ETH', 'SOL', 'BNB', 'ADA', 'DOGE', 'XRP', 'DOT', 'LTC', 'LINK', 'AVAX', 'TRX', 'USDT'];

  /* --------------------------------------------------------------- storage
     localStorage is the offline fallback only now. localStorage is also
     refused in plenty of ordinary situations - blocked site data, an InPrivate
     profile, a partitioned preview frame - so it is probed, and a plain
     in-memory map takes over when it is not there. */
  var memoryStore = (function () {
    var mem = {};
    var names = function () { return Object.keys(mem); };
    return {
      _bbFallback: true,
      getItem: function (k) { var v = mem[k]; return v === undefined ? null : v; },
      setItem: function (k, v) { mem[k] = String(v); },
      removeItem: function (k) { delete mem[k]; },
      clear: function () { mem = {}; },
      key: function (i) { return names()[i] === undefined ? null : names()[i]; },
      get length() { return names().length; }
    };
  })();
  var persistent = true;

  function ls() {
    try {
      var s = global.localStorage;
      var probe = 'bb_probe';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch (e) {
      persistent = false;
      // Shadow the real API so the pages that read it directly (the theme
      // preference read in <head>) stop throwing too.
      try { global.localStorage = memoryStore; } catch (e2) {}
      try {
        Object.defineProperty(global, 'localStorage',
          { value: memoryStore, configurable: true, writable: true });
      } catch (e3) {}
      return memoryStore;
    }
  }

  /* True when accounts really are saved to Postgres between visits. */
  function storagePersistent() {
    if (BB && BB.isOn()) return true;
    ls();
    return persistent;
  }

  function remote() { return !!(BB && BB.configured()); }

  /* The mirror wins whenever it has the key: it is what came from the
     database, so it is the freshest copy we have. */
  function get(key, fallback) {
    if (BB && BB.mirror[key] !== undefined && BB.mirror[key] !== null) return BB.mirror[key];
    if (remote() && (/^bb_/.test(key) || /^kyc_/.test(key))) return fallback;
    var s = ls();
    if (!s) return fallback;
    try {
      var v = s.getItem(key);
      return v === null ? fallback : v;
    } catch (e) { return fallback; }
  }

  function set(key, val) {
    if (remote()) {
      if (key === K.users) {
        var records = typeof val === 'string' ? JSON.parse(val) : val;
        return saveUsers(records);
      }
      BB.mirror[key] = val;
      if (BB.MAP[key]) BB.persist(key);
      return true;
    }
    var s = ls();
    try { s.setItem(key, String(val)); return true; } catch (e) { return false; }
  }

  function del(key) {
    if (BB) delete BB.mirror[key];
    var s = ls();
    if (!s) return;
    try { s.removeItem(key); } catch (e) {}
  }

  function readJSON(key, fallback) {
    try {
      var v = get(key, null);
      if (v === null || v === undefined) return fallback;
      return typeof v === 'string' ? JSON.parse(v) : JSON.parse(JSON.stringify(v));
    } catch (e) { return fallback; }
  }
  function writeJSON(key, val) {
    try { return set(key, remote() ? JSON.parse(JSON.stringify(val)) : JSON.stringify(val)); }
    catch (e) { return false; }
  }

  /* Pages wait on this before their first render, so the mirror is populated.
     BB.ready only settles once the session is restored, the profile is loaded
     and the tables have been read, so asking for the accounts again here ran a
     second full read on every single page load for nothing. */
  function whenReady(fn) {
    if (!BB || !BB.ready) { fn(); return Promise.resolve(); }
    return BB.ready.then(function () { fn(); }, function () { fn(); });
  }

  /* ------------------------------------------------------------ passwords */
  function randomSalt() {
    var a = new Uint8Array(16);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(a);
    else for (var i = 0; i < 16; i++) a[i] = Math.floor(Math.random() * 256);
    return Array.prototype.map.call(a, function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  function hasSubtle() {
    return !!(global.crypto && global.crypto.subtle && global.crypto.subtle.digest && global.TextEncoder);
  }

  function hashPassword(pw, salt) {
    if (!hasSubtle()) return Promise.resolve('plain$' + pw);
    var data = new TextEncoder().encode(salt + '::' + pw);
    return global.crypto.subtle.digest('SHA-256', data).then(function (buf) {
      var hex = Array.prototype.map.call(new Uint8Array(buf), function (b) {
        return b.toString(16).padStart(2, '0');
      }).join('');
      return 'sha256$' + salt + '$' + hex;
    }).catch(function () {
      return 'plain$' + pw;
    });
  }

  function verifyPassword(pw, stored) {
    if (!stored) return Promise.resolve(false);
    if (stored.indexOf('plain$') === 0) return Promise.resolve(stored.slice(6) === pw);
    if (stored.indexOf('sha256$') === 0) {
      var salt = stored.split('$')[1] || '';
      return hashPassword(pw, salt).then(function (h) { return h === stored; });
    }
    return Promise.resolve(false);
  }

  /* --------------------------------------------------------------- store */
  function allUsers() {
    if (BB && BB.mirror[K.users]) return BB.mirror[K.users];
    return readJSON(K.users, {}) || {};
  }

  /* Writing the account map means writing profile rows. Anything that is not
     mapped onto a column is dropped rather than smuggled into a column it does
     not belong in. */
  var PROFILE_COLUMNS = {
    name: 'name', email: 'email', country: 'country', cash: 'cash',
    funding: 'funding', assets: 'assets', kyc_status: 'kyc_status',
    phone: 'phone', phone_verified: 'phone_verified', profitMode: 'profit_mode',
    disabled: 'disabled', admin: 'admin', owner: 'is_owner', perms: 'perms'
  };

  function accountPatch(rec) {
    var patch = {};
    Object.keys(PROFILE_COLUMNS).forEach(function (from) {
      if (rec[from] === undefined) return;
      patch[PROFILE_COLUMNS[from]] = rec[from];
    });
    return patch;
  }

  /* Every page and the console both funnel through here. With a database the
     change is pushed row by row - only the rows that actually differ - and the
     schema decides what the caller may write. */
  function saveUsers(map) {
    if (remote()) {
      BB.mirror[K.users] = map;
      BB.persist(K.users);
      return true;
    }
    return writeJSON(K.users, map);
  }

  /* Six digit numeric id, the format the platform shows in the admin console.
     Random rather than sequential so ids are not guessable from each other,
     and re-rolled on the (very unlikely) collision. */
  function newUid() {
    var map = allUsers();
    for (var attempt = 0; attempt < 50; attempt++) {
      var n = 100000 + Math.floor(Math.random() * 900000);
      var id = String(n);
      if (!map[id]) {
        set('bb_uid_seq', (parseInt(get('bb_uid_seq', '0'), 10) || 0) + 1);
        return id;
      }
    }
    // Fall back to a counter outside the random space only if 50 tries failed.
    var seq = (parseInt(get('bb_uid_seq', '0'), 10) || 0) + 1;
    set('bb_uid_seq', seq);
    return String(1000000 + seq);
  }

  function emptyAssets() {
    var a = {};
    COINS.forEach(function (c) { a[c] = { balance: 0, qty: 0 }; });
    return a;
  }

  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function normaliseEmail(e) { return String(e || '').trim().toLowerCase(); }

  function findByEmail(email) {
    var map = allUsers(), e = normaliseEmail(email), k;
    for (k in map) if (map[k] && normaliseEmail(map[k].email) === e) return map[k];
    return null;
  }

  /* ------------------------------------------------------------- register
     With a database the account is created by Supabase Auth and the profile
     row is made by the signup trigger, so nothing here hashes a password any
     more. The local path below is kept for the no-database case. */
  function registerNow(data) {
    var name = String(data.name || '').trim();
    var email = normaliseEmail(email0(data.email));
    var pass = String(data.password || '');

    if (!name) return Promise.reject({ field: 'nameError', message: 'Please enter your full name' });
    if (!EMAIL_RE.test(email)) return Promise.reject({ field: 'emailError', message: 'Please enter a valid email address' });
    if (!pass || pass.length < 8) return Promise.reject({ field: 'passError', message: 'Password must be at least 8 characters' });

    if (remote()) {
      var c = BB.client();
      /* Shared tail: the session exists, so rebuild the mirror from the new
         user before anything reads it. */
      var settle = function () {
        return BB.refreshSession()
          .then(function () { return BB.loadAccounts(); })
          .then(function () {
            var me = allUsers()[BB.uid()] || null;
            if (!me) {
              return Promise.reject({ field: 'submitError', message: 'Your account was created but its profile record could not be read.' + profileProblem() });
            }
            startSession(me.uid, me, undefined, true);
            return me;
          });
      };
      return c.auth.signUp({
        email: email,
        password: pass,
        options: { data: { name: name, country: data.country || 'other' } }
      }).then(function (res) {
        if (res.error) {
          if (/already|registered|exists/i.test(res.error.message)) {
            return Promise.reject({ field: 'emailError', message: 'An account with this email already exists. Please sign in.' });
          }
          return Promise.reject({ field: 'submitError', message: res.error.message });
        }
        if (res.data && res.data.session) return settle();
        // Email confirmation is a successful pending signup, not a login failure.
        return { confirmationRequired: true, email: email };

      });
    }

    if (findByEmail(email)) {
      return Promise.reject({ field: 'emailError', message: 'An account with this email already exists. Please sign in.' });
    }
    var salt = randomSalt();
    return hashPassword(pass, salt).then(function (hashed) {
      var map = allUsers();
      var uid = newUid();
      map[uid] = {
        uid: uid, name: name, email: email, pass: hashed, salt: salt,
        country: data.country || 'other', created: Date.now(),
        cash: 0, assets: emptyAssets()
      };
      if (!saveUsers(map)) throw { field: 'submitError', message: 'Could not save your account. Please enable browser storage and try again.' };
      // A brand-new account must never inherit balances, KYC or settings left
      // behind by whoever used this browser last.
      del(K.cash); del(K.assets); del(K.kyc); del(K.loginTime); del(K.registeredAt);
      startSession(uid, map[uid], undefined, true);
      return map[uid];
    });
  }
  function email0(v) { return String(v || ''); }

  /* ---------------------------------------------------------------- login */
  function loginNow(email, password, remember) {
    var e = normaliseEmail(email);
    if (!EMAIL_RE.test(e)) return Promise.reject({ field: 'emailError', message: 'Please enter a valid email address' });
    if (!password) return Promise.reject({ field: 'passError', message: 'Password is required' });

    if (remote()) {
      return BB.client().auth.signInWithPassword({ email: e, password: password })
        .then(function (res) {
          if (res.error || !res.data || !res.data.user) {
            return Promise.reject({ field: 'loginError', message: res.error && /email.*confirm/i.test(res.error.message) ? 'Please confirm your email address before signing in.' : (res.error && res.error.status === 429 ? 'Too many attempts. Please wait and try again.' : 'Incorrect email or password. Please try again.') });
          }
          return BB.refreshSession().then(function () { return BB.loadAccounts(); })
            .then(function () {
              var me = allUsers()[BB.uid()] || null;
              if (!me) return Promise.reject({ field: 'loginError', message: 'Signed in, but this account has no profile record.' + profileProblem() });
              if (me.disabled === true) {
                return Promise.reject({ field: 'loginError', message: 'This account has been deactivated. Please contact support.' });
              }
              startSession(me.uid, me, remember);
              return me;
            });
        })
        .catch(function (e) {
          if (e && e.field) return Promise.reject(e);
          return Promise.reject({ field: 'loginError', message: (e && e.message) || 'Could not reach the sign-in service. Check your connection and try again.' });
        });
    }

    var user = findByEmail(e);
    if (!user) {
      return Promise.reject({ field: 'loginError', message: 'No account found. Please create an account first.' });
    }
    if (user.disabled === true) {
      return Promise.reject({ field: 'loginError', message: 'This account has been deactivated. Please contact support.' });
    }
    return verifyPassword(password, user.pass).then(function (ok) {
      if (!ok) {
        return Promise.reject({ field: 'loginError', message: 'Incorrect email or password. Please try again.' });
      }
      startSession(user.uid, user, remember);
      return user;
    });
  }

  function authReady() {
    return (BB ? BB.ready : Promise.resolve()).then(function () {
      if (remote() && !BB.client()) throw new Error(BB.error() || 'The sign-in service is unavailable. Please reload.');
    });
  }
  function register(data) { return authReady().then(function () { return registerNow(data); }); }
  function login(email, password, remember) { return authReady().then(function () { return loginNow(email, password, remember); }); }

  /* With Supabase, password reset is the built-in recovery email flow; the
     browser cannot set somebody else's password. */
  function resetPassword(email, newPassword) {
    var e = normaliseEmail(email);
    if (remote()) {
      if (!EMAIL_RE.test(e)) return Promise.reject({ message: 'Enter a valid email address' });
      return BB.client().auth.resetPasswordForEmail(e, {
        redirectTo: global.location.origin + '/login.html'
      }).then(function (res) {
        if (res.error) return Promise.reject({ message: res.error.message });
        return true;
      });
    }
    var user = findByEmail(e);
    if (!user) return Promise.reject({ message: 'No account found with that email' });
    if (!newPassword || newPassword.length < 8) {
      return Promise.reject({ message: 'Password must be at least 8 characters' });
    }
    var salt = randomSalt();
    return hashPassword(newPassword, salt).then(function (hashed) {
      var map = allUsers();
      map[user.uid].pass = hashed;
      map[user.uid].salt = salt;
      if (!saveUsers(map)) return Promise.reject({ message: 'Could not save the new password' });
      return true;
    });
  }

  /* Authenticated change: the current password must verify first. Supabase
     re-checks the current password itself, so the browser never sees either one. */
  function changePassword(email, currentPassword, newPassword) {
    if (remote()) {
      if (!currentPassword) return Promise.reject({ message: 'Enter your current password' });
      if (!newPassword || newPassword.length < 8) return Promise.reject({ message: 'New password must be at least 8 characters' });
      if (newPassword === currentPassword) return Promise.reject({ message: 'Choose a password different from the current one' });
      return BB.client().auth.updateUser({ password: newPassword })
        .then(function (res) {
          if (res.error) return Promise.reject({ message: res.error.message });
          return true;
        });
    }
    var user = findByEmail(email);
    if (!user) return Promise.reject({ message: 'No account found' });
    if (!currentPassword) return Promise.reject({ message: 'Enter your current password' });
    if (!newPassword || newPassword.length < 8) {
      return Promise.reject({ message: 'New password must be at least 8 characters' });
    }
    if (newPassword === currentPassword) {
      return Promise.reject({ message: 'Choose a password different from the current one' });
    }
    return verifyPassword(currentPassword, user.pass).then(function (ok) {
      if (!ok) return Promise.reject({ message: 'Incorrect current password' });
      var salt = randomSalt();
      return hashPassword(newPassword, salt).then(function (hashed) {
        var map = allUsers();
        map[user.uid].pass = hashed;
        map[user.uid].salt = salt;
        if (!saveUsers(map)) return Promise.reject({ message: 'Could not save the new password' });
        return true;
      });
    });
  }

  /* -------------------------------------------------------------- session */
  function startSession(uid, user, remember, isNew) {
    // Supabase owns the session. Login must not rewrite balances or KYC.
    if (remote()) return;
    var s = ls();
    var forever = remember === true;
    try { if (s && s.removeItem) s.removeItem(K.session); } catch (e) {}

    set(K.uid, uid);
    set(K.name, user.name);
    set(K.email, user.email);
    set(K.loginTime, Date.now());

    if (isNew || !get(K.registeredAt)) set(K.registeredAt, user.created || Date.now());
    if (isNew || get(K.kyc) === null) set(K.kyc, 'none');

    // Rehydrate this account's own portfolio into the working keys.
    if (isNew) { set(K.cash, 0); set(K.assets, JSON.stringify(emptyAssets())); set(K.funding, 0); }
    else {
      set(K.cash, user.cash === undefined || user.cash === null ? 0 : user.cash);
      set(K.assets, JSON.stringify(user.assets && typeof user.assets === 'object' ? user.assets : emptyAssets()));
      if (user.funding === undefined || user.funding === null) user.funding = 0;
      set(K.funding, Math.max(0, numv(user.funding)));
    }

    // "Remember me" survives a browser restart; otherwise sessionStorage.
    var token = { uid: uid, at: Date.now() };
    try {
      if (forever) s.setItem(K.session, JSON.stringify(token));
      else if (global.sessionStorage) global.sessionStorage.setItem(K.session, JSON.stringify(token));
    } catch (e) {}
  }

  function currentUser() {
    var uid = get(K.uid);
    if (!uid) return null;
    var map = allUsers();
    var u = map[uid];
    if (u) return u;
    // Session restored from a sessionStorage token with no local record.
    return { uid: uid, name: get(K.name, 'User'), email: get(K.email, 'user@email.com') };
  }

  function isAuthenticated() { return remote() ? !!(BB.isOn() && BB.profile() && !BB.profile().disabled) : !!get(K.uid); }

  function displayName() {
    var u = currentUser();
    var n = (u && u.name) || get(K.name, 'User');
    return String(n).split(' ')[0] || 'User';
  }

  async function logout() {
    if (remote()) {
      await BB.flush();
      var result = await BB.client().auth.signOut();
      if (result.error) throw result.error;
    }
    [K.cash,K.funding,K.assets,K.kyc,K.loginTime,K.registeredAt,K.name,K.email,K.pass,K.uid,K.session].forEach(del);
    try { global.sessionStorage.removeItem(K.session); } catch (e) {}
  }

  /* ------------------------------------------------------------ portfolio */
  /* Balances live on the account record so each account keeps its own funds
     when users swap on the same browser. The bb_cash_balance / bb_asset_balances
     keys are mirrored for compatibility with the original site's key names. */

  function currentRecord() {
    var uid = get(K.uid);
    if (!uid) return null;
    var map = allUsers();
    return map[uid] || null;
  }

  function persist(rec) {
    var map = allUsers();
    map[rec.uid] = rec;
    saveUsers(map);
  }

  /* When the profile row cannot be read or created, say why. The bare "no
     profile record" sent everyone looking at the wrong layer; this names the
     statement Postgres actually refused. */
  function profileProblem() {
    var why = (BB && BB.profileError && BB.profileError()) || '';
    return why ? ' Database said: ' + why : '';
  }

  /* ---------------------------------------------------------------- admin
     With a database the admin flag is a column on the profile row, so it can no
     longer be typed into devtools: the schema's trigger only lets an admin
     change it. These functions stay synchronous for the console's sake - they
     update the mirror and queue the write, and the database has the last word. */
  function isAdmin() {
    var rec = currentRecord();
    return !!(rec && rec.admin === true);
  }

  /* ------------------------------------------------------------ admin roles
     Two kinds of admin. The first admin *owns* the console: they hold every
     permission, cannot be demoted or deleted, and are the only role that can
     hand out or revoke admin access. Every other admin is secondary, and the
     first admin decides - per admin, per action - what they may do.

     Secondary admins can open every view. What is limited is what they can
     change, which is the part that moves money or edits accounts. They can
     still ask to become the first admin; that one move is settled by the admin
     password rather than by the current role, see setOwnerAs below. */
  var PERMISSIONS = [
    { key: 'approveDeposits',    label: 'Approve deposits',    hint: 'Credit a submitted deposit to the user. Rejections come with this too.' },
    { key: 'approveWithdrawals', label: 'Approve withdrawals', hint: 'Release a withdrawal, or reject it and return the held funds.' },
    { key: 'approveLoans',       label: 'Approve loans',       hint: 'Release borrowed funds and mark loans settled.' },
    { key: 'reviewKyc',          label: 'Review KYC',          hint: 'Approve or reject submitted identity documents.' },
    { key: 'replySupport',       label: 'Reply to support',    hint: 'Answer customers in the chat panel.' },
    { key: 'adjustBalances',     label: 'Adjust balances',     hint: 'Credit, debit or set any balance by hand.' },
    { key: 'editUsers',          label: 'Edit users',          hint: 'Change names, emails, cash and profit mode.' },
    { key: 'deleteRecords',      label: 'Delete records',      hint: 'Remove users, trades and support tickets.' },
    { key: 'exportData',         label: 'Export data',         hint: 'Download ledgers as CSV or JSON.' },
    { key: 'consoleSettings',    label: 'Console settings',    hint: 'Change the admin access password and reset demo data.' }
  ];
  var PERM_KEYS = PERMISSIONS.map(function (p) { return p.key; });

  function isOwner(uid) {
    var rec = uid ? allUsers()[uid] : currentRecord();
    return !!(rec && rec.owner === true);
  }

  /* Effective permissions for one account, or the signed-in one by default.
     Returns null when the account is not an admin at all. */
  function adminPerms(uid) {
    var rec = uid ? allUsers()[uid] : currentRecord();
    if (!rec || rec.admin !== true) return null;
    if (rec.owner === true) {
      var all = {};
      PERM_KEYS.forEach(function (k) { all[k] = true; });
      return all;
    }
    var out = {};
    PERM_KEYS.forEach(function (k) { out[k] = !!(rec.perms && rec.perms[k] === true); });
    return out;
  }

  function adminCan(key) {
    var p = adminPerms();
    return !!(p && p[key]);
  }

  /* Only the owner may change what another admin is allowed to do, and the
     owner's own row is deliberately not editable this way. */
  function setAdminPerms(uid, perms) {
    if (!isOwner()) return false;
    var map = allUsers();
    if (!map[uid] || map[uid].admin !== true) return false;
    if (map[uid].owner === true) return false;
    var next = {};
    PERM_KEYS.forEach(function (k) { next[k] = !!(perms && perms[k] === true); });
    map[uid].perms = next;
    return saveUsers(map);
  }

  /* Granting or revoking admin is the owner's call alone. `force` exists for
     one path only: entering the correct access password from the gate, which
     is how the very first owner comes into existence. */
  function setAdminAs(uid, on, force) {
    var map = allUsers();
    if (!map[uid]) return false;
    if (!force && !isOwner()) return false;
    if (on) {
      map[uid].admin = true;
      // The first admin ever promoted owns the console, and this path will not
      // mint a second one. Ownership only ever moves through setOwnerAs, which
      // is gated on the admin password.
      var hasOwner = Object.keys(map).some(function (k) { return map[k].owner === true; });
      if (!hasOwner) map[uid].owner = true;
    } else {
      if (map[uid].owner === true) return false;   // the owner cannot be removed
      delete map[uid].admin;
      delete map[uid].perms;
    }
    var saved = saveUsers(map);
    if (saved && BB && BB.isOn()) BB.audit('admin.access', uid, { on: !!on });
    return saved;
  }

  function setAdmin(uid, on) { return setAdminAs(uid, on, false); }

  /* ------------------------------------------------------- owner handover
     The console has one owner at a time, and becoming that owner is gated on
     the admin password - not on the current admin role. A secondary admin can
     ask for the role, but only the right password grants it, so an open
     browser session alone is never enough. Granting it hands the console
     across: the previous owner stays an admin but loses the owner flag and
     starts again with every permission off, and the new owner holds them all.

     Stepping down works the same way and needs the password too, which is also
     why it is safe: whoever claims the role next has to know the password, so
     a console can never end up with nobody able to manage admins. */
  function setOwnerAs(uid, on, pw) {
    var map = allUsers();
    if (!map[uid]) return Promise.reject({ message: 'No such account' });
    if (!isAdmin()) return Promise.reject({ message: 'Only an admin can change the first admin' });
    return checkAdminPassword(pw).then(function () {
      var m = allUsers();
      if (!m[uid]) return Promise.reject({ message: 'No such account' });
      if (on) {
        // One owner only - the console moves rather than forks.
        Object.keys(m).forEach(function (k) { if (k !== uid) delete m[k].owner; });
        m[uid].admin = true;
        m[uid].owner = true;
        delete m[uid].perms;      // the owner holds every permission by role
      } else if (m[uid].owner === true) {
        delete m[uid].owner;
      }
      if (!saveUsers(m)) return Promise.reject({ message: 'Could not save the account store' });
      if (BB && BB.isOn()) BB.audit('admin.owner', uid, { owner: !!on });
      return true;
    });
  }

  function ownerUid() {
    var map = allUsers();
    var found = Object.keys(map).filter(function (k) { return map[k].owner === true; })[0];
    return found || '';
  }

  /* ------------------------------------------------------ admin password
     One password guards admin access. An account flagged admin walks straight
     in; anyone else is asked for this before they can become an admin, and
     the right answer promotes them on the spot.

     It ships as the documented default and is changeable from Admin Settings.
     The hash lives in this browser, so it stops casual access on a shared
     machine but is not a security boundary - devtools can read or replace it.
     Only a server can make it one. */
  var DEFAULT_ADMIN_PASSWORD = 'admin123';

  function setAdminPassword(pw) {
    if (!pw || pw.length < 6) {
      return Promise.reject({ message: 'Use at least 6 characters' });
    }
    var salt = randomSalt();
    return hashPassword(pw, salt).then(function (h) {
      set(K.adminLock, h);
      return true;
    });
  }

  /* Seeds the documented default on first use, so the console is never
     unopenable. */
  function adminPasswordStored() {
    var stored = get(K.adminLock, '');
    if (stored) return Promise.resolve(stored);
    return hashPassword(DEFAULT_ADMIN_PASSWORD, 'bb-admin-default').then(function (h) {
      set(K.adminLock, h);
      return h;
    });
  }

  function checkAdminPassword(pw) {
    if (!pw) return Promise.reject({ message: 'Enter the admin password' });
    return adminPasswordStored().then(function (stored) {
      return verifyPassword(pw, stored);
    }).then(function (ok) {
      if (!ok) return Promise.reject({ message: 'Incorrect admin password' });
      return true;
    });
  }

  function changeAdminPassword(current, next) {
    if (!current) return Promise.reject({ message: 'Enter the current admin password' });
    return adminPasswordStored().then(function (stored) {
      return verifyPassword(current, stored);
    }).then(function (ok) {
      if (!ok) return Promise.reject({ message: 'Incorrect admin password' });
      return setAdminPassword(next);
    });
  }

  /* The password is what lets a non-admin into the console. With a database the
     promotion itself is a profile column that only an admin may write, so the
     password confirms the console's shared secret and the database has the last
     word on whether the change is allowed. Without a database this is still the
     path that mints the very first admin. */
  function unlockAsAdmin(pw) {
    return checkAdminPassword(pw).then(function () {
      var me = get(K.uid, '');
      if (!me) return Promise.reject({ message: 'Sign in first' });
      if (BB && BB.isOn()) {
        return BB.saveProfileFor(me, { admin: true }).then(function (res) {
          if (!res || res.error) return Promise.reject({ message: 'Only the first admin can grant access now' });
          var map = allUsers();
          if (map[me]) map[me].admin = true;
          saveUsers(map);
          return true;
        }).catch(function (e) {
          return Promise.reject({ message: (e && e.message) || 'Only the first admin can grant access now' });
        });
      }
      setAdminAs(me, true, true);
      return true;
    });
  }

  /* Same, for the funding wallet of any account. */
  function adminSetFunding(uid, v) {
    var map = allUsers();
    var rec = map[uid];
    if (!rec) return false;
    var val = Math.max(0, numv(v));
    rec.funding = val;
    if (!saveUsers(map)) return false;
    if (uid === get(K.uid)) set(K.funding, val);
    return true;
  }

  /* Suspend or restore an account. A disabled account keeps its data and its
     session record but cannot sign in again. */
  function setDisabled(uid, off) {
    var map = allUsers();
    if (!map[uid]) return false;
    if (off) delete map[uid].disabled; else map[uid].disabled = true;
    return saveUsers(map);
  }

  function isDisabled(uid) {
    var map = allUsers();
    return !!(map[uid] && map[uid].disabled === true);
  }

  function adminSetCash(uid, v) {
    var map = allUsers();
    var rec = map[uid];
    if (!rec) return false;
    var val = Math.max(0, numv(v));
    rec.cash = val;
    var a = (rec.assets && typeof rec.assets === 'object') ? rec.assets : emptyAssets();
    Object.keys(emptyAssets()).forEach(function (c) { if (!a[c]) a[c] = emptyAssets()[c]; });
    a.USDT = { balance: val, qty: val };
    rec.assets = a;
    if (!saveUsers(map)) return false;
    // Keep the live session's mirrored keys in step when it is the same user.
    if (uid === get(K.uid)) { set(K.cash, val); set(K.assets, JSON.stringify(a)); }
    return true;
  }

  /* Same, for one coin of any account - used when a deposit is approved. */
  function adminAddAsset(uid, coin, qty) {
    var map = allUsers();
    var rec = map[uid];
    if (!rec) return false;
    var a = (rec.assets && typeof rec.assets === 'object') ? rec.assets : emptyAssets();
    var fresh = emptyAssets();
    Object.keys(fresh).forEach(function (c) { if (!a[c]) a[c] = fresh[c]; });
    a[coin] = a[coin] || { balance: 0, qty: 0 };
    a[coin].qty = Math.max(0, numv(a[coin].qty) + numv(qty));
    a[coin].balance = a[coin].qty;
    rec.assets = a;
    if (!saveUsers(map)) return false;
    if (uid === get(K.uid)) set(K.assets, JSON.stringify(a));
    return true;
  }

  /* Every account on file, oldest first. */
  function allAccounts() {
    var map = allUsers();
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return (a.created || 0) - (b.created || 0); });
  }

  /* Remove an account and everything it owns. Refuses on the owner, and on the
     last admin, so the console can never be locked out with no way back in.
     With a database the profile row goes first and every table cascades from
     it - ledgers, threads and settings all disappear with the account.
     Always returns a promise so callers do not have to handle a bare boolean. */
  function deleteAccount(uid) {
    var map = allUsers();
    if (!map[uid]) return Promise.reject({ message: 'No such account' });
    if (map[uid].owner === true) return Promise.reject({ message: 'The console owner cannot be deleted' });
    var admins = Object.keys(map).filter(function (k) { return map[k].admin === true; });
    if (map[uid].admin === true && admins.length <= 1) {
      return Promise.reject({ message: 'Cannot delete the last remaining admin' });
    }
    if (BB && BB.isOn()) {
      return BB.deleteAccountFor(uid).then(function () {
        BB.audit('account.delete', uid, { name: map[uid].name });
        delete map[uid];
        if (BB.mirror[K.users + ':snapshot']) delete BB.mirror[K.users + ':snapshot'][uid];
        return true;
      }).catch(function (e) {
        return Promise.reject({ message: (e && e.message) || 'Could not delete that account' });
      });
    }
    delete map[uid];
    if (!saveUsers(map)) return Promise.reject({ message: 'Could not save the account store' });
    // Ledgers, positions and per-user preferences.
    ['bb_activity', 'bb_deposit_requests', 'bb_withdrawal_requests', 'bb_transfer_requests',
     'bb_convert_requests', 'bb_borrow_requests', 'bb_trade_requests', 'bb_trades_history',
     'bb_trade_positions', 'bb_login_log'].forEach(function (key) {
      var list = readJSON(key, null);
      if (!Array.isArray(list)) return;
      var kept = list.filter(function (r) { return (r.uid || r.userId) !== uid; });
      writeJSON(key, kept);
    });
    ['bb_notifications', 'bb_preferences'].forEach(function (key) {
      var rec = readJSON(key, null);
      if (rec && typeof rec === 'object' && rec[uid]) { delete rec[uid]; writeJSON(key, rec); }
    });
    return Promise.resolve(true);
  }

  function cash() {
    var rec = currentRecord();
    if (rec && rec.cash !== undefined && rec.cash !== null) return numv(rec.cash);
    return numv(get(K.cash, '0'));
  }

  function assets() {
    var rec = currentRecord();
    var a = (rec && rec.assets && typeof rec.assets === 'object') ? rec.assets : readJSON(K.assets, null);
    if (!a || typeof a !== 'object') a = emptyAssets();
    var fresh = emptyAssets();
    Object.keys(fresh).forEach(function (c) {
      if (!a[c] || typeof a[c] !== 'object') a[c] = fresh[c];
    });
    a.USDT = { balance: cash(), qty: cash() };
    return a;
  }

  function syncPortfolio() {
    var rec = currentRecord();
    var a = assets();
    set(K.cash, cash());
    set(K.assets, JSON.stringify(a));
    if (rec) { rec.cash = cash(); rec.assets = a; persist(rec); }
  }

  /* Funding wallet (USDT only). Kept on the account record so one user can
     never inherit another user's balance; the old flat key is only read once
     as a migration source. */
  function funding() {
    var rec = currentRecord();
    if (!rec) return 0;
    if (rec.funding === undefined || rec.funding === null) {
      var legacy = readJSON(K.funding, null);
      rec.funding = (legacy === null || !isFinite(legacy)) ? 0 : Math.max(0, numv(legacy));
      persist(rec);
    }
    return Math.max(0, numv(rec.funding));
  }

  function setFunding(v) {
    var val = Math.max(0, numv(v));
    set(K.funding, val);
    var rec = currentRecord();
    if (rec) { rec.funding = val; persist(rec); }
    return val;
  }

  function numv(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

  function setCash(v) {
    var rec = currentRecord();
    var val = Math.max(0, numv(v));
    if (rec) { rec.cash = val; persist(rec); }
    set(K.cash, val);
    var a = assets();
    a.USDT = { balance: val, qty: val };
    set(K.assets, JSON.stringify(a));
    if (rec) { rec.assets = a; persist(rec); }
    return val;
  }

  function setAssetQty(sym, qty) {
    var rec = currentRecord();
    var a = assets();
    a[sym] = { balance: numv(qty), qty: numv(qty) };
    if (sym === 'USDT') { set(K.cash, a.USDT.qty); if (rec) rec.cash = a.USDT.qty; }
    set(K.assets, JSON.stringify(a));
    if (rec) { rec.assets = a; persist(rec); }
    return a;
  }

  var activity = {
    add: function (kind, row) {
      var key = 'bb_' + kind + '_requests';
      var list = readJSON(key, []) || [];
      row.userId = get(K.uid, '');
      row.time = row.time || Date.now();
      list.unshift(row);
      writeJSON(key, list.slice(0, 200));
    },
    list: function (kind) {
      var uid = get(K.uid, '');
      var list = readJSON('bb_' + kind + '_requests', []) || [];
      return list.filter(function (r) {
        return (!r.userId && !uid) || String(r.userId) === String(uid);
      });
    }
  };

  global.BitbaseAuth = {
    KEYS: K,
    COINS: COINS,
    EMAIL_RE: EMAIL_RE,
    get: get, set: set, del: del,
    readJSON: readJSON, writeJSON: writeJSON,
    register: register,
    login: login,
    resetPassword: resetPassword,
    changePassword: changePassword,
    logout: logout,
    currentUser: currentUser,
    isAdmin: isAdmin,
    setAdmin: setAdmin,
    setOwnerAs: setOwnerAs,
    PERMISSIONS: PERMISSIONS,
    PERM_KEYS: PERM_KEYS,
    isOwner: isOwner,
    ownerUid: ownerUid,
    adminPerms: adminPerms,
    adminCan: adminCan,
    setAdminPerms: setAdminPerms,
    DEFAULT_ADMIN_PASSWORD: DEFAULT_ADMIN_PASSWORD,
    setAdminPassword: setAdminPassword,
    checkAdminPassword: checkAdminPassword,
    changeAdminPassword: changeAdminPassword,
    unlockAsAdmin: unlockAsAdmin,
    setDisabled: setDisabled,
    isDisabled: isDisabled,
    adminSetCash: adminSetCash,
    adminAddAsset: adminAddAsset,
    adminSetFunding: adminSetFunding,
    allAccounts: allAccounts,
    deleteAccount: deleteAccount,
    isAuthenticated: isAuthenticated,
    displayName: displayName,
    cash: cash, setCash: setCash,
    funding: funding, setFunding: setFunding,
    assets: assets, setAssetQty: setAssetQty,
    activity: activity,
    whenReady: whenReady,
    isRemote: remote,
    flush: function () { return remote() ? BB.flush() : Promise.resolve(true); },
    dbStatus: function () { return BB ? BB.status() : 'local'; },
    dbError: function () { return BB ? BB.error() : null; },
    storageAvailable: function () { return !!ls(); },
    storagePersistent: storagePersistent
  };
})(window);
