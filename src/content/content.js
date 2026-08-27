/* In-page orchestrator: scan the form, answer what we can locally, ask the
 * background worker for the rest, and show a review panel before anything is
 * written into the page. */
(function () {
  if (window.__resumeAutofillLoaded) return;
  window.__resumeAutofillLoaded = true;

  const RA = window.RA;
  let state = {
    fields: [], answers: new Map(), panel: null, shadow: null, busy: false,
    match: null, matchAi: null, matchBusy: false, jdOverride: ''
  };

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
    return {
      title: document.title,
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
      ], 120),
      jobDescription: pickBlockText([
        '.jobs-description__content',
        '.description__text',
        '#content .section-wrapper',
        '[data-testid="job-description"]',
        '.job-description',
        '#job_description'
      ], 4000)
    };
  }

  /* ------------------------------------------------------ local answering */

  async function resolveLocally(fields) {
    const [profile, bank, applicationResume] = await Promise.all([
      RA.storage.getProfile(),
      RA.storage.getAnswerBank(),
      RA.storage.getApplicationResume()
    ]);
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
        <h1>Resume Autofill</h1>
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
      const generateLabel = a && a.value ? 'Regenerate with AI' : 'Generate with AI';
      item.innerHTML = `
        <div class="q"></div>
        <div class="meta"><span class="badge ${badge.cls}"></span></div>
        <textarea rows="${f.kind === 'textarea' ? 4 : 1}" ${isFile ? 'readonly' : ''}></textarea>
        ${optionHint}
        <div class="basis"></div>
        <div class="row">
          ${canGenerate ? `<button data-act="generate" class="ai-one">${generateLabel}</button>` : ''}
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
      renderMatch();
      return;
    }
    if (act === 'matchai') { await runMatchAi(); return; }
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
        if (button) { button.disabled = false; button.textContent = 'Generate with AI'; }
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
          button.textContent = 'Regenerate with AI';
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
      RA.storage.getProfile(), RA.storage.getResume(), RA.storage.getApplicationResume()
    ]);
    const jd = state.jdOverride || pageContext().jobDescription;
    const scoredResume = applicationResume.text || resume.text;
    if (!scoredResume || !jd || jd.trim().length < 40) {
      state.match = null;
    } else {
      state.match = RA.matchScore(jd, scoredResume, profile, pageContext().jobTitle);
      state.matchAi = null;
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
    const count = document.querySelectorAll('form input:not([type=hidden]), form textarea, form select').length;
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
