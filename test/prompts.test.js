const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'prompts.js'), 'utf8'), ctx);

const RA = ctx.RA;
const prompt = RA.buildAnswerSystemPrompt(
  { tone: 'concise and warm' },
  {
    firstName: 'Alex',
    lastName: 'Rivera',
    currentTitle: 'Backend Engineer',
    currentCompany: 'Example Co',
    skills: [{ name: 'Python', years: 5 }]
  },
  'Built a payments service in Python.',
  'Q: Why this role?\nA: I enjoy reliability work.'
);

assert.match(prompt, /Never invent employers, titles, dates/);
assert.match(prompt, /compact situation-action-result flow/);
assert.match(prompt, /specific priority visible in the supplied job description/);
assert.match(prompt, /confidence from the strength of the cited evidence/);
assert.match(prompt, /Current role: Backend Engineer at Example Co/);
assert.match(prompt, /Python \(5y\)/);
assert.match(prompt, /Built a payments service in Python/);
assert.match(prompt, /PREVIOUSLY APPROVED ANSWERS/);

const block = RA.buildQuestionBlock([
  {
    id: 'q1',
    label: 'Are you authorized?',
    kind: 'select',
    options: [{ label: 'Yes' }, { label: 'No' }],
    maxLength: 3,
    required: true
  },
  { id: 'q2', label: 'Why this role?', kind: 'textarea' }
]);

assert.match(block, /allowed options: Yes \| No/);
assert.match(block, /max characters: 3/);
assert.match(block, /required: yes/);
assert.match(block, /---\nid: q2/);

console.log('Prompt grounding and question formatting assertions passed');
