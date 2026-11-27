// Shared pieces of Pair41's 3D layer (docs/specs/web.md, "Space: the 3D layer"): the renderer, the colours, one
// frame loop for every view, damping, and how many particles this device gets.
import * as THREE from 'three';

export { THREE };

const win = window;
const doc = document;

export const reduce = win.matchMedia('(prefers-reduced-motion: reduce)');

export function hasWebGL2() {
  try {
    const canvas = doc.createElement('canvas');
    return Boolean(canvas.getContext('webgl2'));
  } catch {
    return false;
  }
}

/** high, mid or low: steps the particle counts down on small screens and few-core machines. */
export function tier() {
  const cores = win.navigator.hardwareConcurrency || 4;
  const memory = win.navigator.deviceMemory || 8;
  const width = Math.min(win.screen.width, win.innerWidth);
  if (width < 700 || cores <= 4 || memory <= 4) return 'low';
  if (width < 1280 || cores < 8) return 'mid';
  return 'high';
}

export const pick = (counts) => counts[tier()];

/** The space colours. They do not follow the theme: space is always dark. */
export function palette() {
  const cs = win.getComputedStyle(doc.documentElement);
  const color = (name, fallback) => new THREE.Color(cs.getPropertyValue(name).trim() || fallback);
  return {
    you: color('--space-you', '#2bb8e6'),
    them: color('--space-them', '#b392ff'),
    ruby: color('--space-ruby', '#ff6b8e'),
    net: color('--space-net', '#f5c451'),
    star: color('--space-star', '#d8deff'),
    bg: color('--space-bg', '#050c18'),
    white: new THREE.Color('#ffffff'),
    font: cs.getPropertyValue('--font').trim() || 'sans-serif',
  };
}

/** Frame-rate independent easing toward a target. */
export const damp = (current, target, lambda, dt) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt));

export const clamp01 = (v) => Math.min(1, Math.max(0, v));
/** 0 before a, 1 after b, smooth in between. */
export const remap = (v, a, b) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

export function makeRenderer(canvas, opts = {}) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: opts.antialias ?? false,
    alpha: opts.alpha ?? true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(2, win.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, opts.alpha === false ? 1 : 0);
  return renderer;
}

/** Keeps a renderer (and camera, and composer) the size of an element. */
export function fit(el, renderer, camera, onResize) {
  const apply = () => {
    const w = Math.max(1, el.clientWidth);
    const h = Math.max(1, el.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (onResize) onResize(w, h);
  };
  new win.ResizeObserver(apply).observe(el);
  apply();
}

let glow;
/** A soft round sprite, shared by every glow, comet and spark. */
export function glowTexture() {
  if (glow) return glow;
  const size = 128;
  const canvas = doc.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.2, 'rgba(255,255,255,0.65)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.16)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  glow = new THREE.CanvasTexture(canvas);
  glow.colorSpace = THREE.SRGBColorSpace;
  return glow;
}

export function glowSprite(color, scale, opacity = 1) {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture(),
      color,
      transparent: true,
      opacity,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  sprite.scale.setScalar(scale);
  return sprite;
}

// ---------- pause (the [data-sim-pause] buttons; sim.js owns the buttons and the stored choice) ----------

const PAUSE_KEY = 'pair41-sim-paused';
export function paused() {
  try {
    return win.localStorage.getItem(PAUSE_KEY) === '1';
  } catch {
    return false;
  }
}
/** True when views should not move on their own. */
export const still = () => reduce.matches || paused();

// ---------- one frame loop for every view ----------

const views = new Set();
let running = false;
let last = 0;

function frame(now) {
  if (doc.hidden || views.size === 0) {
    running = false;
    last = 0;
    return;
  }
  const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60);
  last = now;
  const freeze = still();
  for (const view of views) {
    if (!view.visible) continue;
    if (freeze && !view.dirty && !view.scrollDriven) continue;
    const dirty = view.dirty;
    view.dirty = false;
    view.tick(freeze ? 0 : dt, freeze, dirty);
  }
  win.requestAnimationFrame(frame);
}

export function wake() {
  if (running || doc.hidden) return;
  running = true;
  win.requestAnimationFrame(frame);
}

/**
 * Adds a view to the loop. view.tick(dt, frozen, dirty) draws one frame; view.dirty = true asks for a redraw while frozen;
 * view.scrollDriven keeps it drawing while frozen (the landing hero follows the scroll even when still).
 * Drawing stops while the view's element is off screen.
 */
export function addView(view, el) {
  view.visible = true;
  view.dirty = true;
  views.add(view);
  if (el && 'IntersectionObserver' in win) {
    new win.IntersectionObserver((entries) => {
      view.visible = entries[entries.length - 1].isIntersecting;
      view.dirty = true;
      wake();
    }).observe(el);
  }
  wake();
  return view;
}

doc.addEventListener('visibilitychange', wake);
doc.addEventListener('click', (e) => {
  if (!e.target.closest('[data-sim-pause]')) return;
  // sim.js has already flipped the stored choice; redraw once so a paused view settles.
  views.forEach((v) => (v.dirty = true));
  wake();
});
reduce.addEventListener('change', () => {
  views.forEach((v) => (v.dirty = true));
  wake();
});

/** Waits for the page font so canvas text (the ring, labels) uses it. */
export async function fontReady(spec) {
  try {
    await doc.fonts.load(spec);
    await doc.fonts.ready;
  } catch {
    /* the fallback font is fine */
  }
}

/** "Waiting for an agent": a dashed ring in the agent's colour, facing the camera, turning slowly. */
export function waitingRing(color, radius) {
  const ring = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(
      new THREE.EllipseCurve(0, 0, radius * 1.15, radius * 1.15)
        .getPoints(96)
        .map((p) => new THREE.Vector3(p.x, p.y, 0)),
    ),
    new THREE.LineDashedMaterial({
      color,
      dashSize: radius * 0.14,
      gapSize: radius * 0.16,
      transparent: true,
      opacity: 0.7,
    }),
  );
  ring.computeLineDistances();
  const group = new THREE.Group();
  group.add(ring);
  return {
    group,
    update(dt, camera) {
      ring.rotation.z += dt * 0.25;
      group.quaternion.copy(camera.quaternion);
    },
  };
}
