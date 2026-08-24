/* Drives the DOM layer (scanFields / fillField) in real Chromium via Playwright. */
const path = require('path');
const assert = require('assert');
const { chromium } = require('playwright');

const FILES = ['src/lib/util.js', 'src/lib/rules.js', 'src/lib/fields.js']
  .map((f) => path.join(__dirname, '..', f));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('file://' + path.join(__dirname, 'fixtures', 'form.html'));
  await page.addInitScript(() => {});
  for (const file of FILES) await page.addScriptTag({ path: file });

  const fields = await page.evaluate(() => window.RA.scanFields(document));
  const byLabel = (needle) => fields.find((f) => f.label.toLowerCase().includes(needle));

  console.log(fields.map((f) => `${f.kind.padEnd(8)} ${f.label}`).join('\n'));

  assert.ok(byLabel('first name'), 'finds a label[for] text input');
  assert.ok(byLabel('email address'), 'finds the email input');
  assert.ok(byLabel('legally authorized'), 'finds an aria-labelledby select');
  assert.strictEqual(byLabel('legally authorized').kind, 'select');
  assert.ok(byLabel('sponsorship'), 'finds the radio group by its legend');
  assert.strictEqual(byLabel('sponsorship').kind, 'radio');
  assert.strictEqual(byLabel('sponsorship').options.length, 2);
  assert.strictEqual(byLabel('why do you want').kind, 'textarea');
  assert.strictEqual(byLabel('why do you want').maxLength, 300);
  assert.ok(byLabel('years of experience'), 'finds the years-of-experience input');
  assert.ok(byLabel('certify'), 'finds the checkbox');
  assert.strictEqual(byLabel('upload your resume').kind, 'file', 'finds the resume upload');
  assert.ok(!byLabel('optional cover letter'), 'does not claim unrelated file uploads');
  assert.ok(!fields.some((f) => /search/i.test(f.label)), 'skips the search box');
  assert.ok(!fields.some((f) => /csrf/i.test(f.label)), 'skips hidden inputs');
  assert.strictEqual(byLabel('how did you hear').kind, 'combobox', 'recognizes React-style comboboxes');
  assert.strictEqual(byLabel('computer science major').value, 'Yes', 'reads an existing React-select value');

  const result = await page.evaluate(async (ids) => {
    const R = window.RA;
    const out = {};
    out.text = await R.fillField(ids.fn, 'Prashant');
    out.select = await R.fillField(ids.auth, 'Yes');
    out.radio = await R.fillField(ids.sponsor, 'No');
    out.textarea = await R.fillField(ids.why, 'x'.repeat(400));
    out.checkbox = await R.fillField(ids.tos, 'Yes');
    out.combobox = await R.fillField(ids.source, 'Handshake');
    out.file = await R.fillField(ids.resume, {
      fileName: 'Alex_Rivera_Resume.pdf',
      mimeType: 'application/pdf',
      dataUrl: 'data:application/pdf;base64,JVBERi0xLjQK'
    });
    out.dom = {
      fn: document.getElementById('fn').value,
      auth: document.getElementById('auth').value,
      sponsor: (document.querySelector('input[name=sponsor]:checked') || {}).value,
      whyLen: document.getElementById('why').value.length,
      tos: document.getElementById('tos').checked,
      source: document.querySelector('#source-combo').closest('.select__value-container').querySelector('.select__single-value')?.textContent,
      resumeName: (document.getElementById('resume-upload').files[0] || {}).name
    };
    return out;
  }, {
    fn: byLabel('first name').id,
    auth: byLabel('legally authorized').id,
    sponsor: byLabel('sponsorship').id,
    why: byLabel('why do you want').id,
    tos: byLabel('certify').id,
    source: byLabel('how did you hear').id,
    resume: byLabel('upload your resume').id
  });

  assert.strictEqual(result.dom.fn, 'Prashant');
  assert.strictEqual(result.dom.auth, 'y', 'select resolved "Yes" to the y option');
  assert.strictEqual(result.dom.sponsor, 'no', 'radio resolved "No"');
  assert.strictEqual(result.dom.whyLen, 300, 'textarea respected maxlength');
  assert.strictEqual(result.dom.tos, true);
  assert.strictEqual(result.dom.source, 'Handshake', 'custom combobox selected a real option');
  assert.strictEqual(result.dom.resumeName, 'Alex_Rivera_Resume.pdf');
  assert.strictEqual(result.file.ok, true);

  await browser.close();
  console.log('\nAll DOM assertions passed');
})().catch((err) => { console.error(err); process.exit(1); });
