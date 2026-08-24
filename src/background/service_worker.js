/* Service worker: owns the Anthropic API key and every network call.
 * Content scripts never see the key and never talk to api.anthropic.com. */
importScripts('../lib/util.js', '../lib/rules.js');

const RA = self.RA;
const API_URL = 'https://api.anthropic.com/v1/messages';
const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The question id you were given.' },
          answer: { type: 'string', description: 'The answer to put in the field, verbatim.' },
          confidence: { type: 'number', description: '0..1 — how well the resume supports this answer.' },
          basis: { type: 'string', description: 'Short note on where in the resume this came from.' }
        },
        required: ['id', 'answer', 'confidence', 'basis'],
        additionalProperties: false
      }
    }
  },
  required: ['answers'],
  additionalProperties: false
};

function profileSummary(p) {
  const lines = [];
  const push = (k, v) => { if (v !== '' && v != null) lines.push(`${k}: ${v}`); };
  push('Name', [p.firstName, p.lastName].filter(Boolean).join(' '));
  push('Email', p.email);
  push('Phone', p.phone);
  push('Location', [p.city, p.state, p.country].filter(Boolean).join(', '));
  push('LinkedIn', p.linkedin);
  push('GitHub', p.github);
  push('Portfolio', p.portfolio);
  push('Current role', [p.currentTitle, p.currentCompany].filter(Boolean).join(' at '));
  push('Total years of experience', p.totalYearsExperience);
  push('Education', [p.degreeLevel, p.major, p.school, p.gradYear].filter(Boolean).join(', '));
  push('Work authorized', p.workAuthorized);
  push('Requires sponsorship', p.requiresSponsorship);
  push('Work authorization detail', p.workAuthDetail);
  push('Willing to relocate', p.willingToRelocate);
  push('Preferred work mode', p.workMode);
  push('Notice period (days)', p.noticePeriodDays);
  push('Earliest start date', p.earliestStartDate);
  push('Desired compensation', p.desiredSalary);
  if ((p.skills || []).length) {
    push('Skills with years', p.skills.map((s) => `${s.name} (${s.years}y)`).join(', '));
  }
  return lines.join('\n');
}

function systemPrompt(settings, profile, resumeExcerpt, priorAnswers) {
  return [
    'You fill in job application forms on behalf of one candidate.',
    'You are given the candidate\'s resume knowledge base, a structured profile, and a list of questions taken from an application form.',
    '',
    'Rules:',
    '- Answer only from the resume, the profile, and the previously approved answers. Never invent employers, titles, dates, degrees, certifications, or metrics.',
    '- If the resume does not support an answer, return an empty string for `answer` and a confidence of 0 rather than guessing.',
    '- Match the requested format exactly: a number-only question gets a bare number, a yes/no question gets "Yes" or "No", a multiple-choice question gets one of the offered options verbatim.',
    '- Respect any stated character limit.',
    `- Prose answers: ${settings.tone}. Ground every claim in something in the resume. No greetings, no sign-offs, no "As an AI".`,
    '- Do not answer demographic, salary-history, or criminal-record questions from inference; return an empty string for those.',
    '',
    '=== CANDIDATE PROFILE ===',
    profileSummary(profile),
    '',
    '=== RESUME KNOWLEDGE BASE ===',
    resumeExcerpt || '(empty — say so by returning empty answers)',
    priorAnswers ? '\n=== PREVIOUSLY APPROVED ANSWERS (reuse the candidate\'s own wording where relevant) ===\n' + priorAnswers : ''
  ].join('\n');
}

function questionBlock(questions) {
  return questions
    .map((q) => {
      const parts = [`id: ${q.id}`, `question: ${q.label}`, `field type: ${q.kind}`];
      if (q.options && q.options.length) {
        parts.push('allowed options: ' + q.options.map((o) => o.label).join(' | '));
      }
      if (q.maxLength) parts.push(`max characters: ${q.maxLength}`);
      if (q.required) parts.push('required: yes');
      return parts.join('\n');
    })
    .join('\n---\n');
}

async function callClaude(settings, body) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
      // Required for calls made directly from a browser/extension context.
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  });

  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try { detail = JSON.parse(text).error.message; } catch (e) { /* keep raw */ }
    throw new Error(`Anthropic API ${res.status}: ${detail}`);
  }
  return JSON.parse(text);
}

async function generateAnswers({ questions, pageContext }) {
  const settings = await RA.storage.getSettings();
  if (!settings.apiKey) throw new Error('No API key set. Open the extension options and add one.');

  const profile = await RA.storage.getProfile();
  const resume = await RA.storage.getResume();
  if (!resume.text) throw new Error('No resume knowledge base uploaded yet.');

  const bank = await RA.storage.getAnswerBank();
  const limited = questions.slice(0, settings.maxAiQuestions);
  const query = limited.map((q) => q.label).join(' ');
  const resumeExcerpt = RA.retrieve(resume.text, query, 12000);
  const priorAnswers = bank
    .slice()
    .sort((a, b) => (b.uses || 0) - (a.uses || 0))
    .slice(0, 15)
    .map((e) => `Q: ${e.question}\nA: ${RA.truncate(e.answer, 600)}`)
    .join('\n\n');

  const body = {
    model: settings.model || 'claude-opus-5',
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: settings.effort || 'medium',
      format: { type: 'json_schema', schema: ANSWER_SCHEMA }
    },
    fallbacks: 'default',
    system: systemPrompt(settings, profile, resumeExcerpt, priorAnswers),
    messages: [
      {
        role: 'user',
        content:
          `Application page: ${pageContext && pageContext.title ? pageContext.title : 'unknown'}` +
          (pageContext && pageContext.company ? `\nCompany: ${pageContext.company}` : '') +
          (pageContext && pageContext.jobTitle ? `\nRole: ${pageContext.jobTitle}` : '') +
          (pageContext && pageContext.jobDescription
            ? `\n\nJob description excerpt:\n${RA.truncate(pageContext.jobDescription, 4000)}`
            : '') +
          `\n\nAnswer each of these form questions:\n\n${questionBlock(limited)}`
      }
    ]
  };

  const msg = await callClaude(settings, body);

  if (msg.stop_reason === 'refusal') {
    throw new Error('The model declined this request' +
      (msg.stop_details && msg.stop_details.explanation ? `: ${msg.stop_details.explanation}` : '.'));
  }

  const textBlock = (msg.content || []).find((b) => b.type === 'text');
  if (!textBlock) throw new Error('Empty response from the model.');

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (e) {
    throw new Error('Could not parse the model response as JSON.');
  }

  const byId = new Map((parsed.answers || []).map((a) => [a.id, a]));
  return limited.map((q) => {
    const a = byId.get(q.id);
    return {
      id: q.id,
      value: a ? String(a.answer || '') : '',
      confidence: a ? RA.clamp(Number(a.confidence) || 0, 0, 1) : 0,
      basis: a ? a.basis || '' : 'no answer returned',
      source: 'ai'
    };
  });
}

async function testApiKey(apiKey) {
  const settings = await RA.storage.getSettings();
  const res = await callClaude(
    Object.assign({}, settings, { apiKey }),
    {
      model: settings.model || 'claude-opus-5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }]
    }
  );
  const t = (res.content || []).find((b) => b.type === 'text');
  return { ok: true, reply: t ? t.text.trim() : '' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'GENERATE_ANSWERS':
          sendResponse({ ok: true, answers: await generateAnswers(msg.payload || {}) });
          break;
        case 'SAVE_ANSWER':
          await RA.storage.saveAnswer(msg.question, msg.answer);
          sendResponse({ ok: true });
          break;
        case 'TEST_API_KEY':
          sendResponse(await testApiKey(msg.apiKey));
          break;
        case 'GET_STATE': {
          const [settings, profile, resume, bank] = await Promise.all([
            RA.storage.getSettings(),
            RA.storage.getProfile(),
            RA.storage.getResume(),
            RA.storage.getAnswerBank()
          ]);
          sendResponse({
            ok: true,
            hasKey: !!settings.apiKey,
            settings: Object.assign({}, settings, { apiKey: settings.apiKey ? 'set' : '' }),
            profile,
            resume: { fileName: resume.fileName, chars: (resume.text || '').length, updatedAt: resume.updatedAt },
            bankSize: bank.length
          });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message type' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true; // keep the channel open for the async response
});

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});
