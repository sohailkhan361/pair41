// Pair41's live views: small particle simulations drawn from real data (docs/specs/web.md, "Look").
//   <canvas data-sim="people" data-source="ID">  you in the middle, teammates around you, bonds to the people you pair with
//   <canvas data-sim="link" data-source="ID">    two agents, and each message travelling between them as it arrives
//   <canvas data-sim="link" data-demo>           the same with made-up events (the login page)
// ID names a <script type="application/json"> that the page's live updates replace; the view reads it again after each
// swap and animates only what is new. With reduced motion, or after the pause button ([data-sim-pause], remembered in
// this browser), the views are drawn still.
(function () {
  'use strict';
  const win = window;
  const doc = document;
  const reduce = win.matchMedia('(prefers-reduced-motion: reduce)');
  const sims = [];
  const TAU = Math.PI * 2;
  const PAUSE_KEY = 'pair41-sim-paused';
  let paused = false;
  try {
    paused = win.localStorage.getItem(PAUSE_KEY) === '1';
  } catch {
    paused = false;
  }
  const still = () => reduce.matches || paused;

  function palette() {
    const cs = win.getComputedStyle(doc.documentElement);
    const v = (name) => cs.getPropertyValue(name).trim() || '#888888';
    return {
      you: v('--you'),
      them: v('--them'),
      ruby: v('--ruby'),
      net: v('--net'),
      ink: v('--ink'),
      ink2: v('--ink-2'),
      rule: v('--rule'),
      font: cs.getPropertyValue('--font').trim() || 'sans-serif',
    };
  }

  function rgba(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  function readJson(id) {
    const el = doc.getElementById(id);
    if (!el) return null;
    try {
      return JSON.parse(el.textContent);
    } catch {
      return null;
    }
  }

  function glow(ctx, x, y, r, color, a) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(color, a));
    g.addColorStop(1, rgba(color, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }

  function dot(ctx, x, y, r, fill) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }

  /** An agent or a person: a core, a glow, and electrons that orbit faster while it works. */
  function atom(ctx, t, x, y, color, opts) {
    const live = opts.live !== false;
    glow(
      ctx,
      x,
      y,
      opts.glow || 46,
      color,
      live ? (opts.working ? 0.42 : 0.24) + (opts.flash || 0) * 0.5 : 0.06,
    );
    if (live) {
      const speed = opts.working ? 2.4 : 0.7;
      for (let i = 0; i < 3; i++) {
        const tilt = (i * Math.PI) / 3 + 0.4;
        const a = t * speed * (1 + i * 0.27) + i * 2.1;
        const rx = (opts.orbit || 20) + i * 3;
        const ry = rx * 0.38;
        ctx.strokeStyle = rgba(color, 0.12);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(x, y, rx, ry, tilt, 0, TAU);
        ctx.stroke();
        const ex = Math.cos(a) * rx;
        const ey = Math.sin(a) * ry;
        dot(
          ctx,
          x + ex * Math.cos(tilt) - ey * Math.sin(tilt),
          y + ex * Math.sin(tilt) + ey * Math.cos(tilt),
          1.8,
          color,
        );
      }
    }
    planet(ctx, x, y, opts.core || 8, color, live);
  }

  /** A small shaded sphere with a ring, lit from the top left. */
  function planet(ctx, x, y, r, color, live) {
    const a = live ? 1 : 0.4;
    const body = ctx.createRadialGradient(x - r * 0.4, y - r * 0.45, r * 0.1, x, y, r);
    body.addColorStop(0, rgba('#ffffff', 0.85 * a));
    body.addColorStop(0.35, rgba(color, a));
    body.addColorStop(1, rgba(shade(color, 0.45), a));
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
    ctx.save();
    ctx.strokeStyle = rgba(color, 0.55 * a);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.9, r * 0.5, -0.35, Math.PI * 0.95, Math.PI * 2.05);
    ctx.stroke();
    ctx.restore();
  }

  function shade(hex, k) {
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16);
    const c = (v) =>
      Math.round(v * k)
        .toString(16)
        .padStart(2, '0');
    return `#${c((n >> 16) & 255)}${c((n >> 8) & 255)}${c(n & 255)}`;
  }

  /** Nobody attached yet: a dashed ring that turns slowly. */
  function empty(ctx, t, x, y, color) {
    ctx.save();
    ctx.strokeStyle = rgba(color, 0.55);
    ctx.setLineDash([4, 6]);
    ctx.lineDashOffset = -t * 8;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 18, 0, TAU);
    ctx.stroke();
    ctx.restore();
    dot(ctx, x, y, 2, rgba(color, 0.6));
  }

  function label(ctx, c, text, x, y, color, weight) {
    ctx.font = `${weight || 500} 12px ${c.font}`;
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.fillText(text, x, y);
  }

  // ---------- the link: two agents and the messages between them ----------

  function linkNodes(sim) {
    const inset = sim.w < 520 ? 0.17 : 0.2;
    return { partner: { x: sim.w * inset, y: sim.h * 0.5 }, me: { x: sim.w * (1 - inset), y: sim.h * 0.5 } };
  }

  function shotColor(c, e) {
    if (e.kind === 'question') return c.ruby;
    if (e.from === 'net') return c.net;
    return e.from === 'me' ? c.you : c.them;
  }

  function shoot(sim, e, delay) {
    sim.shots.push({ e, start: sim.t + (delay || 0), dur: e.from === 'net' ? 1.1 : 1.5, trail: [] });
  }

  function bezier(a, b, ctl, u) {
    const v = 1 - u;
    return {
      x: v * v * a.x + 2 * v * u * ctl.x + u * u * b.x,
      y: v * v * a.y + 2 * v * u * ctl.y + u * u * b.y,
    };
  }

  function drawLink(sim) {
    const { ctx, t, c, data } = sim;
    const n = linkNodes(sim);
    const state = data ? data.state : 'connected';
    const me = data ? data.me : {};
    const partner = data ? data.partner : {};
    const connected = state === 'connected';

    // The bond: a stream of particles while connected; a dashed line while agreed; nearly nothing otherwise.
    if (connected) {
      for (const p of sim.flow) {
        p.u += p.speed * sim.dt;
        if (p.u > 1) p.u -= 1;
        if (p.u < 0) p.u += 1;
        const x = n.partner.x + (n.me.x - n.partner.x) * p.u;
        const wave = Math.sin(p.u * Math.PI) * p.amp * Math.sin(t * 0.9 + p.phase);
        dot(
          ctx,
          x,
          n.me.y + wave,
          p.r,
          rgba(p.u < 0.5 ? c.them : c.you, 0.18 + 0.25 * Math.sin(p.u * Math.PI)),
        );
      }
    } else if (state !== 'declined') {
      ctx.save();
      ctx.strokeStyle = rgba(c.ink2, state === 'agreed' ? 0.4 : 0.18);
      ctx.setLineDash(state === 'agreed' ? [6, 8] : [2, 10]);
      ctx.lineDashOffset = state === 'ended' ? 0 : -t * 10;
      ctx.beginPath();
      ctx.moveTo(n.partner.x + 26, n.partner.y);
      ctx.lineTo(n.me.x - 26, n.me.y);
      ctx.stroke();
      ctx.restore();
    }

    // Messages in flight.
    for (const s of sim.shots) {
      const u = (t - s.start) / s.dur;
      if (u < 0) continue;
      const color = shotColor(c, s.e);
      if (s.e.from === 'net') {
        // A board change: a ring from the middle, and a spark to each agent.
        const mid = { x: (n.me.x + n.partner.x) / 2, y: n.me.y };
        const k = Math.min(1, u);
        ctx.strokeStyle = rgba(color, 0.6 * (1 - k));
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(mid.x, mid.y, 6 + k * 40, 0, TAU);
        ctx.stroke();
        for (const to of [n.me, n.partner]) {
          const p = { x: mid.x + (to.x - mid.x) * k, y: mid.y + (to.y - mid.y) * k };
          glow(ctx, p.x, p.y, 10, color, 0.5 * (1 - k * 0.5));
          dot(ctx, p.x, p.y, 2.2, color);
        }
        if (u >= 1 && !s.done) {
          s.done = true;
          sim.flash.me = sim.flash.partner = 0.6;
        }
        continue;
      }
      const from = s.e.from === 'me' ? n.me : n.partner;
      const to = s.e.from === 'me' ? n.partner : n.me;
      const lift = (s.e.from === 'me' ? -1 : 1) * sim.h * 0.3;
      const ctl = { x: (from.x + to.x) / 2, y: from.y + lift };
      const ease = u < 1 ? 1 - Math.pow(1 - u, 2.2) : 1;
      const p = bezier(from, to, ctl, ease);
      if (u < 1) {
        s.trail.push(p);
        if (s.trail.length > 22) s.trail.shift();
      } else if (s.trail.length) {
        s.trail.shift();
      }
      s.trail.forEach((q, i) =>
        dot(ctx, q.x, q.y, 1 + (i / s.trail.length) * 2, rgba(color, (i / s.trail.length) * 0.5)),
      );
      if (u < 1) {
        glow(ctx, p.x, p.y, 14, color, 0.6);
        dot(ctx, p.x, p.y, s.e.kind === 'question' ? 3.6 : 3, color);
      } else if (!s.done) {
        s.done = true;
        sim.flash[s.e.from === 'me' ? 'partner' : 'me'] = 0.8;
        sim.rings.push({ x: to.x, y: to.y, start: t, color });
      }
    }
    sim.shots = sim.shots.filter((s) => !(s.done && s.trail.length === 0) && t - s.start < 6);

    for (const r of sim.rings) {
      const k = (t - r.start) / 0.8;
      ctx.strokeStyle = rgba(r.color, 0.5 * (1 - k));
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(r.x, r.y, 12 + k * 30, 0, TAU);
      ctx.stroke();
    }
    sim.rings = sim.rings.filter((r) => t - r.start < 0.8);

    for (const side of ['partner', 'me']) {
      const who = side === 'me' ? me : partner;
      const at = n[side];
      const color = side === 'me' ? c.you : c.them;
      if (who && who.agent) {
        atom(ctx, t, at.x, at.y, color, {
          working: who.working,
          live: who.running !== false,
          flash: sim.flash[side],
          core: 11,
          glow: 64,
          orbit: 27,
        });
      } else {
        empty(ctx, t, at.x, at.y, color);
      }
      if (who && who.caption) label(ctx, c, who.caption, at.x, at.y + 58, c.ink2);
      sim.flash[side] = Math.max(0, sim.flash[side] - sim.dt * 1.5);
    }
  }

  function loadLink(sim, first) {
    const events = (sim.data && sim.data.events) || [];
    const fresh = events.filter((e) => !sim.seen.has(e.id));
    events.forEach((e) => sim.seen.add(e.id));
    if (reduce.matches) return;
    // On first load, replay the last few so the view shows how the pair has been going; after that, only news.
    const play = first ? fresh.slice(-4) : fresh;
    play.forEach((e, i) => shoot(sim, e, i * (first ? 0.7 : 0.35)));
  }

  // The login page's demo: a made-up pair, on a loop.
  const SCRIPT = [
    { from: 'me', kind: 'chat', working: 'me' },
    { from: 'partner', kind: 'question', working: 'partner' },
    { from: 'me', kind: 'answer', working: 'me' },
    { from: 'net', kind: 'board' },
    { from: 'partner', kind: 'chat', working: 'partner' },
    { from: 'me', kind: 'question', working: 'me' },
    { from: 'partner', kind: 'answer' },
  ];
  function demoTick(sim) {
    const step = SCRIPT[sim.demoStep % SCRIPT.length];
    sim.demoStep += 1;
    sim.data.me.working = step.working === 'me';
    sim.data.partner.working = step.working === 'partner';
    shoot(sim, { id: `d${sim.demoStep}`, from: step.from, kind: step.kind }, 0);
  }

  // ---------- people: you in the middle, teammates around you ----------

  function peopleLayout(sim) {
    const data = sim.data || { people: [] };
    const cx = sim.w / 2;
    const cy = sim.h / 2;
    const R = Math.max(60, Math.min(sim.w, sim.h) / 2 - 34);
    const online = data.people.filter((p) => p.online || p.bond);
    const offline = data.people.filter((p) => !(p.online || p.bond));
    const nodes = [];
    const ring = (list, radius, spin, phase) =>
      list.forEach((p, i) => {
        const a = phase + (i / Math.max(1, list.length)) * TAU + sim.t * spin;
        nodes.push({ p, x: cx + Math.cos(a) * radius, y: cy + Math.sin(a) * radius * 0.78 });
      });
    ring(online, R * 0.55, 0.035, -Math.PI / 2);
    ring(offline, R * 0.95, -0.012, -Math.PI / 2 + 0.3);
    return { cx, cy, nodes };
  }

  function drawPeople(sim) {
    const { ctx, t, c } = sim;
    const { cx, cy, nodes } = peopleLayout(sim);
    sim.nodes = nodes;
    for (const n of nodes) {
      const bond = n.p.bond;
      if (!bond || bond === 'ended' || bond === 'declined') continue;
      ctx.save();
      if (bond === 'connected') {
        ctx.strokeStyle = rgba(c.them, 0.35);
        ctx.lineWidth = 1.2;
      } else {
        ctx.strokeStyle = rgba(c.ink2, bond === 'agreed' ? 0.5 : 0.3 + 0.2 * Math.sin(t * 3));
        ctx.setLineDash(bond === 'agreed' ? [6, 7] : [2, 8]);
        ctx.lineDashOffset = -t * 10;
      }
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(n.x, n.y);
      ctx.stroke();
      ctx.restore();
      if (bond === 'connected') {
        // Particles along the bond; more of them when the pair has been talking in the last ten minutes.
        const count = Math.min(14, 3 + (n.p.flow || 0));
        for (let i = 0; i < count; i++) {
          const u = (t * 0.25 + i / count) % 1;
          const back = i % 2 === 1;
          const k = back ? 1 - u : u;
          const x = cx + (n.x - cx) * k;
          const y = cy + (n.y - cy) * k;
          dot(ctx, x, y, 1.6, rgba(back ? c.them : c.you, 0.7 * Math.sin(u * Math.PI)));
        }
      }
    }
    atom(ctx, t, cx, cy, c.you, { core: 10, glow: 70, orbit: 22 });
    label(ctx, c, 'you', cx, cy + 46, c.ink, 700);
    const many = nodes.length > 12;
    for (const n of nodes) {
      const hot = sim.hover === n.p.name;
      const on = n.p.online;
      if (on || n.p.bond) {
        glow(ctx, n.x, n.y, hot ? 30 : 22, c.them, on ? 0.35 + 0.1 * Math.sin(t * 2 + n.x) : 0.12);
        dot(ctx, n.x, n.y, hot ? 6.5 : 5, on ? c.them : rgba(c.them, 0.5));
      } else {
        ctx.strokeStyle = rgba(c.ink2, hot ? 0.9 : 0.45);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(n.x, n.y, hot ? 6 : 4.5, 0, TAU);
        ctx.stroke();
      }
      if (!many || on || n.p.bond || hot) {
        label(ctx, c, n.p.name, n.x, n.y + 22, hot || on ? c.ink : c.ink2, hot ? 800 : 600);
      }
    }
  }

  function nodeAt(sim, ev) {
    const r = sim.canvas.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    return (sim.nodes || []).find((n) => Math.hypot(n.x - x, n.y - y) < 18);
  }

  // ---------- shared ----------

  function drawDust(sim) {
    for (const d of sim.dust) {
      d.x = (d.x + d.vx * sim.dt + 1) % 1;
      d.y = (d.y + d.vy * sim.dt + 1) % 1;
      const twinkle = 0.65 + 0.35 * Math.sin(sim.t * d.tw + d.ph);
      dot(sim.ctx, d.x * sim.w, d.y * sim.h, d.r, rgba(sim.c.ink2, d.a * twinkle));
    }
  }

  function frame(sim) {
    const { ctx } = sim;
    ctx.clearRect(0, 0, sim.w, sim.h);
    drawDust(sim);
    if (sim.kind === 'people') drawPeople(sim);
    else drawLink(sim);
  }

  function resize(sim) {
    const r = sim.canvas.getBoundingClientRect();
    const dpr = Math.min(2, win.devicePixelRatio || 1);
    sim.w = r.width;
    sim.h = r.height;
    sim.canvas.width = Math.round(r.width * dpr);
    sim.canvas.height = Math.round(r.height * dpr);
    sim.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (still()) frame(sim);
  }

  function load(sim, first) {
    if (sim.demo) return;
    const data = readJson(sim.source);
    if (!data) return;
    sim.data = data;
    if (sim.kind === 'link') loadLink(sim, first);
    if (still()) frame(sim);
  }

  function setup(canvas) {
    const sim = {
      canvas,
      ctx: canvas.getContext('2d'),
      kind: canvas.dataset.sim,
      source: canvas.dataset.source,
      demo: canvas.hasAttribute('data-demo'),
      c: palette(),
      w: 0,
      h: 0,
      t: 0,
      dt: 0,
      data: null,
      seen: new Set(),
      shots: [],
      rings: [],
      flash: { me: 0, partner: 0 },
      hover: null,
      nodes: [],
      demoStep: 0,
      dust: Array.from({ length: 46 }, () => ({
        x: Math.random(),
        y: Math.random(),
        vx: (Math.random() - 0.5) * 0.012,
        vy: (Math.random() - 0.5) * 0.008,
        r: 0.5 + Math.random() * 1.1,
        a: 0.08 + Math.random() * 0.22,
        tw: 0.6 + Math.random() * 1.8,
        ph: Math.random() * TAU,
      })),
      flow: Array.from({ length: 70 }, (_, i) => ({
        u: Math.random(),
        speed: (i % 2 ? -1 : 1) * (0.05 + Math.random() * 0.07),
        amp: 6 + Math.random() * 22,
        phase: Math.random() * TAU,
        r: 0.8 + Math.random() * 1.3,
      })),
    };
    if (sim.demo) {
      sim.data = {
        state: 'connected',
        me: { agent: 'Claude Code', running: true, caption: 'your Claude Code' },
        partner: { agent: 'Codex', running: true, caption: "your teammate's Codex" },
      };
    }
    resize(sim);
    new win.ResizeObserver(() => resize(sim)).observe(canvas);
    load(sim, true);
    if (sim.kind === 'people') {
      canvas.addEventListener('mousemove', (ev) => {
        const n = nodeAt(sim, ev);
        sim.hover = n ? n.p.name : null;
        canvas.style.cursor = n ? 'pointer' : 'default';
        if (still()) frame(sim);
      });
      canvas.addEventListener('click', (ev) => {
        const n = nodeAt(sim, ev);
        if (n) win.location.href = `/people/${encodeURIComponent(n.p.name)}`;
      });
    }
    sims.push(sim);
  }

  let last = 0;
  let demoClock = 0;
  let running = false;
  function loop(now) {
    if (still()) {
      running = false;
      last = 0;
      return;
    }
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0);
    last = now;
    demoClock += dt;
    for (const sim of sims) {
      sim.dt = dt;
      sim.t += dt;
      if (sim.demo && demoClock > 1.7) demoTick(sim);
      frame(sim);
    }
    if (demoClock > 1.7) demoClock = 0;
    win.requestAnimationFrame(loop);
  }

  function run() {
    if (running || still()) return;
    running = true;
    win.requestAnimationFrame(loop);
  }

  function syncPauseButtons() {
    doc.querySelectorAll('[data-sim-pause]').forEach((b) => {
      b.setAttribute('aria-pressed', String(paused));
      b.title = paused ? 'Play the animation' : 'Pause the animation';
      b.hidden = reduce.matches;
    });
  }

  doc.addEventListener('click', (e) => {
    const button = e.target.closest('[data-sim-pause]');
    if (!button) return;
    paused = !paused;
    try {
      win.localStorage.setItem(PAUSE_KEY, paused ? '1' : '0');
    } catch {
      /* private window: for this page only */
    }
    syncPauseButtons();
    if (paused) sims.forEach(frame);
    else run();
  });

  function begin() {
    if (win.PAIR41_2D) return;
    win.PAIR41_2D = true;
    // Canvases the 3D layer took over (space/agents.js) stay hidden as its fallback.
    doc.querySelectorAll('canvas[data-sim]').forEach((c) => {
      if (c.dataset.space !== 'on') setup(c);
    });
    syncPauseButtons();
    if (!sims.length) return;
    if (still()) sims.forEach(frame);
    else run();
  }

  // With WebGL 2 the 3D layer (space/boot.js) goes first and says how it went; if it never says, draw in 2D.
  function start() {
    if (!doc.documentElement.classList.contains('webgl') || win.PAIR41_SPACE !== undefined) return begin();
    doc.addEventListener('pair41:space', begin, { once: true });
    win.setTimeout(() => {
      if (win.PAIR41_SPACE === undefined) begin();
    }, 4000);
  }

  doc.addEventListener('htmx:afterSwap', () => sims.forEach((sim) => load(sim, false)));
  doc.addEventListener('pair41:theme', () =>
    sims.forEach((sim) => {
      sim.c = palette();
      if (still()) frame(sim);
    }),
  );
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})();
