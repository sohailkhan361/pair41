// The landing hero (docs/specs/web.md, "Space: the 3D layer"): one fixed canvas behind the page. A star cluster
// bursts into two agents (neural clouds) joined by a bridge of particles, a text ring wraps them, then light streaks warp into
// the content. Scroll drives everything through a mutable store; each frame damps toward it.
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import {
  THREE,
  addView,
  damp,
  fontReady,
  makeRenderer,
  palette,
  pick,
  reduce,
  remap,
  tier,
  wake,
} from './core.js';
import {
  finishShader,
  horizonFrag,
  particleFrag,
  particleVert,
  planetVert,
  streakFrag,
  streakVert,
} from './shaders.js';
import { starfield } from './stars.js';
import { CENTERS, binarySystem } from './targets.js';

// ---------- tuning knobs ----------
const COUNTS = {
  particles: { high: 140000, mid: 80000, low: 36000 },
  stars: { high: 6000, mid: 4200, low: 2600 },
  streaks: { high: 3600, mid: 2400, low: 1200 },
};
const RING_TEXT = 'PAIR41  ·  ASK  ·  ANSWER  ·  AGREE  ·  ';
// Parts of the hero's scroll progress (0..1) where each thing happens.
// The page opens mid-morph (the agents taking shape out of the burst); scrolling finishes it.
const MORPH_START = 0.72;
const MORPH = [0, 0.55];
// How much the particles dim while text sits over them (0 = not at all).
// Wide screens open with the agents framed on the left (the intro sits on the right); this share of the width
// shifts them, easing back to the centre as the hero scrolls.
const SIDE_SHIFT = 0.2;
const SIDE_RETURN = [0.05, 0.4];
const DIM_UNDER_TEXT = { intro: 0.12, tagline: 0.1 };
const RING = [0.38, 0.6];
const TAGLINE = [0.5, 0.86];
const DOLLY = [0.62, 1];
const BLOOM = { strength: 0.7, radius: 0.5, threshold: 0.2 };

const win = window;
const doc = document;

/** Store written by the scroll triggers, read every frame. */
const scroll = { hero: 0, warp: 0, page: 0, velocity: 0 };

function setupScroll() {
  const { gsap, ScrollTrigger, Lenis } = win;
  if (reduce.matches || !gsap || !ScrollTrigger) return undefined;
  gsap.registerPlugin(ScrollTrigger);
  let lenis;
  if (Lenis) {
    lenis = new Lenis({ lerp: 0.1, anchors: { offset: -24 } });
    lenis.on('scroll', (e) => {
      ScrollTrigger.update();
      scroll.velocity = e.velocity;
    });
    gsap.ticker.add((t) => lenis.raf(t * 1000));
    gsap.ticker.lagSmoothing(0);
  }
  ScrollTrigger.create({
    trigger: '#hero',
    start: 'top top',
    end: 'bottom bottom',
    onUpdate: (s) => (scroll.hero = s.progress),
  });
  ScrollTrigger.create({
    trigger: '#warp',
    start: 'top bottom',
    end: 'bottom top',
    onUpdate: (s) => (scroll.warp = s.progress),
  });
  ScrollTrigger.create({ start: 0, end: 'max', onUpdate: (s) => (scroll.page = s.progress) });
  return lenis;
}

/** The brand word around an open cylinder, drawn once to a canvas texture. */
async function textRing(c) {
  await fontReady(`600 64px ${c.font}`);
  const canvas = doc.createElement('canvas');
  canvas.width = 4096;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.font = `600 76px ${c.font}`;
  if ('letterSpacing' in ctx) ctx.letterSpacing = '14px';
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  const unit = ctx.measureText(RING_TEXT).width;
  const repeats = Math.max(1, Math.round(canvas.width / unit));
  const step = canvas.width / repeats;
  for (let i = 0; i < repeats; i++) ctx.fillText(RING_TEXT, i * step, canvas.height / 2 + 4);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const radius = 5.0;
  const height = (2 * Math.PI * radius * canvas.height) / canvas.width;
  const geometry = new THREE.CylinderGeometry(radius, radius, height, 160, 1, true);
  const material = (side, opacity) =>
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      side,
      depthWrite: false,
      opacity,
      color: new THREE.Color('#c9d0f2'),
      blending: THREE.AdditiveBlending,
    });
  // The far side is seen from inside, mirrored and dimmer, like a planetary ring.
  const front = new THREE.Mesh(geometry, material(THREE.FrontSide, 0));
  const back = new THREE.Mesh(geometry, material(THREE.BackSide, 0));
  const ring = new THREE.Group();
  ring.add(back, front);
  ring.rotation.set(0.2, 0, -0.06);
  ring.userData = { front, back };
  return ring;
}

function streakField(count, c) {
  const heads = new Float32Array(count * 4); // x, y, z, speed factor
  const position = new Float32Array(count * 6);
  const alpha = new Float32Array(count * 2);
  const color = new Float32Array(count * 6);
  const palette3 = [c.white, c.you, c.them, c.white];
  const spawn = (i, anywhere) => {
    const a = Math.random() * Math.PI * 2;
    const r = 1.4 + Math.pow(Math.random(), 0.7) * 16;
    heads[i * 4] = Math.cos(a) * r;
    heads[i * 4 + 1] = Math.sin(a) * r * 0.75;
    heads[i * 4 + 2] = anywhere ? -120 + Math.random() * 130 : -120;
    heads[i * 4 + 3] = 0.6 + Math.random() * 0.8;
  };
  for (let i = 0; i < count; i++) {
    spawn(i, true);
    const k = palette3[i % palette3.length];
    for (let v = 0; v < 2; v++) {
      color[i * 6 + v * 3] = k.r;
      color[i * 6 + v * 3 + 1] = k.g;
      color[i * 6 + v * 3 + 2] = k.b;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alpha, 1).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
  const material = new THREE.ShaderMaterial({
    vertexShader: streakVert,
    fragmentShader: streakFrag,
    uniforms: { uOpacity: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  lines.visible = false;
  lines.userData.update = (dt, speed, cameraZ) => {
    for (let i = 0; i < count; i++) {
      const s = speed * heads[i * 4 + 3];
      heads[i * 4 + 2] += s * dt;
      if (heads[i * 4 + 2] > cameraZ) spawn(i, false);
      const x = heads[i * 4];
      const y = heads[i * 4 + 1];
      const z = heads[i * 4 + 2];
      const tail = Math.min(40, 0.4 + s * 0.06);
      position.set([x, y, z, x, y, z - tail], i * 6);
      const near = Math.min(1, Math.max(0, (z + 120) / 120));
      alpha[i * 2] = near;
      alpha[i * 2 + 1] = 0;
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aAlpha.needsUpdate = true;
  };
  return lines;
}

export async function initHero(canvas) {
  const c = palette();
  const level = tier();
  const renderer = makeRenderer(canvas, { alpha: false });
  renderer.toneMapping = THREE.NoToneMapping;
  const scene = new THREE.Scene();
  scene.background = c.bg;
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
  camera.position.set(0, 0.6, 13);

  // Stars far behind everything.
  const stars = starfield(pick(COUNTS.stars), 140, c, { size: 1.5 });
  scene.add(stars);

  // The morphing particles.
  const n = pick(COUNTS.particles);
  const data = binarySystem(n, c);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
  geometry.setAttribute('aTarget', new THREE.BufferAttribute(data.target, 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(data.color, 3));
  geometry.setAttribute('aRandom', new THREE.BufferAttribute(data.random, 1));
  geometry.setAttribute('aKind', new THREE.BufferAttribute(data.kind, 1));
  geometry.setAttribute('aPulse', new THREE.BufferAttribute(data.pulse, 1));
  const particles = new THREE.Points(
    geometry,
    new THREE.ShaderMaterial({
      vertexShader: particleVert,
      fragmentShader: particleFrag,
      uniforms: {
        uProgress: { value: 0 },
        uTime: { value: 0 },
        // Fewer particles each get a little bigger, so the agents look as full on every device.
        uSize: { value: 22 * Math.min(2, Math.sqrt(140000 / n)) },
        uPixelRatio: { value: Math.min(2, win.devicePixelRatio || 1) },
        uFade: { value: 1 },
        uA: { value: new THREE.Vector3(...CENTERS.a) },
        uB: { value: new THREE.Vector3(...CENTERS.b) },
        uPointer: { value: new THREE.Vector4(0, 0, 0, 0) },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  particles.frustumCulled = false;
  const system = new THREE.Group();
  system.add(particles);
  system.rotation.x = 0.14;
  scene.add(system);

  const ring = await textRing(c);
  system.add(ring);

  const streaks = streakField(pick(COUNTS.streaks), c);
  scene.add(streaks);

  const horizon = new THREE.Mesh(
    new THREE.SphereGeometry(60, 96, 64),
    new THREE.ShaderMaterial({
      vertexShader: planetVert,
      fragmentShader: horizonFrag,
      uniforms: { uA: { value: c.you }, uB: { value: c.them }, uOpacity: { value: 0 } },
      transparent: true,
      depthWrite: false,
    }),
  );
  horizon.position.set(0, -63.5, -24);
  horizon.visible = false;
  scene.add(horizon);

  // Bloom on capable devices; the additive particles already glow without it.
  let composer;
  let finish;
  if (level !== 'low') {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(
      new UnrealBloomPass(new THREE.Vector2(1, 1), BLOOM.strength, BLOOM.radius, BLOOM.threshold),
    );
    finish = new ShaderPass(finishShader);
    composer.addPass(finish);
    composer.addPass(new OutputPass());
  }

  let baseZ = 13;
  const frame = { w: 1, h: 1, side: false };
  const resize = () => {
    const w = win.innerWidth;
    const h = win.innerHeight;
    renderer.setSize(w, h, false);
    if (composer) composer.setSize(w, h);
    camera.aspect = w / h;
    // Keep the whole pair (and its ring) in view on narrow screens.
    baseZ = camera.aspect < 1 ? Math.min(26, 11 / camera.aspect) : 13;
    frame.w = w;
    frame.h = h;
    // Matches the CSS: from 901px wide the intro is a column on the right.
    frame.side = w > 900 && camera.aspect > 1.15;
    camera.updateProjectionMatrix();
  };
  win.addEventListener('resize', resize, { passive: true });
  resize();

  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  win.addEventListener(
    'pointermove',
    (e) => {
      pointer.tx = (e.clientX / win.innerWidth) * 2 - 1;
      pointer.ty = (e.clientY / win.innerHeight) * 2 - 1;
    },
    { passive: true },
  );

  setupScroll();

  // ---------- hover: the pointer parts the particles near it while the intro is on screen ----------
  // Mouse only, and only over empty space: the intro text, the card, links and the navs are left alone.
  let heroView = null;
  const touch = { near: 0, active: false };
  const ndc = new THREE.Vector2();
  const ray = new THREE.Raycaster();
  const plane = new THREE.Plane();
  const aim = new THREE.Vector3();
  const centre = new THREE.Vector3();
  const interactive = () => cur.hero < 0.3;
  const onEmpty = (e) =>
    !e.target.closest(
      'a, button, input, label, select, textarea, form, nav, .hero-copy, .hero-auth, .pill-nav, .nav-wrap',
    );
  /** Where the pointer meets the plane through the pair, in the system's own space. */
  const project = (clientX, clientY, out) => {
    ndc.set((clientX / win.innerWidth) * 2 - 1, -(clientY / win.innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const facing = camera.getWorldDirection(centre).negate().clone();
    plane.setFromNormalAndCoplanarPoint(facing, system.getWorldPosition(centre));
    if (!ray.ray.intersectPlane(plane, out)) return false;
    system.worldToLocal(out);
    return true;
  };
  win.addEventListener(
    'pointermove',
    (e) => {
      touch.active = e.pointerType === 'mouse' && interactive() && onEmpty(e);
      // Project into a Vector3 and copy x, y, z: the uniform is a Vector4 whose w is the strength.
      if (touch.active && project(e.clientX, e.clientY, aim)) {
        const target = particles.material.uniforms.uPointer.value;
        target.x = aim.x;
        target.y = aim.y;
        target.z = aim.z;
        // While paused, the loop only draws when asked.
        if (heroView) {
          heroView.dirty = true;
          wake();
        }
      }
    },
    { passive: true },
  );
  doc.documentElement.addEventListener('pointerleave', () => {
    touch.active = false;
  });

  const words = Array.from(doc.querySelectorAll('[data-tagline] .word'));
  const taglineBox = doc.querySelector('.hero-pin-inner');
  const warpLine = doc.querySelector('.warp-line');
  const cur = { hero: 0, warp: 0, page: 0 };
  let time = 0;
  let ringSpin = 0;
  let lastKey = '';

  const view = {
    scrollDriven: true,
    tick(dt, frozen, dirty) {
      const sdt = dt || 1 / 60;
      if (reduce.matches) {
        cur.hero = 1;
        cur.warp = 0;
      } else {
        cur.hero = damp(cur.hero, scroll.hero, 4, sdt);
        cur.warp = damp(cur.warp, scroll.warp, 5, sdt);
        cur.page = damp(cur.page, scroll.page, 3, sdt);
      }
      // While paused, draw only when the scroll moves.
      if (frozen && !dirty) {
        const key = `${cur.hero.toFixed(4)}|${cur.warp.toFixed(4)}`;
        if (key === lastKey) return;
        lastKey = key;
      }
      time += dt;
      pointer.x = damp(pointer.x, frozen ? 0 : pointer.tx, 2.5, sdt);
      pointer.y = damp(pointer.y, frozen ? 0 : pointer.ty, 2.5, sdt);

      const p = cur.hero;
      const w = cur.warp;
      // Reduced motion: the formed agents, still, dimmed and further away so the intro text reads over them.
      const calm = reduce.matches;
      const camP = calm ? 0 : p;
      const warpIn = remap(w, 0.05, 0.45);
      const u = particles.material.uniforms;
      u.uTime.value = time;
      u.uProgress.value = calm ? 1 : MORPH_START + (1 - MORPH_START) * remap(p, MORPH[0], MORPH[1]);
      // Dim the scene under the intro (first screen) and under the tagline, so the text stays easy to read.
      const underIntro = 1 - remap(p, 0.05, 0.3);
      const underTagline = remap(p, 0.42, 0.52) * (1 - remap(w, 0, 0.25));
      const dim = 1 - DIM_UNDER_TEXT.intro * underIntro - DIM_UNDER_TEXT.tagline * underTagline;
      u.uFade.value = (1 - warpIn) * (calm ? 0.5 : dim);
      particles.visible = u.uFade.value > 0.01;

      // The ring: fades in as the agents settle, spins faster with scroll speed.
      const ringOpacity = remap(p, RING[0], RING[1]) * (1 - remap(w, 0, 0.3)) * (calm ? 0.35 : 1);
      ring.userData.front.material.opacity = ringOpacity * 0.7 * (calm ? 1 : dim);
      ring.userData.back.material.opacity = ringOpacity * 0.3 * (calm ? 1 : dim);
      ring.visible = ringOpacity > 0.01;
      ringSpin += dt * (0.12 + Math.min(1.5, Math.abs(scroll.velocity) * 0.01));
      ring.rotation.y = ringSpin;

      // The system turns slowly and rushes toward the camera as the warp starts.
      system.rotation.y = time * 0.05 + camP * 0.6;
      // The pointer's pull eases in and out.
      touch.near = damp(touch.near, touch.active && interactive() ? 1 : 0, 6, sdt);
      u.uPointer.value.w = touch.near;
      system.position.z = warpIn * 7;

      // Camera: a gentle arc with scroll, a dolly in at the end, a nudge from the pointer, a punch in the warp.
      const dolly = remap(camP, DOLLY[0], DOLLY[1]);
      camera.position.x = Math.sin(camP * 0.9) * 1.6 + pointer.x * 0.6;
      camera.position.y = 0.6 + dolly * 1.1 - pointer.y * 0.4;
      camera.position.z = baseZ - dolly * 3.2;
      camera.lookAt(0, 0, 0);
      const punch = remap(w, 0.15, 0.6) * (1 - remap(w, 0.8, 1));
      camera.fov = 50 + punch * 26;
      // Shift the picture so the agents sit left of the intro, then return to the centre.
      const side = frame.side ? SIDE_SHIFT * (1 - remap(camP, SIDE_RETURN[0], SIDE_RETURN[1])) : 0;
      if (side > 0.0005) camera.setViewOffset(frame.w, frame.h, frame.w * side, 0, frame.w, frame.h);
      else camera.clearViewOffset();
      camera.updateProjectionMatrix();

      // Stars: slow turn plus parallax with the page.
      stars.material.uniforms.uTime.value = time;
      stars.rotation.y = time * 0.006 + cur.page * 0.5;
      stars.rotation.x = cur.page * 0.35;

      // The warp: streaks speed up (ease in), then fade as the content arrives; a planet horizon rises.
      const warpSpeed = Math.pow(remap(w, 0.05, 0.65), 3);
      const streakOpacity = remap(w, 0.02, 0.2) * (1 - remap(w, 0.82, 1));
      streaks.visible = streakOpacity > 0.01 && !reduce.matches;
      if (streaks.visible) {
        streaks.material.uniforms.uOpacity.value = streakOpacity;
        streaks.userData.update(dt || 1 / 60, 4 + warpSpeed * 150, camera.position.z);
      }
      horizon.material.uniforms.uOpacity.value = remap(w, 0.3, 0.65) * (1 - remap(w, 0.85, 1));
      horizon.visible = horizon.material.uniforms.uOpacity.value > 0.01 && !reduce.matches;

      // HTML: the tagline lights word by word; the warp line shows mid-warp.
      if (!reduce.matches) {
        const lit = Math.round(remap(p, TAGLINE[0], TAGLINE[1]) * words.length);
        words.forEach((word, i) => word.classList.toggle('lit', i < lit));
        if (taglineBox) taglineBox.style.opacity = String(remap(p, 0.42, 0.52) * (1 - remap(w, 0, 0.25)));
        if (warpLine) warpLine.style.opacity = String(remap(w, 0.3, 0.45) * (1 - remap(w, 0.7, 0.85)));
      }

      if (finish) finish.uniforms.uTime.value = time;
      if (composer) composer.render();
      else renderer.render(scene, camera);
    },
  };
  heroView = view;
  addView(view, canvas);
  return view;
}
