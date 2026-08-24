/* Node smoke test for the local ATS/match-score module (no DOM, no network). */
const assert = require('assert');

global.self = global;
global.chrome = { storage: { local: { get: (k, cb) => cb({}), set: (o, cb) => cb() } } };
require('../src/lib/util.js');
require('../src/lib/keywords.js');
const RA = global.RA;

const JOB = `
Senior Backend Engineer

About the role:
We build the payments platform that processes millions of transactions a day.

Requirements:
- 5+ years of backend engineering experience
- Strong experience with Python and distributed systems
- Hands-on experience with Kubernetes and Docker
- Experience with AWS (EC2, S3, Lambda)
- Familiarity with PostgreSQL

Nice to have:
- Experience with Terraform
- Exposure to Kafka
`;

const RESUME_STRONG = `
Senior Software Engineer, Acme Corp (2019-2024)
Led migration of the payments platform to Kubernetes and Docker, cutting deploy
time by 60%. Built distributed systems in Python handling 10M+ daily
transactions. Operated services on AWS (EC2, S3, Lambda) and PostgreSQL.
`;

const RESUME_WEAK = `
Frontend developer with 2 years building React dashboards and CSS layouts.
`;

const kws = RA.extractKeywords(JOB, 20);
console.log('Top keywords:', kws.slice(0, 8).map((k) => k.phrase).join(', '));
assert.ok(kws.some((k) => /python/i.test(k.phrase)), 'extracts "python"');
assert.ok(kws.some((k) => /kubernetes/i.test(k.phrase)), 'extracts "kubernetes"');
assert.ok(kws.length > 0);

const strong = RA.matchScore(JOB, RESUME_STRONG, { totalYearsExperience: '6', currentTitle: 'Senior Backend Engineer' });
console.log('Strong resume score:', strong.score, strong.breakdown);
assert.ok(strong.score >= 60, `strong resume should score reasonably well, got ${strong.score}`);
assert.ok(strong.matched.some((m) => /kubernetes/i.test(m)));

const weak = RA.matchScore(JOB, RESUME_WEAK, { totalYearsExperience: '2', currentTitle: 'Frontend Developer' });
console.log('Weak resume score:', weak.score, weak.breakdown);
assert.ok(weak.score < strong.score, 'unrelated resume should score lower than a matching one');
assert.ok(weak.missing.length > 0, 'weak resume should surface missing keywords');
assert.ok(weak.missing.some((m) => /kubernetes|python|aws/i.test(m)));

const APPIAN_JOB = `Product Manager (2027 Graduates)
What You'll Do
Own the Backlog: Act as product owner, owning and prioritizing the product backlog.
Champion User Experience through design sessions, mockups, UX reviews, and usability testing.
Basic Qualifications
Effective written and verbal communication skills. Proven fluency in AI and LLMs.
Preferred Qualifications
Familiarity with Agile/Scrum methodologies and running sprint ceremonies.
Thank you for your interest in joining our team.
The base salary range is $110,000 - $113,000.
Benefits include disability insurance and tuition reimbursement.
Appian provides reasonable accommodations.`;
const appianKeywords = RA.extractKeywords(APPIAN_JOB, 40).map((item) => item.phrase.toLowerCase());
assert.ok(appianKeywords.includes('product owner'));
assert.ok(appianKeywords.includes('product backlog'));
assert.ok(appianKeywords.includes('usability testing'));
assert.ok(appianKeywords.includes('agile'));
assert.ok(!appianKeywords.some((item) => /salary|disability|tuition|accommodation|appian provides|please note/.test(item)), 'drops compensation, benefits, legal and company boilerplate');
assert.ok(!(appianKeywords.includes('roadmap') && appianKeywords.includes('product roadmap')), 'keeps the more specific requirement instead of duplicate nested terms');
const appianMatch = RA.matchScore(APPIAN_JOB, 'Product owner for an AI platform using Agile and usability testing.', { totalYearsExperience: '7', currentTitle: 'Product Manager' }, 'Product Manager (2027 Graduates)');
assert.strictEqual(appianMatch.breakdown.yearsRequired, null, 'does not treat company age or salary numbers as experience requirements');
assert.ok(appianMatch.breakdown.titleMatch > 70, 'uses the explicit job title for title similarity');

// Deterministic and offline: no network, no chrome.runtime dependency.
assert.strictEqual(typeof RA.matchScore, 'function');

console.log('\nAll ATS scoring assertions passed');
