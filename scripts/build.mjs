// Build: bundle TypeScript entry points into dist/ (what Chrome loads unpacked) and copy static
// assets plus the onnxruntime-web WASM binaries. No framework, no transpile-only step: esbuild
// does bundling; `npm run check` (tsc --noEmit) does type checking.
import * as esbuild from 'esbuild';
import {
  cpSync,
  mkdirSync,
  readdirSync,
  rmSync,
  copyFileSync,
  existsSync,
  globSync,
} from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');
const OUT = 'dist';

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// --- Static files -------------------------------------------------------------------------
copyFileSync('src/manifest.json', join(OUT, 'manifest.json'));
// The extension's pages: the app tab, the two dialogs and the processing tab, each a directory of
// html/css + one bundle.
for (const page of ['app', 'stop', 'start', 'progress']) {
  mkdirSync(join(OUT, page), { recursive: true });
  for (const f of readdirSync(join('src', page)).filter((f) => /\.(html|css|svg|png)$/.test(f))) {
    copyFileSync(join('src', page, f), join(OUT, page, f));
  }
}
if (existsSync('src/icons')) cpSync('src/icons', join(OUT, 'icons'), { recursive: true });
// Stylesheets of the DOM helpers the pages share (src/ui/), linked from the pages as ../ui/*.css.
mkdirSync(join(OUT, 'ui'), { recursive: true });
for (const f of readdirSync('src/ui').filter((f) => f.endsWith('.css'))) {
  copyFileSync(join('src/ui', f), join(OUT, 'ui', f));
}

// onnxruntime-web loads its .wasm (and the .mjs glue for threaded builds) at runtime from
// ort.env.wasm.wasmPaths. We point that at chrome-extension://<id>/vendor/ort/.
const ortDist = 'node_modules/onnxruntime-web/dist';
mkdirSync(join(OUT, 'vendor/ort'), { recursive: true });
for (const f of readdirSync(ortDist).filter((f) =>
  /^ort-wasm-simd-threaded.*\.(wasm|mjs)$/.test(f),
)) {
  copyFileSync(join(ortDist, f), join(OUT, 'vendor/ort', f));
}

// --- Bundles ------------------------------------------------------------------------------
const common = {
  bundle: true,
  target: 'chrome130',
  sourcemap: true,
  logLevel: 'info',
  outdir: OUT,
  outbase: 'src',
};

// Extension pages, workers, AudioWorklet processors and the service worker are ES modules.
// Every file in src/workers/ is its own bundle (spawned with `new Worker(url, { type: 'module' })`),
// as is every `*.worklet.ts` (loaded with `audioWorklet.addModule(url)`). Each bundle carries its
// own copy of whatever it imports from src/lib/; there is no code splitting.
const esm = await esbuild.context({
  ...common,
  format: 'esm',
  entryPoints: [
    'src/background.ts',
    'src/app/app.ts',
    'src/stop/stop.ts',
    'src/start/start.ts',
    'src/progress/progress.ts',
    ...globSync('src/workers/*.ts').filter((f) => !f.endsWith('.test.ts')),
    ...globSync('src/**/*.worklet.ts'),
  ],
});

// Content scripts run as classic scripts inside the host page: no ESM, so IIFE.
const iife = await esbuild.context({
  ...common,
  format: 'iife',
  entryPoints: ['src/content/meet.ts'],
});

if (watch) {
  await Promise.all([esm.watch(), iife.watch()]);
  console.log('watching…');
} else {
  await Promise.all([esm.rebuild(), iife.rebuild()]);
  await Promise.all([esm.dispose(), iife.dispose()]);
}
