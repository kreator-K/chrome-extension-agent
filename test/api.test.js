/* Service-worker regression with an intercepted Anthropic endpoint. Verifies
 * both AI workflows and the exact request shape without using a real API key. */
const path = require('path');
const assert = require('assert');

global.self = global;
const ROOT = path.join(__dirname, '..');
const store = {
  settings: {
    apiKey: 'test-key', model: 'claude-sonnet-5', effort: 'medium',
    maxAiQuestions: 25, tone: 'concise and specific'
  },
  profile: { firstName: 'Alex', lastName: 'Rivera', skills: [] },
  resume: { text: 'Product manager who shipped a Python analytics product.', fileName: 'kb.txt' },
  applicationResume: { text: 'Product manager with enterprise product experience.', fileName: 'resume.pdf' },
  answerBank: []
};

function getStorage(keys, cb) {
  if (keys == null) return cb(Object.assign({}, store));
  const names = Array.isArray(keys) ? keys : [keys];
  const out = {};
  for (const name of names) out[name] = store[name];
  cb(out);
}

let messageListener;
global.chrome = {
  storage: { local: {
    get: getStorage,
    set: (patch, cb) => { Object.assign(store, patch); if (cb) cb(); }
  } },
  runtime: {
    onMessage: { addListener: (listener) => { messageListener = listener; } },
    onInstalled: { addListener: () => {} },
    openOptionsPage: () => {}
  }
};

global.importScripts = (...files) => {
  for (const file of files) require(path.resolve(ROOT, 'src', 'background', file));
};

const requests = [];
global.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  requests.push({ url, headers: options.headers, body });
  let payload = { type: 'message', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] };
  const schema = body.output_config && body.output_config.format && body.output_config.format.schema;
  if (schema && schema.properties && schema.properties.answers) {
    payload.content[0].text = JSON.stringify({
      answers: [{ id: 'q1', answer: 'A grounded answer.', confidence: 0.9, basis: 'Resume evidence' }]
    });
  } else if (schema && schema.properties && schema.properties.keywordSuggestions) {
    payload.content[0].text = JSON.stringify({
      summary: 'The main gap is Kubernetes.',
      keywordSuggestions: [{
        keyword: 'kubernetes', inResume: false,
        suggestion: 'Not supported by the resume — do not add unless true.', section: 'Skills'
      }]
    });
  }
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
};

require('../src/background/service_worker.js');

function send(message) {
  return new Promise((resolve) => messageListener(message, {}, resolve));
}

(async () => {
  const answers = await send({
    type: 'GENERATE_ANSWERS',
    payload: { questions: [{ id: 'q1', label: 'Why this role?', kind: 'textarea' }], pageContext: {} }
  });
  assert.strictEqual(answers.ok, true);
  assert.strictEqual(answers.answers[0].value, 'A grounded answer.');

  const match = await send({
    type: 'ANALYZE_MATCH',
    payload: {
      jobTitle: 'Platform Product Manager', company: 'Example',
      jobDescription: 'We require Kubernetes, Docker, AWS, SQL, Agile product roadmaps, stakeholder management, and enterprise software experience.'
    }
  });
  assert.strictEqual(match.ok, true);
  assert.strictEqual(match.ai.summary, 'The main gap is Kubernetes.');
  assert.ok(match.ai.keywordSuggestions.length);

  for (const request of requests) {
    assert.ok(!Object.prototype.hasOwnProperty.call(request.body, 'fallbacks'));
    assert.ok(!Object.prototype.hasOwnProperty.call(request.headers, 'anthropic-beta'));
  }

  store.settings.model = 'claude-haiku-4-5';
  const haiku = await send({
    type: 'GENERATE_ANSWERS',
    payload: { questions: [{ id: 'q1', label: 'Why this role?', kind: 'textarea' }], pageContext: {} }
  });
  assert.strictEqual(haiku.ok, true);
  const haikuBody = requests[requests.length - 1].body;
  assert.ok(!Object.prototype.hasOwnProperty.call(haikuBody, 'thinking'));
  assert.ok(!Object.prototype.hasOwnProperty.call(haikuBody.output_config, 'effort'));

  console.log('Anthropic answer, gap-analysis, and model-compatibility assertions passed');
})().catch((err) => { console.error(err); process.exit(1); });
