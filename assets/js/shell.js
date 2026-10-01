/* ==========================================================================
   Bitbase – shared app shell
   Renders the dashboard header, mobile drawer and bottom bar from one nav
   definition so every authenticated page stays byte-identical. Also handles
   the auth guard and identity painting.
   ========================================================================== */
(function (global) {
  'use strict';

  var A = global.BitbaseAuth;

  var NAV = [
    { id: 'dashboard', label: 'Dashboard', href: 'dashboard.html' },
    { id: 'assets',    label: 'Assets',    href: 'assets.html' },
    { id: 'markets',   label: 'Markets',   href: 'markets.html' },
    { id: 'trade',     label: 'Trade',     href: 'trade.html' },
    { id: 'history',   label: 'History',   href: 'history.html' },
    { id: 'demo',      label: 'Demo',      href: 'demo.html' },
    { id: 'settings',  label: 'Settings',  href: 'settings.html' },
    // Only rendered for accounts flagged as admin.
    { id: 'admin',     label: 'Admin',     href: 'admin.html', admin: true }
  ];

  var BOTTOM = [
    { id: 'dashboard', label: 'Home',    icon: 'bitcoin', href: 'dashboard.html', logo: true },
    { id: 'assets',    label: 'Assets',  icon: 'wallet',  href: 'assets.html' },
    { id: 'trade',     label: 'Trade',   icon: 'arrow-left-right', href: 'trade.html' },
    { id: 'markets',   label: 'Markets', icon: 'bar-chart-3',      href: 'markets.html' },
    { id: 'history',   label: 'History', icon: 'history',          href: 'history.html' }
  ];

  var LOGO =
    '<div style="width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,#F7931A,#FDB022);display:flex;align-items:center;justify-content:center;">' +
    '<i data-lucide="bitcoin" style="width:16px;height:16px;color:#fff;"></i></div>';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* The admin link only appears for accounts carrying admin:true. */
  function navFor() {
    return NAV.filter(function (n) { return !n.admin || (A && A.isAdmin()); });
  }

  function headerHtml(active, badge) {
    return '' +
      '<div class="flex items-center gap-2">' +
        '<a href="index.html" class="flex items-center gap-2">' + LOGO +
          '<span class="font-heading" style="font-size:20px;font-weight:700;letter-spacing:-0.02em;">BITBASE</span>' +
        '</a>' +
      '</div>' +
      '<nav class="dash-nav">' +
        navFor().map(function (n) {
          return '<a href="' + n.href + '"' + (n.id === active ? ' class="active"' : '') + '>' + n.label + '</a>';
        }).join('') +
      '</nav>' +
      '<div class="dash-right">' +
        '<div class="user-pill">' +
          '<div class="user-avatar">U</div>' +
          '<div>' +
            '<div class="user-name" style="font-size:13px;font-weight:500;">User</div>' +
            '<div class="user-email" style="font-size:11px;color:var(--text-tertiary);">user@email.com</div>' +
          '</div>' +
        '</div>' +
        (badge || '') +
        '<a href="assets.html" class="deposit-btn"><i data-lucide="plus" style="width:14px;height:14px;"></i> Deposit</a>' +
        '<button class="lg:hidden" id="shellMenuBtn" style="width:36px;height:36px;display:flex;align-items:center;justify-content:center;">' +
          '<i data-lucide="menu" style="width:20px;height:20px;"></i>' +
        '</button>' +
      '</div>';
  }

  function drawerHtml(active) {
    return '' +
      '<div class="flex justify-between items-center mb-6">' +
        '<span class="font-heading font-bold text-lg">Menu</span>' +
        '<button id="shellNavClose" aria-label="Close menu"><i data-lucide="x" style="width:20px;height:20px;"></i></button>' +
      '</div>' +
      navFor().map(function (n) {
        return '<a href="' + n.href + '"' + (n.id === active ? ' class="active"' : '') + '>' + n.label + '</a>';
      }).join('') +
      '<a href="index.html" style="color:var(--accent-orange);">Back to Homepage</a>' +
      '<a href="#" id="shellLogout" style="color:var(--accent-red);">Logout</a>';
  }

  function bottomHtml(active) {
    return BOTTOM.map(function (n) {
      var glyph = n.logo
        ? '<div style="width:24px;height:24px;border-radius:7px;background:linear-gradient(135deg,#F7931A,#FDB022);display:flex;align-items:center;justify-content:center;">' +
          '<i data-lucide="' + n.icon + '" style="width:14px;height:14px;color:#fff;"></i></div>'
        : '<i data-lucide="' + n.icon + '"></i>';
      return '<a href="' + n.href + '"' + (n.id === active ? ' class="active"' : '') + '>' + glyph + n.label + '</a>';
    }).join('');
  }

  function paintIdentity() {
    var u = A.currentUser() || {};
    var first = String(u.name || 'User').split(' ')[0] || 'User';
    Array.prototype.forEach.call(document.querySelectorAll('.user-avatar'), function (a) {
      a.textContent = first.charAt(0).toUpperCase();
    });
    Array.prototype.forEach.call(document.querySelectorAll('.user-name'), function (d) {
      d.textContent = first;
    });
    Array.prototype.forEach.call(document.querySelectorAll('.user-email'), function (d) {
      d.textContent = u.email || 'user@email.com';
    });
    var welcome = document.getElementById('dashUserName');
    if (welcome) welcome.textContent = first;
  }

  function wireDrawer() {
    var open = document.getElementById('shellMenuBtn');
    var drawer = document.getElementById('mobileNav');
    var close = document.getElementById('shellNavClose');
    if (open && drawer) open.addEventListener('click', function () { drawer.classList.add('open'); });
    if (close && drawer) close.addEventListener('click', function () { drawer.classList.remove('open'); });
    if (drawer) drawer.addEventListener('click', function (e) {
      if (e.target === drawer) drawer.classList.remove('open');
    });
    var out = document.getElementById('shellLogout');
    if (out) {
      out.addEventListener('click', function (e) {
        e.preventDefault();
        A.logout().then(function () { global.location.href = 'login.html'; }).catch(function (e) { if (global.BitbaseDB) global.BitbaseDB.warn(e); });
      });
    }
  }

  /* opts: { active, badge, bottom } */
  function mount(opts) {
    opts = opts || {};
    var active = opts.active || '';

    if (!A || !A.isAuthenticated()) {
      global.location.replace('login.html');
      return false;
    }

    var header = document.getElementById('shellHeader');
    if (header) header.querySelector('.dash-header-inner').innerHTML = headerHtml(active, opts.badge);

    var drawer = document.getElementById('mobileNav');
    if (drawer) {
      drawer.querySelector('.mobile-nav').innerHTML = drawerHtml(active);
      drawer.addEventListener('click', function (e) {
        if (e.target === drawer) drawer.classList.remove('open');
      });
    }

    var bottom = document.getElementById('shellBottom');
    if (bottom) bottom.innerHTML = bottomHtml(opts.bottom || active);

    paintIdentity();
    global.addEventListener('bitbase:session', function (e) { if (!e.detail.signedIn) global.location.replace('login.html'); });
    wireDrawer();

    if (global.lucide) global.lucide.createIcons();
    return true;
  }

  /* --------------------------------------------------------- attachments
     Proof of payment, proof of income and identity documents are all picked the
     same way and all travel with their request, so one reader handles them.

     An image is drawn down to fit a byte budget before it is inlined. A phone
     screenshot is several megabytes, which is why the old path gave up and
     stored nothing but the file name - and a name is exactly what an admin
     cannot review. A file the browser will not decode, or one still too big
     after shrinking, falls back to its name so the request still records that
     something was attached. */
  var IMG_MAX_EDGE = 1400;
  var IMG_BUDGET = 700 * 1024;

  function readDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var rd = new FileReader();
      rd.onload = function () { resolve(String(rd.result || '')); };
      rd.onerror = function () { reject(rd.error || new Error('The file could not be read.')); };
      rd.readAsDataURL(file);
    });
  }

  function shrinkImage(file) {
    return readDataUrl(file).then(function (src) {
      return new Promise(function (resolve) {
        var img = new Image();
        img.onload = function () {
          try {
            var w = img.naturalWidth || img.width || 0;
            var h = img.naturalHeight || img.height || 0;
            if (!w || !h) { resolve(src); return; }
            var scale = Math.min(1, IMG_MAX_EDGE / Math.max(w, h));
            var canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(w * scale));
            canvas.height = Math.max(1, Math.round(h * scale));
            var ctx = canvas.getContext('2d');
            if (!ctx) { resolve(src); return; }
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            var q = 0.82, out = canvas.toDataURL('image/jpeg', q);
            // Ease the quality down rather than throw the picture away.
            while (out.length > IMG_BUDGET && q > 0.34) {
              q -= 0.12;
              out = canvas.toDataURL('image/jpeg', q);
            }
            resolve(out);
          } catch (e) { resolve(src); }
        };
        img.onerror = function () { resolve(src); };
        img.src = src;
      });
    });
  }

  /* Resolves to { name, type, size, at, data, truncated } where `data` is a
     data: URL when the file could be inlined and null when it could not. */
  function readAttachment(file) {
    if (!file) return Promise.resolve(null);
    var rec = { name: file.name || 'attachment', type: file.type || '',
                size: file.size || 0, at: Date.now(), data: null, truncated: false };
    if (/^image\//i.test(rec.type)) {
      return shrinkImage(file).then(function (data) {
        if (data && data.length <= IMG_BUDGET) rec.data = data; else rec.truncated = true;
        return rec;
      }, function () { rec.truncated = true; return rec; });
    }
    if (/^application\/pdf$/i.test(rec.type)) {
      return readDataUrl(file).then(function (data) {
        if (data && data.length <= IMG_BUDGET) rec.data = data; else rec.truncated = true;
        return rec;
      }, function () { rec.truncated = true; return rec; });
    }
    rec.truncated = true;
    return Promise.resolve(rec);
  }

  global.BitbaseShell = { mount: mount, NAV: NAV, BOTTOM: BOTTOM, esc: esc, paintIdentity: paintIdentity,
    readAttachment: readAttachment };
})(window);
