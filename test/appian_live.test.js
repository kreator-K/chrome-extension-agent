/* Optional live, read-only regression against the exact Appian Greenhouse job.
 * It scans and scores the real page but never fills or submits any field. */
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const URL = process.env.APPIAN_JOB_URL || 'https://job-boards.greenhouse.io/appian/jobs/8069612';
const RESUME = process.env.RESUME_TEXT_PATH && fs.existsSync(process.env.RESUME_TEXT_PATH)
  ? fs.readFileSync(process.env.RESUME_TEXT_PATH, 'utf8')
  : 'Product Manager with AI, LLM, product strategy, user research, Figma, Python and SQL experience.';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#first_name', { timeout: 15000 });
    for (const file of ['util.js', 'rules.js', 'fields.js', 'keywords.js']) {
      await page.addScriptTag({ path: path.join(ROOT, 'src', 'lib', file) });
    }
    const result = await page.evaluate((resumeText) => {
      const fields = window.RA.scanFields(document);
      const job = document.querySelector('#job_description')?.innerText || document.body.innerText;
      const title = document.querySelector('h1')?.innerText || '';
      const keywords = window.RA.extractKeywords(job, 40).map((item) => item.phrase);
      const score = window.RA.matchScore(job, resumeText, {
        currentTitle: 'Product Manager', totalYearsExperience: '7'
      }, title);
      return {
        title,
        fieldCount: fields.length,
        comboboxCount: fields.filter((field) => field.kind === 'combobox').length,
        labels: fields.map((field) => field.label),
        keywords,
        score
      };
    }, RESUME);

    assert.match(result.title, /Product Manager/i);
    assert.ok(result.fieldCount >= 20, `expected the full application form, found ${result.fieldCount} fields`);
    assert.ok(result.comboboxCount >= 10, 'expected Greenhouse React comboboxes');
    assert.ok(result.labels.some((label) => /Major.*Computer Science.*Computer Engineering/i.test(label)));
    assert.ok(result.keywords.some((keyword) => /product owner/i.test(keyword)));
    assert.ok(result.keywords.some((keyword) => /usability testing/i.test(keyword)));
    assert.ok(result.keywords.some((keyword) => /agile/i.test(keyword)));
    assert.ok(!result.keywords.some((keyword) => /salary|disability insurance|tuition reimbursement|reasonable accommodation|appian provides|please note/i.test(keyword)));
    assert.strictEqual(result.score.breakdown.yearsRequired, null);

    console.log(JSON.stringify({
      title: result.title,
      fields: result.fieldCount,
      comboboxes: result.comboboxCount,
      score: result.score.score,
      matched: result.score.matched,
      missing: result.score.missing,
      keywords: result.keywords
    }, null, 2));
    console.log('\nLive Appian read-only regression passed');
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exit(1); });
