const assert = require('assert');
const fs = require('fs');
const path = require('path');

global.self = global;
require('../src/lib/docx_builder.js');

const profile = {
  firstName: 'PRASHANT', lastName: 'KUMAR', city: 'New York', state: 'NY',
  phone: '(646) 276-3647', email: 'pk627@cornell.edu',
  linkedin: 'https://linkedin.com/in/example', github: 'https://github.com/example'
};
const resume = {
  education: [{ school: 'Cornell SC Johnson College of Business and Cornell Tech', location: 'New York, NY', degree: 'Master of Business Administration', date: 'May 2027', bullets: ['Emerging Markets Fellow'] }],
  skills: [{ label: 'Product', text: 'Product strategy, user research, A/B testing' }, { label: 'Technical', text: 'Python, SQL, LLM applications' }],
  experience: [{ company: 'Example Company', location: 'New York, NY', title: 'Head of Product', date: '2024 - Present', summary: 'AI product platform', bullets: ['Shipped a grounded AI workflow that improved conversion 18%.', 'Led cross-functional product strategy and roadmap execution.'] }],
  projects: [{ name: 'Creative Ads Agent', description: 'AI-directed campaign studio with human approval.' }],
  additional: ['Mentor to early-stage founders.']
};
const cover = {
  date: 'August 28, 2026', company: 'Example Company', role: 'Product Manager', salutation: 'Dear Hiring Team,',
  paragraphs: ['I am applying for the Product Manager role.', 'My product work connects customer evidence to measurable outcomes.', 'I would welcome the opportunity to discuss the role.'],
  closing: 'Sincerely,'
};

function inspect(bytes, expected, expectsBullets) {
  assert.strictEqual(bytes[0], 0x50);
  assert.strictEqual(bytes[1], 0x4b);
  const raw = Buffer.from(bytes).toString('utf8');
  assert.match(raw, /word\/document.xml/);
  for (const value of expected) assert.ok(raw.includes(value), `DOCX contains ${value}`);
  if (expectsBullets) assert.match(raw, /w:numPr/, 'uses real Word numbering for bullets');
  assert.match(raw, /w:pgSz w:w="12240" w:h="15840"/, 'uses US Letter geometry');
}

const resumeBytes = global.RA.buildResumeDocx(resume, profile);
const coverBytes = global.RA.buildCoverLetterDocx(cover, profile);
inspect(resumeBytes, ['PRASHANT KUMAR', 'TECHNICAL PROFICIENCY', 'Example Company'], true);
inspect(coverBytes, ['Dear Hiring Team,', 'Product Manager', 'Sincerely,'], false);
assert.match(global.RA.resumeDraftText(resume), /cross-functional product strategy/);

if (process.env.DOCX_SAMPLE_DIR) {
  fs.mkdirSync(process.env.DOCX_SAMPLE_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.DOCX_SAMPLE_DIR, 'tailored-resume-sample.docx'), resumeBytes);
  fs.writeFileSync(path.join(process.env.DOCX_SAMPLE_DIR, 'cover-letter-sample.docx'), coverBytes);
}
console.log('DOCX resume and cover-letter structure assertions passed');
