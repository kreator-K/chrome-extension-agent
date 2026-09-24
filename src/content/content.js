/* In-page orchestrator: scan the form, answer what we can locally, ask the
 * background worker for the rest, and show a review panel before anything is
 * written into the page. */
(function () {
  if (window.__resumeAutofillLoaded) return;
  window.__resumeAutofillLoaded = true;

  const RA = window.RA;
  let state = {
    fields: [], answers: new Map(), panel: null, shadow: null, busy: false,
    match: null, matchAi: null, matchBusy: false, jdOverride: '',
    careerBusy: false, tailoredResume: null, coverLetter: null,
    mode: 'job', networking: { intent: 'Referral', angle: 'Direct Referral', customIntent: '', result: '', basis: '', busy: false }
  };

  const NETWORKING_ANGLES = {
    'Referral': ['Direct Referral', 'Learn First, Referral Second', 'Shared Background', 'Specific Role', 'Custom'],
    'Potential Cofounder': ['Complementary Skills', 'Specific Work / Experience', 'Explore Fit First', 'Custom'],
    'Guidance': ['Career Guidance', 'Industry Guidance', 'Role / Company Guidance', 'Founder / Startup Guidance', 'Technical / Product Guidance', 'Career Transition', 'Custom'],
    'Resume Review': ['General Review', 'Role-Specific Review', 'Industry-Specific Review', 'Career Positioning', 'Specific Section', 'Custom'],
    'Custom': []
  };

  function networkingAngles(intent) { return NETWORKING_ANGLES[intent] || []; }

  // Reloading/updating an extension invalidates content scripts that were
  // already injected into open tabs. Chrome throws synchronously in that old
  // script, so every message must be guarded; otherwise its expected lifecycle
  // event is recorded as an extension error.
  function runtimeFailure(error) {
    const message = String(error && error.message ? error.message : error || 'No response from the extension.');
    if (/extension context invalidated/i.test(message)) {
      return { ok: false, contextInvalidated: true, error: 'Resume Autofill was updated. Refresh this page, then open the panel again.' };
    }
    return { ok: false, error: message };
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      try {
        if (!chrome.runtime || !chrome.runtime.id) {
          resolve(runtimeFailure('Extension context invalidated.'));
          return;
        }
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve(runtimeFailure(chrome.runtime.lastError));
            return;
          }
          resolve(response || { ok: false, error: 'No response from the extension.' });
        });
      } catch (error) {
        resolve(runtimeFailure(error));
      }
    });
  }

  /* --------------------------------------------------------- page context */

  function pickText(selectors, max) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const t = el && (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return t.slice(0, max || 200);
    }
    return '';
  }

  /** Like pickText, but keeps line breaks — the keyword scorer relies on them
   * to tell a "Requirements" header from the paragraph under it. */
  function pickBlockText(selectors, max) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const raw = el && (el.innerText || el.textContent || '');
      if (!raw) continue;
      const t = raw.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
      if (t) return t.slice(0, max || 200);
    }
    return '';
  }

  function pageContext() {
    const pageTitle = document.title;
    const companyFromTitle = ((pageTitle.match(/\bat\s+(.+?)(?:\s*[|—-].*)?$/i) || [])[1] || '').trim();
    return {
      title: pageTitle,
      url: location.href,
      jobTitle: pickText([
        'h1.top-card-layout__title',
        '.job-details-jobs-unified-top-card__job-title',
        '[data-testid="job-title"]',
        '.posting-headline h2',
        '.app-title',
        'h1'
      ], 200),
      company: pickText([
        '.job-details-jobs-unified-top-card__company-name',
        '.topcard__org-name-link',
        '[data-testid="company-name"]',
        '.company-name',
        '.main-header-content h1'
      ], 120) || companyFromTitle,
      jobDescription: pickBlockText([
        '.jobs-description__content',
        '.description__text',
        '#content .section-wrapper',
        '[data-testid="job-description"]',
        '.job__description',
        '.job-description',
        '#job_description'
      ], 4000)
    };
  }

  /* ------------------------------------------------------ local answering */

  async function resolveLocally(fields) {
    const [storedProfile, bank, resume, applicationResumes] = await Promise.all([
      RA.storage.getProfile(),
      RA.storage.getAnswerBank(),
      RA.storage.getResume(),
      RA.storage.getApplicationResumes()
    ]);
    const applicationResume = await RA.storage.getActiveApplicationResume();
    // Older installs may have saved the source documents before profile
    // extraction was reliable. Re-derive blank facts at scan time so portal
    // answers always consider both sources, without overwriting reviewed data.
    const sourceText = [resume.text, ...applicationResumes.map((item) => item.text)].filter(Boolean).join('\n\n');
    const profile = sourceText && RA.extractProfile
      ? RA.mergeExtractedProfile(storedProfile, RA.extractProfile(sourceText)).profile
      : storedProfile;
    const resolved = new Map();
    const unresolved = [];

    for (const f of fields) {
      if (f.value && String(f.value).trim()) {
        resolved.set(f.id, {
          id: f.id, value: String(f.value), confidence: 1,
          source: 'existing', basis: 'already filled on this application'
        });
        continue;
      }
      if (f.kind === 'file') {
        resolved.set(f.id, applicationResume.fileName
          ? {
              id: f.id, value: applicationResume.fileName, confidence: 1,
              source: 'resume', basis: 'application resume saved in Options',
              file: applicationResume
            }
          : {
              id: f.id, value: '', confidence: 0, source: 'skipped',
              basis: 'no application resume saved — add one in Options'
            });
        continue;
      }
      const hit = RA.matchAnswerBank(bank, f.label);
      if (hit) {
        resolved.set(f.id, {
          id: f.id,
          value: hit.entry.answer,
          confidence: Math.min(0.99, 0.8 + hit.score * 0.2),
          source: 'saved',
          basis: 'previously approved answer'
        });
        continue;
      }
      const rule = RA.answerFromRules(f, profile);
      if (rule) {
        resolved.set(f.id, Object.assign({ id: f.id, basis: 'profile field: ' + rule.ruleId }, rule));
        continue;
      }
      if (RA.isSensitive(f.label)) {
        // Never send these to the model; leave them to the candidate.
        resolved.set(f.id, {
          id: f.id, value: '', confidence: 0, source: 'skipped',
          basis: 'sensitive question — set a default in Options or answer manually'
        });
        continue;
      }
      unresolved.push(f);
    }
    return { resolved, unresolved };
  }

  async function askBackground(unresolved) {
    return sendRuntimeMessage(
      { type: 'GENERATE_ANSWERS', payload: { questions: unresolved, pageContext: pageContext() } }
    );
  }

  /* ------------------------------------------------------------- the panel */

  const PANEL_CSS = `
  :host { all: initial; }
  .wrap { font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #16181d; background: #fff; width: 380px; max-height: 78vh; display: flex; flex-direction: column;
    border: 1px solid #d6d9de; border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,.22); overflow-y: auto; }
  header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #f6f7f9; border-bottom: 1px solid #e3e6ea;
    position: sticky; top: 0; z-index: 2; flex: none; }
  header h1 { font-size: 13px; margin: 0; font-weight: 600; flex: 1; }
  .mode-switch { display: flex; gap: 3px; }
  .mode-switch button { font-size: 11px; padding: 4px 6px; }
  .mode-switch button.active { background: #1a63d8; border-color: #1a63d8; color: #fff; }
  .networking { padding: 12px; display: grid; gap: 10px; }
  .networking .q { font-weight: 600; font-size: 15px; }
  .networking label { display: grid; gap: 4px; }
  .networking select, .networking input, .networking textarea { width: 100%; box-sizing: border-box; font: inherit; padding: 7px; border: 1px solid #c8ccd2; border-radius: 6px; }
  button { font: inherit; border-radius: 6px; border: 1px solid #c8ccd2; background: #fff; padding: 5px 9px; cursor: pointer; }
  button:hover { background: #f1f3f5; }
  button.primary { background: #1a63d8; border-color: #1a63d8; color: #fff; }
  button.primary:hover { background: #1552b6; }
  button.ai-one { border-color: #1a63d8; color: #1a63d8; }
  button.ai-one:hover { background: #eef4ff; }
  button:disabled { opacity: .55; cursor: default; }
  .body { overflow: visible; padding: 8px 10px 12px; flex: none; }
  .item { border: 1px solid #e3e6ea; border-radius: 8px; padding: 8px; margin-bottom: 8px; }
  .q { font-weight: 600; margin-bottom: 5px; }
  .meta { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; flex-wrap: wrap; }
  .badge { font-size: 11px; padding: 1px 6px; border-radius: 999px; border: 1px solid #c8ccd2; color: #4a4f57; }
  .badge.saved { border-color: #7a5cd0; color: #5a3fb0; }
  .badge.profile, .badge.resume { border-color: #2f9e63; color: #1f7a4a; }
  .badge.ai { border-color: #1a63d8; color: #1a63d8; }
  .badge.skipped, .badge.none { border-color: #c9a227; color: #8a6d0b; }
  textarea { width: 100%; box-sizing: border-box; min-height: 34px; resize: vertical; font: inherit;
    border: 1px solid #c8ccd2; border-radius: 6px; padding: 5px 6px; }
  .row { display: flex; gap: 6px; margin-top: 6px; align-items: center; }
  .basis { font-size: 11px; color: #6b7079; margin-top: 4px; }
  .status { padding: 8px 12px; font-size: 12px; color: #4a4f57; border-top: 1px solid #e3e6ea; background: #fafbfc; }
  .actions { display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid #e3e6ea;
    background: #fff; position: sticky; bottom: 0; z-index: 2; flex: none; }
  .err { color: #b3261e; }
  .empty { padding: 16px; color: #6b7079; text-align: center; }
  .match { padding: 10px 12px; border-bottom: 1px solid #e3e6ea; background: #fbfbfc; }
  .match-top { display: flex; align-items: center; gap: 10px; }
  .score-circle { width: 44px; height: 44px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    font-weight: 700; font-size: 14px; flex: none; color: #fff; }
  .score-circle.good { background: #1f7a4a; }
  .score-circle.mid { background: #c9861b; }
  .score-circle.low { background: #b3261e; }
  .match-summary { flex: 1; font-size: 12px; }
  .match-summary .label { font-weight: 600; margin-bottom: 2px; }
  .match-bars { display: flex; gap: 10px; margin-top: 6px; font-size: 11px; color: #6b7079; }
  .kw-title { font-size: 11px; font-weight: 600; color: #4a4f57; margin: 8px 0 4px; text-transform: uppercase; letter-spacing: .03em; }
  .kw-list { display: flex; flex-wrap: wrap; gap: 5px; }
  .kw-chip { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid #d6d9de; background: #fff; color: #4a4f57; }
  .kw-chip.supported { border-color: #2f9e63; color: #1f7a4a; }
  .kw-chip.gap { border-color: #c9a227; color: #8a6d0b; }
  .kw-chip.gap.required { border-color: #b3261e; color: #b3261e; background: #fdf0ef; font-weight: 600; }
  .kw-note { font-size: 11.5px; color: #4a4f57; margin-top: 3px; padding-left: 2px; border-left: 2px solid #e3e6ea; padding-left: 6px; }
  .career { margin-top: 9px; border-top: 1px solid #e3e6ea; padding-top: 8px; }
  .career-result { margin-top: 6px; padding: 7px; border-radius: 6px; background: #f1f7f3; color: #1f6a43; font-size: 11.5px; }
  .career-result.warn { background: #fff8e6; color: #7a5a00; }
  .match textarea.jd-paste { margin-top: 6px; min-height: 50px; }
  `;

  function ensurePanel() {
    if (state.panel && state.panel.isConnected) return state.shadow;
    const host = document.createElement('div');
    host.id = 'ra-host';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = PANEL_CSS;
    shadow.appendChild(style);
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML = `
      <header>
        <h1>Fill-Up</h1>
        <div class="mode-switch"><button data-act="modejob" class="active">Job Application</button><button data-act="modenetwork">Networking</button></div>
        <button data-act="rescan">Rescan</button>
        <button data-act="close" title="Close">✕</button>
      </header>
      <div class="match"></div>
      <div class="body"></div>
      <div class="status"></div>
      <div class="actions">
        <button class="primary" data-act="ai">Answer remaining with AI</button>
        <button data-act="fillall">Fill all</button>
      </div>`;
    shadow.appendChild(wrap);
    document.documentElement.appendChild(host);

    shadow.addEventListener('click', onPanelClick);
    state.panel = host;
    state.shadow = shadow;
    return shadow;
  }

  function setStatus(text, isError) {
    const el = state.shadow && state.shadow.querySelector('.status');
    if (el) {
      el.textContent = text || '';
      el.classList.toggle('err', !!isError);
    }
  }

  function networkingContext() {
    const active = document.activeElement;
    const conversation = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'))
      .map((el) => String(el.value || el.innerText || '').trim()).filter(Boolean).slice(0, 3).join('\n\n');
    const visibleText = pickBlockText([
      '[data-testid="profile-card"]', '[data-testid="post-content"]', '[data-testid="conversation"]',
      '.feed-shared-update-v2', '.msg-s-message-list-content', '.conversation',
      '[class*="profile-card"]', '[class*="post-content"]', '[class*="conversation"]'
    ], 3500);
    return {
      personName: pickText(['h1', '[data-testid*="name"]', '[class*="profile-name"]', '[class*="person-name"]'], 160),
      role: pickText(['[data-testid*="headline"]', '[class*="headline"]', '[class*="job-title"]', 'h2'], 220),
      company: pickText(['[data-testid*="company"]', '[class*="company-name"]', '[class*="company"]'], 160),
      headline: pickText(['[data-testid*="headline"]', '[class*="headline"]'], 300),
      pageTitle: document.title,
      url: location.href,
      conversation,
      visibleContent: visibleText.slice(0, 5000),
      activeField: !!(active && (active.matches('textarea, input[type="text"], input[type="search"]') || active.isContentEditable))
    };
  }

  function renderNetworking() {
    const shadow = ensurePanel();
    shadow.querySelector('[data-act="modejob"]').classList.toggle('active', false);
    shadow.querySelector('[data-act="modenetwork"]').classList.toggle('active', true);
    const body = shadow.querySelector('.body');
    const n = state.networking;
    const angles = networkingAngles(n.intent);
    if (n.intent !== 'Custom' && !angles.includes(n.angle)) n.angle = angles[0] || '';
    body.innerHTML = `<div class="networking">
      <div class="q">Networking</div>
      <label class="hint">Intent<select data-networking="intent">
        ${Object.keys(NETWORKING_ANGLES).map((v) => `<option${v === n.intent ? ' selected' : ''}>${v}</option>`).join('')}
      </select></label>
      ${n.intent !== 'Custom' ? `<label class="hint">Angle<select data-networking="angle">${angles.map((v) => `<option${v === n.angle ? ' selected' : ''}>${v}</option>`).join('')}</select></label>` : '<label class="hint">What do you want this message to achieve?<input data-networking="custom" value="" placeholder="Describe your objective…" /></label>'}
      <div class="basis">Uses visible recipient/page context plus your existing profile, knowledge base, resumes, and saved answers. Review before inserting.</div>
      <textarea data-networking="result" rows="8" placeholder="Your personalized message will appear here…">${escapeHtml(n.result)}</textarea>
      <div class="row"><button data-act="networkgenerate" class="primary" ${n.busy ? 'disabled' : ''}>${n.busy ? 'Generating…' : 'Generate Message'}</button><button data-act="networkinsert" ${n.result ? '' : 'disabled'}>Insert</button></div>
      <div class="basis">${escapeHtml(n.basis || '')}</div>
    </div>`;
    const custom = body.querySelector('[data-networking="custom"]'); if (custom) custom.value = n.customIntent;
    body.querySelector('[data-networking="intent"]').addEventListener('change', (ev) => { n.intent = ev.target.value; n.angle = networkingAngles(n.intent)[0] || ''; n.result = ''; renderNetworking(); });
    const angle = body.querySelector('[data-networking="angle"]');
    if (angle) angle.addEventListener('change', (ev) => { n.angle = ev.target.value; n.result = ''; renderNetworking(); });
    const result = body.querySelector('[data-networking="result"]');
    result.addEventListener('input', () => { n.result = result.value; });
    if (custom) custom.addEventListener('input', () => { n.customIntent = custom.value; });
  }

  async function generateNetworking() {
    const n = state.networking;
    if (n.intent === 'Custom' && !n.customIntent.trim()) { setStatus('Describe what you are trying to do first.', true); return; }
    n.busy = true; n.result = ''; renderNetworking(); setStatus('Generating a personalized networking message…');
    try {
      const response = await sendRuntimeMessage({ type: 'GENERATE_NETWORKING', payload: { intent: n.intent, angle: n.angle, customIntent: n.customIntent, context: networkingContext() } });
      if (!response || !response.ok) { setStatus((response && response.error) || 'Could not generate the networking message.', true); return; }
      n.result = response.result.message || ''; n.basis = response.result.basis || ''; renderNetworking();
      setStatus(n.result ? 'Review the message, then choose Insert.' : 'No grounded message was returned.', !n.result);
    } finally { n.busy = false; renderNetworking(); }
  }

  function insertNetworking() {
    const value = state.networking.result.trim();
    if (!value) return;
    const active = document.activeElement && (document.activeElement.matches('textarea, input[type="text"], input[type="search"]') || document.activeElement.isContentEditable)
      ? document.activeElement : document.querySelector('textarea, [contenteditable="true"], input[type="text"], input[type="search"]');
    if (!active) { setStatus('No editable text field found on this page.', true); return; }
    if (active.isContentEditable) active.textContent = value;
    else { const proto = active instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(proto, 'value'); if (setter && setter.set) setter.set.call(active, value); else active.value = value; }
    active.dispatchEvent(new Event('input', { bubbles: true })); active.dispatchEvent(new Event('change', { bubbles: true }));
    setStatus('Inserted. Review it before sending.', false);
  }

  function badgeFor(a) {
    if (!a || !a.value) return { cls: 'none', text: 'no answer' };
    if (a.source === 'saved') return { cls: 'saved', text: 'saved answer' };
    if (a.source === 'existing') return { cls: 'profile', text: 'already filled' };
    if (a.source === 'profile') return { cls: 'profile', text: 'profile' };
    if (a.source === 'resume') return { cls: 'resume', text: 'application resume' };
    if (a.source === 'ai') return { cls: 'ai', text: `AI · ${Math.round((a.confidence || 0) * 100)}%` };
    if (a.source === 'skipped') return { cls: 'skipped', text: 'left to you' };
    return { cls: 'none', text: a.source || '' };
  }

  function canGenerateWithAi(field) {
    if (!field || field.kind === 'file' || RA.isSensitive(field.label)) return false;
    if (field.kind === 'textarea') return true;
    return field.kind === 'text' && /\b(?:why|describe|explain|tell us|share|additional information|anything else|interest|motivat|cover letter)\b/i.test(field.label);
  }

  function render() {
    const shadow = ensurePanel();
    shadow.querySelector('[data-act="modejob"]').classList.toggle('active', true);
    shadow.querySelector('[data-act="modenetwork"]').classList.toggle('active', false);
    if (state.mode === 'networking') { renderNetworking(); return; }
    const body = shadow.querySelector('.body');
    if (!state.fields.length) {
      body.innerHTML = '<div class="empty">No application questions found on this page.</div>';
      return;
    }
    body.innerHTML = '';
    for (const f of state.fields) {
      const a = state.answers.get(f.id);
      const badge = badgeFor(a);
      const item = document.createElement('div');
      item.className = 'item';
      item.dataset.id = f.id;
      const optionHint = f.options && f.options.length
        ? `<div class="basis">options: ${f.options.map((o) => o.label).join(' · ').slice(0, 160)}</div>`
        : '';
      const isFile = f.kind === 'file';
      const canGenerate = canGenerateWithAi(f);
      const generateLabel = a && a.value ? 'Regenerate Personalized Answer' : 'Generate Personalized Answer';
      item.innerHTML = `
        <div class="q"></div>
        <div class="meta"><span class="badge ${badge.cls}"></span></div>
        <textarea rows="${f.kind === 'textarea' ? 4 : 1}" ${isFile ? 'readonly' : ''}></textarea>
        ${optionHint}
        <div class="basis"></div>
        <div class="row">
          ${canGenerate ? `<button data-act="generate" class="ai-one" title="Generate a grounded answer from your profile, resume, knowledge base, saved answers, and job context">${generateLabel}</button>` : ''}
          <button data-act="fill">${isFile ? 'Attach resume' : 'Fill'}</button>
          <button data-act="show">Show field</button>
          ${isFile ? '' : '<button data-act="save">Save answer</button>'}
        </div>`;
      item.querySelector('.q').textContent = f.label;
      item.querySelector('.badge').textContent = badge.text;
      item.querySelector('textarea').value = a ? a.value : '';
      item.querySelector('.basis').textContent = a && a.basis ? a.basis : '';
      body.appendChild(item);
    }
  }

  function answerOf(itemEl) {
    return itemEl.querySelector('textarea').value;
  }

  async function fillItem(itemEl) {
    const field = state.fields.find((f) => f.id === itemEl.dataset.id);
    const answer = state.answers.get(itemEl.dataset.id);
    const value = field && field.kind === 'file' ? (answer && answer.file) : answerOf(itemEl);
    return RA.fillField(itemEl.dataset.id, value);
  }

  function scoreClass(score) {
    return score >= 75 ? 'good' : score >= 50 ? 'mid' : 'low';
  }

  function renderMatch() {
    const shadow = ensurePanel();
    const host = shadow.querySelector('.match');
    const m = state.match;

    if (!m) {
      host.innerHTML = `
        <div class="hint" style="font-size:12px;color:#6b7079;margin-bottom:6px;">
          No job description detected on this page. Paste it to get a match score.
        </div>
        <textarea class="jd-paste" placeholder="Paste the job description…"></textarea>
        <div class="row"><button data-act="usejd">Score against this</button></div>`;
      return;
    }

    const { score, breakdown, matched, missing, missingRequired } = m;
    const requiredSet = new Set((missingRequired || []).map((k) => k.toLowerCase()));
    const kwChips = (list, cls) => list.map((k) => {
      const extraCls = cls === 'gap' && requiredSet.has(k.toLowerCase()) ? ' required' : '';
      return `<span class="kw-chip ${cls}${extraCls}" title="${extraCls ? 'Called out in the requirements/qualifications section' : ''}">${escapeHtml(k)}</span>`;
    }).join('');
    const aiBlock = state.matchAi
      ? `<div class="kw-title">What to do about it</div>` +
        `<div class="kw-note" style="border:none;padding-left:0;margin-bottom:6px;">${escapeHtml(state.matchAi.summary || '')}</div>` +
        state.matchAi.keywordSuggestions.map((s) => `
          <div class="kw-note">
            <strong>${escapeHtml(s.keyword)}</strong> — ${s.inResume ? `add to <em>${escapeHtml(s.section)}</em>: ` : ''}${escapeHtml(s.suggestion)}
          </div>`).join('')
      : '';
    const resumeResult = state.tailoredResume
      ? `<div class="career-result ${state.tailoredResume.targetMet ? '' : 'warn'}">Tailored resume score: <strong>${state.tailoredResume.score}</strong>${state.tailoredResume.targetMet ? ' · target reached' : ' · best truthful result; unsupported gaps were not invented'}<div class="row"><button data-act="downloadresume">Download tailored resume (.docx)</button></div></div>`
      : '';
    const coverResult = state.coverLetter
      ? '<div class="career-result">Cover letter is ready.<div class="row"><button data-act="downloadcover">Download cover letter (.docx)</button></div></div>'
      : '';

    host.innerHTML = `
      <div class="match-top">
        <div class="score-circle ${scoreClass(score)}">${score}</div>
        <div class="match-summary">
          <div class="label">Resume match score</div>
          <div class="match-bars">
            <span>Keywords ${breakdown.keywordsFound}/${breakdown.keywordsTotal}</span>
            <span>Title ${breakdown.titleMatch}%</span>
            <span>Experience ${breakdown.experienceMatch}%</span>
          </div>
        </div>
      </div>
      ${matched.length ? `<div class="kw-title">Matched job requirements</div><div class="kw-list">${kwChips(matched.slice(0, 12), 'supported')}</div>` : ''}
      ${missing.length ? `<div class="kw-title">Relevant requirements not explicit in the resume ${missingRequired && missingRequired.length ? '(red = required)' : ''}</div><div class="kw-list">${kwChips(missing.slice(0, 15), 'gap')}</div>` : '<div class="kw-title">No significant requirement gaps found</div>'}
      ${aiBlock}
      <div class="row">
        ${missing.length ? '<button data-act="matchai">Explain gaps with AI</button>' : ''}
        <button data-act="pastejd">Use a different job description</button>
      </div>
      <div class="career">
        <div class="kw-title">Tailored application documents</div>
        <div class="kw-note" style="border:none;padding-left:0;">Uses both saved sources and the detected JD. The resume keeps the source layout and is rescored locally; unsupported claims are never added to force 90.</div>
        <div class="row">
          <button data-act="tailorresume" ${state.careerBusy ? 'disabled' : ''}>Create 90+ tailored resume</button>
          <button data-act="coverletter" ${state.careerBusy ? 'disabled' : ''}>Create cover letter</button>
        </div>
        ${resumeResult}${coverResult}
      </div>`;
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function onPanelClick(ev) {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const act = btn.dataset.act;
    const item = btn.closest('.item');

    if (act === 'modejob') { state.mode = 'job'; btn.classList.add('active'); await scan(); return; }
    if (act === 'modenetwork') { state.mode = 'networking'; renderNetworking(); return; }
    if (act === 'networkgenerate') { await generateNetworking(); return; }
    if (act === 'networkinsert') { insertNetworking(); return; }
    if (act === 'close') { state.panel.remove(); state.panel = null; return; }
    if (act === 'rescan') { await scan(); return; }
    if (act === 'ai') { await runAi(); return; }
    if (act === 'usejd') {
      const text = state.shadow.querySelector('.jd-paste').value.trim();
      if (!text) return;
      state.jdOverride = text;
      await computeMatch();
      return;
    }
    if (act === 'pastejd') {
      state.match = null;
      state.matchAi = null;
      state.tailoredResume = null;
      state.coverLetter = null;
      renderMatch();
      return;
    }
    if (act === 'matchai') { await runMatchAi(); return; }
    if (act === 'tailorresume') { await runCareerDocument('resume'); return; }
    if (act === 'coverletter') { await runCareerDocument('cover'); return; }
    if (act === 'downloadresume') { await downloadCareerDocument('resume'); return; }
    if (act === 'downloadcover') { await downloadCareerDocument('cover'); return; }
    if (act === 'fillall') {
      let filled = 0; let failed = 0; let preserved = 0;
      for (const el of state.shadow.querySelectorAll('.item')) {
        const field = state.fields.find((f) => f.id === el.dataset.id);
        if (field && field.value && String(field.value).trim()) { preserved++; continue; }
        const value = answerOf(el);
        if (!value.trim()) continue;
        const r = await fillItem(el);
        if (r.ok) filled++; else failed++;
      }
      setStatus(`Filled ${filled} blank field${filled === 1 ? '' : 's'}` +
        (preserved ? ` · preserved ${preserved} existing answer${preserved === 1 ? '' : 's'}` : '') +
        (failed ? ` · ${failed} could not be set` : '') + '. Review before submitting.');
      return;
    }
    if (!item) return;
    const fieldId = item.dataset.id;
    const field = state.fields.find((f) => f.id === fieldId);

    if (act === 'generate') {
      await runAiForQuestion(field, item);
    } else if (act === 'fill') {
      const r = await fillItem(item);
      setStatus(r.ok ? `Filled: ${RA.truncate(r.applied, 80)}` : `Could not fill: ${r.reason}`, !r.ok);
    } else if (act === 'show') {
      RA.highlightField(fieldId, true);
      setTimeout(() => RA.highlightField(fieldId, false), 2500);
    } else if (act === 'save') {
      const result = await sendRuntimeMessage(
        { type: 'SAVE_ANSWER', question: field.label, answer: answerOf(item) }
      );
      setStatus(
        result && result.ok ? 'Saved to your answer bank — it will be reused on the next application.' : result.error,
        !(result && result.ok)
      );
    }
  }

  /* ------------------------------------------------------------- workflow */

  async function runAiForQuestion(field, item) {
    if (!field || !canGenerateWithAi(field)) return;
    if (state.busy) { setStatus('Another AI request is already running.'); return; }
    const button = item.querySelector('[data-act="generate"]');
    if (button && button.disabled) return;
    state.busy = true;
    const allButton = state.shadow.querySelector('[data-act="ai"]');
    if (button) { button.disabled = true; button.textContent = 'Generating…'; }
    if (allButton) allButton.disabled = true;
    setStatus(`Asking Claude: ${RA.truncate(field.label, 100)}`);

    try {
      const response = await askBackground([field]);
      if (!response || !response.ok) {
        if (button) { button.disabled = false; button.textContent = 'Generate Personalized Answer'; }
        setStatus((response && response.error) || 'Could not generate an answer.', true);
        return;
      }

      const generated = (response.answers || []).find((answer) => answer.id === field.id);
      if (!generated || !String(generated.value || '').trim()) {
        const prior = state.answers.get(field.id);
        if (!prior || !prior.value) {
          state.answers.set(field.id, generated || {
            id: field.id, value: '', confidence: 0, source: 'ai', basis: 'No grounded answer returned.'
          });
          render();
        } else if (button) {
          button.disabled = false;
          button.textContent = 'Regenerate Personalized Answer';
        }
        setStatus((generated && generated.basis) || 'Claude did not return a grounded answer for this question.', true);
        return;
      }

      state.answers.set(field.id, generated);
      render();
      setStatus('Generated one answer. Review it, then choose Fill or Save answer.');
    } finally {
      state.busy = false;
      if (allButton && allButton.isConnected) allButton.disabled = false;
    }
  }

  async function computeMatch() {
    const [profile, resume, applicationResume] = await Promise.all([
      RA.storage.getProfile(), RA.storage.getResume(), RA.storage.getActiveApplicationResume()
    ]);
    const jd = state.jdOverride || pageContext().jobDescription;
    const scoredResume = applicationResume.text || resume.text;
    if (!scoredResume || !jd || jd.trim().length < 40) {
      state.match = null;
    } else {
      state.match = RA.matchScore(jd, scoredResume, profile, pageContext().jobTitle);
      state.matchAi = null;
      state.tailoredResume = null;
      state.coverLetter = null;
    }
    renderMatch();
  }

  async function runMatchAi() {
    if (state.matchBusy || !state.match) return;
    state.matchBusy = true;
    const btn = state.shadow.querySelector('[data-act="matchai"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Asking Claude…'; }
    const ctx = pageContext();
    const applicationFacts = state.fields
      .filter((f) => f.value && /major|degree|education|school|graduat|gpa|internship|leadership|university organization/i.test(f.label))
      .map((f) => `${f.label}: ${f.value}`)
      .join('\n');
    sendRuntimeMessage(
      {
        type: 'ANALYZE_MATCH',
        payload: { jobDescription: state.jdOverride || ctx.jobDescription, jobTitle: ctx.jobTitle, company: ctx.company, applicationFacts }
      }
    ).then((res) => {
      state.matchBusy = false;
      if (!res || !res.ok) { setStatus((res && res.error) || 'Could not analyze the match.', true); renderMatch(); return; }
      if (res.local) state.match = res.local;
      state.matchAi = res.ai;
      if (!res.ai) setStatus(res.aiError || 'No AI suggestions available — check your API key in settings.', !!res.aiError);
      renderMatch();
    });
  }

  function safeFilePart(value, fallback) {
    const cleaned = String(value || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
    return cleaned || fallback;
  }

  async function runCareerDocument(kind) {
    if (state.careerBusy) return;
    const ctx = pageContext();
    const jobDescription = state.jdOverride || ctx.jobDescription;
    if (!jobDescription || jobDescription.trim().length < 40) {
      setStatus('No job description detected. Choose “Use a different job description” and paste it first.', true);
      return;
    }
    state.careerBusy = true;
    renderMatch();
    setStatus(kind === 'resume' ? 'Tailoring and rescoring the resume…' : 'Creating a grounded cover letter…');
    const type = kind === 'resume' ? 'GENERATE_TAILORED_RESUME' : 'GENERATE_COVER_LETTER';
    const response = await sendRuntimeMessage({ type, payload: {
      jobDescription, jobTitle: ctx.jobTitle, company: ctx.company
    } });
    state.careerBusy = false;
    if (!response || !response.ok) {
      setStatus((response && response.error) || 'Document generation failed.', true);
      renderMatch();
      return;
    }
    if (kind === 'resume') {
      state.tailoredResume = response.result;
      setStatus(response.result.targetMet
        ? `Tailored resume reached ${response.result.score}. Review and download the DOCX.`
        : `Best truthful resume scored ${response.result.score}; remaining gaps are unsupported by the supplied evidence.`);
    } else {
      state.coverLetter = response.result;
      setStatus('Cover letter created. Review the role and company, then download the DOCX.');
    }
    renderMatch();
  }

  async function downloadCareerDocument(kind) {
    const profile = await RA.storage.getProfile();
    const ctx = pageContext();
    const role = safeFilePart(ctx.jobTitle, 'Role');
    const company = safeFilePart(ctx.company, 'Company');
    const candidate = safeFilePart([profile.firstName, profile.lastName].filter(Boolean).join('_'), 'Candidate');
    if (kind === 'resume' && state.tailoredResume) {
      RA.downloadDocx(RA.buildResumeDocx(state.tailoredResume.draft, profile), `${candidate}_${role}_Resume.docx`);
      setStatus('Tailored resume downloaded.');
    } else if (kind === 'cover' && state.coverLetter) {
      RA.downloadDocx(RA.buildCoverLetterDocx(state.coverLetter, profile), `${candidate}_${company}_${role}_Cover_Letter.docx`);
      setStatus('Cover letter downloaded.');
    }
  }

  async function scan() {
    ensurePanel();
    setStatus('Scanning page…');
    state.fields = RA.scanFields(document);
    const { resolved } = await resolveLocally(state.fields);
    state.answers = resolved;
    render();
    await computeMatch();
    const known = Array.from(resolved.values()).filter((a) => a.value).length;
    setStatus(`${state.fields.length} question${state.fields.length === 1 ? '' : 's'} found · ${known} answered from your profile and saved answers.`);
    return state.fields.length;
  }

  async function runAi() {
    if (state.busy) return;
    if (!state.fields.length) await scan();
    const unresolved = state.fields.filter((f) => {
      if (f.kind === 'file') return false;
      const a = state.answers.get(f.id);
      return !a || (!a.value && a.source !== 'skipped');
    });
    if (!unresolved.length) { setStatus('Nothing left for the model to answer.'); return; }

    state.busy = true;
    const aiBtn = state.shadow.querySelector('[data-act="ai"]');
    if (aiBtn) aiBtn.disabled = true;
    setStatus(`Asking Claude about ${unresolved.length} question${unresolved.length === 1 ? '' : 's'}…`);

    const res = await askBackground(unresolved);
    state.busy = false;
    if (aiBtn) aiBtn.disabled = false;

    if (!res.ok) { setStatus(res.error, true); return; }
    for (const a of res.answers) state.answers.set(a.id, a);
    render();
    const answered = res.answers.filter((a) => a.value).length;
    setStatus(`Claude answered ${answered} of ${res.answers.length}. Review and edit before filling.`);
  }

  /* --------------------------------------------------------- entry points */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      if (msg.type === 'PING') { sendResponse({ ok: true }); return; }
      if (msg.type === 'OPEN_PANEL') { sendResponse({ ok: true, count: await scan() }); return; }
      if (msg.type === 'RUN_AI') { await scan(); await runAi(); sendResponse({ ok: true }); return; }
      sendResponse({ ok: false, error: 'unknown message' });
    })();
    return true;
  });

  // Discoverability: if the page clearly holds an application form, show a
  // small launcher rather than opening the panel unprompted.
  function maybeShowLauncher() {
    if (document.getElementById('ra-launcher') || document.getElementById('ra-host')) return;
    // Ashby and some SPA portals render an application as controlled inputs
    // without a semantic <form>. Content scripts already run only on known job
    // portal hosts, so count visible application-like controls page-wide.
    const count = Array.from(document.querySelectorAll('input:not([type=hidden]), textarea, select'))
      .filter((el) => {
        if (el.name === 'g-recaptcha-response' || /captcha/i.test(el.id || '')) return false;
        if (el.closest('[role="search"], nav, header')) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      }).length;
    if (count < 3) return;
    const btn = document.createElement('button');
    btn.id = 'ra-launcher';
    btn.type = 'button';
    btn.textContent = 'Resume Autofill';
    btn.addEventListener('click', (e) => { e.preventDefault(); btn.remove(); scan(); });
    document.documentElement.appendChild(btn);
  }

  RA.storage.getSettings().then((s) => {
    if (s.autoScan !== false) {
      setTimeout(maybeShowLauncher, 1500);
      const mo = new MutationObserver(() => maybeShowLauncher());
      mo.observe(document.documentElement, { childList: true, subtree: true });
    }
  });
})();
