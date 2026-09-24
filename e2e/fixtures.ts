// Playwright fixtures: launch Chromium with the built extension and Chrome's fake media devices.
// See AGENTS/DNA/DEVELOPMENT.md § "The e2e harness".
import { test as base, chromium, type BrowserContext } from '@playwright/test';
import path from 'node:path';

export const SPIKE_TARGET_TITLE = 'Rescribe Spike Target';

export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const dist = path.resolve('dist');
    const wav = path.resolve('e2e/fixtures/speech.wav');
    const headed = !!process.env['HEADED'];
    const context = await chromium.launchPersistentContext(path.resolve('.playwright/profile'), {
      channel: process.env['CHROME_CHANNEL'] ?? 'chromium',
      headless: !headed,
      args: [
        `--disable-extensions-except=${dist}`,
        `--load-extension=${dist}`,
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${wav}`,
        `--auto-select-tab-capture-source-by-title=${SPIKE_TARGET_TITLE}`,
        '--autoplay-policy=no-user-gesture-required',
        '--enable-unsafe-webgpu',
      ],
    });
    await use(context);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    await use(new URL(worker.url()).host);
  },
});

export const expect = test.expect;
