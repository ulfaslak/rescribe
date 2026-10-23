// Playwright fixtures: launch Chromium with the built extension and Chrome's fake media devices.
// See AGENTS/DNA/DEVELOPMENT.md § "The e2e harness".
import { test as base, chromium, type BrowserContext } from '@playwright/test';
import {
  chmodSync,
  constants,
  cpSync,
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extensionIdForPath } from '../native/lib.ts';
import { NATIVE_HOST } from '../src/lib/routines.ts';

/** Title of the page a test opens for getDisplayMedia to auto-select (see the flag below). */
export const CAPTURE_TARGET_TITLE = 'Rescribe Capture Target';

/**
 * The build the browser loads: a copy of dist/ whose manifest also holds host access to every
 * page. A real toolbar click grants activeTab on the clicked tab, which the start dialog's overlay
 * is injected on; the click the harness fakes through the service worker grants nothing, so
 * without this every page would get the fallback window (ENVIRONMENT_NOTES § "The faked toolbar
 * click has no activeTab grant"). It reaches the file:// capture target too (an extension loaded
 * with --load-extension has file access), so a test that wants the fallback window clicks on a
 * chrome:// tab. The path is fixed, so the extension id (and the model cache under it) survives
 * between runs.
 */
function testBuild(): string {
  const dist = path.resolve('dist');
  const out = path.resolve('.playwright/extension');
  rmSync(out, { recursive: true, force: true });
  cpSync(dist, out, { recursive: true, mode: constants.COPYFILE_FICLONE });
  const manifest = JSON.parse(readFileSync(path.join(dist, 'manifest.json'), 'utf8')) as Record<
    string,
    unknown
  >;
  manifest['host_permissions'] = ['<all_urls>'];
  writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return out;
}

/**
 * The routines' native host for the test browser: the real native/host.ts, with a home, a
 * recordings folder and routines of the harness's own (e2e/fixtures/routines/), registered in the
 * profile, which Chromium reads native messaging hosts from (`<user-data-dir>/NativeMessagingHosts`).
 * The recordings folder is named like helpers.ts `EXPORT_DIR`, since the host checks the Settings
 * folder's name against it; the export itself goes to OPFS, so a spec that wants a run to find
 * the recording on disk writes it there (routines.spec.ts). The home is emptied on every launch.
 * It is outside ~/Documents, as the real one is (`~/.rescribe`): the browser cannot start a host
 * whose executable lives there (ENVIRONMENT_NOTES § "A native host under ~/Documents never
 * starts"). One per checkout, so worktrees do not share it.
 */
export const HOST_HOME = path.join(
  tmpdir(),
  `rescribe-e2e-${createHash('sha256').update(process.cwd()).digest('hex').slice(0, 8)}`,
);
export const HOST_RECORDINGS = path.join(HOST_HOME, 'export-test');

function registerHost(profile: string, extensionDir: string): void {
  rmSync(HOST_HOME, { recursive: true, force: true });
  mkdirSync(HOST_RECORDINGS, { recursive: true });
  const wrapper = path.join(HOST_HOME, 'rescribe-host');
  writeFileSync(
    wrapper,
    [
      '#!/bin/sh',
      `export RESCRIBE_HOME="${HOST_HOME}"`,
      `export RESCRIBE_RECORDINGS="${HOST_RECORDINGS}"`,
      `export RESCRIBE_ROUTINES="${path.resolve('e2e/fixtures/routines')}"`,
      'export RESCRIBE_NOTIFY=0',
      // Chrome drops a host's stderr; the harness keeps it.
      `exec "${process.execPath}" --no-warnings "${path.resolve('native/host.ts')}" "$@" 2>>"${path.join(HOST_HOME, 'host.log')}"`,
      '',
    ].join('\n'),
  );
  chmodSync(wrapper, 0o755);
  const hosts = path.join(profile, 'NativeMessagingHosts');
  mkdirSync(hosts, { recursive: true });
  writeFileSync(
    path.join(hosts, `${NATIVE_HOST}.json`),
    JSON.stringify({
      name: NATIVE_HOST,
      description: 'Rescribe routines (e2e)',
      path: wrapper,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${extensionIdForPath(extensionDir)}/`],
    }),
  );
}

export const test = base.extend<{ context: BrowserContext; extensionId: string }>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const dist = testBuild();
    const wav = path.resolve('e2e/fixtures/speech.wav');
    const headed = !!process.env['HEADED'];
    const profile = path.resolve(process.env['PW_PROFILE'] ?? '.playwright/profile');
    // The profile is reused for the model cache (IndexedDB), but Chromium also keeps the
    // extension's service worker script in it and serves the stale copy after a rebuild
    // (ENVIRONMENT_NOTES § "A reused profile runs the old service worker"). Drop that cache.
    rmSync(path.join(profile, 'Default', 'Service Worker'), { recursive: true, force: true });
    // Chrome reopens pinned tabs at startup on its own (`pinned_tabs`, a protected preference
    // in Secure Preferences), and the service worker creates the app tab pinned: the next
    // launch would start with a ghost app tab (an error page under the app URL) that
    // `chrome.tabs.query` sees, the service worker reloads instead of opening a tab, and
    // Playwright never emits `page` for (ENVIRONMENT_NOTES § "The reused profile reopens the
    // last run's pinned app tab"). The session files go too, so nothing else comes back. No
    // braces in the patterns: Node's globSync does not expand them.
    for (const name of ['Preferences', 'Secure Preferences']) {
      const prefs = path.join(profile, 'Default', name);
      if (!existsSync(prefs)) continue;
      const json = JSON.parse(readFileSync(prefs, 'utf8')) as Record<string, unknown>;
      if ('pinned_tabs' in json) {
        delete json['pinned_tabs'];
        writeFileSync(prefs, JSON.stringify(json));
      }
    }
    for (const pattern of [
      'Sessions',
      'Session_*',
      'Tabs_*',
      'Last Session',
      'Current Session',
      'Last Tabs',
      'Current Tabs',
    ])
      for (const f of globSync(path.join(profile, 'Default', pattern)))
        rmSync(f, { recursive: true, force: true });
    registerHost(profile, dist);
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
    // Close the app tabs the service worker pinned before the browser goes, so Chrome has no
    // pinned tab to bring back (the launch-time strip above is the belt for a run that died).
    const worker = context.serviceWorkers()[0];
    if (worker)
      await worker
        .evaluate(async () => {
          const url = chrome.runtime.getURL('app/app.html');
          for (const t of await chrome.tabs.query({ url }))
            if (t.id !== undefined) await chrome.tabs.remove(t.id).catch(() => undefined);
        })
        .catch(() => undefined);
    await context.close();
  },
  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker');
    await use(new URL(worker.url()).host);
  },
});

export const expect = test.expect;
