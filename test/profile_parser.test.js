const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'profile_parser.js'), 'utf8'), ctx);

const text = `PROFESSIONAL RESUME
Alex Rivera
Austin, TX 78701
alex.rivera@example.com | +1 (512) 555-0199
https://linkedin.com/in/alexrivera
https://github.com/alexrivera

Backend engineer with 8+ years of professional experience.
Authorized to work in the United States without sponsorship.
Python (6 years) · Kubernetes — 3 yrs
Master's in Computer Science | Example University | 2018

PROFESSIONAL EXPERIENCE
Senior Backend Engineer | Acme Corp | 2022 - Present`;

const extracted = ctx.RA.extractProfile(text);
assert.strictEqual(extracted.firstName, 'Alex');
assert.strictEqual(extracted.lastName, 'Rivera');
assert.strictEqual(extracted.email, 'alex.rivera@example.com');
assert.match(extracted.phone, /512/);
assert.strictEqual(extracted.city, 'Austin');
assert.strictEqual(extracted.state, 'TX');
assert.strictEqual(extracted.postalCode, '78701');
assert.strictEqual(extracted.linkedin, 'https://linkedin.com/in/alexrivera');
assert.strictEqual(extracted.github, 'https://github.com/alexrivera');
assert.strictEqual(extracted.totalYearsExperience, '8');
assert.strictEqual(extracted.degreeLevel, "Master's");
assert.strictEqual(extracted.major, 'Computer Science');
assert.strictEqual(extracted.school, 'Example University');
assert.strictEqual(extracted.gradYear, '2018');
assert.strictEqual(extracted.currentTitle, 'Senior Backend Engineer');
assert.strictEqual(extracted.currentCompany, 'Acme Corp');
assert.strictEqual(extracted.workAuthorized, 'yes');
assert.strictEqual(extracted.requiresSponsorship, 'no');
assert.ok(extracted.skills.some((s) => s.name === 'Python' && s.years === 6));
assert.ok(extracted.skills.some((s) => s.name === 'Kubernetes' && s.years === 3));

const merged = ctx.RA.mergeExtractedProfile(
  { firstName: 'Preferred', email: '', skills: [{ name: 'Python', years: 7 }] },
  extracted
);
assert.strictEqual(merged.profile.firstName, 'Preferred', 'does not overwrite reviewed values');
assert.strictEqual(merged.profile.email, extracted.email);
assert.strictEqual(merged.profile.skills.find((s) => s.name === 'Python').years, 7);

const pollutedDefaults = ctx.RA.mergeExtractedProfile(
  { firstName: '', lastName: '', email: '', degreeLevel: "Master's", workAuthorized: 'yes' },
  extracted
);
assert.strictEqual(pollutedDefaults.profile.firstName, 'Alex', 'fills blanks even when prior state stored every key');
assert.strictEqual(pollutedDefaults.profile.email, extracted.email);
assert.strictEqual(pollutedDefaults.profile.degreeLevel, "Master's", 'preserves nonblank reviewed/default values');

const markdownKnowledgeBase = `# Candidate Knowledge Base

## Contact and identity
- **Name:** Prashant Kumar
- **Email:** [prashant.kumar@example.com](mailto:prashant.kumar@example.com)
- **Phone:** +1 (607) 555-0142
- **Location:** Ithaca, NY 14850, USA
- **LinkedIn:** [Profile](https://linkedin.com/in/prashant-kumar)
- **GitHub:** [Projects](https://github.com/kreator-K)

## Current work
| Current title | Product Strategy Consultant |
| Current company | Example Advisory LLC |
| Total years of experience | 12 years |

## Education
- **Highest degree:** Master's
- **School:** Cornell SC Johnson College of Business
- **Major / field of study:** Business Administration
- **Graduation year:** 2024`;

const markdown = ctx.RA.extractProfile(markdownKnowledgeBase);
assert.strictEqual(markdown.firstName, 'Prashant');
assert.strictEqual(markdown.lastName, 'Kumar');
assert.strictEqual(markdown.email, 'prashant.kumar@example.com');
assert.match(markdown.phone, /607/);
assert.strictEqual(markdown.city, 'Ithaca');
assert.strictEqual(markdown.state, 'NY');
assert.strictEqual(markdown.postalCode, '14850');
assert.strictEqual(markdown.country, 'USA');
assert.strictEqual(markdown.linkedin, 'https://linkedin.com/in/prashant-kumar');
assert.strictEqual(markdown.github, 'https://github.com/kreator-K');
assert.strictEqual(markdown.currentTitle, 'Product Strategy Consultant');
assert.strictEqual(markdown.currentCompany, 'Example Advisory LLC');
assert.strictEqual(markdown.totalYearsExperience, '12');
assert.strictEqual(markdown.school, 'Cornell SC Johnson College of Business');
assert.strictEqual(markdown.major, 'Business Administration');
assert.strictEqual(markdown.gradYear, '2024');
assert.ok(!/[#*|]/.test(markdown.school), 'does not leak Markdown formatting into profile fields');

const cleanedStoredFormatting = ctx.RA.mergeExtractedProfile(
  { firstName: 'Manual', school: '- **Cornell SC Johnson College of Business**' },
  markdown
);
assert.strictEqual(cleanedStoredFormatting.profile.firstName, 'Manual', 'still preserves genuine manual values');
assert.strictEqual(cleanedStoredFormatting.profile.school, 'Cornell SC Johnson College of Business', 'replaces stale Markdown-corrupted values');

console.log('Profile extraction and non-destructive merge assertions passed');
