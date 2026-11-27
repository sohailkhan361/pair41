// GLSL for the 3D layer. Particles are soft additive sprites; planets are lit spheres with bands and a rim.

// The landing morph. aKind: 0 halo, 1 bridge (flows between the planets), 2 your planet, 3 your teammate's.
export const particleVert = /* glsl */ `
uniform float uProgress;
uniform float uTime;
uniform float uSize;
uniform float uPixelRatio;
uniform float uFade;
uniform vec3 uA;
uniform vec3 uB;
// The pointer in the system's own space (w = strength, 0 when away).
uniform vec4 uPointer;
attribute vec3 aTarget;
attribute vec3 aColor;
attribute float aRandom;
attribute float aKind;
attribute float aPulse;
varying vec3 vColor;
varying float vAlpha;

vec3 spinY(vec3 p, vec3 c, float a) {
  vec3 d = p - c;
  float s = sin(a), k = cos(a);
  return c + vec3(d.x * k - d.z * s, d.y, d.x * s + d.z * k);
}

// A point on the bridge: an arc from your planet to your teammate's, as a loose tube.
vec3 bridge(float u, float r) {
  vec3 mid = (uA + uB) * 0.5 + vec3(0.0, 0.85, 0.35);
  vec3 p = mix(mix(uA, mid, u), mix(mid, uB, u), u);
  float a = r * 6.28318 + uTime * 0.6;
  float w = 0.05 + 0.16 * sin(u * 3.14159);
  return p + vec3(0.0, cos(a), sin(a)) * w;
}

void main() {
  vec3 target = aTarget;
  if (aKind > 0.5 && aKind < 1.5) {
    // aTarget.x: where on the arc it starts; aTarget.y > 0.5: flows from your planet to theirs.
    float dir = aTarget.y > 0.5 ? 1.0 : -1.0;
    float u = fract(aTarget.x + dir * uTime * (0.05 + 0.07 * aRandom));
    target = bridge(u, aRandom);
  } else if (aKind > 1.5 && aKind < 2.5) {
    target = spinY(aTarget, uA, uTime * 0.18);
  } else if (aKind > 2.5) {
    target = spinY(aTarget, uB, -uTime * 0.15);
  }

  // Staggered, so the cluster bursts outward instead of moving in lockstep.
  float delay = aRandom * 0.45;
  float p = smoothstep(delay, delay + 0.55, uProgress);
  vec3 dir = normalize(target - position + vec3(aRandom - 0.5, aRandom * 0.3, 0.5 - aRandom) + 1e-4);
  float burst = sin(p * 3.14159) * (1.5 + aRandom * 2.0);
  vec3 pos = mix(position, target, p) + dir * burst;

  // The pointer parts the particles near it and lights them a little.
  vec3 away = pos - uPointer.xyz;
  float near = uPointer.w * smoothstep(1.3, 0.0, length(away));
  pos += normalize(away + 1e-4) * near * 0.45;

  // Idle drift that calms as the shape forms.
  float t = uTime * 0.4 + aRandom * 40.0;
  pos += vec3(sin(t), cos(t * 0.8), sin(t * 0.6)) * 0.03 * (1.0 - 0.7 * p);

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  float bridgeBoost = (aKind > 0.5 && aKind < 1.5) ? 1.6 : 1.0;
  gl_PointSize = uSize * uPixelRatio * (0.5 + aRandom) * bridgeBoost / -mv.z;

  // A spark runs along each synapse filament (aPulse = synapse number + position along it).
  float spark = 0.0;
  if (aPulse >= 0.0) {
    float id = floor(aPulse);
    float seed = fract(sin(id * 12.9898) * 43758.5453);
    float head = fract(uTime * (0.25 + seed * 0.45) + seed * 7.0);
    spark = smoothstep(0.09, 0.0, abs(fract(aPulse) - head)) * p;
  }
  vColor = mix(aColor, vec3(1.0), clamp(spark * 0.85 + near * 0.3, 0.0, 1.0));
  // The packed cluster would blow out to white; it brightens as it spreads.
  vAlpha = (0.55 + 0.45 * sin(uTime * 2.0 + aRandom * 60.0)) * uFade * mix(0.14, 1.0, p) * (1.0 + spark * 1.6 + near * 1.2);
}
`;

export const particleFrag = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  a *= a;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor, a * vAlpha);
}
`;

// Background stars: tiny, twinkling, with a size per star.
export const starVert = /* glsl */ `
uniform float uTime;
uniform float uPixelRatio;
uniform float uSize;
attribute float aSize;
attribute float aRandom;
attribute vec3 aColor;
varying vec3 vColor;
varying float vAlpha;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = max(1.0, uSize * aSize * uPixelRatio * (60.0 / -mv.z));
  vColor = aColor;
  vAlpha = 0.45 + 0.55 * (0.5 + 0.5 * sin(uTime * (0.6 + aRandom * 2.2) + aRandom * 80.0));
}
`;

export const starFrag = /* glsl */ `
uniform float uOpacity;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.05, d);
  if (a < 0.02) discard;
  gl_FragColor = vec4(vColor, a * vAlpha * uOpacity);
}
`;

// Warp streaks: per-vertex alpha so each streak fades toward its tail and with distance.
export const streakVert = /* glsl */ `
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
void main() {
  vAlpha = aAlpha;
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const streakFrag = /* glsl */ `
uniform float uOpacity;
varying float vAlpha;
varying vec3 vColor;
void main() {
  gl_FragColor = vec4(vColor, vAlpha * uOpacity);
}
`;

// A planet: soft bands that drift, lit from the top left, a coloured rim, and a flash when a message lands.
const noise = /* glsl */ `
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= 0.5; } return v; }
`;

export const planetVert = /* glsl */ `
varying vec3 vNormal;
varying vec3 vLocal;
varying vec3 vView;
void main() {
  vLocal = position;
  vNormal = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vView = normalize(-mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

export const planetFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uFlash;
uniform float uDim;
uniform float uSeed;
varying vec3 vNormal;
varying vec3 vLocal;
varying vec3 vView;
${noise}
void main() {
  vec3 n = normalize(vLocal);
  float lat = n.y;
  float swirl = fbm(n * 2.6 + vec3(uSeed, uTime * 0.04, uSeed * 0.5));
  float bands = 0.5 + 0.5 * sin(lat * 11.0 + swirl * 5.0 + uSeed);
  vec3 dark = uColor * 0.22;
  vec3 light = mix(uColor, vec3(1.0), 0.35);
  vec3 base = mix(dark, light, bands * 0.75 + swirl * 0.25);
  vec3 L = normalize(vec3(-0.55, 0.65, 0.75));
  float diff = max(dot(vNormal, L), 0.0);
  float rim = pow(1.0 - max(dot(vNormal, vView), 0.0), 2.4);
  vec3 col = base * (0.18 + 0.95 * diff) + uColor * rim * 1.1 + uColor * uFlash * 0.9;
  col = mix(col, col * 0.35 + vec3(0.03), 1.0 - uDim);
  gl_FragColor = vec4(col, 1.0);
}
`;

// The glow around a planet: a back-facing shell, brightest at the edge.
export const atmosphereFrag = /* glsl */ `
uniform vec3 uColor;
uniform float uStrength;
varying vec3 vNormal;
varying vec3 vView;
void main() {
  float rim = pow(1.0 - abs(dot(vNormal, vView)), 4.0);
  gl_FragColor = vec4(uColor, rim * uStrength);
}
`;

// The horizon under the warp: a huge sphere lit only at its rim.
export const horizonFrag = /* glsl */ `
uniform vec3 uA;
uniform vec3 uB;
uniform float uOpacity;
varying vec3 vNormal;
varying vec3 vView;
varying vec3 vLocal;
void main() {
  float rim = pow(1.0 - max(dot(vNormal, vView), 0.0), 4.0);
  vec3 col = mix(uA, uB, 0.5 + 0.5 * normalize(vLocal).x);
  gl_FragColor = vec4(col * rim * 1.6 + vec3(0.004, 0.004, 0.012), uOpacity);
}
`;

// Vignette and a little film grain, after the bloom.
export const finishShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uDarkness: { value: 0.6 },
    uGrain: { value: 0.014 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uDarkness;
    uniform float uGrain;
    varying vec2 vUv;
    float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float v = smoothstep(0.85, 0.2, length(vUv - 0.5));
      c.rgb *= mix(1.0 - uDarkness, 1.0, v);
      c.rgb += (rand(vUv * 1000.0 + uTime) - 0.5) * uGrain;
      gl_FragColor = c;
    }
  `,
};
