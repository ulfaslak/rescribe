// Playwright fixtures: launch Chromium with the built extension and Chrome's fake media devices.
// See AGENTS/DNA/DEVELOPMENT.md § "The e2e harness".
import { test as base, chromium, type BrowserContext } from '@playwright/test';
import { globSync, rmSync } from 'node:fs';
import path from 'node:path';

/** Title of the page a test opens for getDisplayMedia to auto-select (see the flag below). */
export const CAPTURE_TARGET_TITLE = 'Rescribe Capture Target';

export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const dist = path.resolve('dist');
    const wav = path.resolve('e2e/fixtures/speech.wav');
    const headed = !!process.env['HEADED'];
    const profile = path.resolve(process.env['PW_PROFILE'] ?? '.playwright/profile');
    // The profile is reused for the model cache (IndexedDB), but Chromium also keeps the
    // extension's service worker script in it and serves the stale copy after a rebuild
    // (ENVIRONMENT_NOTES § "A reused profile runs the old service worker"). Drop that cache.
    rmSync(path.join(profile, 'Default', 'Service Worker'), { recursive: true, force: true });
    // A run killed mid-way leaves session-restore state; the next launch then restores the old
    // tabs and Playwright never sees a `page` event for tabs the extension opens
    // (ENVIRONMENT_NOTES § "A killed run poisons the profile's session restore").
    for (const f of globSync(
      path.join(
        profile,
        'Default',
        '{Session_*,Tabs_*,Sessions,Last Session,Current Session,Last Tabs,Current Tabs}',
      ),
    ))
      rmSync(f, { recursive: true, force: true });
    const context = await chromium.launchPersistentContext(profile, {
      channel: process.env['CHROME_CHANNEL'] ?? 'chromium',
      headless: !headed,
      args: [
        `--disable-extensions-except=${dist}`,
        `--load-extension=${dist}`,
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-audio-capture=${wav}`,
        `--auto-select-tab-capture-source-by-title=${CAPTURE_TARGET_TITLE}`,
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
