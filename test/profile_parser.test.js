const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'profile_parser.js'), 'utf8'), ctx);

const text = `Alex Rivera
Austin, TX 78701
alex.rivera@example.com | +1 (512) 555-0199
https://linkedin.com/in/alexrivera
https://github.com/alexrivera

Backend engineer with 8+ years of professional experience.
Authorized to work in the United States without sponsorship.
Python (6 years) · Kubernetes — 3 yrs
Master's in Computer Science`;

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

console.log('Profile extraction and non-destructive merge assertions passed');
