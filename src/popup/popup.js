const CONTENT_FILES = [
  'src/lib/util.js',
  'src/lib/rules.js',
  'src/lib/fields.js',
  'src/content/content.js'
];

const msgEl = document.getElementById('msg');
function say(text, isError) {
  msgEl.textContent = text || '';
  msgEl.classList.toggle('err', !!isError);
}

function send(target, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(target, message, (res) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(res);
    });
  });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

/** Make sure the content script is running in the tab, injecting it if needed. */
async function ensureInjected(tabId) {
  const pong = await send(tabId, { type: 'PING' });
  if (pong && pong.ok) return true;
  await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/content/overlay.css'] });
  await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
  const retry = await send(tabId, { type: 'PING' });
  return !!(retry && retry.ok);
}

async function run(type) {
  const tab = await activeTab();
  if (!tab || !tab.id) return say('No active tab.', true);
  if (/^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
    return say('This page cannot be scripted by extensions.', true);
  }
  say('Working…');
  try {
    const ready = await ensureInjected(tab.id);
    if (!ready) return say('Could not load into this page.', true);
    const res = await send(tab.id, { type });
    if (!res || !res.ok) return say((res && res.error) || 'No response from the page.', true);
    say(type === 'OPEN_PANEL' ? `Found ${res.count} question(s). See the panel on the page.` : 'Done — check the panel on the page.');
  } catch (err) {
    say(err.message || String(err), true);
  }
}

document.getElementById('scan').addEventListener('click', () => run('OPEN_PANEL'));
document.getElementById('ai').addEventListener('click', () => run('RUN_AI'));
document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
  const ul = document.getElementById('status');
  if (!state || !state.ok) {
    ul.innerHTML = '<li class="bad">Could not read extension state.</li>';
    return;
  }
  const rows = [
    state.resume.chars
      ? { ok: true, text: `Resume loaded (${state.resume.chars.toLocaleString()} chars)` }
      : { ok: false, text: 'No resume uploaded yet' },
    state.hasKey
      ? { ok: true, text: `API key set · ${state.settings.model}` }
      : { ok: false, text: 'No Anthropic API key set' },
    { ok: true, text: `${state.bankSize} saved answer(s)` }
  ];
  ul.innerHTML = '';
  for (const r of rows) {
    const li = document.createElement('li');
    li.className = r.ok ? '' : 'bad';
    li.textContent = (r.ok ? '✓ ' : '• ') + r.text;
    ul.appendChild(li);
  }
});
