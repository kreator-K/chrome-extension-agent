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
  applicationResume: { text: 'Product Manager at Example Co with enterprise product experience.', fileName: 'resume.pdf' },
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
  } else if (schema && schema.properties && schema.properties.education) {
    payload.content[0].text = JSON.stringify({
      education: [{ school: 'Example University', location: 'New York, NY', degree: 'MBA', date: '2027', bullets: [] }],
      skills: [{ label: 'Product', text: 'Product management, enterprise product strategy' }],
      experience: [{ company: 'Example Co', location: 'New York, NY', title: 'Product Manager', date: '2022 - Present', summary: 'Enterprise product platform', bullets: ['Shipped a Python analytics product using Agile roadmaps and stakeholder management.'] }],
      projects: [], additional: []
    });
  } else if (schema && schema.properties && schema.properties.paragraphs) {
    payload.content[0].text = JSON.stringify({
      date: 'August 28, 2026', company: 'Example', role: 'Platform Product Manager', salutation: 'Dear Hiring Team,',
      paragraphs: ['I am applying for this role.', 'My enterprise product experience aligns with the work.', 'I welcome a conversation.'], closing: 'Sincerely,'
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
  const answerPrompt = requests[0].body.system;
  assert.match(answerPrompt, /Python analytics product/, 'AI answer prompt includes the knowledge base');
  assert.match(answerPrompt, /enterprise product experience/, 'AI answer prompt includes the application resume');

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

  const tailored = await send({
    type: 'GENERATE_TAILORED_RESUME',
    payload: { jobTitle: 'Platform Product Manager', company: 'Example', jobDescription: 'We require Python, Agile product roadmaps, stakeholder management, and enterprise product strategy experience.' }
  });
  assert.strictEqual(tailored.ok, true);
  assert.ok(tailored.result.draft.experience.length);
  assert.strictEqual(typeof tailored.result.score, 'number');

  const cover = await send({
    type: 'GENERATE_COVER_LETTER',
    payload: { jobTitle: 'Platform Product Manager', company: 'Example', jobDescription: 'We require Python, Agile product roadmaps, stakeholder management, and enterprise product strategy experience.' }
  });
  assert.strictEqual(cover.ok, true);
  assert.strictEqual(cover.result.paragraphs.length, 3);
  const coverPrompt = requests[requests.length - 1].body.system;
  assert.match(coverPrompt, /opening paragraph/i);
  assert.match(coverPrompt, /one or two middle paragraphs/i);
  assert.match(coverPrompt, /thanks the reader/i);
  assert.match(coverPrompt, /Never invent a recipient name/i);
  assert.match(coverPrompt, /active, specific verbs naturally/i);

  const resumePrompt = requests.find((request) => request.body.output_config && request.body.output_config.format && request.body.output_config.format.schema && request.body.output_config.format.schema.properties && request.body.output_config.format.schema.properties.education).body.system;
  assert.match(resumePrompt, /ACTION-VERB DIRECTORY/);
  assert.match(resumePrompt, /spearheaded/);
  assert.match(resumePrompt, /do not rotate verbs mechanically/i);

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
