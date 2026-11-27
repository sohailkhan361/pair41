// An agent in the live views as a particle orb (docs/specs/web.md, "Agents"): a clean sphere of evenly spaced fine
// particles around a bright core. Each state looks different, so you can tell them apart at a glance:
//   working      the surface ripples and the core pulses
//   idle         full colour, a slow turn and a gentle breath
//   not running  grey, dim and still, no core glow
//   not joined   makeGhost: a dashed ring and a faint grey outline that pulses slowly (waiting for an agent)
import { THREE, glowSprite, waitingRing } from './core.js';

const GREY = new THREE.Color('#6b7a90');

const orbVert = /* glsl */ `
uniform float uTime;
uniform float uAmp;
uniform float uSize;
uniform float uPixelRatio;
uniform float uRadius;
attribute float aRandom;
varying float vRim;
varying float vRandom;
void main() {
  vec3 n = normalize(position);
  // Ripples: two travelling waves over the surface, only while working (uAmp > 0).
  float wave = sin(dot(n, vec3(0.8, 0.5, 0.3)) * 9.0 - uTime * 3.2) + 0.6 * sin(dot(n, vec3(-0.3, 0.9, 0.2)) * 13.0 - uTime * 4.1);
  vec3 p = n * uRadius * (1.0 + uAmp * wave);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * uPixelRatio * (0.7 + aRandom * 0.6) / -mv.z;
  // Brighter at the rim, like a lit shell.
  vRim = 1.0 - abs(normalize(normalMatrix * n).z);
  vRandom = aRandom;
}
`;

const orbFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uLevel;
uniform float uTime;
varying float vRim;
varying float vRandom;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.05, d);
  if (a < 0.02) discard;
  float twinkle = 0.85 + 0.15 * sin(uTime * 1.7 + vRandom * 40.0);
  vec3 col = mix(uColor * 0.55, mix(uColor, vec3(1.0), 0.35), vRim);
  gl_FragColor = vec4(col * uLevel * twinkle, a * (0.35 + 0.65 * vRim));
}
`;

/** Evenly spaced points on a unit sphere (Fibonacci). */
function shell(count) {
  const pos = new Float32Array(count * 3);
  const rnd = new Float32Array(count);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    pos.set([Math.cos(golden * i) * r, y, Math.sin(golden * i) * r], i * 3);
    rnd[i] = Math.random();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aRandom', new THREE.BufferAttribute(rnd, 1));
  return g;
}

function orbPoints(count, radius, size) {
  const points = new THREE.Points(
    shell(count),
    new THREE.ShaderMaterial({
      vertexShader: orbVert,
      fragmentShader: orbFrag,
      uniforms: {
        uTime: { value: 0 },
        uAmp: { value: 0 },
        uSize: { value: size },
        uPixelRatio: { value: Math.min(2, window.devicePixelRatio || 1) },
        uRadius: { value: radius },
        uColor: { value: new THREE.Color() },
        uLevel: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  points.frustumCulled = false;
  return points;
}

/**
 * color: THREE.Color; radius: world units; opts.particles: how many on the shell.
 * Returns { group, state: { flash, working, live }, update(t, dt) }.
 */
export function makeAgent(color, radius, opts = {}) {
  const count = opts.particles ?? Math.round(1400 * radius);
  const group = new THREE.Group();
  const orb = orbPoints(count, radius, opts.size ?? 30 * radius);
  const halo = glowSprite(color, radius * 4.2, 0.2);
  const core = glowSprite(color.clone().lerp(new THREE.Color('#ffffff'), 0.5), radius * 1.3, 0.7);
  group.add(halo, orb, core);

  const state = { flash: 0, working: false, live: true };
  const u = orb.material.uniforms;
  let clock = 0;
  let amp = 0;

  return {
    group,
    state,
    update(t, dt) {
      const live = state.live;
      state.flash = Math.max(0, state.flash - dt * 1.4);
      clock += dt * (live ? 1 : 0);
      // Ripples ease in and out with work.
      amp += ((live && state.working ? 0.05 : 0) - amp) * Math.min(1, dt * 3);
      u.uTime.value = clock;
      u.uAmp.value = amp;
      u.uColor.value.copy(live ? color : GREY);
      u.uLevel.value = (live ? (state.working ? 1.15 : 0.9) : 0.55) + state.flash * 0.6;
      orb.rotation.y += dt * (live ? (state.working ? 0.35 : 0.1) : 0);
      const breath = live && !state.working ? 1 + 0.02 * Math.sin(t * 1.6) : 1;
      orb.scale.setScalar(breath);
      halo.material.color.copy(live ? color : GREY);
      halo.material.opacity = (live ? (state.working ? 0.3 : 0.18) : 0.04) + state.flash * 0.3;
      const pulse = live ? (state.working ? 0.25 * Math.sin(t * 6) : 0.06 * Math.sin(t * 1.6)) : 0;
      core.visible = live;
      core.material.opacity = (state.working ? 0.85 : 0.6) + state.flash * 0.4;
      core.scale.setScalar(radius * (1.3 + pulse));
    },
  };
}

/** Nobody attached yet: a dashed ring and a faint grey outline of the orb that pulses slowly, facing the camera. */
export function makeGhost(color, radius) {
  const group = new THREE.Group();
  const ring = waitingRing(color, radius);
  const outline = orbPoints(Math.round(500 * radius), radius, 22 * radius);
  outline.material.uniforms.uColor.value.copy(GREY);
  group.add(outline, ring.group);
  return {
    group,
    update(t, dt, camera) {
      ring.update(dt, camera);
      outline.rotation.y += dt * 0.05;
      outline.material.uniforms.uTime.value = t;
      outline.material.uniforms.uLevel.value = 0.35 + 0.2 * Math.sin(t * 1.4);
    },
  };
}
