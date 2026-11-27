// Where each landing particle starts (a tight star cluster) and where it ends: two agents as neural clouds (yours
// and your teammate's) — bright clusters of particles for the neurons, fine filaments of particles along the
// synapses between them — a bridge of particles between the two agents, and a faint halo.

// Share of the particles per part; the rest is halo.
const SHARE = { agentA: 0.42, agentB: 0.42, bridge: 0.1 };
// Within an agent: how much goes to the neurons; the rest makes the synapse filaments.
const NEURON_SHARE = 0.24;
const NEURONS = 64;
const SYNAPSES_PER_NEURON = 3;

/** Centres of the two agents. */
export const CENTERS = { a: [-2.25, 0, 0], b: [2.25, 0, 0] };
export const AGENT_RADIUS = 1.35;

function gauss() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Neuron positions in a slightly flattened ball, denser in the middle, and the synapses between near ones. */
function brain(radius) {
  const nodes = [];
  for (let i = 0; i < NEURONS; i++) {
    const u = Math.random() * 2 - 1;
    const a = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const r = radius * (0.2 + 0.8 * Math.cbrt(Math.random()));
    nodes.push([Math.cos(a) * s * r, u * r * 0.86, Math.sin(a) * s * r]);
  }
  const d2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
  const edges = [];
  const seen = new Set();
  nodes.forEach((p, i) => {
    nodes
      .map((q, j) => ({ j, d: i === j ? Infinity : d2(p, q) }))
      .sort((x, y) => x.d - y.d)
      .slice(0, SYNAPSES_PER_NEURON)
      .forEach(({ j }) => {
        const key = i < j ? `${i}-${j}` : `${j}-${i}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push([i, j]);
        }
      });
  });
  return { nodes, edges };
}

/**
 * Buffers for n particles.
 * colors: { you, them, white } as THREE.Color.
 * pulse: -1 for most particles; for a synapse particle, the synapse's number plus where along it (0..1), so the
 * shader can run a spark along each filament.
 */
export function binarySystem(n, colors) {
  const position = new Float32Array(n * 3);
  const target = new Float32Array(n * 3);
  const color = new Float32Array(n * 3);
  const random = new Float32Array(n);
  const kind = new Float32Array(n);
  const pulse = new Float32Array(n).fill(-1);

  let i = 0;
  const put = (x, y, z, c, k, p = -1) => {
    // Start: a small Gaussian cluster at the centre.
    position[i * 3] = gauss() * 0.45;
    position[i * 3 + 1] = gauss() * 0.45;
    position[i * 3 + 2] = gauss() * 0.45;
    target[i * 3] = x;
    target[i * 3 + 1] = y;
    target[i * 3 + 2] = z;
    color[i * 3] = Math.min(1, c.r);
    color[i * 3 + 1] = Math.min(1, c.g);
    color[i * 3 + 2] = Math.min(1, c.b);
    random[i] = Math.random();
    kind[i] = k;
    pulse[i] = p;
    i += 1;
  };

  let synapseId = 0;
  const agent = (count, center, base, k) => {
    const { nodes, edges } = brain(AGENT_RADIUS);
    const neuronCount = Math.floor(count * NEURON_SHARE);
    // Neurons: small bright clusters, some bigger than others.
    const weight = nodes.map(() => 0.4 + Math.random());
    const total = weight.reduce((a, b) => a + b, 0);
    let made = 0;
    nodes.forEach((p, j) => {
      const share =
        j === nodes.length - 1 ? neuronCount - made : Math.round((neuronCount * weight[j]) / total);
      const sigma = 0.035 + weight[j] * 0.035;
      for (let m = 0; m < share; m++) {
        // Dim per particle: many overlap in a neuron, and additive blending adds them up.
        const c = base
          .clone()
          .lerp(colors.white, 0.15 + Math.random() * 0.25)
          .multiplyScalar(0.42);
        put(
          center[0] + p[0] + gauss() * sigma,
          center[1] + p[1] + gauss() * sigma,
          center[2] + p[2] + gauss() * sigma,
          c,
          k,
        );
      }
      made += share;
    });
    // Synapses: fine filaments, evenly shared, each carrying a running spark (see the shader).
    const perEdge = Math.max(1, Math.floor((count - neuronCount) / edges.length));
    for (const [a, b] of edges) {
      const p = nodes[a];
      const q = nodes[b];
      for (let m = 0; m < perEdge; m++) {
        const u = Math.random();
        const c = base.clone().multiplyScalar(0.35 + Math.random() * 0.35);
        put(
          center[0] + p[0] + (q[0] - p[0]) * u + gauss() * 0.012,
          center[1] + p[1] + (q[1] - p[1]) * u + gauss() * 0.012,
          center[2] + p[2] + (q[2] - p[2]) * u + gauss() * 0.012,
          c,
          k,
          synapseId + u * 0.999,
        );
      }
      synapseId += 1;
    }
  };

  agent(Math.floor(n * SHARE.agentA), CENTERS.a, colors.you, 2);
  agent(Math.floor(n * SHARE.agentB), CENTERS.b, colors.them, 3);

  // The bridge: positions are computed in the shader; target.x is where on the arc, target.y the direction.
  const bridge = Math.floor(n * SHARE.bridge);
  for (let j = 0; j < bridge && i < n; j++) {
    const forward = Math.random() < 0.5;
    const c = (forward ? colors.you : colors.them).clone().lerp(colors.white, Math.random() * 0.4);
    put(Math.random(), forward ? 1 : 0, 0, c, 1);
  }

  // The halo: a faint, wide disc of dust around the pair.
  while (i < n) {
    const a = Math.random() * Math.PI * 2;
    const rad = 3.2 + Math.pow(Math.random(), 0.6) * 6;
    const c = colors.white
      .clone()
      .lerp(Math.random() < 0.5 ? colors.you : colors.them, 0.5)
      .multiplyScalar(0.25 + Math.random() * 0.3);
    put(Math.cos(a) * rad, gauss() * 0.35, Math.sin(a) * rad * 0.55, c, 0);
  }

  return { position, target, color, random, kind, pulse };
}
