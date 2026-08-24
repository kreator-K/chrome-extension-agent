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

function storedZip(name, content) {
  const fileName = Buffer.from(name);
  const data = Buffer.from(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(fileName.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(fileName.length, 28);

  const centralOffset = local.length + fileName.length + data.length;
  const centralSize = central.length + fileName.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, fileName, data, central, fileName, end]);
}

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

    const knowledgeBase = `# Candidate knowledge base

## Contact
- **Email:** alex.rivera@example.com
- **GitHub:** [Projects](https://github.com/alexrivera)

## Work preferences
Authorized to work in the United States without sponsorship.
Python (6 years) · Kubernetes — 3 yrs

## Education
- **Highest degree:** Master's
- **School:** Example University
- **Major / field of study:** Computer Science
- **Graduation year:** 2018`;

    await options.setInputFiles('#kbFile', {
      name: 'resume-knowledge-base.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(knowledgeBase)
    });
    await options.waitForFunction(() => document.getElementById('resumeText').value.includes('Candidate knowledge base'));
    await options.click('#saveResume');
    await options.waitForFunction(() => document.getElementById('p_email').value === 'alex.rivera@example.com');
    assert.strictEqual(await options.inputValue('#p_firstName'), '', 'KB intentionally leaves the name for the application resume');

    const applicationResumeText = `Name: Alex Rivera
Phone: +1 (512) 555-0199
Location: Austin, TX 78701, USA
LinkedIn: https://linkedin.com/in/alexrivera
Current title: Senior Backend Engineer
Current company: Acme Corp
Total years of experience: 8 years`;
    const applicationResumeDocx = storedZip(
      'word/document.xml',
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      applicationResumeText.split('\n').map((line) => `<w:p><w:r><w:t>${line}</w:t></w:r></w:p>`).join('') +
      '</w:body></w:document>'
    );
    await options.setInputFiles('#applicationResumeFile', {
      name: 'Alex_Rivera_Resume.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: applicationResumeDocx
    });
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
      chrome.storage.local.get(['profile', 'applicationResume'], ({ profile, applicationResume }) => {
        profile.phone = '';
        applicationResume.text = ''; // simulate a DOCX stored by v0.3.1 before text extraction existed
        chrome.storage.local.set({ profile, applicationResume }, resolve);
      });
    }));
    await options.fill('#p_phone', '');
    await options.click('#extractProfile');
    await options.waitForFunction(() => new Promise((resolve) => {
      chrome.storage.local.get('applicationResume', ({ applicationResume }) => {
        resolve((applicationResume.text || '').includes('Name: Alex Rivera'));
      });
    }));
    await options.waitForFunction(() => document.getElementById('p_phone').value.includes('512'));
    const migratedResumeText = await options.evaluate(() => new Promise((resolve) => {
      chrome.storage.local.get('applicationResume', ({ applicationResume }) => resolve(applicationResume.text));
    }));
    assert.ok(migratedResumeText.includes('Name: Alex Rivera'), 'backfills text from a previously stored DOCX');

    const store = await options.evaluate(() => new Promise((resolve) => chrome.storage.local.get(null, resolve)));
    assert.strictEqual(store.applicationResume.fileName, 'Alex_Rivera_Resume.docx');
    assert.ok(store.applicationResume.text.includes('Name: Alex Rivera'), 'DOCX text is stored for profile extraction');
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
    await application.waitForFunction(() => document.getElementById('fn').value === 'Alex');

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
