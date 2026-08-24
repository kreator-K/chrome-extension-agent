/* Confirms the on-page panel renders a match score section using a fixture
 * resume + job-description page, via real Chromium (Playwright). */
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const LIBS = ['src/lib/util.js', 'src/lib/rules.js', 'src/lib/fields.js', 'src/lib/keywords.js']
  .map((f) => path.join(__dirname, '..', f));
const CONTENT = path.join(__dirname, '..', 'src', 'content', 'content.js');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  // Fake chrome.* before any extension script runs, and stub storage with a resume + profile.
  await page.addInitScript(() => {
    window.__STORE = {
      resume: {
        text: 'Senior Software Engineer. Led migration of the payments platform to Kubernetes and Docker. Built distributed systems in Python. Operated services on AWS (EC2, S3, Lambda) and PostgreSQL.',
        fileName: 'resume.txt',
        updatedAt: Date.now()
      },
      profile: { currentTitle: 'Senior Backend Engineer', totalYearsExperience: '6' },
      settings: { apiKey: '', model: 'claude-opus-5', autoScan: true },
      answerBank: []
    };
    window.chrome = {
      storage: { local: {
        get: (keys, cb) => {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => { out[k] = window.__STORE[k]; });
          cb(out);
        },
        set: (obj, cb) => { Object.assign(window.__STORE, obj); cb && cb(); }
      } },
      runtime: {
        onMessage: { addListener: (fn) => { window.__listeners = window.__listeners || []; window.__listeners.push(fn); } },
        sendMessage: () => {},
        lastError: null
      }
    };
  });

  // addInitScript only fires on a real navigation, not setContent().
  await page.goto('file://' + path.join(__dirname, 'fixtures', 'jd.html'));

  for (const file of LIBS) await page.addScriptTag({ path: file });
  await page.addScriptTag({ path: CONTENT });

  // Content script registers its message listener synchronously; drive it
  // exactly like the popup does with an OPEN_PANEL message.
  await page.evaluate(() => new Promise((resolve) => {
    const listener = window.__listeners[0];
    listener({ type: 'OPEN_PANEL' }, {}, () => resolve());
  }));

  const host = await page.waitForSelector('#ra-host', { timeout: 5000 }).catch(() => null);
  assert.ok(host, 'panel host was not created — content script did not run scan()');

  const scoreText = await page.evaluate(() => {
    const host = document.getElementById('ra-host');
    const el = host.shadowRoot.querySelector('.score-circle');
    return el ? el.textContent : null;
  });
  assert.ok(scoreText, 'no match score rendered');
  const score = Number(scoreText);
  console.log('Rendered match score:', score);
  assert.ok(score > 0 && score <= 100, `score out of range: ${score}`);

  const chips = await page.evaluate(() => {
    const host = document.getElementById('ra-host');
    return Array.from(host.shadowRoot.querySelectorAll('.kw-chip.gap')).map((el) => el.textContent);
  });
  console.log('Missing keywords shown:', chips.join(', '));
  assert.ok(chips.some((c) => /terraform|kafka/i.test(c)), 'expected Terraform/Kafka to show as a gap');

  await browser.close();
  console.log('\nPanel match-score rendering passed');
})().catch((err) => { console.error(err); process.exit(1); });
