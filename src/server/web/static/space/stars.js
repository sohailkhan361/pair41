// A starfield: tiny twinkling points on a large sphere, most of them white, a few tinted with the side colours.
import { THREE } from './core.js';
import { starFrag, starVert } from './shaders.js';

export function starfield(count, radius, colors, opts = {}) {
  const position = new Float32Array(count * 3);
  const color = new Float32Array(count * 3);
  const size = new Float32Array(count);
  const random = new Float32Array(count);
  const tint = [colors.star, colors.star, colors.star, colors.you, colors.them];
  for (let i = 0; i < count; i++) {
    // Uniform on a sphere, with some depth so parallax reads.
    const u = Math.random() * 2 - 1;
    const a = Math.random() * Math.PI * 2;
    const r = radius * (0.6 + Math.random() * 0.4);
    const s = Math.sqrt(1 - u * u);
    position[i * 3] = Math.cos(a) * s * r;
    position[i * 3 + 1] = u * r;
    position[i * 3 + 2] = Math.sin(a) * s * r;
    const c = tint[Math.floor(Math.random() * tint.length)];
    const k = 0.55 + Math.random() * 0.45;
    color[i * 3] = c.r * k;
    color[i * 3 + 1] = c.g * k;
    color[i * 3 + 2] = c.b * k;
    // Mostly small, a few bright ones.
    size[i] = Math.random() < 0.04 ? 2.2 + Math.random() * 1.5 : 0.6 + Math.random() * 0.9;
    random[i] = Math.random();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(color, 3));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  geometry.setAttribute('aRandom', new THREE.BufferAttribute(random, 1));
  const material = new THREE.ShaderMaterial({
    vertexShader: starVert,
    fragmentShader: starFrag,
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(2, window.devicePixelRatio || 1) },
      uSize: { value: opts.size ?? 1.6 },
      uOpacity: { value: opts.opacity ?? 1 },
    },
    transparent: true,
    depthWrite: false,
    blending: opts.blending ?? THREE.AdditiveBlending,
  });
  return new THREE.Points(geometry, material);
}
