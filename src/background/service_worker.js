/* Service worker: owns the Anthropic API key and every network call.
 * Content scripts never see the key and never talk to api.anthropic.com. */
importScripts('../lib/util.js', '../lib/rules.js', '../lib/keywords.js', '../lib/prompts.js', '../lib/profile_parser.js', '../lib/docx_builder.js');

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

const MATCH_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '2-3 sentences on overall fit and the biggest gaps.' },
    keywordSuggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          keyword: { type: 'string' },
          inResume: { type: 'boolean', description: 'True only if the resume already demonstrates this, just not in this exact wording.' },
          suggestion: { type: 'string', description: 'One concrete instruction: either how to reword an existing bullet to surface this keyword, or "Not supported by the resume — do not add unless true" if it is not.' },
          section: { type: 'string', description: 'Where it would naturally fit: Skills, a specific role, Summary, etc.' }
        },
        required: ['keyword', 'inResume', 'suggestion', 'section'],
        additionalProperties: false
      }
    }
  },
  required: ['summary', 'keywordSuggestions'],
  additionalProperties: false
};

const RESUME_SCHEMA = {
  type: 'object',
  properties: {
    education: { type: 'array', items: { type: 'object', properties: {
      school: { type: 'string' }, location: { type: 'string' }, degree: { type: 'string' }, date: { type: 'string' },
      bullets: { type: 'array', items: { type: 'string' } }
    }, required: ['school', 'location', 'degree', 'date', 'bullets'], additionalProperties: false } },
    skills: { type: 'array', items: { type: 'object', properties: {
      label: { type: 'string' }, text: { type: 'string' }
    }, required: ['label', 'text'], additionalProperties: false } },
    experience: { type: 'array', items: { type: 'object', properties: {
      company: { type: 'string' }, location: { type: 'string' }, title: { type: 'string' }, date: { type: 'string' },
      summary: { type: 'string' }, bullets: { type: 'array', items: { type: 'string' } }
    }, required: ['company', 'location', 'title', 'date', 'summary', 'bullets'], additionalProperties: false } },
    projects: { type: 'array', items: { type: 'object', properties: {
      name: { type: 'string' }, description: { type: 'string' }
    }, required: ['name', 'description'], additionalProperties: false } },
    additional: { type: 'array', items: { type: 'string' } }
  },
  required: ['education', 'skills', 'experience', 'projects', 'additional'],
  additionalProperties: false
};

const COVER_LETTER_SCHEMA = {
  type: 'object',
  properties: {
    date: { type: 'string' }, company: { type: 'string' }, role: { type: 'string' }, salutation: { type: 'string' },
    paragraphs: { type: 'array', minItems: 3, maxItems: 4, items: { type: 'string' } },
    closing: { type: 'string' }
  },
  required: ['date', 'company', 'role', 'salutation', 'paragraphs', 'closing'],
  additionalProperties: false
};

// User-supplied action-verb directory. It is a vocabulary aid, not a license
// to inflate a claim: the model may use a verb only when the source evidence
// supports the underlying action.
const ACTION_VERB_DIRECTORY = [
  'Leadership: accomplished, achieved, administered, analyzed, assigned, coordinated, delegated, developed, directed, evaluated, executed, improved, increased, led, orchestrated, organized, oversaw, prioritized, produced, recommended, reorganized, reviewed, spearheaded, strengthened, supervised, surpassed',
  'Communication: addressed, authored, collaborated, delivered, documented, drafted, edited, formulated, influenced, interpreted, liaised, mediated, negotiated, persuaded, presented, reconciled, reported, synthesized, translated, wrote',
  'Research: clarified, collected, conducted, diagnosed, discovered, evaluated, examined, extracted, identified, inspected, investigated, modeled, resolved, reviewed, summarized, surveyed, systematized, tested',
  'Technical: assembled, built, calculated, computed, designed, devised, engineered, installed, maintained, operated, optimized, overhauled, programmed, solved, standardized, streamlined, upgraded',
  'Teaching: advised, coached, communicated, coordinated, clarified, demystified, enabled, evaluated, explained, facilitated, guided, informed, instructed, taught, trained',
  'Quantitative: allocated, analyzed, appraised, audited, balanced, budgeted, calculated, forecasted, managed, maximized, minimized, planned, projected, researched',
  'Creative: conceived, conceptualized, created, customized, designed, established, founded, initiated, integrated, introduced, invented, originated, published, redesigned, revised, revitalized, shaped, visualized',
  'Helping: assessed, assisted, counseled, demonstrated, diagnosed, educated, enhanced, expedited, facilitated, guided, motivated, proposed, provided, represented, served, supported',
  'Organizational: accelerated, arranged, cataloged, centralized, classified, compiled, completed, controlled, defined, executed, expanded, generated, implemented, launched, monitored, prepared, processed, recorded, reduced, selected, simplified, structured, systematized, validated, verified'
].join('\n');

const RESUME_QUALITY_CHECKPOINTS = [
  'DO: keep format and content consistent; make the document easy to read with balanced whitespace; use consistent spacing, capitalization, and restrained emphasis; order headings by importance; list experience in reverse chronological order; preserve known dates and flag gaps rather than inventing dates.',
  'DO NOT: use first-person pronouns in resume bullets or summaries; use unexplained abbreviations; write bullets as a narrative story; use slang or colloquialisms; add pictures, age, gender, or references; start every line with a date.',
  'These checkpoints apply to the resume document only. They do not prohibit first-person pronouns in the separate cover letter.'
].join('\n');

async function callClaude(settings, body) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
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
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error('Anthropic returned an unreadable response.');
  }
}

function parsedStructuredResponse(msg, label) {
  if (msg.stop_reason === 'refusal') {
    throw new Error('The model declined this request' +
      (msg.stop_details && msg.stop_details.explanation ? `: ${msg.stop_details.explanation}` : '.'));
  }
  const textBlock = (msg.content || []).find((block) => block.type === 'text');
  if (!textBlock || !String(textBlock.text || '').trim()) {
    throw new Error(`Anthropic returned no ${label}.`);
  }
  try {
    return JSON.parse(textBlock.text);
  } catch (e) {
    const suffix = msg.stop_reason === 'max_tokens' ? ' The response reached its token limit.' : '';
    throw new Error(`Anthropic returned invalid structured ${label}.${suffix}`);
  }
}

async function generateAnswers({ questions, pageContext }) {
  const settings = await RA.storage.getSettings();
  if (!settings.apiKey) throw new Error('No API key set. Open the extension options and add one.');

  const profile = await RA.storage.getProfile();
  const resume = await RA.storage.getResume();
  const applicationResumes = await RA.storage.getApplicationResumes();
  const applicationResume = await RA.storage.getActiveApplicationResume();
  const evidenceText = [resume.text, ...applicationResumes.map((item) => item.text)].filter(Boolean).join('\n\n');
  if (!evidenceText) throw new Error('No readable resume knowledge base or application resume uploaded yet.');

  const bank = await RA.storage.getAnswerBank();
  const limited = questions.slice(0, settings.maxAiQuestions);
  const query = limited.map((q) => q.label).join(' ');
  const resumeExcerpt = RA.retrieve(evidenceText, query, 12000);
  const priorAnswers = bank
    .slice()
    .sort((a, b) => (b.uses || 0) - (a.uses || 0))
    .slice(0, 15)
    .map((e) => `Q: ${e.question}\nA: ${RA.truncate(e.answer, 600)}`)
    .join('\n\n');

  const body = Object.assign(RA.claudeRequestConfig(settings, 16000, ANSWER_SCHEMA), {
    system: RA.buildAnswerSystemPrompt(settings, profile, resumeExcerpt, priorAnswers),
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
          `\n\nAnswer each of these form questions:\n\n${RA.buildQuestionBlock(limited)}`
      }
    ]
  });

  const msg = await callClaude(settings, body);
  const parsed = parsedStructuredResponse(msg, 'application answers');

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

/**
 * Local score plus an AI pass over the specific missing keywords, telling the
 * candidate where each one could honestly fit (or that it doesn't, rather
 * than inventing experience to close the gap).
 */
async function analyzeMatch({ jobDescription, jobTitle, company, applicationFacts }) {
  if (!jobDescription || jobDescription.trim().length < 40) {
    throw new Error('No job description could be read from this page. Paste it in the panel to score against it.');
  }

  const settings = await RA.storage.getSettings();
  const profile = await RA.storage.getProfile();
  const resume = await RA.storage.getResume();
  const applicationResume = await RA.storage.getActiveApplicationResume();
  const applicationResumes = await RA.storage.getApplicationResumes();
  const scoredResume = applicationResume.text || resume.text;
  if (!scoredResume) throw new Error('No readable application resume or resume knowledge base uploaded yet.');

  const local = RA.matchScore(jobDescription, scoredResume, profile, jobTitle);
  if (!settings.apiKey || !local.missing.length) {
    return { local, ai: null };
  }

  const evidenceText = [resume.text, ...applicationResumes.map((item) => item.text)].filter(Boolean).join('\n\n');
  const resumeExcerpt = RA.retrieve(evidenceText, local.missing.join(' '), 10000);
  const body = Object.assign(RA.claudeRequestConfig(settings, 8000, MATCH_SCHEMA), {
    system: [
      'You help a candidate see why an ATS keyword-matching score is not higher, and what to honestly do about it.',
      'You are given a job description, the keywords it identified as missing from the resume, the resume text, and the candidate profile.',
      '',
      'For every missing keyword:',
      '- If the resume already shows equivalent experience under different words (e.g. resume says "Postgres", JD wants "SQL databases"), set inResume: true and say exactly how to reword the existing bullet to include the JD\'s term.',
      '- If the resume does not support it at all, set inResume: false and say so plainly — never invent a project, tool, or skill the candidate has not demonstrated. Do not suggest adding a keyword the resume cannot back up.',
      '- Never suggest keyword stuffing (dumping unrelated terms into a skills list just to match). Every suggestion must point to a specific, truthful place it belongs.',
      '- Candidate-entered application facts are current inputs and must be considered. If one conflicts with the application resume or profile, state the conflict plainly and ask the candidate to review it; never silently choose a side or claim the sources agree.',
      '',
      '=== CANDIDATE PROFILE ===',
      RA.profileSummary(profile),
      '',
      '=== CANDIDATE-ENTERED APPLICATION FACTS ===',
      applicationFacts || 'None supplied.',
      '',
      '=== RESUME (relevant excerpt) ===',
      resumeExcerpt
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content:
          `Job: ${jobTitle || 'unknown title'}${company ? ' at ' + company : ''}\n\n` +
          `Job description:\n${RA.truncate(jobDescription, 6000)}\n\n` +
          `Keywords the local scan flagged as missing, most important first:\n${local.missing.join(', ')}\n\n` +
          'For each of these keywords, tell me whether my resume already supports it and how to reword it in, or whether it is a genuine gap.'
      }
    ]
  });

  const msg = await callClaude(settings, body);
  const ai = parsedStructuredResponse(msg, 'gap analysis');
  if (!ai || !Array.isArray(ai.keywordSuggestions)) {
    throw new Error('Anthropic returned an incomplete gap analysis.');
  }
  return { local, ai };
}

async function careerSources() {
  const [settings, profile, resume, applicationResumes] = await Promise.all([
    RA.storage.getSettings(), RA.storage.getProfile(), RA.storage.getResume(), RA.storage.getApplicationResumes()
  ]);
  const applicationResume = await RA.storage.getActiveApplicationResume();
  if (!settings.apiKey) throw new Error('No API key set. Open the extension options and add one.');
  if (!applicationResume.text) throw new Error('The application resume has no readable text. Upload a text-based PDF or DOCX in Options.');
  return { settings, profile, resume, applicationResume, applicationResumes };
}

function compactResumeDraft(draft) {
  const clip = (value, max) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (text.length <= max) return text;
    const cut = text.slice(0, max + 1);
    return cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 25)).replace(/[,:; -]+$/, '') + '.';
  };
  let bulletsLeft = 12;
  return {
    education: (draft.education || []).slice(0, 2).map((item) => ({
      school: clip(item.school, 100), location: clip(item.location, 45), degree: clip(item.degree, 100), date: clip(item.date, 30),
      bullets: (item.bullets || []).slice(0, 1).map((value) => clip(value, 150))
    })),
    skills: (draft.skills || []).slice(0, 2).map((item) => ({ label: clip(item.label, 30), text: clip(item.text, 300) })),
    experience: (draft.experience || []).slice(0, 6).map((item) => {
      const count = Math.min(4, bulletsLeft, (item.bullets || []).length);
      bulletsLeft -= count;
      return {
        company: clip(item.company, 80), location: clip(item.location, 45), title: clip(item.title, 80), date: clip(item.date, 35),
        summary: clip(item.summary, 150), bullets: (item.bullets || []).slice(0, count).map((value) => clip(value, 235))
      };
    }),
    projects: (draft.projects || []).slice(0, 3).map((item) => ({ name: clip(item.name, 45), description: clip(item.description, 180) })),
    additional: (draft.additional || []).slice(0, 2).map((value) => clip(value, 180))
  };
}

async function generateTailoredResume({ jobDescription, jobTitle, company }) {
  if (!jobDescription || jobDescription.trim().length < 40) throw new Error('No readable job description found.');
  const { settings, profile, resume, applicationResume, applicationResumes } = await careerSources();
  const evidence = [applicationResume.text, resume.text, ...applicationResumes.map((item) => item.text)].filter(Boolean).join('\n\n');
  let prior = null;
  let best = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const priorText = prior ? `\n\n=== PRIOR DRAFT ===\n${JSON.stringify(prior.draft)}\n\nIts verified local score was ${prior.score}. Missing relevant terms: ${prior.missing.join(', ') || 'none'}. Improve only where the evidence truthfully supports it.` : '';
    const body = Object.assign(RA.claudeRequestConfig(settings, 16000, RESUME_SCHEMA), {
      system: [
        'You tailor one candidate resume to one job description.',
        'Return the complete resume in the supplied structure, preserving the source resume section order, employers, roles, dates, education, project count, and one-page density.',
        'Never invent or upgrade facts, titles, dates, metrics, employers, degrees, skills, tools, or scope. Use the knowledge base only to clarify or reword facts that are genuinely supported.',
        'Use exact job-description terminology only where an existing fact supports it. Do not keyword-stuff.',
        'Keep every bullet concise, evidence-led, and results-oriented. Preserve all numerical claims exactly unless the evidence supplies a more precise version.',
        'Use the action-verb directory below to replace weak or passive openings when the source evidence supports the stronger verb. Choose the category that matches the actual work; do not rotate verbs mechanically, exaggerate ownership, or add an action that is not documented.',
        '=== ACTION-VERB DIRECTORY ===', ACTION_VERB_DIRECTORY,
        '=== RESUME QUALITY CHECKPOINTS ===', RESUME_QUALITY_CHECKPOINTS,
        'Keep roughly the same number of bullets per role as the source. The DOCX renderer preserves the visual format; your task is content only.',
        'Technical Proficiency should contain only demonstrated skills. WhatsApp and Telegram are product channels, not skills.',
        '', '=== PROFILE ===', RA.profileSummary(profile),
        '', '=== SOURCE APPLICATION RESUME — structural and factual authority ===', applicationResume.text,
        '', '=== KNOWLEDGE BASE — supporting evidence only ===', RA.retrieve(evidence, jobDescription, 14000)
      ].join('\n'),
      messages: [{ role: 'user', content: `Target role: ${jobTitle || 'unknown'}${company ? ' at ' + company : ''}\n\nJob description:\n${RA.truncate(jobDescription, 8000)}${priorText}\n\nProduce the complete tailored resume now.` }]
    });
    const parsed = compactResumeDraft(parsedStructuredResponse(await callClaude(settings, body), 'tailored resume'));
    if (!parsed.experience.length || !parsed.education.length) throw new Error('Anthropic returned an incomplete resume structure.');
    const sourceNorm = RA.normalize(applicationResume.text);
    const unknownCompany = parsed.experience.find((item) => item.company && !sourceNorm.includes(RA.normalize(item.company)));
    if (unknownCompany) throw new Error(`Tailoring introduced an unsupported employer: ${unknownCompany.company}. No document was created.`);
    const resumeText = RA.resumeDraftText(parsed);
    const scored = RA.matchScore(jobDescription, resumeText, profile, jobTitle);
    const candidate = { draft: parsed, score: scored.score, missing: scored.missing, breakdown: scored.breakdown, attempts: attempt };
    if (!best || candidate.score > best.score) best = candidate;
    if (candidate.score >= 90) break;
    prior = candidate;
  }
  return Object.assign(best, { targetMet: best.score >= 90 });
}

async function generateCoverLetter({ jobDescription, jobTitle, company }) {
  if (!jobDescription || jobDescription.trim().length < 40) throw new Error('No readable job description found.');
  const { settings, profile, resume, applicationResume, applicationResumes } = await careerSources();
  const evidence = [applicationResume.text, resume.text, ...applicationResumes.map((item) => item.text)].filter(Boolean).join('\n\n');
  const body = Object.assign(RA.claudeRequestConfig(settings, 6000, COVER_LETTER_SCHEMA), {
    system: [
      'Write a polished, concise cover letter grounded only in the candidate evidence and supplied job description.',
      'Follow this structure exactly: (1) opening paragraph that clearly states the role, why the candidate is writing, and—only when supported—how they heard about it plus two or three specific fit reasons; (2) one or two middle paragraphs explaining interest in this employer/work and connecting one or two concrete candidate examples to the job; (3) closing paragraph that reiterates interest, states the contribution the candidate can make, thanks the reader, and looks forward to discussing the role.',
      'Do not repeat the entire resume. Select the strongest relevant evidence and explain the connection to the job in a confident, natural voice.',
      'Use active, specific verbs naturally (for example, led, coordinated, analyzed, built, optimized, facilitated, or delivered) when the evidence supports them; do not turn the letter into a list of resume keywords.',
      'Never invent a recipient name, address, company research, motivations, metrics, skills, or experience. If no contact name is supplied, use the salutation "Dear Hiring Team,". Do not claim how the candidate heard about the role unless the evidence or page context supplies it.',
      'Keep three or four short paragraphs and stay under 350 words. Do not use generic enthusiasm, buzzwords, headings, labels such as "Opening paragraph", or bullet lists.',
      '', '=== PROFILE ===', RA.profileSummary(profile),
      '', '=== CANDIDATE EVIDENCE ===', RA.retrieve(evidence, jobDescription, 12000)
    ].join('\n'),
    messages: [{ role: 'user', content: `Role: ${jobTitle || 'unknown'}\nCompany: ${company || 'Hiring company'}\n\nJob description:\n${RA.truncate(jobDescription, 8000)}\n\nWrite the grounded cover letter.` }]
  });
  return parsedStructuredResponse(await callClaude(settings, body), 'cover letter');
}

async function testApiKey(apiKey, model) {
  const settings = await RA.storage.getSettings();
  const selectedModel = model || settings.model || 'claude-opus-5';
  const res = await callClaude(
    Object.assign({}, settings, { apiKey }),
    {
      model: selectedModel,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }]
    }
  );
  const t = (res.content || []).find((b) => b.type === 'text');
  return { ok: true, reply: t ? t.text.trim() : '', model: selectedModel };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case 'GENERATE_ANSWERS':
          sendResponse({ ok: true, answers: await generateAnswers(msg.payload || {}) });
          break;
        case 'ANALYZE_MATCH':
          sendResponse(Object.assign({ ok: true }, await analyzeMatch(msg.payload || {})));
          break;
        case 'GENERATE_TAILORED_RESUME':
          sendResponse({ ok: true, result: await generateTailoredResume(msg.payload || {}) });
          break;
        case 'GENERATE_COVER_LETTER':
          sendResponse({ ok: true, result: await generateCoverLetter(msg.payload || {}) });
          break;
        case 'SAVE_ANSWER':
          await RA.storage.saveAnswer(msg.question, msg.answer);
          sendResponse({ ok: true });
          break;
        case 'TEST_API_KEY':
          sendResponse(await testApiKey(msg.apiKey, msg.model));
          break;
        case 'GET_STATE': {
          const [settings, profile, resume, applicationResumes] = await Promise.all([
            RA.storage.getSettings(),
            RA.storage.getProfile(),
            RA.storage.getResume(),
            RA.storage.getApplicationResumes()
          ]);
          const [applicationResume, bank] = await Promise.all([RA.storage.getActiveApplicationResume(), RA.storage.getAnswerBank()]);
          sendResponse({
            ok: true,
            hasKey: !!settings.apiKey,
            settings: Object.assign({}, settings, { apiKey: settings.apiKey ? 'set' : '' }),
            profile,
            resume: { fileName: resume.fileName, chars: (resume.text || '').length, updatedAt: resume.updatedAt },
            applicationResume: {
              fileName: applicationResume.fileName,
              size: applicationResume.size,
              updatedAt: applicationResume.updatedAt
            },
            applicationResumes: applicationResumes.map((item) => ({ id: item.id, fileName: item.fileName, size: item.size, updatedAt: item.updatedAt, textChars: (item.text || '').length })),
            activeApplicationResumeId: applicationResume.id || '',
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

chrome.runtime.onInstalled.addListener((details) => {
  (async () => {
    const stored = await RA.storage.get('profile');
    if (stored.profile) {
      const migration = RA.clearLegacyAssumedDefaults(stored.profile);
      if (migration.changed) await RA.storage.set({ profile: migration.profile });
    }
    if (details.reason === 'install') chrome.runtime.openOptionsPage();
  })().catch((error) => console.error('Profile migration failed:', error));
});
