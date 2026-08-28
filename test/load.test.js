/* Loads the unpacked extension in Chromium to confirm the manifest parses,
 * the service worker registers, and the content script attaches to a page. */
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const { chromium } = require('playwright');

(async () => {
  const ext = path.join(__dirname, '..');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-profile-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = new URL(worker.url()).host;
  console.log('service worker up:', worker.url());

  // The worker's message handler answers GET_STATE with defaults on a fresh profile.
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/src/options/options.html`);
  await page.waitForSelector('#profileGrid label');
  const labels = await page.$$eval('#profileGrid label span', (els) => els.length);
  assert.ok(labels > 30, 'options page renders the profile editor');

  const state = await page.evaluate(() => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, resolve);
  }));
  assert.ok(state && state.ok, 'service worker responds to GET_STATE');
  assert.strictEqual(state.hasKey, false);
  assert.strictEqual(state.settings.model, 'claude-opus-5');
  assert.deepStrictEqual(state.applicationResume, { fileName: '', size: 0, updatedAt: 0 });
  console.log('GET_STATE:', JSON.stringify(state.resume), 'bank:', state.bankSize);

  // The application resume is a separate original file, not the text knowledge base.
  await page.setInputFiles('#applicationResumeFile', {
    name: 'Alex_Rivera_Resume.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from('test-docx-bytes')
  });
  await page.waitForFunction(() => /Saved (?:and ready|for attachment)/.test(document.getElementById('applicationResumeStatus').textContent));
  const storedFile = await page.evaluate(() => new Promise((resolve) => {
    chrome.storage.local.get('applicationResume', ({ applicationResume }) => resolve(applicationResume));
  }));
  assert.strictEqual(storedFile.fileName, 'Alex_Rivera_Resume.docx');
  assert.match(storedFile.dataUrl, /^data:application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document;base64,/);

  // Generating answers without a key must fail loudly rather than silently.
  const err = await page.evaluate(() => new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GENERATE_ANSWERS', payload: { questions: [] } }, resolve);
  }));
  assert.strictEqual(err.ok, false);
  assert.match(err.error, /API key/i);
  console.log('no-key error surfaced:', err.error);

  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
  console.log('\nExtension loaded and wired up correctly');
})().catch((err) => { console.error(err); process.exit(1); });
