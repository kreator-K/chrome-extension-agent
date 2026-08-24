/* Fresh-profile regression for the complete local workflow:
 * knowledge-base upload -> profile extraction -> application-resume storage ->
 * review panel -> profile field fill + resume attachment. */
const path = require('path');
const os = require('os');
const fs = require('fs');
const assert = require('assert');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const LIBS = ['src/lib/util.js', 'src/lib/rules.js', 'src/lib/fields.js', 'src/lib/keywords.js']
  .map((file) => path.join(ROOT, file));
const CONTENT = path.join(ROOT, 'src', 'content', 'content.js');

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ra-workflow-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    args: [`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`]
  });

  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(worker.url()).host;
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extId}/src/options/options.html`);
    await options.waitForSelector('#profileGrid label');

    const knowledgeBase = `PROFESSIONAL RESUME
Alex Rivera
Austin, TX 78701
alex.rivera@example.com | +1 (512) 555-0199
linkedin.com/in/alexrivera | github.com/alexrivera

Backend engineer with 8+ years of professional experience.
Authorized to work in the United States without sponsorship.
Python (6 years) · Kubernetes — 3 yrs
Master's in Computer Science | Example University | 2018

PROFESSIONAL EXPERIENCE
Senior Backend Engineer | Acme Corp | 2022 - Present`;

    await options.setInputFiles('#kbFile', {
      name: 'resume-knowledge-base.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(knowledgeBase)
    });
    await options.waitForFunction(() => document.getElementById('resumeText').value.includes('Alex Rivera'));
    await options.click('#saveResume');
    await options.waitForFunction(() => document.getElementById('p_firstName').value === 'Alex');

    assert.strictEqual(await options.inputValue('#p_lastName'), 'Rivera');
    assert.strictEqual(await options.inputValue('#p_email'), 'alex.rivera@example.com');
    assert.strictEqual(await options.inputValue('#p_city'), 'Austin');
    assert.strictEqual(await options.inputValue('#p_totalYearsExperience'), '8');
    assert.strictEqual(await options.inputValue('#p_major'), 'Computer Science');
    assert.strictEqual(await options.inputValue('#p_school'), 'Example University');
    assert.strictEqual(await options.inputValue('#p_currentTitle'), 'Senior Backend Engineer');
    assert.strictEqual(await options.inputValue('#p_currentCompany'), 'Acme Corp');

    // Re-running extraction must still fill blanks left by a previous partial pass.
    await options.evaluate(() => new Promise((resolve) => {
      chrome.storage.local.get('profile', ({ profile }) => {
        profile.phone = '';
        chrome.storage.local.set({ profile }, resolve);
      });
    }));
    await options.click('#extractProfile');
    await options.waitForFunction(() => document.getElementById('p_phone').value.includes('512'));

    await options.setInputFiles('#applicationResumeFile', {
      name: 'Alex_Rivera_Resume.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('workflow-docx-bytes')
    });
    await options.waitForFunction(() => /Alex_Rivera_Resume\.docx/.test(document.getElementById('applicationResumeMeta').textContent));

    const store = await options.evaluate(() => new Promise((resolve) => chrome.storage.local.get(null, resolve)));
    assert.strictEqual(store.applicationResume.fileName, 'Alex_Rivera_Resume.docx');
    assert.strictEqual(store.profile.firstName, 'Alex');

    const application = await context.newPage();
    await application.addInitScript((saved) => {
      window.__STORE = saved;
      window.chrome = {
        storage: { local: {
          get: (keys, cb) => {
            if (keys == null) return cb(Object.assign({}, window.__STORE));
            const out = {};
            (Array.isArray(keys) ? keys : [keys]).forEach((key) => { out[key] = window.__STORE[key]; });
            cb(out);
          },
          set: (obj, cb) => { Object.assign(window.__STORE, obj); if (cb) cb(); }
        } },
        runtime: {
          onMessage: { addListener: (fn) => { window.__listeners = window.__listeners || []; window.__listeners.push(fn); } },
          sendMessage: () => {},
          lastError: null
        }
      };
    }, store);
    await application.goto('file://' + path.join(__dirname, 'fixtures', 'form.html'));
    for (const file of LIBS) await application.addScriptTag({ path: file });
    await application.addScriptTag({ path: CONTENT });

    await application.evaluate(() => new Promise((resolve) => {
      window.__listeners[0]({ type: 'OPEN_PANEL' }, {}, () => resolve());
    }));
    await application.waitForSelector('#ra-host');
    const resumeBadge = await application.evaluate(() => {
      const root = document.getElementById('ra-host').shadowRoot;
      const item = Array.from(root.querySelectorAll('.item')).find((el) => /upload your resume/i.test(el.querySelector('.q').textContent));
      return item && item.querySelector('.badge').textContent;
    });
    assert.strictEqual(resumeBadge, 'application resume');

    await application.evaluate(() => {
      document.getElementById('ra-host').shadowRoot.querySelector('[data-act="fillall"]').click();
    });

    const applied = await application.evaluate(() => ({
      firstName: document.getElementById('fn').value,
      email: document.getElementById('em').value,
      resumeName: (document.getElementById('resume-upload').files[0] || {}).name || '',
      coverLetterCount: document.getElementById('cover-letter-upload').files.length
    }));
    assert.deepStrictEqual(applied, {
      firstName: 'Alex',
      email: 'alex.rivera@example.com',
      resumeName: 'Alex_Rivera_Resume.docx',
      coverLetterCount: 0
    });

    console.log('Fresh-profile upload, extraction, review, fill, and attachment workflow passed');
  } finally {
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exit(1); });
