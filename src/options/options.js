const RA = window.RA;

const PROFILE_FIELDS = [
  ['firstName', 'First name', 'text'],
  ['lastName', 'Last name', 'text'],
  ['email', 'Email', 'email'],
  ['phone', 'Phone', 'tel'],
  ['city', 'City', 'text'],
  ['state', 'State / province', 'text'],
  ['country', 'Country', 'text'],
  ['postalCode', 'Postal code', 'text'],
  ['addressLine', 'Street address', 'text'],
  ['linkedin', 'LinkedIn URL', 'url'],
  ['github', 'GitHub URL', 'url'],
  ['portfolio', 'Portfolio URL', 'url'],
  ['currentTitle', 'Current title', 'text'],
  ['currentCompany', 'Current company', 'text'],
  ['totalYearsExperience', 'Total years of experience', 'number'],
  ['degreeLevel', 'Highest degree', 'text'],
  ['school', 'School', 'text'],
  ['major', 'Major / field of study', 'text'],
  ['gradYear', 'Graduation year', 'text'],
  ['workAuthorized', 'Authorized to work', 'yesno'],
  ['requiresSponsorship', 'Requires visa sponsorship', 'yesno'],
  ['workAuthDetail', 'Work authorization detail', 'text'],
  ['willingToRelocate', 'Willing to relocate', 'yesno'],
  ['willingToTravel', 'Willing to travel', 'yesno'],
  ['workMode', 'Preferred work mode', 'select', ['remote', 'hybrid', 'onsite']],
  ['noticePeriodDays', 'Notice period (days)', 'number'],
  ['earliestStartDate', 'Earliest start date', 'text'],
  ['desiredSalary', 'Desired compensation', 'text'],
  ['currentSalary', 'Current compensation', 'text'],
  ['referralSource', 'How you heard about roles', 'text'],
  ['previouslyEmployedHere', 'Previously employed by employers you apply to', 'yesno'],
  ['relatedToEmployee', 'Related to a current employee', 'yesno'],
  ['nonCompete', 'Bound by a non-compete', 'yesno'],
  ['criminalRecord', 'Criminal record', 'yesno'],
  ['backgroundCheckConsent', 'Consent to background check', 'yesno'],
  ['drugTestConsent', 'Consent to drug test', 'yesno'],
  ['gender', 'Gender (EEO)', 'text'],
  ['ethnicity', 'Race / ethnicity (EEO)', 'text'],
  ['hispanicLatino', 'Hispanic / Latino (EEO)', 'text'],
  ['veteranStatus', 'Veteran status (EEO)', 'text'],
  ['disabilityStatus', 'Disability status (EEO)', 'text']
];

const $ = (id) => document.getElementById(id);

function status(el, text, cls) {
  el.textContent = text;
  el.className = 'hint ' + (cls || '');
  if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 4000);
}

async function mergeProfileFromText(text) {
  const extracted = RA.extractProfile(text);
  const raw = await RA.storage.get('profile');
  const current = Object.assign({}, RA.DEFAULT_PROFILE, raw.profile || {});
  const result = RA.mergeExtractedProfile(current, extracted);
  if (result.changed.length) await RA.storage.set({ profile: result.profile });
  return result.changed;
}

/* ------------------------------------------------------------- knowledge base */

async function loadResume() {
  const resume = await RA.storage.getResume();
  $('resumeText').value = resume.text || '';
  $('resumeMeta').textContent = resume.fileName
    ? `${resume.fileName} · ${(resume.text || '').length.toLocaleString()} chars · saved ${new Date(resume.updatedAt).toLocaleString()}`
    : '';
}

$('kbFile').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  status($('resumeStatus'), 'Reading ' + file.name + '…');
  try {
    if (/\.pdf$/i.test(file.name)) {
      const { text, ok } = await window.PDFText.extract(await file.arrayBuffer());
      $('resumeText').value = text;
      status(
        $('resumeStatus'),
        ok
          ? 'Extracted text from the PDF — read it over, then save.'
          : 'This PDF did not extract cleanly (it may be scanned). Paste the text instead.',
        ok ? 'ok' : 'err'
      );
    } else {
      $('resumeText').value = await file.text();
      status($('resumeStatus'), 'Loaded — press Save.', 'ok');
    }
    $('resumeMeta').textContent = file.name;
  } catch (err) {
    status($('resumeStatus'), err.message, 'err');
  }
});

$('saveResume').addEventListener('click', async () => {
  const text = $('resumeText').value.trim();
  await RA.storage.set({
    resume: { text, fileName: $('resumeMeta').textContent.split(' · ')[0] || 'pasted text', updatedAt: Date.now() }
  });
  const changed = await mergeProfileFromText(text);
  await loadResume();
  if (changed.length) await loadProfile();
  status($('resumeStatus'), changed.length ? `Saved · filled ${changed.length} profile field(s).` : 'Saved.', 'ok');
});

/* --------------------------------------------------------- application resume */

const MAX_APPLICATION_RESUME_BYTES = 5 * 1024 * 1024;
const APPLICATION_RESUME_EXT = /\.(pdf|docx?)$/i;

function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read the file.'));
    reader.readAsDataURL(file);
  });
}

async function loadApplicationResume() {
  const file = await RA.storage.getApplicationResume();
  $('applicationResumeMeta').textContent = file.fileName
    ? `${file.fileName} · ${(file.size / 1024).toFixed(1)} KB · saved ${new Date(file.updatedAt).toLocaleString()}`
    : 'No application resume saved.';
  $('clearApplicationResume').disabled = !file.fileName;
}

$('applicationResumeFile').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  if (!APPLICATION_RESUME_EXT.test(file.name)) {
    status($('applicationResumeStatus'), 'Choose a PDF, DOC, or DOCX file.', 'err');
    ev.target.value = '';
    return;
  }
  if (file.size > MAX_APPLICATION_RESUME_BYTES) {
    status($('applicationResumeStatus'), 'The application resume must be 5 MB or smaller.', 'err');
    ev.target.value = '';
    return;
  }
  status($('applicationResumeStatus'), 'Saving ' + file.name + ' locally…');
  try {
    let extractedText = '';
    if (/\.pdf$/i.test(file.name)) {
      const extracted = await window.PDFText.extract(await file.arrayBuffer());
      if (extracted.ok) extractedText = extracted.text;
    }
    await RA.storage.set({
      applicationResume: {
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        dataUrl: await fileAsDataUrl(file),
        text: extractedText,
        updatedAt: Date.now()
      }
    });
    const kb = await RA.storage.getResume();
    const changed = await mergeProfileFromText([kb.text, extractedText].filter(Boolean).join('\n\n'));
    await loadApplicationResume();
    if (changed.length) await loadProfile();
    status(
      $('applicationResumeStatus'),
      changed.length ? `Saved and ready · filled ${changed.length} profile field(s).` : 'Saved and ready to attach.',
      'ok'
    );
  } catch (err) {
    status($('applicationResumeStatus'), 'Could not save: ' + err.message, 'err');
  } finally {
    ev.target.value = '';
  }
});

$('clearApplicationResume').addEventListener('click', async () => {
  if (!confirm('Remove the saved application resume from this browser?')) return;
  await RA.storage.set({ applicationResume: null });
  await loadApplicationResume();
  status($('applicationResumeStatus'), 'Removed.', 'ok');
});

/* -------------------------------------------------------------------- profile */

function profileInput(key, label, type, options) {
  const wrap = document.createElement('label');
  const span = document.createElement('span');
  span.textContent = label;
  wrap.appendChild(span);
  let input;
  if (type === 'yesno' || type === 'select') {
    input = document.createElement('select');
    for (const v of type === 'yesno' ? ['yes', 'no'] : options) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v;
      input.appendChild(opt);
    }
  } else {
    input = document.createElement('input');
    input.type = type;
  }
  input.id = 'p_' + key;
  wrap.appendChild(input);
  return wrap;
}

function skillRow(skill) {
  const row = document.createElement('div');
  row.className = 'skill';
  row.innerHTML = '<input name="name" placeholder="Skill, e.g. Python" />' +
    '<input name="years" type="number" min="0" max="60" placeholder="years" />' +
    '<button type="button" class="danger">Remove</button>';
  row.querySelector('[name=name]').value = skill ? skill.name : '';
  row.querySelector('[name=years]').value = skill ? skill.years : '';
  row.querySelector('button').addEventListener('click', () => row.remove());
  return row;
}

async function loadProfile() {
  const profile = await RA.storage.getProfile();
  const grid = $('profileGrid');
  grid.innerHTML = '';
  for (const [key, label, type, options] of PROFILE_FIELDS) {
    grid.appendChild(profileInput(key, label, type, options));
  }
  for (const [key] of PROFILE_FIELDS) {
    const el = $('p_' + key);
    if (el) el.value = profile[key] == null ? '' : profile[key];
  }
  const skills = $('skills');
  skills.innerHTML = '';
  (profile.skills || []).forEach((s) => skills.appendChild(skillRow(s)));
  if (!(profile.skills || []).length) skills.appendChild(skillRow());
}

$('addSkill').addEventListener('click', () => $('skills').appendChild(skillRow()));

$('saveProfile').addEventListener('click', async () => {
  const profile = {};
  for (const [key] of PROFILE_FIELDS) {
    const el = $('p_' + key);
    profile[key] = el ? el.value.trim() : '';
  }
  profile.skills = Array.from($('skills').querySelectorAll('.skill'))
    .map((row) => ({
      name: row.querySelector('[name=name]').value.trim(),
      years: Number(row.querySelector('[name=years]').value) || 0
    }))
    .filter((s) => s.name);
  await RA.storage.set({ profile });
  status($('profileStatus'), 'Saved.', 'ok');
});

$('extractProfile').addEventListener('click', async () => {
  const resume = await RA.storage.getResume();
  const text = [$('resumeText').value, resume.text].filter(Boolean).join('\n\n');
  const changed = await mergeProfileFromText(text);
  await loadProfile();
  status(
    $('profileStatus'),
    changed.length ? `Filled ${changed.length} field(s). Review and save any edits.` : 'No new unambiguous profile facts found.',
    changed.length ? 'ok' : ''
  );
});

/* ------------------------------------------------------------------- settings */

async function loadSettings() {
  const s = await RA.storage.getSettings();
  $('apiKey').value = s.apiKey || '';
  $('model').value = s.model;
  $('effort').value = s.effort;
  $('tone').value = s.tone;
  $('maxAiQuestions').value = s.maxAiQuestions;
  $('autoScan').checked = s.autoScan !== false;
}

$('saveSettings').addEventListener('click', async () => {
  const current = await RA.storage.getSettings();
  const settings = Object.assign(current, {
    apiKey: $('apiKey').value.trim(),
    model: $('model').value,
    effort: $('effort').value,
    tone: $('tone').value.trim() || RA.DEFAULT_SETTINGS.tone,
    maxAiQuestions: RA.clamp(Number($('maxAiQuestions').value) || 25, 1, 60),
    autoScan: $('autoScan').checked
  });
  await RA.storage.set({ settings });
  status($('settingsStatus'), 'Saved.', 'ok');
});

$('testKey').addEventListener('click', () => {
  const key = $('apiKey').value.trim();
  if (!key) return status($('settingsStatus'), 'Enter a key first.', 'err');
  status($('settingsStatus'), 'Testing…');
  chrome.runtime.sendMessage({ type: 'TEST_API_KEY', apiKey: key }, (res) => {
    if (!res || !res.ok) status($('settingsStatus'), (res && res.error) || 'No response.', 'err');
    else status($('settingsStatus'), 'Key works.', 'ok');
  });
});

/* ----------------------------------------------------------------- answer bank */

async function loadBank() {
  const bank = await RA.storage.getAnswerBank();
  const host = $('bank');
  host.innerHTML = '';
  if (!bank.length) {
    host.innerHTML = '<p class="hint">Nothing saved yet.</p>';
    return;
  }
  bank
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .forEach((entry) => {
      const div = document.createElement('div');
      div.className = 'bank-item';
      div.innerHTML = '<div class="q"></div><div class="a"></div>' +
        '<div class="row"><button class="danger">Delete</button></div>';
      div.querySelector('.q').textContent = entry.question;
      div.querySelector('.a').textContent = entry.answer;
      div.querySelector('button').addEventListener('click', async () => {
        const rest = (await RA.storage.getAnswerBank()).filter((e) => e.key !== entry.key);
        await RA.storage.set({ answerBank: rest });
        loadBank();
      });
      host.appendChild(div);
    });
}

$('clearBank').addEventListener('click', async () => {
  if (!confirm('Delete every saved answer?')) return;
  await RA.storage.set({ answerBank: [] });
  loadBank();
  status($('bankStatus'), 'Cleared.', 'ok');
});

$('exportAll').addEventListener('click', async () => {
  const [settings, profile, resume, applicationResume, answerBank] = await Promise.all([
    RA.storage.getSettings(), RA.storage.getProfile(), RA.storage.getResume(),
    RA.storage.getApplicationResume(), RA.storage.getAnswerBank()
  ]);
  // The API key is deliberately left out of the export.
  const data = { profile, resume, applicationResume, answerBank, settings: Object.assign({}, settings, { apiKey: '' }) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'resume-autofill-backup.json';
  a.click();
  URL.revokeObjectURL(url);
});

$('importAll').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const patch = {};
    if (data.profile) patch.profile = Object.assign({}, RA.DEFAULT_PROFILE, data.profile);
    if (data.resume) patch.resume = data.resume;
    if (data.applicationResume) patch.applicationResume = data.applicationResume;
    if (Array.isArray(data.answerBank)) patch.answerBank = data.answerBank;
    if (data.settings) {
      const current = await RA.storage.getSettings();
      patch.settings = Object.assign({}, current, data.settings, { apiKey: current.apiKey });
    }
    await RA.storage.set(patch);
    await Promise.all([loadResume(), loadApplicationResume(), loadProfile(), loadSettings(), loadBank()]);
    status($('bankStatus'), 'Imported.', 'ok');
  } catch (err) {
    status($('bankStatus'), 'Import failed: ' + err.message, 'err');
  }
});

loadResume();
loadApplicationResume();
loadProfile();
loadSettings();
loadBank();
