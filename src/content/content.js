/* In-page orchestrator: scan the form, answer what we can locally, ask the
 * background worker for the rest, and show a review panel before anything is
 * written into the page. */
(function () {
  if (window.__resumeAutofillLoaded) return;
  window.__resumeAutofillLoaded = true;

  const RA = window.RA;
  let state = { fields: [], answers: new Map(), panel: null, shadow: null, busy: false };

  /* --------------------------------------------------------- page context */

  function pickText(selectors, max) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const t = el && (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
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
      jobDescription: pickText([
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
    const [profile, bank] = await Promise.all([
      RA.storage.getProfile(),
      RA.storage.getAnswerBank()
    ]);
    const resolved = new Map();
    const unresolved = [];

    for (const f of fields) {
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
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        { type: 'GENERATE_ANSWERS', payload: { questions: unresolved, pageContext: pageContext() } },
        (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, error: 'no response' });
        }
      );
    });
  }

  /* ------------------------------------------------------------- the panel */

  const PANEL_CSS = `
  :host { all: initial; }
  .wrap { font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #16181d; background: #fff; width: 380px; max-height: 78vh; display: flex; flex-direction: column;
    border: 1px solid #d6d9de; border-radius: 10px; box-shadow: 0 12px 40px rgba(0,0,0,.22); overflow: hidden; }
  header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #f6f7f9; border-bottom: 1px solid #e3e6ea; }
  header h1 { font-size: 13px; margin: 0; font-weight: 600; flex: 1; }
  button { font: inherit; border-radius: 6px; border: 1px solid #c8ccd2; background: #fff; padding: 5px 9px; cursor: pointer; }
  button:hover { background: #f1f3f5; }
  button.primary { background: #1a63d8; border-color: #1a63d8; color: #fff; }
  button.primary:hover { background: #1552b6; }
  button:disabled { opacity: .55; cursor: default; }
  .body { overflow-y: auto; padding: 8px 10px 12px; }
  .item { border: 1px solid #e3e6ea; border-radius: 8px; padding: 8px; margin-bottom: 8px; }
  .q { font-weight: 600; margin-bottom: 5px; }
  .meta { display: flex; align-items: center; gap: 6px; margin-bottom: 5px; flex-wrap: wrap; }
  .badge { font-size: 11px; padding: 1px 6px; border-radius: 999px; border: 1px solid #c8ccd2; color: #4a4f57; }
  .badge.saved { border-color: #7a5cd0; color: #5a3fb0; }
  .badge.profile { border-color: #2f9e63; color: #1f7a4a; }
  .badge.ai { border-color: #1a63d8; color: #1a63d8; }
  .badge.skipped, .badge.none { border-color: #c9a227; color: #8a6d0b; }
  textarea { width: 100%; box-sizing: border-box; min-height: 34px; resize: vertical; font: inherit;
    border: 1px solid #c8ccd2; border-radius: 6px; padding: 5px 6px; }
  .row { display: flex; gap: 6px; margin-top: 6px; align-items: center; }
  .basis { font-size: 11px; color: #6b7079; margin-top: 4px; }
  .status { padding: 8px 12px; font-size: 12px; color: #4a4f57; border-top: 1px solid #e3e6ea; background: #fafbfc; }
  .err { color: #b3261e; }
  .empty { padding: 16px; color: #6b7079; text-align: center; }
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
      <div class="body"></div>
      <div class="status"></div>
      <div style="display:flex;gap:6px;padding:8px 10px;border-top:1px solid #e3e6ea">
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
    if (a.source === 'profile') return { cls: 'profile', text: 'profile' };
    if (a.source === 'ai') return { cls: 'ai', text: `AI · ${Math.round((a.confidence || 0) * 100)}%` };
    if (a.source === 'skipped') return { cls: 'skipped', text: 'left to you' };
    return { cls: 'none', text: a.source || '' };
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
      item.innerHTML = `
        <div class="q"></div>
        <div class="meta"><span class="badge ${badge.cls}"></span></div>
        <textarea rows="${f.kind === 'textarea' ? 4 : 1}"></textarea>
        ${optionHint}
        <div class="basis"></div>
        <div class="row">
          <button data-act="fill">Fill</button>
          <button data-act="show">Show field</button>
          <button data-act="save">Save answer</button>
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

  async function onPanelClick(ev) {
    const btn = ev.target.closest('button');
    if (!btn) return;
    const act = btn.dataset.act;
    const item = btn.closest('.item');

    if (act === 'close') { state.panel.remove(); state.panel = null; return; }
    if (act === 'rescan') { await scan(); return; }
    if (act === 'ai') { await runAi(); return; }
    if (act === 'fillall') {
      let filled = 0; let failed = 0;
      state.shadow.querySelectorAll('.item').forEach((el) => {
        const value = answerOf(el);
        if (!value.trim()) return;
        const r = RA.fillField(el.dataset.id, value);
        if (r.ok) filled++; else failed++;
      });
      setStatus(`Filled ${filled} field${filled === 1 ? '' : 's'}` + (failed ? `, ${failed} could not be set` : '') + '. Review before submitting.');
      return;
    }
    if (!item) return;
    const fieldId = item.dataset.id;
    const field = state.fields.find((f) => f.id === fieldId);

    if (act === 'fill') {
      const r = RA.fillField(fieldId, answerOf(item));
      setStatus(r.ok ? `Filled: ${RA.truncate(r.applied, 80)}` : `Could not fill: ${r.reason}`, !r.ok);
    } else if (act === 'show') {
      RA.highlightField(fieldId, true);
      setTimeout(() => RA.highlightField(fieldId, false), 2500);
    } else if (act === 'save') {
      chrome.runtime.sendMessage(
        { type: 'SAVE_ANSWER', question: field.label, answer: answerOf(item) },
        () => setStatus('Saved to your answer bank — it will be reused on the next application.')
      );
    }
  }

  /* ------------------------------------------------------------- workflow */

  async function scan() {
    ensurePanel();
    setStatus('Scanning page…');
    state.fields = RA.scanFields(document);
    const { resolved } = await resolveLocally(state.fields);
    state.answers = resolved;
    render();
    const known = Array.from(resolved.values()).filter((a) => a.value).length;
    setStatus(`${state.fields.length} question${state.fields.length === 1 ? '' : 's'} found · ${known} answered from your profile and saved answers.`);
    return state.fields.length;
  }

  async function runAi() {
    if (state.busy) return;
    if (!state.fields.length) await scan();
    const unresolved = state.fields.filter((f) => {
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
