// A little space behind every logged-in page (docs/specs/web.md, "Every logged-in page"): stars in three depth
// layers with scroll and pointer parallax, a faint drifting nebula, and a rare shooting star. About 30 frames a
// second, nothing while the tab is hidden. Light theme: no nebula, fewer and darker stars, normal blending.
import { THREE, addView, damp, makeRenderer, palette, pick, still } from './core.js';
import { starfield } from './stars.js';

const win = window;
const doc = document;

// ---------- tuning knobs ----------
const LAYERS = [
  // count share, radius, parallax strength
  { share: 0.5, radius: 140, parallax: 0.4 },
  { share: 0.35, radius: 90, parallax: 0.75 },
  { share: 0.15, radius: 55, parallax: 1.2 },
];
const COUNT = { high: 3600, mid: 2600, low: 1500 };
const NEBULA_OPACITY = 0.16;
const SHOOTING_EVERY = [10, 20]; // seconds between shooting stars

const nebulaVert = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const nebulaFrag = /* glsl */ `
uniform float uTime;
uniform float uScroll;
uniform float uOpacity;
uniform vec3 uA;
uniform vec3 uB;
uniform vec2 uAspect;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; } return v; }
void main() {
  vec2 p = vUv * uAspect * 1.6 + vec2(uTime * 0.006, uScroll * 0.00025);
  float n = fbm(p + fbm(p * 1.7 + uTime * 0.01));
  float m = fbm(p * 0.7 - 3.1);
  float cloud = smoothstep(0.45, 0.85, n);
  vec3 col = mix(uA, uB, smoothstep(0.3, 0.7, m));
  gl_FragColor = vec4(col * cloud, cloud * uOpacity);
}
`;

function shootingStar() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array(6), 3).setUsage(THREE.DynamicDrawUsage),
  );
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array([1, 1, 1, 0, 0, 0]), 3));
  const line = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  line.frustumCulled = false;
  line.visible = false;
  const s = { line, t: 0, life: 0, from: new THREE.Vector3(), dir: new THREE.Vector3() };
  s.launch = (camera) => {
    // Somewhere in the upper part of the view, heading down and sideways.
    const z = -40;
    const halfH = Math.tan((camera.fov * Math.PI) / 360) * -z;
    const halfW = halfH * camera.aspect;
    s.from.set((Math.random() * 1.6 - 0.8) * halfW, (0.2 + Math.random() * 0.7) * halfH, z);
    const side = Math.random() < 0.5 ? -1 : 1;
    s.dir.set(side * (0.8 + Math.random() * 0.4), -(0.35 + Math.random() * 0.3), 0).normalize();
    s.t = 0;
    s.life = 0.9 + Math.random() * 0.5;
    line.visible = true;
  };
  s.update = (dt) => {
    if (!line.visible) return;
    s.t += dt;
    const k = s.t / s.life;
    if (k >= 1) {
      line.visible = false;
      return;
    }
    const travel = 28 * k;
    const tail = 7 * Math.sin(Math.PI * k);
    const head = s.from.clone().addScaledVector(s.dir, travel);
    const end = head.clone().addScaledVector(s.dir, -tail);
    geometry.attributes.position.array.set([head.x, head.y, head.z, end.x, end.y, end.z]);
    geometry.attributes.position.needsUpdate = true;
    line.material.opacity = Math.sin(Math.PI * k);
  };
  return s;
}

export function initBackdrop() {
  const canvas = doc.createElement('canvas');
  canvas.className = 'space-backdrop';
  canvas.setAttribute('aria-hidden', 'true');
  doc.body.prepend(canvas);
  const renderer = makeRenderer(canvas, { alpha: true });
  renderer.setPixelRatio(Math.min(1.5, win.devicePixelRatio || 1));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 400);

  const nebula = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({
      vertexShader: nebulaVert,
      fragmentShader: nebulaFrag,
      uniforms: {
        uTime: { value: 0 },
        uScroll: { value: 0 },
        uOpacity: { value: NEBULA_OPACITY },
        uA: { value: new THREE.Color() },
        uB: { value: new THREE.Color() },
        uAspect: { value: new THREE.Vector2(1, 1) },
      },
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  nebula.frustumCulled = false;
  nebula.renderOrder = -1;
  scene.add(nebula);

  let layers = [];
  const star = shootingStar();
  scene.add(star.line);
  let nextShot = SHOOTING_EVERY[0];

  const build = () => {
    for (const l of layers) {
      scene.remove(l.points);
      l.points.geometry.dispose();
      l.points.material.dispose();
    }
    const light = doc.documentElement.getAttribute('data-theme') === 'light';
    const c = palette();
    nebula.material.uniforms.uA.value.copy(c.you);
    nebula.material.uniforms.uB.value.copy(c.them);
    nebula.visible = !light;
    if (light) {
      const ink = new THREE.Color('#5a5f73');
      c.star = ink;
      c.you = ink.clone().lerp(c.you, 0.5);
      c.them = ink.clone().lerp(c.them, 0.5);
    }
    const total = Math.round(pick(COUNT) * (light ? 0.5 : 1));
    layers = LAYERS.map((layer, i) => {
      const points = starfield(Math.round(total * layer.share), layer.radius, c, {
        size: (light ? 1.0 : 1.2) + i * 0.25,
        opacity: light ? 0.35 : 0.55 + i * 0.12,
        blending: light ? THREE.NormalBlending : THREE.AdditiveBlending,
      });
      scene.add(points);
      return { points, parallax: layer.parallax };
    });
    star.line.visible = false;
    view.dirty = true;
  };
  const resize = () => {
    renderer.setSize(win.innerWidth, win.innerHeight, false);
    camera.aspect = win.innerWidth / win.innerHeight;
    camera.updateProjectionMatrix();
    nebula.material.uniforms.uAspect.value.set(Math.max(1, camera.aspect), Math.max(1, 1 / camera.aspect));
    view.dirty = true;
  };
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
  win.addEventListener(
    'pointermove',
    (e) => {
      pointer.tx = (e.clientX / win.innerWidth) * 2 - 1;
      pointer.ty = (e.clientY / win.innerHeight) * 2 - 1;
    },
    { passive: true },
  );
  let t = 0;
  let wait = 0;
  let scroll = 0;
  const view = {
    tick(dt, frozen, dirty) {
      t += dt;
      wait += dt;
      // 30 frames a second is plenty for a backdrop.
      if (!frozen && !dirty && wait < 1 / 30) return;
      const step = Math.max(wait, dt);
      wait = 0;
      const sdt = Math.max(step, 1 / 30);
      scroll = damp(scroll, win.scrollY, 4, sdt);
      pointer.x = damp(pointer.x, pointer.tx, 1.5, sdt);
      pointer.y = damp(pointer.y, pointer.ty, 1.5, sdt);
      for (const l of layers) {
        l.points.material.uniforms.uTime.value = t;
        l.points.rotation.y = t * 0.004 + pointer.x * 0.03 * l.parallax;
        l.points.rotation.x = scroll * 0.00018 * l.parallax + pointer.y * 0.02 * l.parallax;
      }
      nebula.material.uniforms.uTime.value = t;
      nebula.material.uniforms.uScroll.value = scroll;
      if (!still() && nebula.visible) {
        nextShot -= step;
        if (nextShot <= 0) {
          star.launch(camera);
          nextShot = SHOOTING_EVERY[0] + Math.random() * (SHOOTING_EVERY[1] - SHOOTING_EVERY[0]);
        }
        star.update(step);
      }
      renderer.render(scene, camera);
    },
  };
  build();
  win.addEventListener('resize', resize, { passive: true });
  resize();
  doc.addEventListener('pair41:theme', build);
  addView(view);
  // Redraw while paused when the page scrolls, so the parallax still follows.
  win.addEventListener('scroll', () => (view.dirty = true), { passive: true });
}
