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

const schema = { type: 'object', properties: {}, additionalProperties: false };
const sonnetConfig = RA.claudeRequestConfig({ model: 'claude-sonnet-5', effort: 'medium' }, 8000, schema);
assert.strictEqual(sonnetConfig.model, 'claude-sonnet-5');
assert.strictEqual(sonnetConfig.max_tokens, 8000);
assert.strictEqual(sonnetConfig.thinking.type, 'adaptive');
assert.strictEqual(sonnetConfig.output_config.effort, 'medium');
assert.strictEqual(sonnetConfig.output_config.format.type, 'json_schema');
assert.ok(!Object.prototype.hasOwnProperty.call(sonnetConfig, 'fallbacks'), 'Messages requests do not send the unsupported fallbacks parameter');

const haikuConfig = RA.claudeRequestConfig({ model: 'claude-haiku-4-5', effort: 'high' }, 4000, schema);
assert.ok(!Object.prototype.hasOwnProperty.call(haikuConfig, 'thinking'), 'Haiku does not receive unsupported adaptive thinking');
assert.ok(!Object.prototype.hasOwnProperty.call(haikuConfig.output_config, 'effort'), 'Haiku does not receive unsupported effort');
assert.strictEqual(haikuConfig.output_config.format.schema, schema);

console.log('Prompt grounding and question formatting assertions passed');
