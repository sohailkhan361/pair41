// An agent in the live views as an atom made of particles (the look of the first Pair41 views, in 3D): a packed
// nucleus, three tilted orbits drawn as fine dotted rings, and an electron with a short trail on each.
// Same interface as orb.js: { group, state: { flash, working, live }, update(t, dt) }.
//   working      electrons race round, the nucleus pulses
//   idle         electrons drift, a gentle breath
//   not running  grey, dim and still
//   not joined   makeGhost: the same grey, dim, still atom
import { THREE, glowSprite, glowTexture } from './core.js';

const GREY = new THREE.Color('#6b7a90');
const WHITE = new THREE.Color('#ffffff');
const TAU = Math.PI * 2;
const TRAIL = 14;
// Orbits are ovals, not circles: height as a share of width (the classic atom symbol).
const FLAT = 0.37;

function gauss() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function points(positions, colors, size) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const p = new THREE.Points(
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
  p.frustumCulled = false;
  return p;
}

/**
 * color: THREE.Color; radius: the orbit radius in world units.
 * opts.nucleons: particles in the nucleus; opts.ringDots: particles on each orbit ring; opts.offLevel: brightness
 * when not running (0.45 by default).
 */
export function makeAgent(color, radius, opts = {}) {
  const group = new THREE.Group();
  const spin = new THREE.Group();
  group.add(spin);

  // The nucleus: a dozen small clusters packed together, so it reads as particles, not a ball.
  const clusters = 12;
  const perCluster = Math.round((opts.nucleons ?? 900 * radius) / clusters);
  const nPos = new Float32Array(clusters * perCluster * 3);
  const nCol = new Float32Array(clusters * perCluster * 3);
  const core = radius * 0.3;
  let k = 0;
  for (let c = 0; c < clusters; c++) {
    const u = Math.random() * 2 - 1;
    const a = Math.random() * TAU;
    const s = Math.sqrt(1 - u * u);
    const r = core * (0.35 + Math.random() * 0.65);
    const cx = Math.cos(a) * s * r;
    const cy = u * r;
    const cz = Math.sin(a) * s * r;
    const tone = Math.random() < 0.5 ? 1 : 0.7;
    for (let j = 0; j < perCluster; j++) {
      const sigma = core * 0.28;
      nPos.set([cx + gauss() * sigma, cy + gauss() * sigma, cz + gauss() * sigma], k * 3);
      const w = 0.45 + Math.random() * 0.4;
      nCol.set([tone * w, tone * w, tone * w], k * 3);
      k += 1;
    }
  }
  const nucleus = points(nPos, nCol, radius * 0.1);
  spin.add(nucleus);
  const halo = glowSprite(color, radius * 2.6, 0.25);
  const heart = glowSprite(color.clone().lerp(WHITE, 0.5), radius * 0.7, 0.6);
  group.add(halo, heart);

  // Three orbits, tilted like the classic atom symbol, each a ring of fine dots.
  const ringDots = opts.ringDots ?? Math.max(120, Math.round(340 * radius));
  const orbits = [];
  for (let i = 0; i < 3; i++) {
    const pivot = new THREE.Group();
    // Three ovals crossed at 60 degrees in the view plane, tipped a little for depth.
    pivot.rotation.set(0.3, 0, (i * Math.PI) / 3 + 0.35);
    const rPos = new Float32Array(ringDots * 3);
    const rCol = new Float32Array(ringDots * 3);
    for (let j = 0; j < ringDots; j++) {
      const a = (j / ringDots) * TAU;
      const wobble = 1 + gauss() * 0.006;
      rPos.set(
        [Math.cos(a) * radius * wobble, Math.sin(a) * radius * FLAT * wobble, gauss() * radius * 0.004],
        j * 3,
      );
      const w = 0.5 + Math.random() * 0.3;
      rCol.set([w, w, w], j * 3);
    }
    const ring = points(rPos, rCol, radius * 0.07);
    // The electron and its trail: TRAIL points behind it on the ring, fading.
    const tPos = new Float32Array(TRAIL * 3);
    const tCol = new Float32Array(TRAIL * 3);
    for (let j = 0; j < TRAIL; j++) {
      const w = j === 0 ? 1 : 0.7 * (1 - j / TRAIL);
      tCol.set([w, w, w], j * 3);
    }
    const trail = points(tPos, tCol, radius * 0.16);
    trail.geometry.attributes.position.setUsage(THREE.DynamicDrawUsage);
    const electron = glowSprite(color.clone().lerp(WHITE, 0.4), radius * 0.45, 1);
    pivot.add(ring, trail, electron);
    spin.add(pivot);
    orbits.push({ ring, trail, tPos, electron, phase: i * 2.1, speed: 1 + i * 0.27 });
  }

  const state = { flash: 0, working: false, live: true };
  const tint = new THREE.Color();

  return {
    group,
    state,
    update(t, dt) {
      const live = state.live;
      state.flash = Math.max(0, state.flash - dt * 1.4);
      tint.copy(live ? color : GREY);
      const level = (live ? (state.working ? 1.15 : 0.9) : (opts.offLevel ?? 0.45)) + state.flash * 0.6;

      // Electrons: fast while working, slow while idle, stopped when not running.
      const speed = live ? (state.working ? 2.4 : 0.7) : 0;
      for (const o of orbits) {
        o.phase += dt * speed * o.speed;
        const step = 0.045 * (state.working ? 1.4 : 1);
        for (let j = 0; j < TRAIL; j++) {
          const a = o.phase - j * step;
          o.tPos[j * 3] = Math.cos(a) * radius;
          o.tPos[j * 3 + 1] = Math.sin(a) * radius * FLAT;
          o.tPos[j * 3 + 2] = 0;
        }
        o.trail.geometry.attributes.position.needsUpdate = true;
        o.trail.visible = live;
        o.electron.visible = live;
        o.electron.position.set(Math.cos(o.phase) * radius, Math.sin(o.phase) * radius * FLAT, 0);
        o.electron.material.color.copy(tint).lerp(WHITE, 0.4);
        o.ring.material.color.copy(tint).multiplyScalar(level);
        o.trail.material.color.copy(tint).lerp(WHITE, 0.3).multiplyScalar(level);
      }

      // Nucleus: tinted, pulses while working, breathes while idle.
      nucleus.material.color.copy(tint).lerp(WHITE, 0.25).multiplyScalar(level);
      const pulse = live ? (state.working ? 0.08 * Math.sin(t * 6) : 0.03 * Math.sin(t * 1.6)) : 0;
      nucleus.scale.setScalar(1 + pulse);
      nucleus.rotation.y += dt * (live ? 0.6 : 0);
      // Turn in the view plane (so the orbits stay ovals) with a slight wobble for depth.
      spin.rotation.z += dt * (live ? (state.working ? 0.25 : 0.06) : 0);
      spin.rotation.y = 0.25 * Math.sin(t * 0.3);
      halo.material.color.copy(tint);
      halo.material.opacity =
        (live ? (state.working ? 0.38 : 0.24) : 0.11 * (opts.offLevel ?? 0.45)) + state.flash * 0.35;
      heart.visible = live;
      heart.material.opacity = (state.working ? 0.8 : 0.55) + state.flash * 0.4;
      heart.scale.setScalar(radius * (0.7 + pulse * 2));
    },
  };
}

/** Nobody attached yet: the grey, dim, still atom of an agent that is not running. */
export function makeGhost(color, radius) {
  // A little brighter than not running, so it reads as waiting rather than gone.
  const atom = makeAgent(color, radius, { offLevel: 0.75 });
  atom.state.live = false;
  return { group: atom.group, update: (t, dt) => atom.update(t, dt) };
}
