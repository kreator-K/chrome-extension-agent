/* Shared helpers. Loaded as a classic script in both the content script world
 * and the service worker (via importScripts), so it must not touch the DOM at
 * the top level. Everything hangs off globalThis.RA. */
(function (root) {
  const RA = (root.RA = root.RA || {});

  /* ---------------------------------------------------------------- storage */

  const DEFAULT_SETTINGS = {
    apiKey: '',
    model: 'claude-opus-5',
    effort: 'medium',
    tone: 'concise and specific, first person, no buzzwords',
    autoScan: true,
    autofillThreshold: 0.9, // only auto-apply answers at or above this score
    maxAiQuestions: 25
  };

  const DEFAULT_PROFILE = {
    firstName: '', lastName: '', email: '', phone: '',
    city: '', state: '', country: '', postalCode: '', addressLine: '',
    linkedin: '', github: '', portfolio: '', otherUrl: '',
    currentTitle: '', currentCompany: '', totalYearsExperience: '',
    degreeLevel: '', school: '', major: '', gradYear: '',
    workAuthorized: 'yes',          // yes | no
    requiresSponsorship: 'no',      // yes | no
    workAuthDetail: '',             // free text, e.g. "US citizen"
    willingToRelocate: 'yes',
    willingToTravel: 'yes',
    workMode: 'hybrid',             // remote | hybrid | onsite
    noticePeriodDays: '',
    earliestStartDate: '',
    desiredSalary: '',
    currentSalary: '',
    referralSource: '',
    criminalRecord: 'no',
    backgroundCheckConsent: 'yes',
    drugTestConsent: 'yes',
    previouslyEmployedHere: 'no',
    relatedToEmployee: 'no',
    nonCompete: 'no',
    gender: 'Decline to self-identify',
    ethnicity: 'Decline to self-identify',
    veteranStatus: 'I do not wish to answer',
    disabilityStatus: 'I do not wish to answer',
    hispanicLatino: 'Decline to self-identify',
    skills: [] // [{ name: 'Python', years: 5 }]
  };

  RA.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  RA.DEFAULT_PROFILE = DEFAULT_PROFILE;

  RA.storage = {
    async get(keys) {
      return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
    },
    async set(obj) {
      return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
    },
    async getSettings() {
      const { settings } = await RA.storage.get('settings');
      return Object.assign({}, DEFAULT_SETTINGS, settings || {});
    },
    async getProfile() {
      const { profile } = await RA.storage.get('profile');
      return Object.assign({}, DEFAULT_PROFILE, profile || {});
    },
    async getResume() {
      const { resume } = await RA.storage.get('resume');
      return resume || { text: '', fileName: '', updatedAt: 0 };
    },
    async getApplicationResume() {
      const { applicationResume } = await RA.storage.get('applicationResume');
      return applicationResume || {
        fileName: '', mimeType: '', size: 0, dataUrl: '', updatedAt: 0
      };
    },
    async getAnswerBank() {
      const { answerBank } = await RA.storage.get('answerBank');
      return Array.isArray(answerBank) ? answerBank : [];
    },
    async saveAnswer(question, answer) {
      const bank = await RA.storage.getAnswerBank();
      const key = RA.normalize(question);
      if (!key || !String(answer).trim()) return bank;
      const existing = bank.find((e) => e.key === key);
      if (existing) {
        existing.answer = answer;
        existing.updatedAt = Date.now();
        existing.uses = (existing.uses || 0) + 1;
      } else {
        bank.push({ key, question, answer, updatedAt: Date.now(), uses: 1 });
      }
      await RA.storage.set({ answerBank: bank });
      return bank;
    }
  };

  /* ------------------------------------------------------------ text utils */

  RA.normalize = function (s) {
    return String(s || '')
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\s+/g, ' ')
      .replace(/[^a-z0-9'"+#./ -]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const STOP = new Set(
    ('a an the is are was were be been do does did you your yours we our us i my me of in on at to for with and or if how what when which that this these those please tell describe about as by from can could would will shall have has had it its'
    ).split(' ')
  );

  RA.tokens = function (s) {
    return RA.normalize(s).split(' ').filter((t) => t && !STOP.has(t));
  };

  /** Jaccard-ish similarity over content words, 0..1. */
  RA.similarity = function (a, b) {
    const A = new Set(RA.tokens(a));
    const B = new Set(RA.tokens(b));
    if (!A.size || !B.size) return 0;
    let inter = 0;
    A.forEach((t) => { if (B.has(t)) inter++; });
    return inter / (A.size + B.size - inter);
  };

  /** Best entry in the answer bank for a question, or null. */
  RA.matchAnswerBank = function (bank, question, threshold) {
    const min = threshold == null ? 0.72 : threshold;
    const key = RA.normalize(question);
    let best = null;
    let bestScore = 0;
    for (const entry of bank) {
      const score = entry.key === key ? 1 : RA.similarity(entry.question, question);
      if (score > bestScore) { bestScore = score; best = entry; }
    }
    if (best && bestScore >= min) return { entry: best, score: bestScore };
    return null;
  };

  /** Pick the option whose text best matches `value`. Returns option or null. */
  RA.bestOption = function (options, value) {
    if (!options || !options.length) return null;
    const target = RA.normalize(value);
    if (!target) return null;
    let best = null;
    let bestScore = 0;
    for (const opt of options) {
      const label = RA.normalize(opt.label != null ? opt.label : opt);
      if (!label) continue;
      let score = 0;
      if (label === target) score = 1;
      else if (label.startsWith(target) || target.startsWith(label)) score = 0.9;
      else if (label.includes(target) || target.includes(label)) score = 0.8;
      else score = RA.similarity(label, target) * 0.7;
      if (score > bestScore) { bestScore = score; best = opt; }
    }
    return bestScore >= 0.55 ? best : null;
  };

  RA.clamp = function (n, lo, hi) { return Math.max(lo, Math.min(hi, n)); };

  RA.truncate = function (s, n) {
    s = String(s || '');
    return s.length <= n ? s : s.slice(0, n) + '\n…[truncated]';
  };

  /** Rank resume paragraphs by overlap with a query; return the top ones. */
  RA.retrieve = function (resumeText, query, maxChars) {
    const limit = maxChars || 4000;
    const text = String(resumeText || '');
    if (text.length <= limit) return text;
    const chunks = text
      .split(/\n\s*\n/)
      .map((c) => c.trim())
      .filter(Boolean);
    const scored = chunks
      .map((c, i) => ({ c, i, s: RA.similarity(c, query) }))
      .sort((a, b) => b.s - a.s);
    const picked = [];
    let size = 0;
    for (const item of scored) {
      if (size + item.c.length > limit) continue;
      picked.push(item);
      size += item.c.length;
      if (size > limit * 0.9) break;
    }
    picked.sort((a, b) => a.i - b.i);
    return picked.map((p) => p.c).join('\n\n') || text.slice(0, limit);
  };
})(typeof self !== 'undefined' ? self : this);
