/* ==========================================================================
   Bitbase – settings page
   Everything here persists: profile edits write back to the account record,
   the password change re-hashes, notification toggles and preferences are
   stored, the theme applies live, and the verification flows update the
   account's kyc / phone state.
   ========================================================================== */
(function (global) {
  'use strict';

  var A = global.BitbaseAuth;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  if (!global.BitbaseShell.mount({ active: 'settings' })) return;

  var PREF_KEY = 'bb_preferences';
  var NOTIFY_KEY = 'bb_notification_prefs';

  var NOTIFICATIONS = [
    { id: 'email',      label: 'Email Notifications',      help: 'Receive updates via email',              on: true },
    { id: 'priceAlerts',label: 'Price Alerts',             help: 'Get notified when prices hit your targets', on: true },
    { id: 'deposits',   label: 'Deposit Confirmations',    help: 'Notifications for successful deposits',  on: true },
    { id: 'withdrawals',label: 'Withdrawal Confirmations', help: 'Notifications for withdrawal requests', on: true },
    { id: 'security',   label: 'Security Alerts',         help: '',                                       on: true, required: true },
    { id: 'marketing',  label: 'Marketing Emails',        help: 'Promotional offers and news',            on: false }
  ];

  var COUNTRIES = ['United States','United Kingdom','Canada','Australia','Germany','France','Japan','South Korea',
    'India','Brazil','Nigeria','Singapore','United Arab Emirates','Other'];

  var DIAL_CODES = [
    ['+1','US / CA'],['+44','UK'],['+49','DE'],['+33','FR'],['+34','ES'],['+39','IT'],['+31','NL'],
    ['+46','SE'],['+47','NO'],['+45','DK'],['+48','PL'],['+41','CH'],['+43','AT'],['+353','IE'],
    ['+61','AU'],['+64','NZ'],['+65','SG'],['+66','TH'],['+81','JP'],['+82','KR'],['+84','VN'],
    ['+86','CN'],['+90','TR'],['+91','IN'],['+92','PK'],['+971','AE'],['+966','SA'],['+972','IL'],
    ['+27','ZA'],['+20','EG'],['+234','NG'],['+254','KE'],['+55','BR'],['+52','MX'],['+54','AR']
  ];

  function esc(s) { return global.BitbaseShell.esc(s); }
  function say(msg, sel) {
    var e = $(sel);
    if (!e) return;
    e.textContent = msg;
    e.classList.remove('hidden');
  }
  function hush(sel) { var e = $(sel); if (e) e.classList.add('hidden'); }

  /* ------------------------------------------------------------- profile */
  function loadProfile() {
    var u = A.currentUser() || {};
    var rec = A.readJSON(A.KEYS.users, {})[A.get(A.KEYS.uid, '')] || {};
    $('#settingsName').value = rec.name || u.name || '';
    $('#settingsEmail').value = rec.email || u.email || '';
    $('#uidField').value = A.get(A.KEYS.uid, '');
    $('#settingsUsername').value = rec.username || '@' + String(rec.name || 'user').split(' ')[0].toLowerCase();
    $('#settingsPhone').value = rec.phone || '';
    $('#settingsCountry').value = rec.country || 'us';
    var av = $('#profileAvatar');
    if (av) av.textContent = String(rec.name || 'U').charAt(0).toUpperCase();
  }

  function saveProfile() {
    var name = String($('#settingsName').value || '').trim();
    var username = String($('#settingsUsername').value || '').trim();
    var phone = String($('#settingsPhone').value || '').trim();
    var country = $('#settingsCountry').value;
    if (!name) { say('Display name cannot be empty', '#profileSaved'); $('#profileSaved').style.color = '#ea3943'; return; }
    if (phone && !/^[0-9\s+()-]{6,20}$/.test(phone)) { say('Enter a valid phone number', '#profileSaved'); $('#profileSaved').style.color = '#ea3943'; return; }

    var uid = A.get(A.KEYS.uid, '');
    var map = A.readJSON(A.KEYS.users, {}) || {};
    if (map[uid]) {
      map[uid].name = name;
      map[uid].username = username;
      map[uid].phone = phone;
      map[uid].country = country;
      A.writeJSON(A.KEYS.users, map);
    }
    A.set(A.KEYS.name, name);
    global.BitbaseShell.paintIdentity();
    loadProfile();
    var p = $('#profileSaved');
    p.textContent = 'Profile updated.';
    p.style.color = '#16c784';
    p.classList.remove('hidden');
  }

  /* ------------------------------------------------------------ security */
  function deviceLabel() {
    var ua = navigator.userAgent;
    var os = /Windows/i.test(ua) ? 'Windows' : /Mac OS/i.test(ua) ? 'macOS' : /Android/i.test(ua) ? 'Android'
      : /iPhone|iPad/i.test(ua) ? 'iOS' : /Linux/i.test(ua) ? 'Linux' : 'Unknown OS';
    var br = /Edg\//i.test(ua) ? 'Edge' : /OPR\//i.test(ua) ? 'Opera' : /Chrome\//i.test(ua) ? 'Chrome'
      : /Firefox\//i.test(ua) ? 'Firefox' : /Safari\//i.test(ua) ? 'Safari' : 'Browser';
    return br + ' on ' + os;
  }

  function renderLoginActivity() {
    var t = num(A.get(A.KEYS.loginTime, 0));
    var when = t ? new Date(t) : null;
    var stamp = when
      ? when.toLocaleDateString() + ' ' + ('0' + when.getHours()).slice(-2) + ':' + ('0' + when.getMinutes()).slice(-2)
      : 'This session';
    $('#loginActivityBody').innerHTML =
      '<tr>' +
        '<td class="py-3 font-mono text-sm" style="color:var(--text-secondary);">&mdash;</td>' +
        '<td class="py-3 text-sm">' + esc(deviceLabel()) +
          ' <span class="badge-green" style="margin-left:6px;">Current</span></td>' +
        '<td class="py-3 text-sm" style="color:var(--text-secondary);">This device</td>' +
        '<td class="py-3 text-sm" style="color:var(--text-secondary);">' + stamp + '</td>' +
      '</tr>';
  }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

  function updatePassword() {
    hush('#pwError');
    var cur = $('#pwCurrent').value;
    var next = $('#pwNew').value;
    var conf = $('#pwConfirm').value;
    if (!cur) { say('Enter your current password', '#pwError'); return; }
    if (!next || next.length < 8) { say('New password must be at least 8 characters', '#pwError'); return; }
    if (next !== conf) { say('New passwords do not match', '#pwError'); return; }
    if (next === cur) { say('Choose a password different from the current one', '#pwError'); return; }

    var uid = A.get(A.KEYS.uid, '');
    var map = A.readJSON(A.KEYS.users, {}) || {};
    if (!map[uid]) { say('Could not find your account', '#pwError'); return; }
    A.changePassword(map[uid].email, cur, next).then(function () {
      ['pwCurrent', 'pwNew', 'pwConfirm'].forEach(function (id) { $('#' + id).value = ''; });
      var box = $('#pwError');
      box.textContent = 'Password updated.';
      box.style.color = '#16c784';
      box.classList.remove('hidden');
      setTimeout(function () { box.style.color = '#ea3943'; box.classList.add('hidden'); }, 2600);
    }).catch(function (e) {
      say((e && e.message) || 'Could not update the password', '#pwError');
    });
  }

  /* -------------------------------------------------------- notifications */
  function loadNotify() {
    var saved = A.readJSON(NOTIFY_KEY, {}) || {};
    $('#notifyList').innerHTML = NOTIFICATIONS.map(function (n) {
      var on = saved[n.id] === undefined ? n.on : !!saved[n.id];
      var badge = n.required
        ? '<span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase" style="background:rgba(247,147,26,0.1);color:var(--accent-orange);">Required</span>'
        : '';
      return '<div class="flex items-center justify-between py-2" style="border-bottom:1px solid var(--border-subtle);' + (n.required ? '' : 'padding-bottom:14px;') + '">' +
        '<div>' + (badge
          ? '<div class="flex items-center gap-2"><div class="text-sm font-medium">' + n.label + '</div>' + badge + '</div>'
          : '<div class="text-sm font-medium">' + n.label + '</div>') +
          (n.help ? '<div class="text-xs" style="color:var(--text-tertiary);margin-top:2px;">' + n.help + '</div>' : '') +
        '</div>' +
        '<div class="toggle-switch' + (on ? ' on' : '') + '" data-notify="' + n.id + '"' + (n.required ? ' style="opacity:.7;pointer-events:none;"' : '') + '>' +
          '<div class="toggle-knob"></div></div>' +
      '</div>';
    }).join('');

    $$('[data-notify]').forEach(function (t) {
      t.addEventListener('click', function () {
        t.classList.toggle('on');
        var s = A.readJSON(NOTIFY_KEY, {}) || {};
        s[t.dataset.notify] = t.classList.contains('on');
        A.writeJSON(NOTIFY_KEY, s);
      });
    });
  }

  /* ---------------------------------------------------------- preferences */
  function radio(groupId, value) {
    $$('#' + groupId + ' .radio-option').forEach(function (r) {
      r.classList.toggle('selected', r.dataset.value === value);
    });
  }
  function radioValue(groupId) {
    var el = $('#' + groupId + ' .radio-option.selected');
    return el ? el.dataset.value : null;
  }

  function applyTheme(theme) {
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
  }

  function loadPrefs() {
    var p = A.readJSON(PREF_KEY, {}) || {};
    if (p.language) $('#prefLanguage').value = p.language;
    if (p.currency) $('#prefCurrency').value = p.currency;
    if (p.timezone) $('#prefTimezone').value = p.timezone;
    radio('prefThemeGroup', p.theme || 'dark');
    radio('prefTradingViewGroup', p.tradingView || 'advanced');
    applyTheme(p.theme || 'dark');
  }

  function savePrefs() {
    var p = A.readJSON(PREF_KEY, {}) || {};
    p.language = $('#prefLanguage').value;
    p.currency = $('#prefCurrency').value;
    p.timezone = $('#prefTimezone').value;
    p.theme = radioValue('prefThemeGroup');
    p.tradingView = radioValue('prefTradingViewGroup');
    A.writeJSON(PREF_KEY, p);
    applyTheme(p.theme);
    var el = $('#prefsSaved');
    el.textContent = 'Preferences saved.';
    el.classList.remove('hidden');
  }

  function wireRadio() {
    ['prefThemeGroup', 'prefTradingViewGroup'].forEach(function (id) {
      $$('#' + id + ' .radio-option').forEach(function (r) {
        r.addEventListener('click', function () {
          radio(id, r.dataset.value);
          // Theme previews live, matching the original's behaviour.
          if (id === 'prefThemeGroup') {
            applyTheme(r.dataset.value);
            var p = A.readJSON(PREF_KEY, {}) || {};
            p.theme = r.dataset.value;
            A.writeJSON(PREF_KEY, p);
          }
        });
      });
    });
  }

  /* ---------------------------------------------------------- phone verify */
  function openPhone() {
    var sel = $('#phoneCountryCode');
    sel.innerHTML = DIAL_CODES.map(function (d) { return '<option value="' + d[0] + '">' + d[0] + ' ' + d[1] + '</option>'; }).join('');
    $('#phoneStep1').style.display = 'block';
    $('#phoneStep2').style.display = 'none';
    hush('#phoneError');
    $('#phoneInput').value = '';
    var m = $('#phoneVerifyModal');
    m.classList.add('open');
    m.style.display = 'flex';
  }

  function renderPhone() {
    var uid = A.get(A.KEYS.uid, '');
    var map = A.readJSON(A.KEYS.users, {}) || {};
    var rec = map[uid] || {};
    var done = !!rec.phone_verified;
    var icon = $('#phoneVerifyIcon');
    var text = $('#phoneVerifyText');
    var btn = $('#phoneVerifyBtn');
    icon.style.background = done ? 'rgba(22,199,132,0.1)' : 'rgba(247,147,26,0.1)';
    icon.innerHTML = '<i data-lucide="' + (done ? 'check-circle' : 'clock') + '" style="width:18px;height:18px;color:' + (done ? 'var(--accent-green)' : 'var(--accent-orange)') + ';"></i>';
    text.textContent = done ? ('Verified' + (rec.phone ? ' \u00b7 ' + rec.phone : '')) : 'Verify your phone number';
    if (done) {
      btn.outerHTML = '<span class="px-3 py-1 rounded-lg text-xs font-medium" style="background:rgba(22,199,132,0.1);color:var(--accent-green);">Complete</span>';
    } else {
      btn.onclick = openPhone;
    }
    if (global.lucide) global.lucide.createIcons();
  }

  function patchRecord(patch) {
    var uid = A.get(A.KEYS.uid, '');
    var map = A.readJSON(A.KEYS.users, {}) || {};
    if (!map[uid]) return;
    Object.keys(patch).forEach(function (k) { map[uid][k] = patch[k]; });
    A.writeJSON(A.KEYS.users, map);
  }

  /* ------------------------------------------------------------------ KYC */
  function renderKyc() {
    var uid = A.get(A.KEYS.uid, '');
    var map = A.readJSON(A.KEYS.users, {}) || {};
    var st = (map[uid] && map[uid].kyc_status) || 'none';
    var icon = $('#kycIcon');
    var text = $('#kycStatusText');
    var btn = $('#kycStartBtn');
    var conf = { none: ['clock', 'rgba(247,147,26,0.1)', 'var(--accent-orange)', 'Required for higher limits', 'Start', false],
                 pending: ['clock', 'rgba(247,147,26,0.1)', 'var(--accent-orange)', 'Under Review', 'Pending', true],
                 approved: ['check-circle', 'rgba(22,199,132,0.1)', 'var(--accent-green)', 'Verified', 'Complete', true],
                 rejected: ['x-circle', 'rgba(234,57,67,0.1)', '#ef4444', 'Rejected \u2014 please re-submit', 'Re-submit', false] };
    var c = conf[st] || conf.none;
    icon.style.background = c[1];
    icon.innerHTML = '<i data-lucide="' + c[0] + '" style="width:18px;height:18px;color:' + c[2] + ';"></i>';
    text.textContent = c[3];
    btn.textContent = c[4];
    btn.disabled = c[5];
    btn.style.opacity = c[5] ? '.5' : '';
    btn.style.cursor = c[5] ? 'not-allowed' : 'pointer';
    if (global.lucide) global.lucide.createIcons();
  }

  function kycStep(n) {
    [1, 2, 3].forEach(function (i) {
      $('#kycStep' + i).style.display = i === n ? 'block' : 'none';
    });
    $$('#kycProgress .kyc-step-dot').forEach(function (d) {
      var i = parseInt(d.dataset.step, 10);
      d.classList.toggle('active', i === n);
      d.classList.toggle('done', i < n);
      d.textContent = i < n ? '\u2713' : String(i);
    });
    $('#kycLine1').classList.toggle('done', n > 1);
    $('#kycLine2').classList.toggle('done', n > 2);
  }

  function openKyc() {
    var uid = A.get(A.KEYS.uid, '');
    var map = A.readJSON(A.KEYS.users, {}) || {};
    var rec = map[uid] || {};
    if (rec.kyc_first) $('#kycFirstName').value = rec.kyc_first;
    if (rec.kyc_last) $('#kycLastName').value = rec.kyc_last;
    if (rec.kyc_dob) $('#kycDOB').value = rec.kyc_dob;
    if (rec.kyc_country) $('#kycNationality').value = rec.kyc_country;
    if (rec.kyc_address) $('#kycAddress').value = rec.kyc_address;
    kycStep(1);
    var m = $('#kycModal');
    m.classList.add('open');
    m.style.display = 'flex';
  }

  function initKyc() {
    var sel = $('#kycNationality');
    sel.innerHTML = '<option value="">Select country</option>' +
      COUNTRIES.map(function (c) { return '<option>' + c + '</option>'; }).join('');

    $('#kycStartBtn').addEventListener('click', openKyc);
    $('#kycClose').addEventListener('click', function () {
      var m = $('#kycModal');
      m.classList.remove('open');
      m.style.display = 'none';
    });

    $('#kycNextBtn').addEventListener('click', function () {
      var first = $('#kycFirstName').value.trim();
      var last = $('#kycLastName').value.trim();
      var dob = $('#kycDOB').value;
      var nat = $('#kycNationality').value;
      var addr = $('#kycAddress').value.trim();
      if (!first || !last || !dob || !nat || !addr) {
        say('Fill in every field before continuing', '#kycError');
        return;
      }
      hush('#kycError');
      patchRecord({ kyc_first: first, kyc_last: last, kyc_dob: dob, kyc_country: nat, kyc_address: addr });
      kycStep(2);
    });

    $('#kycBackBtn').addEventListener('click', function () { kycStep(1); });

    function uploader(side) {
      var area = $('#kycUpload' + side);
      var input = $('#kyc' + side + 'Input');
      area.addEventListener('click', function () { input.click(); });
      input.addEventListener('change', function (e) {
        var f = e.target.files && e.target.files[0];
        if (!f) return;
        if (f.size > 10 * 1024 * 1024) { return; }
        var key = 'kyc_doc_' + side;
        var docs = A.readJSON(key, {}) || {};
        docs[side] = { name: f.name, size: f.size, at: Date.now() };
        A.writeJSON(key, docs);
        $('#kyc' + side + 'Placeholder').style.display = 'none';
        $('#kyc' + side + 'Preview').style.display = 'block';
        $('#kyc' + side + 'Name').textContent = f.name;
        if (global.lucide) global.lucide.createIcons();
      });
    }
    uploader('Front');
    uploader('Back');

    $('#kycSubmitBtn').addEventListener('click', function () {
      var docs = A.readJSON('kyc_doc_Front', {}) || {};
      if (!docs.Front) { return; }
      var rec = A.readJSON(A.KEYS.users, {})[A.get(A.KEYS.uid, '')] || {};
      var submitted = Date.now();
      patchRecord({
        kyc_status: 'pending',
        kyc_doc_type: $('#kycDocType').value,
        kyc_submitted: submitted
      });
      A.set(A.KEYS.kyc, 'pending');
      // Queue a request so the admin console can review and decide on it.
      var reqs = A.readJSON('bb_kyc_requests', []) || [];
      reqs.unshift({
        id: 'KYC-' + A.get(A.KEYS.uid, '') + '-' + submitted,
        uid: A.get(A.KEYS.uid, ''),
        name: (rec.kyc_first || '') + ' ' + (rec.kyc_last || ''),
        email: rec.email || '',
        nationality: rec.kyc_country || rec.country || '',
        docType: $('#kycDocType').value,
        docs: { front: docs.Front, back: docs.Back || null },
        status: 'pending',
        time: submitted
      });
      A.writeJSON('bb_kyc_requests', reqs.slice(0, 400));
      kycStep(3);
      renderKyc();
    });
    $('#kycFinishBtn').addEventListener('click', function () {
      var m = $('#kycModal');
      m.classList.remove('open');
      m.style.display = 'none';
    });
  }

  /* ----------------------------------------------------------------- tabs */
  function showTab(name) {
    $$('#settingsTabs .settings-tab-btn').forEach(function (b) {
      b.classList.toggle('active', b.dataset.settingsTab === name);
    });
    $$('.settings-panel').forEach(function (p) {
      p.classList.toggle('active', p.id === 'settings-' + name);
    });
    var sidebar = $('#settingsSidebar');
    if (global.innerWidth <= 640) sidebar.classList.remove('mobile-open');
    if (global.location.hash !== '#' + name) {
      try { history.replaceState(null, '', '#' + name); } catch (e) {}
    }
  }

  function boot() {
    loadProfile();
    renderLoginActivity();
    loadNotify();
    loadPrefs();
    wireRadio();
    initKyc();
    renderPhone();
    renderKyc();

    $$('#settingsTabs .settings-tab-btn').forEach(function (b) {
      b.addEventListener('click', function () { showTab(b.dataset.settingsTab); });
    });
    ['settingsBack', 'settingsBack2', 'settingsBack3', 'settingsBack4', 'settingsBack5'].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.addEventListener('click', function () { $('#settingsSidebar').classList.add('mobile-open'); });
    });

    var hash = (global.location.hash || '').replace('#', '');
    showTab(hash || 'profile');

    $('#saveProfileBtn').addEventListener('click', saveProfile);
    $('#cancelProfileBtn').addEventListener('click', loadProfile);
    $('#copyUidBtn').addEventListener('click', function () {
      var uid = $('#uidField').value;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(uid).then(function () {
          var b = $('#copyUidBtn');
          var html = b.innerHTML;
          b.textContent = 'Copied';
          setTimeout(function () { b.innerHTML = html; if (global.lucide) global.lucide.createIcons(); }, 1400);
        }, function () {});
      }
    });

    $('#updatePwBtn').addEventListener('click', updatePassword);
    $('#logoutAllBtn').addEventListener('click', function () {
      A.logout();
      global.location.href = 'login.html';
    });

    $('#savePrefsBtn').addEventListener('click', savePrefs);

    $('#phoneVerifyClose').addEventListener('click', function () {
      var m = $('#phoneVerifyModal');
      m.classList.remove('open');
      m.style.display = 'none';
    });
    $('#phoneDoneBtn').addEventListener('click', function () {
      var m = $('#phoneVerifyModal');
      m.classList.remove('open');
      m.style.display = 'none';
    });
    $('#phoneSubmitBtn').addEventListener('click', function () {
      hush('#phoneError');
      var cc = $('#phoneCountryCode').value;
      var digits = String($('#phoneInput').value || '').replace(/[^0-9]/g, '');
      if (digits.length < 6) { say('Enter at least 6 digits', '#phoneError'); return; }
      if (digits.length > 15) { say('That number looks too long', '#phoneError'); return; }
      patchRecord({ phone_verified: '1', phone: cc + ' ' + digits });
      $('#phoneStep1').style.display = 'none';
      $('#phoneStep2').style.display = 'block';
      renderPhone();
      if (global.lucide) global.lucide.createIcons();
    });

    $$('.modal-overlay').forEach(function (m) {
      m.addEventListener('click', function (e) {
        if (e.target === m) { m.classList.remove('open'); m.style.display = 'none'; }
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      $$('.modal-overlay.open').forEach(function (m) { m.classList.remove('open'); m.style.display = 'none'; });
    });

    global.addEventListener('hashchange', function () {
      var h = (global.location.hash || '').replace('#', '');
      if (h) showTab(h);
    });
  }
// Nothing renders until the database mirror is filled, so the first
  // paint is already the user's own data rather than a blank frame.
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', function () { A.whenReady(boot); });
  else A.whenReady(boot);
})(window);
