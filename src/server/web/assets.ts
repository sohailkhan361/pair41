// Static files for the web pages (docs/specs/web.md, "Space: the 3D layer"). Everything is read once at boot and
// gzipped once, so serving is a map lookup. Our own files live under a path with a hash of their contents, and
// vendor packages under a path with their version, so both can be cached for a long time and relative ES-module
// imports (three.module.js → ./three.core.js) keep the same versioned prefix.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

export interface Asset {
  type: string;
  body: Buffer;
  gzip: Buffer | undefined;
  /** Seconds a browser may keep it. */
  maxAge: number;
}

const STATIC = join(import.meta.dirname, 'static');
const require = createRequire(import.meta.url);
const HOUR = 3600;
const YEAR = 365 * 24 * HOUR;

const TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
};

const typeOf = (file: string) => TYPES[file.slice(file.lastIndexOf('.') + 1)] ?? 'application/octet-stream';

/** A package's root folder (where its package.json is), found from any file it resolves to. */
function packageRoot(name: string): string {
  let dir = dirname(require.resolve(name));
  while (!dir.endsWith(`${sep}node_modules${sep}${name}`)) {
    const up = dirname(dir);
    if (up === dir) throw new Error(`Cannot find the folder of ${name}`);
    dir = up;
  }
  return dir;
}

function versionOf(root: string): string {
  return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
}

function asset(body: Buffer, file: string, maxAge: number): Asset {
  const type = typeOf(file);
  const compressible = type.startsWith('text/') || type === 'image/svg+xml';
  return {
    type,
    body,
    gzip: compressible && body.length > 1024 ? gzipSync(body, { level: 9 }) : undefined,
    maxAge,
  };
}

const files = new Map<string, Asset>();

// Our own files: style, scripts, icon. Their URLs carry ?v=<hash> (the layout adds it), so an hour is plenty.
for (const file of ['style.css', 'site.js', 'sim.js', 'p41-icon.svg']) {
  files.set(file, asset(readFileSync(join(STATIC, file)), file, HOUR));
}
files.set(
  'htmx.min.js',
  asset(readFileSync(require.resolve('htmx.org/dist/htmx.min.js')), 'htmx.min.js', HOUR),
);

// The 3D modules: one folder, served under a path with a hash of all of them.
const SPACE_DIR = join(STATIC, 'space');
const spaceFiles = readdirSync(SPACE_DIR).filter((f) => f.endsWith('.js'));
const spaceHash = createHash('sha256');
for (const file of spaceFiles) spaceHash.update(file).update(readFileSync(join(SPACE_DIR, file)));
export const spaceBase = `space-${spaceHash.digest('hex').slice(0, 10)}`;
for (const file of spaceFiles) {
  files.set(`${spaceBase}/${file}`, asset(readFileSync(join(SPACE_DIR, file)), file, YEAR));
}

// Vendor packages, under their versions.
const three = packageRoot('three');
const gsap = packageRoot('gsap');
const lenis = packageRoot('lenis');
export const vendor = {
  three: `vendor/three-${versionOf(three)}`,
  gsap: `vendor/gsap-${versionOf(gsap)}`,
  lenis: `vendor/lenis-${versionOf(lenis)}`,
};
const vendorFiles: [string, string][] = [
  [`${vendor.three}/three.module.js`, join(three, 'build/three.module.js')],
  [`${vendor.three}/three.core.js`, join(three, 'build/three.core.js')],
  ...['EffectComposer', 'RenderPass', 'ShaderPass', 'MaskPass', 'Pass', 'UnrealBloomPass', 'OutputPass'].map(
    (name): [string, string] => [
      `${vendor.three}/addons/postprocessing/${name}.js`,
      join(three, `examples/jsm/postprocessing/${name}.js`),
    ],
  ),
  ...['CopyShader', 'LuminosityHighPassShader', 'OutputShader'].map((name): [string, string] => [
    `${vendor.three}/addons/shaders/${name}.js`,
    join(three, `examples/jsm/shaders/${name}.js`),
  ]),
  [`${vendor.gsap}/gsap.min.js`, join(gsap, 'dist/gsap.min.js')],
  [`${vendor.gsap}/ScrollTrigger.min.js`, join(gsap, 'dist/ScrollTrigger.min.js')],
  [`${vendor.lenis}/lenis.min.js`, join(lenis, 'dist/lenis.min.js')],
  [`${vendor.lenis}/lenis.css`, join(lenis, 'dist/lenis.css')],
];
for (const [path, source] of vendorFiles) files.set(path, asset(readFileSync(source), path, YEAR));

/** The stylesheet's and 2D scripts' version: a hash of their contents. */
export const styleVersion = createHash('sha256')
  .update(files.get('style.css')!.body)
  .update(files.get('site.js')!.body)
  .update(files.get('sim.js')!.body)
  .digest('hex')
  .slice(0, 10);

/** The import map for the 3D modules: bare "three" and its addons resolve to our versioned copies. */
export const importMap = JSON.stringify({
  imports: {
    three: `/static/${vendor.three}/three.module.js`,
    'three/addons/': `/static/${vendor.three}/addons/`,
  },
});

/** Every static file, keyed by its path under /static/. */
export const staticFiles: ReadonlyMap<string, Asset> = files;
