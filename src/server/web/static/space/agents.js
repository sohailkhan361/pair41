// The live views in 3D (docs/specs/web.md, "Space: the 3D layer"). They read the same data as the 2D views in
// sim.js: <canvas data-sim="link|people" data-source="ID">, where ID names a <script type="application/json"> that
// the page's live updates replace. The 2D canvas stays in the page, hidden, as the fallback.
//   link:   two agents as particle orbs, a glowing beam between them, each message a pulse of light along it
//   people: you in the middle, teammates orbiting (online close and bright), a bond to each person you pair with
import { THREE, addView, damp, glowSprite, glowTexture, makeRenderer, palette, still, wake } from './core.js';
import * as atom from './atom.js';
import * as orb from './orb.js';

// Which look the agents have: 'atom' or 'orb'. Try the other with ?agents=orb (or ?agents=atom) on any page;
// the choice is remembered in this browser. Change DEFAULT_STYLE to switch everyone.
const DEFAULT_STYLE = 'atom';
const STYLES = { atom: atom.makeAgent, orb: orb.makeAgent };
const GHOSTS = { atom: atom.makeGhost, orb: orb.makeGhost };
function agentStyle() {
  const asked = new window.URLSearchParams(window.location.search).get('agents');
  try {
    if (asked && STYLES[asked]) window.localStorage.setItem('pair41-agents', asked);
    const kept = window.localStorage.getItem('pair41-agents');
    if (kept && STYLES[kept]) return kept;
  } catch {
    if (asked && STYLES[asked]) return asked;
  }
  return DEFAULT_STYLE;
}
const style = agentStyle();
const makeAgent = STYLES[style];
const makeGhost = GHOSTS[style];
import { starfield } from './stars.js';

const win = window;
const doc = document;
const TAU = Math.PI * 2;

function readJson(id) {
  const el = id && doc.getElementById(id);
  if (!el) return null;
  try {
    return JSON.parse(el.textContent);
  } catch {
    return null;
  }
}

// ---------- building blocks ----------

/**
 * The bond's gentle wave: the height of the line at u (0 at their side, 1 at yours) and time t. It is flat at both
 * ends, so it meets the agents, and drifts slowly.
 */
const WAVE_AMP = 0.14;
function wave(u, t) {
  return WAVE_AMP * Math.sin(Math.PI * u) * Math.sin(2 * Math.PI * 1.5 * u - 0.9 * t);
}

/** The bond while connected: a thin bright beam inside a soft glow, from their colour to yours, gently wavy. */
function makeBeam(from, to) {
  const tubes = [];
  const tube = (r, opacity) => {
    const g = new THREE.CylinderGeometry(r, r, 1, 12, 96, true);
    const pos = g.attributes.position;
    pos.setUsage(THREE.DynamicDrawUsage);
    const base = Float32Array.from(pos.array);
    const col = new Float32Array(pos.count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      c.copy(from).lerp(to, pos.getY(i) + 0.5);
      col.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mesh = new THREE.Mesh(
      g,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    // The cylinder's length runs along y; turn it so it runs along x, their side (-x) to yours (+x).
    // After that turn, the mesh's -x is the world's +y, which is where the wave bends it.
    mesh.rotation.z = -Math.PI / 2;
    tubes.push({ pos, base });
    return mesh;
  };
  const core = tube(0.016, 0.9);
  const glow = tube(0.075, 0.16);
  const group = new THREE.Group();
  group.add(glow, core);
  return {
    group,
    /** Spans x0..x1 on the axis; level 0..1 sets the brightness; t moves the wave. */
    set(x0, x1, level, t) {
      group.position.set((x0 + x1) / 2, 0, 0);
      core.scale.y = glow.scale.y = Math.max(0.001, x1 - x0);
      core.material.opacity = 0.45 * level;
      glow.material.opacity = 0.1 * level;
      for (const { pos, base } of tubes) {
        const a = pos.array;
        for (let i = 0; i < a.length; i += 3) a[i] = base[i] - wave(base[i + 1] + 0.5, t);
        pos.needsUpdate = true;
      }
    },
  };
}

/** A pool of dots for streams of particles (bonds), drawn as one object. */
function dotPool(max, size) {
  const pos = new Float32Array(max * 3);
  const col = new Float32Array(max * 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  const points = new THREE.Points(
    g,
    new THREE.PointsMaterial({
      size,
      map: glowTexture(),
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  points.frustumCulled = false;
  let n = 0;
  return {
    points,
    begin() {
      n = 0;
    },
    add(x, y, z, color, k) {
      if (n >= max) return;
      pos[n * 3] = x;
      pos[n * 3 + 1] = y;
      pos[n * 3 + 2] = z;
      // Additive blending: a darker colour is a fainter dot.
      col[n * 3] = color.r * k;
      col[n * 3 + 1] = color.g * k;
      col[n * 3 + 2] = color.b * k;
      n += 1;
    },
    end() {
      g.setDrawRange(0, n);
      g.attributes.position.needsUpdate = true;
      g.attributes.color.needsUpdate = true;
    },
  };
}

/** HTML labels that follow points in the scene. */
function labelLayer(stage) {
  const layer = doc.createElement('div');
  layer.className = 'space-labels';
  layer.setAttribute('aria-hidden', 'true');
  stage.appendChild(layer);
  const labels = new Map();
  const v = new THREE.Vector3();
  return {
    set(key, text, cls) {
      let el = labels.get(key);
      if (!el) {
        el = doc.createElement('span');
        el.className = 'space-label';
        layer.appendChild(el);
        labels.set(key, el);
      }
      if (el.textContent !== text) el.textContent = text;
      el.className = `space-label ${cls || ''}`;
      return el;
    },
    place(key, pos, camera, w, h, show = true) {
      const el = labels.get(key);
      if (!el) return;
      v.copy(pos).project(camera);
      el.style.transform = `translate(-50%, 0) translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
      el.style.opacity = show && v.z < 1 ? '1' : '0';
    },
    prune(keep) {
      for (const [key, el] of labels) {
        if (!keep.has(key)) {
          el.remove();
          labels.delete(key);
        }
      }
    },
  };
}

function baseScene(canvas, stage, c) {
  const renderer = makeRenderer(canvas, { alpha: true, antialias: true });
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
  const stars = starfield(700, 40, c, { size: 1.2, opacity: 0.8 });
  scene.add(stars);
  const size = { w: 1, h: 1 };
  const resize = () => {
    size.w = Math.max(1, stage.clientWidth);
    size.h = Math.max(1, canvas.clientHeight || stage.clientHeight);
    renderer.setSize(size.w, size.h, false);
    camera.aspect = size.w / size.h;
    camera.updateProjectionMatrix();
  };
  new win.ResizeObserver(() => {
    resize();
    wake();
  }).observe(canvas);
  resize();
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  stage.addEventListener('pointermove', (e) => {
    const r = stage.getBoundingClientRect();
    pointer.tx = ((e.clientX - r.left) / r.width) * 2 - 1;
    pointer.ty = ((e.clientY - r.top) / r.height) * 2 - 1;
  });
  stage.addEventListener('pointerleave', () => {
    pointer.tx = 0;
    pointer.ty = 0;
  });
  return { renderer, scene, camera, stars, size, pointer };
}

// ---------- link: two agents and the messages between them ----------

function linkView(canvas, stage, source) {
  const c = palette();
  const { renderer, scene, camera, stars, size, pointer } = baseScene(canvas, stage, c);
  const labels = labelLayer(stage);
  const sides = {
    me: {
      color: c.you,
      agent: makeAgent(c.you, 1.0),
      empty: makeGhost(c.you, 0.9),
      pos: new THREE.Vector3(),
    },
    partner: {
      color: c.them,
      agent: makeAgent(c.them, 1.0),
      empty: makeGhost(c.them, 0.9),
      pos: new THREE.Vector3(),
    },
  };
  for (const s of Object.values(sides)) scene.add(s.agent.group, s.empty.group);
  const bond = dotPool(400, 0.34);
  scene.add(bond.points);
  const beam = makeBeam(c.them, c.you);
  scene.add(beam.group);
  // Particles that ride the beam, both ways, at varied speeds, held tight to the line.
  const flow = Array.from({ length: 150 }, (_, i) => ({
    u: Math.random(),
    speed: (i % 2 ? -1 : 1) * (0.05 + Math.random() * 0.09),
    y: (Math.random() - 0.5) * 0.05,
    z: (Math.random() - 0.5) * 0.05,
    glow: 0.55 + Math.random() * 0.45,
  }));
  const EDGE = 1.25;
  const shots = [];
  const seen = new Set();
  let data = null;
  let t = 0;

  function shotColor(e) {
    if (e.kind === 'question') return c.ruby;
    if (e.from === 'net') return c.net;
    return e.from === 'me' ? c.you : c.them;
  }

  function shoot(e, delay) {
    const color = shotColor(e);
    const head = glowSprite(color, e.kind === 'question' ? 0.6 : 0.5, 1);
    const trail = dotPool(36, 0.3);
    scene.add(head, trail.points);
    shots.push({
      e,
      color,
      // Each one takes its own arc: how high it lifts off the beam (up for yours, down for theirs), and how far it
      // bows toward you or away, into the scene.
      lift: 1.8 + Math.random() * 1.2,
      bow: (Math.random() < 0.5 ? -1 : 1) * (1.6 + Math.random() * 1.4),
      head,
      trail,
      start: t + delay,
      dur: e.dur ?? (e.from === 'net' ? 1.2 : 1.6),
      history: [],
      done: false,
    });
  }

  // ---------- the game: catch the sparks ----------
  // For GAME_SECONDS, sparks fly from both agents at a random pace; click one to burst it. The score sits top left.
  const GAME_SECONDS = 10;
  const game = { on: false, end: 0, next: 0, score: 0, missed: 0, shown: '' };
  const scoreEl = doc.createElement('div');
  scoreEl.className = 'space-score';
  scoreEl.hidden = true;
  scoreEl.setAttribute('aria-live', 'polite');
  // "Score <n> · missed 2 · 7s", with the score number set larger.
  const scoreLabel = doc.createTextNode('');
  const scoreNum = doc.createElement('strong');
  const scoreRest = doc.createTextNode('');
  scoreEl.append(scoreLabel, scoreNum, scoreRest);
  stage.appendChild(scoreEl);
  let hideScore = 0;

  function startGame() {
    if (game.on || still()) return;
    Object.assign(game, { on: true, end: t + GAME_SECONDS, next: t + 0.3, score: 0, missed: 0 });
    win.clearTimeout(hideScore);
    stage.classList.add('space-game');
    wake();
  }

  function stepGame() {
    if (!game.on) return;
    if (t < game.end && t >= game.next) {
      const from = Math.random() < 0.5 ? 'me' : 'partner';
      const kind = Math.random() < 0.2 ? 'question' : 'chat';
      shoot({ from, kind, game: true, dur: 1.5 + Math.random() * 1.1 }, 0);
      game.next = t + 0.2 + Math.random() * 0.6;
    }
    // The round ends once time is up and the last sparks have landed or burst.
    const flying = shots.some((s) => s.e.game && !s.done);
    if (t >= game.end && !flying) {
      game.on = false;
      stage.classList.remove('space-game');
      hideScore = win.setTimeout(() => (scoreEl.hidden = true), 5000);
    }
    const left = Math.max(0, Math.ceil(game.end - t));
    const label = game.on ? 'Score ' : 'Final score ';
    const rest = game.on ? ` · missed ${game.missed} · ${left}s` : ` · missed ${game.missed}`;
    const text = `${label}${game.score}${rest}`;
    if (text !== game.shown) {
      game.shown = text;
      scoreLabel.textContent = label;
      scoreNum.textContent = String(game.score);
      scoreRest.textContent = rest;
    }
    scoreEl.hidden = false;
  }

  // Bursts: a flash and a ring of particles flying out and fading.
  const bursts = [];
  const sparks = dotPool(1600, 0.2);
  scene.add(sparks.points);
  function burst(at, color) {
    const flash = glowSprite(color, 0.6, 1);
    flash.position.copy(at);
    scene.add(flash);
    const parts = Array.from({ length: 48 }, () => {
      const dir = new THREE.Vector3(
        Math.random() - 0.5,
        Math.random() - 0.5,
        Math.random() - 0.5,
      ).normalize();
      return { dir, speed: 1.2 + Math.random() * 2.2, glow: 0.5 + Math.random() * 0.5 };
    });
    bursts.push({ at: at.clone(), color, flash, parts, born: t });
  }
  function stepBursts() {
    const LIFE = 0.9;
    sparks.begin();
    for (let i = bursts.length - 1; i >= 0; i--) {
      const bu = bursts[i];
      const age = t - bu.born;
      if (age > LIFE) {
        scene.remove(bu.flash);
        bu.flash.material.dispose();
        bursts.splice(i, 1);
        continue;
      }
      const k = age / LIFE;
      bu.flash.scale.setScalar(0.6 + 2.2 * k);
      bu.flash.material.opacity = 1 - k;
      // Fast at first, then slowing: distance = speed * age * (1 - k / 2).
      const travel = age * (1 - k / 2);
      for (const p of bu.parts) {
        sparks.add(
          bu.at.x + p.dir.x * p.speed * travel,
          bu.at.y + p.dir.y * p.speed * travel,
          bu.at.z + p.dir.z * p.speed * travel,
          bu.color,
          p.glow * (1 - k) * 1.4,
        );
      }
    }
    sparks.end();
  }

  // A click near a flying game spark bursts it.
  const hit = new THREE.Vector3();
  canvas.addEventListener('pointerdown', (e) => {
    if (!game.on) return;
    const r = canvas.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    let best = null;
    let bestDist = Math.max(26, size.w * 0.025);
    for (const s of shots) {
      if (!s.e.game || s.done || !s.head.visible) continue;
      hit.copy(s.head.position).project(camera);
      const d = Math.hypot(((hit.x + 1) / 2) * size.w - px, ((1 - hit.y) / 2) * size.h - py);
      if (d < bestDist) {
        best = s;
        bestDist = d;
      }
    }
    if (!best) return;
    best.done = true;
    best.hit = true;
    best.head.visible = false;
    best.history.length = 0;
    burst(best.head.position, best.color);
    game.score += 1;
  });

  function load(first) {
    data = readJson(source);
    const events = (data && data.events) || [];
    const fresh = events.filter((e) => !seen.has(e.id));
    events.forEach((e) => seen.add(e.id));
    if (!still()) {
      // First load replays the last few, so the view shows how the pair has been going; after that, only news.
      const play = first ? fresh.slice(-4) : fresh;
      play.forEach((e, i) => shoot(e, i * (first ? 0.7 : 0.35)));
    }
    view.dirty = true;
    wake();
  }

  const mid = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const bez = (a, b, ctl, u, out) => {
    const v = 1 - u;
    return out.set(
      v * v * a.x + 2 * v * u * ctl.x + u * u * b.x,
      v * v * a.y + 2 * v * u * ctl.y + u * u * b.y,
      v * v * a.z + 2 * v * u * ctl.z + u * u * b.z,
    );
  };

  const view = {
    tick(dt) {
      t += dt;
      const state = data ? data.state : 'connected';
      // Keep both agents in view, whatever the stage's shape.
      const dist = 11;
      const halfW = Math.tan((camera.fov * Math.PI) / 360) * dist * camera.aspect;
      const X = Math.min(6.5, halfW * 0.42);
      sides.partner.pos.set(-X, 0, 0);
      sides.me.pos.set(X, 0, 0);
      pointer.x = damp(pointer.x, pointer.tx, 2.5, dt || 1);
      pointer.y = damp(pointer.y, pointer.ty, 2.5, dt || 1);
      camera.position.set(Math.sin(t * 0.07) * 0.6 + pointer.x * 0.7, 1.3 - pointer.y * 0.5, dist);
      camera.lookAt(0, 0, 0);
      stars.rotation.y = t * 0.01 + pointer.x * 0.05;
      stars.material.uniforms.uTime.value = t;

      for (const key of ['partner', 'me']) {
        const s = sides[key];
        const who = data ? data[key] : null;
        const attached = Boolean(who && who.agent);
        s.agent.group.visible = attached;
        s.empty.group.visible = !attached;
        s.agent.group.position.copy(s.pos);
        s.empty.group.position.copy(s.pos);
        s.agent.state.working = Boolean(who && who.working);
        s.agent.state.live = attached && who.running !== false;
        s.agent.update(t, dt);
        s.empty.update(t, dt, camera);
        const caption =
          (who && who.caption) ||
          (key === 'me'
            ? attached
              ? `Your ${who.agent}`
              : 'Your agent'
            : attached
              ? `${who.name}'s ${who.agent}`
              : `${(who && who.name) || 'Partner'}'s agent`);
        const status = !attached
          ? 'not joined'
          : who.running === false
            ? 'not running'
            : who.working
              ? 'working'
              : 'idle';
        labels.set(
          key,
          `${caption} · ${status}`,
          `${key === 'me' ? 'you' : 'them'} ${who && who.working ? 'busy' : ''}`,
        );
        labels.place(key, tmp.copy(s.pos).add(new THREE.Vector3(0, -1.95, 0)), camera, size.w, size.h);
      }

      // The bond.
      bond.begin();
      const a = sides.partner.pos;
      const b = sides.me.pos;
      const x0 = a.x + EDGE;
      const x1 = b.x - EDGE;
      beam.group.visible = state === 'connected';
      if (state === 'connected') {
        const live =
          data && data.me && data.partner && data.me.running !== false && data.partner.running !== false;
        beam.set(x0, x1, live ? 1 : 0.35, t);
        for (const p of flow) {
          if (live) p.u = (p.u + p.speed * dt + 1) % 1;
          const fade = Math.sin(p.u * Math.PI);
          bond.add(
            x0 + (x1 - x0) * p.u,
            p.y + wave(p.u, t),
            p.z,
            p.u < 0.5 ? c.them : c.you,
            (live ? 0.95 : 0.3) * fade * p.glow,
          );
        }
      } else if (state !== 'declined') {
        // Agreed: a dotted line that moves; asked: fainter; ended: still.
        const count = 46;
        const move = state === 'ended' ? 0 : t * 0.05;
        for (let i = 0; i < count; i++) {
          const u = (i / count + move) % 1;
          bond.add(x0 + (x1 - x0) * u, 0, 0, c.star, state === 'agreed' ? 0.35 : 0.16);
        }
      }
      bond.end();

      // Messages in flight.
      for (const s of shots) {
        if (s.hit) continue;
        const u = (t - s.start) / s.dur;
        if (u < 0) {
          s.head.visible = false;
          continue;
        }
        s.trail.begin();
        if (s.e.from === 'net') {
          // A board change: a spark from the middle to each agent.
          mid.set(0, 0, 0);
          const k = Math.min(1, u);
          s.head.visible = k < 1;
          s.head.position.lerpVectors(mid, b, k);
          tmp.lerpVectors(mid, a, k);
          s.trail.add(tmp.x, tmp.y, tmp.z, s.color, 1 - k * 0.5);
          if (u >= 1 && !s.done) {
            s.done = true;
            sides.me.agent.state.flash = sides.partner.agent.state.flash = 0.6;
          }
        } else {
          const from = s.e.from === 'me' ? b : a;
          const to = s.e.from === 'me' ? a : b;
          // Messages arc above (yours) or below (theirs) the beam, so the two directions stay apart.
          const ctl = new THREE.Vector3((from.x + to.x) / 2, (s.e.from === 'me' ? 1 : -1) * s.lift, s.bow);
          const ease = u < 1 ? 1 - Math.pow(1 - u, 2.2) : 1;
          bez(from, to, ctl, ease, tmp);
          if (u < 1) {
            s.history.push(tmp.clone());
            if (s.history.length > 18) s.history.shift();
            s.head.visible = true;
            s.head.position.copy(tmp);
            s.head.scale.setScalar((s.e.kind === 'question' ? 0.6 : 0.5) * (1 + 0.15 * Math.sin(t * 20)));
          } else {
            s.head.visible = false;
            if (s.history.length) s.history.shift();
            if (!s.done) {
              s.done = true;
              if (s.e.game) game.missed += 1;
              sides[s.e.from === 'me' ? 'partner' : 'me'].agent.state.flash = 0.9;
            }
          }
          s.history.forEach((q, i) => s.trail.add(q.x, q.y, q.z, s.color, (i / s.history.length) * 0.9));
        }
        s.trail.end();
      }
      for (let i = shots.length - 1; i >= 0; i--) {
        const s = shots[i];
        if ((s.done && s.history.length === 0) || t - s.start > 6) {
          if (s.e.game && !s.done) game.missed += 1;
          scene.remove(s.head, s.trail.points);
          s.head.material.dispose();
          s.trail.points.geometry.dispose();
          shots.splice(i, 1);
        }
      }

      stepGame();
      stepBursts();
      renderer.render(scene, camera);
    },
  };
  addView(view, stage);
  stage.querySelector('[data-sim-game]')?.addEventListener('click', startGame);
  // The spark button: one message-like shot, from a random side, along its own arc.
  const shootButton = stage.querySelector('[data-sim-shoot]');
  if (shootButton) {
    shootButton.addEventListener('click', () => {
      if (still()) return;
      shoot({ from: Math.random() < 0.5 ? 'me' : 'partner', kind: 'chat' }, 0);
      wake();
    });
  }
  doc.addEventListener('htmx:afterSwap', () => load(false));
  load(true);
}

// ---------- people: you in the middle, teammates around you ----------

function peopleView(canvas, stage, source) {
  const c = palette();
  const { renderer, scene, camera, stars, size, pointer } = baseScene(canvas, stage, c);
  camera.fov = 42;
  const labels = labelLayer(stage);
  const you = makeAgent(c.you, 0.62);
  scene.add(you.group);
  const nodes = new Map();
  const dots = dotPool(400, 0.32);
  // Bonds: a fine, continuous line of small particles (dense enough to read as a line), pulses ride on top.
  const line = dotPool(2400, 0.12);
  scene.add(line.points, dots.points);
  let data = null;
  let t = 0;
  let hover = null;
  const v = new THREE.Vector3();
  const tint = new THREE.Color();

  function node(name) {
    let n = nodes.get(name);
    if (!n) {
      n = {
        agent: makeAgent(c.them, 0.34),
        pos: new THREE.Vector3(),
        scale: 1,
      };
      scene.add(n.agent.group);
      nodes.set(name, n);
    }
    return n;
  }

  function load() {
    data = readJson(source);
    const people = (data && data.people) || [];
    const keep = new Set(people.map((p) => p.name));
    for (const [name, n] of nodes) {
      if (!keep.has(name)) {
        scene.remove(n.agent.group);
        nodes.delete(name);
      }
    }
    labels.prune(new Set(['you', ...keep]));
    view.dirty = true;
    wake();
  }

  function nearest(ev) {
    const r = canvas.getBoundingClientRect();
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    let best = null;
    let bestD = 26;
    for (const [name, n] of nodes) {
      v.copy(n.pos).project(camera);
      const d = Math.hypot(((v.x + 1) / 2) * size.w - x, ((1 - v.y) / 2) * size.h - y);
      if (d < bestD) {
        best = name;
        bestD = d;
      }
    }
    return best;
  }
  canvas.addEventListener('pointermove', (ev) => {
    const name = nearest(ev);
    if (name !== hover) {
      hover = name;
      canvas.style.cursor = name ? 'pointer' : 'default';
      view.dirty = true;
      wake();
    }
  });
  canvas.addEventListener('click', (ev) => {
    const name = nearest(ev);
    if (name) win.location.href = `/people/${encodeURIComponent(name)}`;
  });

  const view = {
    tick(dt) {
      t += dt;
      pointer.x = damp(pointer.x, pointer.tx, 2.5, dt || 1);
      pointer.y = damp(pointer.y, pointer.ty, 2.5, dt || 1);
      // The orbits face the camera (like the 2D view), tilted a little so the depth reads.
      camera.position.set(pointer.x * 0.8, 1.4 - pointer.y * 0.8, 10);
      camera.lookAt(0, 0, 0);
      stars.rotation.y = t * 0.01;
      stars.material.uniforms.uTime.value = t;
      you.update(t, dt);
      const halfW = Math.tan((camera.fov * Math.PI) / 360) * 10 * camera.aspect;
      const R = Math.min(5.2, Math.max(2.8, halfW * 1.05));
      // Rings are ellipses: as wide as the view allows, never taller than it.
      const halfH = Math.tan((camera.fov * Math.PI) / 360) * 10;
      const squash = Math.min(0.78, (halfH * 0.72) / R);
      const people = (data && data.people) || [];
      const close = people.filter((p) => p.online || p.bond);
      const far = people.filter((p) => !(p.online || p.bond));
      const many = people.length > 12;
      dots.begin();
      line.begin();
      const place = (list, radius, spin, phase, ring) =>
        list.forEach((p, i) => {
          const n = node(p.name);
          const a = phase + (i / Math.max(1, list.length)) * TAU + t * spin;
          n.pos.set(Math.cos(a) * radius, Math.sin(a) * radius * squash, Math.sin(a) * radius * 0.35);
          n.agent.group.position.copy(n.pos);
          const hot = hover === p.name;
          n.scale = damp(n.scale, hot ? 1.45 : 1, 8, dt || 1);
          n.agent.group.scale.setScalar(n.scale);
          n.agent.state.live = Boolean(p.online || p.bond);
          n.agent.state.working = Boolean(p.bond === 'connected');
          n.agent.update(t, dt);
          const show = !many || p.online || p.bond || hot;
          labels.set(p.name, p.name, `${hot ? 'hot' : ''} ${p.online ? '' : 'dim'} ${ring}`);
          labels.place(
            p.name,
            v.copy(n.pos).add(new THREE.Vector3(0, -0.7, 0)),
            camera,
            size.w,
            size.h,
            show,
          );
          // The bond to each person you have an open pair with.
          const bond = p.bond;
          if (bond && bond !== 'ended' && bond !== 'declined') {
            if (bond === 'connected') {
              // More particles the more the pair talked in the last ten minutes.
              const steps = 60;
              for (let j = 0; j <= steps; j++) {
                const k = j / steps;
                tint.copy(c.you).lerp(c.them, k);
                line.add(n.pos.x * k, n.pos.y * k, n.pos.z * k, tint, 0.55);
              }
              // A few pulses each way; more when the pair has talked in the last ten minutes.
              const pulses = Math.min(6, 2 + Math.floor((p.flow || 0) / 2));
              for (let j = 0; j < pulses; j++) {
                const u = (t * 0.22 + j / pulses) % 1;
                const back = j % 2 === 1;
                const k = back ? 1 - u : u;
                dots.add(n.pos.x * k, n.pos.y * k, n.pos.z * k, back ? c.them : c.you, Math.sin(u * Math.PI));
              }
            } else {
              // Agreed: a dotted line; asked: fainter and blinking (as before).
              const count = 18;
              const blink = bond === 'agreed' ? 0.6 : 0.35 + 0.2 * Math.sin(t * 3);
              for (let j = 1; j < count; j++) {
                const k = (j / count + t * 0.03) % 1;
                line.add(n.pos.x * k, n.pos.y * k, n.pos.z * k, c.star, blink * 1.4);
              }
            }
          }
        });
      // Start the rings off-axis so two or three people spread across the view rather than stacking.
      place(close, R * 0.55, 0.035, 0.35, 'close');
      place(far, R, -0.012, 0.35 + Math.PI / Math.max(2, far.length), 'far');
      dots.end();
      line.end();
      labels.set('you', 'you', 'you strong');
      labels.place('you', v.set(0, -1.0, 0), camera, size.w, size.h);
      renderer.render(scene, camera);
    },
  };
  addView(view, stage);
  doc.addEventListener('htmx:afterSwap', load);
  load();
}

/** Takes over each 2D live view on the page; the 2D canvas stays hidden as the fallback. */
export function initAgents() {
  doc.querySelectorAll('canvas[data-sim]').forEach((original) => {
    if (original.hasAttribute('data-demo')) return;
    const stage = original.parentElement;
    const canvas = doc.createElement('canvas');
    canvas.className = 'space-view';
    for (const attr of ['role', 'aria-label', 'aria-hidden']) {
      const value = original.getAttribute(attr);
      if (value !== null) canvas.setAttribute(attr, value);
    }
    original.dataset.space = 'on';
    original.hidden = true;
    stage.classList.add('space-stage');
    stage.insertBefore(canvas, original);
    const source = original.dataset.source;
    if (original.dataset.sim === 'people') peopleView(canvas, stage, source);
    else linkView(canvas, stage, source);
  });
}
