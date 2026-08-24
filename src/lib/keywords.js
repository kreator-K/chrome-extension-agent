/* Local, offline resume/JD match scoring. No network call — this runs before
 * (and independently of) any AI request, so a candidate gets a score and a
 * keyword gap list for free, on every page.
 *
 * Two sources of candidate keywords, merged:
 *  1. A curated skills/tools dictionary, matched with word boundaries — this
 *     is what keeps single words like "Python" or "SQL" from being drowned
 *     out by generic phrasing.
 *  2. Multi-word noun-phrase n-grams, for role-specific terms the dictionary
 *     will never fully cover ("payments platform", "distributed systems").
 * Single words that show up only from source 2 are dropped unless they are
 * clearly acronyms (ALL CAPS) — plain capitalized bullet-starters ("Strong",
 * "Familiarity") are not signal, they're just where a sentence began.
 */
(function (root) {
  const RA = (root.RA = root.RA || {});

  const STOPWORDS = new Set((
    'a about above after again against all am an and any are as at be because been before being below ' +
    'between both but by could did do does doing down during each few for from further had has have having ' +
    'he her here hers herself him himself his how i if in into is it its itself just me more most my myself ' +
    'no nor not now of off on once only or other our ours ourselves out over own same she should so some such ' +
    'than that the their theirs them themselves then there these they this those through to too under until up ' +
    'very was we were what when where which while who whom why will with you your yours yourself yourselves ' +
    'will would can may might must shall able using use used within across per etc via one two three including ' +
    'work team strong solid proven excellent good great working deep extensive demonstrated familiarity ' +
    'hands-on exposure knowledge understanding background comfortable passion passionate self-starter ' +
    'experience years year plus preferred required requirements responsibilities ' +
    'qualifications skills job role company looking candidate applicants ideal join help drive build ensure'
  ).split(/\s+/).filter(Boolean));

  // A deliberately broad, generic dictionary — not tied to any one field —
  // so the same scorer works for an engineering, marketing or ops posting.
  const DICTIONARY_PHRASES = [
    'python', 'java', 'javascript', 'typescript', 'golang', 'go', 'rust', 'c++', 'c#', 'ruby', 'php', 'scala',
    'kotlin', 'swift', 'sql', 'nosql', 'bash', 'matlab',
    'react', 'angular', 'vue', 'node.js', 'django', 'flask', 'spring', 'rails', 'next.js',
    'graphql', 'rest api', 'microservices', 'grpc', 'kafka', 'rabbitmq',
    'aws', 'azure', 'gcp', 'google cloud', 'ec2', 's3', 'lambda',
    'kubernetes', 'docker', 'terraform', 'ansible', 'jenkins', 'ci/cd',
    'devops', 'linux', 'unix',
    'postgresql', 'postgres', 'mysql', 'mongodb', 'redis', 'elasticsearch', 'snowflake', 'bigquery',
    'databricks', 'spark', 'hadoop', 'airflow',
    'machine learning', 'deep learning', 'nlp', 'computer vision', 'pytorch', 'tensorflow', 'scikit-learn',
    'llm', 'generative ai', 'data science', 'data engineering', 'data analysis', 'etl', 'a/b testing', 'statistics',
    'agile', 'scrum', 'kanban', 'jira', 'confluence', 'project management', 'product management',
    'stakeholder management', 'roadmap', 'prioritization', 'cross-functional', 'communication', 'leadership',
    'mentoring', 'team leadership',
    'sales', 'marketing', 'seo', 'sem', 'crm', 'erp', 'salesforce', 'hubspot', 'google analytics',
    'content strategy', 'brand strategy',
    'financial modeling', 'budgeting', 'forecasting', 'p&l', 'accounting', 'gaap', 'audit', 'compliance',
    'risk management',
    'supply chain', 'logistics', 'procurement', 'inventory management', 'six sigma', 'lean manufacturing',
    'ux', 'ui design', 'figma', 'user research', 'usability testing', 'accessibility', 'wcag',
    'security', 'penetration testing', 'soc 2', 'iso 27001', 'gdpr', 'hipaa', 'encryption', 'oauth',
    'unit testing', 'test automation', 'selenium', 'cypress', 'qa', 'quality assurance',
    'html', 'css', 'sass', 'tableau', 'power bi', 'excel', 'vba', 'git', 'github', 'gitlab'
  ];

  // required: true marks sections an ATS keyword-matcher would treat as
  // "must have" and weight far more heavily than the rest of the posting.
  const SECTION_HEADERS = [
    { re: /^\s*(minimum\s+)?(required|requirements|must[- ]haves?|basic qualifications)\s*:?\s*$/i, weight: 1.6, required: true },
    { re: /^\s*(preferred|nice[- ]to[- ]haves?|bonus|good to have)\s*:?\s*$/i, weight: 1.1, required: false },
    { re: /^\s*(qualifications|what you.?ll need|what we.?re looking for|skills)\s*:?\s*$/i, weight: 1.4, required: true },
    { re: /^\s*(responsibilities|what you.?ll do|role|about the role)\s*:?\s*$/i, weight: 1.0, required: false }
  ];

  function sectionInfo(line) {
    for (const s of SECTION_HEADERS) if (s.re.test(line)) return s;
    return null;
  }

  function isHeaderish(line) {
    return line.length < 60 && /:$/.test(line.trim());
  }

  function cleanToken(t) {
    return t.replace(/^[^a-z0-9+#.]+|[^a-z0-9+#.]+$/gi, '');
  }

  /** Break job text into weighted sections so "required" terms outrank fluff. */
  function weightedLines(jobText) {
    const lines = String(jobText || '').split(/\n+/);
    let current = 1.0;
    let currentRequired = false;
    const out = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const section = sectionInfo(line);
      if (section) { current = section.weight; currentRequired = section.required; continue; }
      if (isHeaderish(line)) continue;
      out.push({ line, weight: current, required: currentRequired });
    }
    return out.length ? out : [{ line: String(jobText || ''), weight: 1, required: false }];
  }

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function dictionaryHits(weightedLinesArr) {
    const found = new Map();
    for (const { line, weight, required } of weightedLinesArr) {
      const lower = line.toLowerCase();
      for (const phrase of DICTIONARY_PHRASES) {
        const re = new RegExp('(?:^|[^a-z0-9])' + escapeRe(phrase) + '(?:$|[^a-z0-9])', 'gi');
        let m;
        let hits = 0;
        while ((m = re.exec(lower)) !== null) { hits++; re.lastIndex = Math.max(re.lastIndex - 1, m.index + 1); }
        if (!hits) continue;
        const entry = found.get(phrase) || { phrase, weight: 0, count: 0, required: false };
        const specificity = phrase.split(' ').length > 1 ? 1.3 : 1.1;
        entry.weight += weight * specificity * hits;
        entry.count += hits;
        entry.required = entry.required || required;
        found.set(phrase, entry);
      }
    }
    return found;
  }

  function ngrams(words, n) {
    const out = [];
    for (let i = 0; i + n <= words.length; i++) out.push(words.slice(i, i + n).join(' '));
    return out;
  }

  function phraseNgramHits(weightedLinesArr, dictSet) {
    const dictWords = new Set();
    dictSet.forEach((phrase) => phrase.split(' ').forEach((w) => dictWords.add(w)));

    const found = new Map();
    for (const { line, weight, required } of weightedLinesArr) {
      const rawWords = line.split(/\s+/).map(cleanToken).filter(Boolean);
      const words = rawWords.map((w) => w.toLowerCase());
      for (const n of [1, 2, 3]) {
        const rawGrams = ngrams(rawWords, n);
        const grams = ngrams(words, n);
        grams.forEach((g, i) => {
          if (dictSet.has(g)) return; // already captured with a cleaner boundary match
          const parts = g.split(' ');
          if (parts.some((p) => STOPWORDS.has(p))) return;
          if (parts.every((p) => /^[0-9.]+$/.test(p))) return;
          // A multi-word gram whose every word is already its own dictionary
          // hit (e.g. "AWS EC2 S3") adds no new information — skip it.
          if (n > 1 && parts.every((p) => dictWords.has(p))) return;
          if (n === 1) {
            // Single free-floating words are only signal when they read as an
            // acronym (AWS, SQL, CI/CD) — sentence-initial capitals are noise.
            const raw = rawGrams[i];
            const isAcronym = /^[A-Z0-9/]{2,6}$/.test(raw);
            if (!isAcronym) return;
          }
          const display = rawGrams[i];
          const entry = found.get(g) || { phrase: display, weight: 0, count: 0, required: false };
          const lenBonus = n === 1 ? 1 : n === 2 ? 1.2 : 1.4;
          entry.weight += weight * lenBonus;
          entry.count += 1;
          entry.required = entry.required || required;
          found.set(g, entry);
        });
      }
    }
    return found;
  }

  /**
   * Extract and rank candidate keywords/phrases from a job description.
   * @returns {Array<{phrase:string, weight:number, count:int}>} sorted desc by weight
   */
  RA.extractKeywords = function (jobText, max) {
    const lines = weightedLines(jobText);
    const dict = dictionaryHits(lines);
    const extra = phraseNgramHits(lines, new Set(dict.keys ? Array.from(dict.keys()) : Object.keys(dict)));
    const merged = new Map(dict);
    extra.forEach((v, k) => { if (!merged.has(k)) merged.set(k, v); });

    // Drop a shorter candidate if it is wholly contained inside a
    // heavier-weighted longer candidate (e.g. "backend" inside
    // "senior backend engineer").
    const all = Array.from(merged.entries()).sort((a, b) => b[1].weight - a[1].weight);
    const kept = [];
    for (const [key, val] of all) {
      const subsumed = kept.some(([, keptVal]) =>
        keptVal.phrase.toLowerCase() !== val.phrase.toLowerCase() &&
        (' ' + keptVal.phrase.toLowerCase() + ' ').includes(' ' + key + ' ') &&
        keptVal.weight >= val.weight
      );
      if (!subsumed) kept.push([key, val]);
    }
    return kept.slice(0, max || 40).map(([, v]) => v);
  };

  function extractYearsRequirement(jobText) {
    const m = String(jobText || '').match(/(\d{1,2})\+?\s*(?:-\s*\d{1,2})?\s*years?/i);
    return m ? Number(m[1]) : null;
  }

  function titleContext(jobText) {
    const firstLines = String(jobText || '').split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 3);
    return firstLines.join(' ');
  }

  /**
   * Score a resume against a job description. Fully local — no network call.
   * @returns {{score:int, matched:Array, missing:Array, breakdown:object}}
   */
  RA.matchScore = function (jobText, resumeText, profile) {
    const keywords = RA.extractKeywords(jobText, 40);
    const resumeNorm = RA.normalize(resumeText);
    let totalWeight = 0;
    let matchedWeight = 0;
    const matched = [];
    const missing = [];

    for (const kw of keywords) {
      totalWeight += kw.weight;
      // A plain " word " substring check misses "Docker." at a sentence end,
      // since normalize() deliberately keeps periods (for "node.js", "c#").
      // Boundary on "not alphanumeric" instead, same as dictionaryHits().
      const needle = escapeRe(RA.normalize(kw.phrase)).replace(/ /g, '\\s+');
      const re = new RegExp('(?:^|[^a-z0-9])' + needle + '(?:$|[^a-z0-9])', 'i');
      if (re.test(resumeNorm)) {
        matchedWeight += kw.weight;
        matched.push(kw.phrase);
      } else {
        missing.push(kw);
      }
    }
    const keywordScore = totalWeight ? matchedWeight / totalWeight : 1;

    // Title similarity: does the resume/profile mention something like the JD title?
    const titleMatch = profile && profile.currentTitle
      ? RA.similarity(profile.currentTitle, titleContext(jobText))
      : 0.5;

    // Years-of-experience: full credit if we meet or exceed a stated minimum.
    const wantYears = extractYearsRequirement(jobText);
    let yearsScore = 0.75; // neutral when the JD states no minimum
    if (wantYears != null && profile) {
      const have = Number(profile.totalYearsExperience) || 0;
      yearsScore = have >= wantYears ? 1 : RA.clamp(have / wantYears, 0, 1);
    }

    const score = Math.round(
      RA.clamp(keywordScore, 0, 1) * 70 +
      RA.clamp(titleMatch, 0, 1) * 15 +
      RA.clamp(yearsScore, 0, 1) * 15
    );

    missing.sort((a, b) => (b.required - a.required) || (b.weight - a.weight));
    const missingTop = missing.slice(0, 20);
    return {
      score,
      matched,
      missing: missingTop.map((m) => m.phrase),
      missingRequired: missingTop.filter((m) => m.required).map((m) => m.phrase),
      breakdown: {
        keywordCoverage: Math.round(keywordScore * 100),
        titleMatch: Math.round(RA.clamp(titleMatch, 0, 1) * 100),
        experienceMatch: Math.round(RA.clamp(yearsScore, 0, 1) * 100),
        keywordsFound: matched.length,
        keywordsTotal: keywords.length,
        yearsRequired: wantYears
      }
    };
  };
})(typeof self !== 'undefined' ? self : this);
