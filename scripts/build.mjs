// Build: bundle TypeScript entry points into dist/ (what Chrome loads unpacked) and copy static
// assets plus the onnxruntime-web WASM binaries. No framework, no transpile-only step: esbuild
// does bundling; `npm run check` (tsc --noEmit) does type checking.
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const watch = process.argv.includes('--watch');
const OUT = 'dist';

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// --- Static files -------------------------------------------------------------------------
copyFileSync('src/manifest.json', join(OUT, 'manifest.json'));
mkdirSync(join(OUT, 'app'), { recursive: true });
for (const f of readdirSync('src/app').filter((f) => /\.(html|css|svg|png)$/.test(f))) {
  copyFileSync(join('src/app', f), join(OUT, 'app', f));
}
if (existsSync('src/icons')) cpSync('src/icons', join(OUT, 'icons'), { recursive: true });

// Spike pages (throwaway experiments, see spikes/README.md). Built so Playwright can open them.
for (const dir of readdirSync('spikes', { withFileTypes: true }).filter((d) => d.isDirectory())) {
  const src = join('spikes', dir.name);
  const dst = join(OUT, 'spikes', dir.name);
  mkdirSync(dst, { recursive: true });
  for (const f of readdirSync(src).filter((f) => /\.(html|css|wav)$/.test(f))) {
    copyFileSync(join(src, f), join(dst, f));
  }
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

// Extension pages, workers and the service worker are ES modules.
const esm = await esbuild.context({
  ...common,
  format: 'esm',
  entryPoints: [
    'src/background.ts',
    'src/app/app.ts',
    ...readdirSync('spikes', { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join('spikes', d.name, 'spike.ts')))
      .map((d) => ({
        in: join('spikes', d.name, 'spike.ts'),
        out: join('spikes', d.name, 'spike'),
      })),
    ...readdirSync('spikes', { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join('spikes', d.name, 'worker.ts')))
      .map((d) => ({
        in: join('spikes', d.name, 'worker.ts'),
        out: join('spikes', d.name, 'worker'),
      })),
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
