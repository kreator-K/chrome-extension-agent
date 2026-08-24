/* Node smoke test for the pure-logic layer (no DOM, no chrome APIs). */
const assert = require('assert');

global.self = global; // the libs attach to `self` in the browser and worker

// Minimal chrome.storage stub so util.js can be loaded outside the browser.
global.chrome = { storage: { local: { get: (k, cb) => cb({}), set: (o, cb) => cb() } } };
require('../src/lib/util.js');
require('../src/lib/rules.js');
const RA = global.RA;

const profile = Object.assign({}, RA.DEFAULT_PROFILE, {
  firstName: 'Prashant', lastName: 'K', email: 'p@example.com', phone: '+1 555 0100',
  city: 'Austin', state: 'TX', country: 'USA',
  linkedin: 'https://linkedin.com/in/p', github: 'https://github.com/p',
  currentTitle: 'Senior Engineer', currentCompany: 'Acme',
  totalYearsExperience: '8', degreeLevel: "Master's", school: 'NITK', major: 'CS',
  workAuthorized: 'yes', requiresSponsorship: 'no', willingToRelocate: 'yes',
  noticePeriodDays: '30', desiredSalary: '$180,000',
  skills: [{ name: 'Python', years: 6 }, { name: 'Kubernetes', years: 3 }]
});

const cases = [
  ['First Name', 'Prashant'],
  ['Email address', 'p@example.com'],
  ['Mobile phone number', '+1 555 0100'],
  ['LinkedIn Profile URL', 'https://linkedin.com/in/p'],
  ['Are you legally authorized to work in the United States?', 'Yes'],
  ['Will you now or in the future require sponsorship for employment visa status?', 'No'],
  ['How many years of experience do you have with Python?', '6'],
  ['How many years of experience do you have with Kubernetes?', '3'],
  ['Years of experience', '8'],
  ['What is your notice period?', '30 days'],
  ['Expected salary', '$180,000'],
  ['Are you willing to relocate?', 'Yes'],
  ['Highest level of education completed', "Master's"],
  ['Have you ever been convicted of a felony?', 'No'],
  ['Gender', 'Decline to self-identify']
];

let failures = 0;
for (const [question, expected] of cases) {
  const got = RA.answerFromRules({ label: question, kind: 'text' }, profile);
  const value = got ? got.value : null;
  const pass = value === expected;
  if (!pass) failures++;
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${question}  ->  ${JSON.stringify(value)}${pass ? '' : ' (expected ' + JSON.stringify(expected) + ')'}`);
}

// Unknown skill falls back to total experience with lower confidence.
const rust = RA.answerFromRules({ label: 'How many years of experience do you have with Rust?', kind: 'number' }, profile);
assert.strictEqual(rust.value, '8');
assert.ok(rust.confidence < 0.8, 'fallback should be low confidence');

// Open-ended questions are left for the model.
assert.strictEqual(RA.answerFromRules({ label: 'Why do you want to work here?', kind: 'textarea' }, profile), null);
assert.strictEqual(
  RA.answerFromRules({ label: 'Have you held leadership roles through university organizations?', kind: 'combobox' }, profile),
  null,
  'does not answer a university-organization yes/no question with the school name'
);
assert.strictEqual(
  RA.answerFromRules({ label: 'Are you currently pursuing a Major in Computer Science or Computer Engineering?', kind: 'combobox' }, profile),
  null,
  'does not answer a yes/no qualification question with free-text major'
);

// Sensitive questions are never sent to the model.
assert.ok(RA.isSensitive('Please self-identify your race/ethnicity'));
assert.ok(!RA.isSensitive('Describe a project you are proud of'));

// Answer-bank fuzzy matching.
const bank = [{ key: RA.normalize('Why do you want to work at this company?'), question: 'Why do you want to work at this company?', answer: 'Because…', uses: 1 }];
assert.ok(RA.matchAnswerBank(bank, 'Why do you want to work at this company?'));
assert.ok(!RA.matchAnswerBank(bank, 'What is your phone number?'));

// Option matching for selects and radio groups.
const opts = [{ label: 'Yes' }, { label: 'No' }, { label: 'Prefer not to say' }];
assert.strictEqual(RA.bestOption(opts, 'Yes').label, 'Yes');
assert.strictEqual(RA.bestOption(opts, 'No').label, 'No');
assert.strictEqual(RA.bestOption([{ label: 'Remote' }, { label: 'Hybrid' }, { label: 'On-site' }], 'hybrid').label, 'Hybrid');

// Retrieval keeps the relevant paragraph when the resume is too long.
const resume = ['Led payments platform migration to Kubernetes.', 'Built an internal Python data pipeline.', 'x'.repeat(500)].join('\n\n');
assert.ok(RA.retrieve(resume, 'kubernetes migration', 120).includes('Kubernetes'));

console.log(failures ? `\n${failures} rule case(s) failed` : '\nAll assertions passed');
process.exit(failures ? 1 : 0);
