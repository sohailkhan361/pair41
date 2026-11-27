// Pair41's page behaviour (docs/specs/web.md): theme, copy buttons, the menu, "Needs you" and its browser
// notifications, popovers, reveals, local times.
// Everything here is progressive: the pages work and read the same without it.
(function () {
  'use strict';
  const doc = document;
  const root = doc.documentElement;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const store = {
    get(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        /* private window: the choice lasts for this page only */
      }
    },
  };

  // ---------- announcements for screen readers ----------
  function announce(text) {
    const live = doc.getElementById('announce');
    if (!live) return;
    live.textContent = '';
    window.setTimeout(() => (live.textContent = text), 30);
  }

  // ---------- theme ----------
  doc.addEventListener('click', (e) => {
    const button = e.target.closest('[data-theme-toggle]');
    if (!button) return;
    const next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);
    store.set('pair41-theme', next);
    doc.dispatchEvent(new window.Event('pair41:theme'));
    announce(next === 'light' ? 'Light theme' : 'Dark theme');
  });

  // ---------- copy ----------
  // <button data-copy="text"> copies that text; <button data-copy> inside .cmd copies the command beside it.
  function copyText(text) {
    if (window.navigator.clipboard && window.isSecureContext)
      return window.navigator.clipboard.writeText(text);
    // Plain http (a dev server on a LAN address): the old way still works.
    return new Promise((resolve, reject) => {
      const area = doc.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      doc.body.appendChild(area);
      area.select();
      const ok = doc.execCommand('copy');
      area.remove();
      if (ok) resolve();
      else reject(new Error('copy failed'));
    });
  }

  doc.addEventListener('click', (e) => {
    const button = e.target.closest('[data-copy]');
    if (!button) return;
    const own = button.getAttribute('data-copy');
    const holder = button.closest('.cmd');
    const source = holder && holder.querySelector('[data-copy-source]');
    const text = own || (source ? source.textContent.trim() : '');
    if (!text) return;
    const label = button.querySelector('.copy-label');
    copyText(text).then(
      () => {
        button.classList.add('copied');
        if (label) label.textContent = 'Copied';
        announce('Copied to the clipboard');
        window.setTimeout(() => {
          button.classList.remove('copied');
          if (label) label.textContent = 'Copy';
        }, 1600);
      },
      () => {
        if (label) label.textContent = 'Select and copy';
        announce('Could not copy. Select the text and copy it yourself.');
        if (source) {
          const range = doc.createRange();
          range.selectNodeContents(source);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      },
    );
  });

  // ---------- menu (small screens) ----------
  function setMenu(open) {
    const toggle = doc.querySelector('[data-menu-toggle]');
    const panel = doc.getElementById('menu');
    if (!toggle || !panel) return;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close the menu' : 'Open the menu');
    panel.classList.toggle('open', open);
    panel.toggleAttribute('inert', !open);
    doc.body.classList.toggle('menu-open', open);
    if (open) {
      const first = panel.querySelector('a, button');
      if (first) first.focus();
    }
  }
  doc.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-menu-toggle]');
    if (toggle) setMenu(toggle.getAttribute('aria-expanded') !== 'true');
  });

  // ---------- "Needs you" popover ----------
  function setNeeds(open) {
    const button = doc.querySelector('[data-needs-toggle]');
    const panel = doc.getElementById('needs-panel');
    if (!button || !panel) return;
    button.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
  }
  doc.addEventListener('click', (e) => {
    const button = e.target.closest('[data-needs-toggle]');
    if (button) {
      setNeeds(button.getAttribute('aria-expanded') !== 'true');
      return;
    }
    if (!e.target.closest('#needs')) setNeeds(false);
  });

  // ---------- popovers: <details data-popover> closes on a click outside or Escape ----------
  function closePopovers(except) {
    doc.querySelectorAll('details[data-popover][open]').forEach((d) => {
      if (d !== except) d.removeAttribute('open');
    });
  }
  doc.addEventListener('click', (e) => closePopovers(e.target.closest('details[data-popover]')));
  doc.addEventListener(
    'toggle',
    (e) => {
      const d = e.target;
      if (!d.matches || !d.matches('details[data-popover]') || !d.open) return;
      const field = d.querySelector('textarea, input:not([type=hidden]), button');
      if (field) field.focus();
    },
    true,
  );

  // ---------- browser notifications: one per new "your turn" item, while the tab is in the background ----------
  const canNotify = 'Notification' in window;
  const NOTIFY_ON = 'pair41-notify';
  const NOTIFIED = 'pair41-notified';
  function notifiedKeys() {
    try {
      const list = JSON.parse(store.get(NOTIFIED) || 'null');
      return Array.isArray(list) ? list : null;
    } catch {
      return null;
    }
  }
  function notifyOn() {
    return canNotify && store.get(NOTIFY_ON) === 'on' && window.Notification.permission === 'granted';
  }
  function notifyNew() {
    if (!canNotify || !doc.getElementById('needs')) return;
    const items = Array.from(doc.querySelectorAll('#needs-panel .need.turn-you[data-key]'));
    const known = notifiedKeys();
    // The first time this browser sees the list, everything on it counts as already told.
    if (known && notifyOn() && (doc.hidden || !doc.hasFocus())) {
      items
        .filter((el) => !known.includes(el.dataset.key))
        .forEach((el) => {
          const title = el.querySelector('.need-title');
          const detail = el.querySelector('.need-detail');
          try {
            const n = new window.Notification(title ? title.textContent.trim() : 'Pair41 needs you', {
              body: detail ? detail.textContent.trim() : '',
              tag: el.dataset.key,
            });
            n.onclick = () => {
              window.focus();
              if (el.dataset.href) window.location.href = el.dataset.href;
              n.close();
            };
          } catch {
            /* some mobile browsers only notify from a service worker */
          }
        });
    }
    const keys = items.map((el) => el.dataset.key);
    store.set(NOTIFIED, JSON.stringify(Array.from(new Set([...(known || []), ...keys])).slice(-200)));
  }
  function notifyRow() {
    const row = doc.querySelector('[data-notify-row]');
    if (!row || !canNotify) return;
    row.hidden = false;
    const state = row.querySelector('[data-notify-state]');
    const button = row.querySelector('[data-notify-toggle]');
    const blocked = window.Notification.permission === 'denied';
    state.textContent = blocked
      ? "Notifications are blocked in this site's browser settings"
      : notifyOn()
        ? 'Browser notifications are on'
        : 'Browser notifications are off';
    button.hidden = blocked;
    button.textContent = notifyOn() ? 'Turn off' : 'Turn on';
  }
  doc.addEventListener('click', (e) => {
    if (!e.target.closest('[data-notify-toggle]') || !canNotify) return;
    if (notifyOn()) {
      store.set(NOTIFY_ON, 'off');
      notifyRow();
      announce('Browser notifications off');
      return;
    }
    Promise.resolve(window.Notification.requestPermission()).then((permission) => {
      if (permission === 'granted') store.set(NOTIFY_ON, 'on');
      notifyNew();
      notifyRow();
      announce(permission === 'granted' ? 'Browser notifications on' : 'Notifications were not allowed');
    });
  });

  doc.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const pop = doc.querySelector('details[data-popover][open]');
    if (pop) {
      pop.removeAttribute('open');
      const summary = pop.querySelector('summary');
      if (summary) summary.focus();
    }
    const needsOpen = doc.querySelector('[data-needs-toggle][aria-expanded="true"]');
    if (needsOpen) {
      setNeeds(false);
      needsOpen.focus();
    }
    const menuOpen = doc.querySelector('[data-menu-toggle][aria-expanded="true"]');
    if (menuOpen) {
      setMenu(false);
      menuOpen.focus();
    }
  });

  // ---------- auth tabs (login page) ----------
  doc.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"][data-tab]');
    const jump = e.target.closest('[data-show-tab]');
    const name = tab ? tab.getAttribute('data-tab') : jump ? jump.getAttribute('data-show-tab') : null;
    if (!name) return;
    if (jump) e.preventDefault();
    showTab(name, Boolean(jump));
  });
  function showTab(name, focus) {
    doc.querySelectorAll('[role="tab"][data-tab]').forEach((t) => {
      const on = t.getAttribute('data-tab') === name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });
    doc.querySelectorAll('[role="tabpanel"][data-panel]').forEach((p) => {
      p.hidden = p.getAttribute('data-panel') !== name;
    });
    if (focus) {
      const panel = doc.querySelector(`[data-panel="${name}"]`);
      const input = panel && panel.querySelector('input:not([type=hidden])');
      if (input) input.focus({ preventScroll: true });
      const card = doc.getElementById('auth');
      if (card) card.scrollIntoView({ behavior: reduce.matches ? 'auto' : 'smooth', block: 'center' });
    }
  }
  doc.addEventListener('keydown', (e) => {
    const tab = e.target.closest && e.target.closest('[role="tab"][data-tab]');
    if (!tab || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
    const tabs = Array.from(doc.querySelectorAll('[role="tab"][data-tab]'));
    const next = tabs[(tabs.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    showTab(next.getAttribute('data-tab'), false);
    next.focus();
  });

  // ---------- times in the viewer's time zone ----------
  function localTimes(scope) {
    scope.querySelectorAll('time[datetime]').forEach((t) => {
      const d = new Date(t.getAttribute('datetime'));
      if (Number.isNaN(d.getTime())) return;
      t.textContent = t.hasAttribute('data-date')
        ? d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
        : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    });
  }

  // ---------- items that arrive in a live update ease in ----------
  const seen = new Set();
  function markArrivals(scope, animate) {
    scope.querySelectorAll('[data-key]').forEach((el) => {
      const key = el.getAttribute('data-key');
      if (animate && !seen.has(key)) el.classList.add('arrive');
      seen.add(key);
    });
  }

  // ---------- scroll reveals: once, on the way in ----------
  function reveals(scope) {
    const items = scope.querySelectorAll('[data-reveal]:not(.revealed)');
    if (!items.length) return;
    if (reduce.matches || !('IntersectionObserver' in window)) {
      items.forEach((el) => el.classList.add('revealed'));
      return;
    }
    const io = new window.IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('revealed');
          io.unobserve(entry.target);
        }),
      { rootMargin: '0px 0px -10% 0px' },
    );
    items.forEach((el) => io.observe(el));
  }

  // ---------- tagline: words light up one at a time as they cross a line ----------
  function tagline() {
    const block = doc.querySelector('[data-tagline]');
    if (!block) return;
    const words = [];
    block.querySelectorAll('[data-line]').forEach((line) => {
      const parts = line.textContent.trim().split(/\s+/);
      line.textContent = '';
      parts.forEach((word, i) => {
        const span = doc.createElement('span');
        span.className = 'word';
        span.textContent = word;
        line.appendChild(span);
        if (i < parts.length - 1) line.appendChild(doc.createTextNode(' '));
        words.push(span);
      });
    });
    if (reduce.matches) {
      words.forEach((w) => w.classList.add('lit'));
      return;
    }
    block.classList.add('animated');
    let pending = false;
    function update() {
      pending = false;
      // On the 3D landing page the hero lights the words with its own scroll progress (space/hero.js).
      if (root.classList.contains('space-on')) return;
      // The trigger line sits at 70% of the viewport height; each word lights once it passes it.
      const trigger = window.innerHeight * 0.7;
      let lit = 0;
      words.forEach((w) => {
        const r = w.getBoundingClientRect();
        const on = r.top + r.height / 2 < trigger;
        w.classList.toggle('lit', on);
        if (on) lit += 1;
      });
      if (lit === words.length) block.classList.add('done');
    }
    window.addEventListener(
      'scroll',
      () => {
        if (pending) return;
        pending = true;
        window.requestAnimationFrame(update);
      },
      { passive: true },
    );
    window.addEventListener('resize', update, { passive: true });
    update();
  }

  // ---------- the landing pill nav: the section in view is marked ----------
  function pillNav() {
    const links = Array.from(doc.querySelectorAll('.pill-nav a[data-pill]'));
    if (!links.length || !('IntersectionObserver' in window)) return;
    const io = new window.IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          links.forEach((a) => a.setAttribute('aria-current', String(a.dataset.pill === entry.target.id)));
        }),
      { rootMargin: '-45% 0px -50% 0px' },
    );
    links.forEach((a) => {
      const target = doc.getElementById(a.dataset.pill);
      if (target) io.observe(target);
    });
  }

  function init() {
    pillNav();
    localTimes(doc);
    markArrivals(doc, false);
    reveals(doc);
    tagline();
    notifyRow();
    notifyNew();
  }

  doc.addEventListener('htmx:afterSwap', (e) => {
    localTimes(e.target);
    markArrivals(e.target, true);
    reveals(e.target);
  });
  // The "Needs you" button is swapped whole (outerHTML), so look again once each swap settles.
  doc.addEventListener('htmx:afterSettle', () => {
    notifyRow();
    notifyNew();
  });
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})();
