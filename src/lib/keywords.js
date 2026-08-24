/* Local, offline resume/JD match scoring. No network call — this runs before
 * (and independently of) any AI request, so a candidate gets a score and a
 * keyword gap list for free, on every page.
 *
 * Requirements come from a curated cross-functional dictionary. Free-form
 * n-grams are deliberately excluded: they tend to mistake company, benefits,
 * compensation and legal boilerplate for candidate skills.
 */
(function (root) {
  const RA = (root.RA = root.RA || {});

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
    'ai', 'artificial intelligence', 'llm', 'generative ai', 'data science', 'data engineering', 'data analysis', 'etl', 'a/b testing', 'statistics',
    'agile', 'scrum', 'kanban', 'jira', 'confluence', 'project management', 'product management',
    'product owner', 'product backlog', 'product development backlog', 'backlog management', 'product strategy', 'product roadmap', 'sprint ceremonies', 'enterprise software',
    'workflow automation', 'process automation', 'stakeholder management', 'roadmap', 'prioritization', 'cross-functional', 'communication', 'leadership',
    'mentoring', 'team leadership',
    'sales', 'marketing', 'seo', 'sem', 'crm', 'erp', 'salesforce', 'hubspot', 'google analytics',
    'content strategy', 'brand strategy',
    'financial modeling', 'budgeting', 'forecasting', 'p&l', 'accounting', 'gaap', 'audit', 'compliance',
    'risk management',
    'supply chain', 'logistics', 'procurement', 'inventory management', 'six sigma', 'lean manufacturing',
    'ux', 'user experience', 'ui design', 'interactive design', 'design sessions', 'mockups', 'ux reviews', 'figma', 'user research', 'usability testing', 'accessibility', 'wcag',
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
    { re: /^\s*(responsibilities|what you.?ll do|role|about the role)\s*:?\s*$/i, weight: 1.0, required: false },
    { re: /^\s*(benefits|compensation|salary|pay range|about (us|the company)|equal opportunity|privacy|tools and resources|community)\s*:?\s*$/i, weight: 0, required: false, stop: true }
  ];

  function sectionInfo(line) {
    for (const s of SECTION_HEADERS) if (s.re.test(line)) return s;
    return null;
  }

  function isHeaderish(line) {
    return line.length < 60 && /:$/.test(line.trim());
  }

  /** Break job text into weighted sections so "required" terms outrank fluff. */
  function weightedLines(jobText) {
    const lines = String(jobText || '').split(/\n+/);
    const structured = lines.some((line) => {
      const section = sectionInfo(line.trim());
      return section && !section.stop;
    });
    let current = structured ? 0 : 1.0;
    let currentRequired = false;
    const out = [];
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const section = sectionInfo(line);
      if (section) { current = section.weight; currentRequired = section.required; continue; }
      if (/^(thank you for your interest|at this time|at appian, we embrace|the base salary range|in addition, .*benefits|pay and benefits|appian offers a comprehensive benefits|appian is an equal opportunity|appian provides reasonable accommodations)/i.test(line)) {
        current = 0;
        currentRequired = false;
        continue;
      }
      if (isHeaderish(line)) continue;
      if (!current) continue;
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
        const plural = /[a-z]$/.test(phrase) ? '(?:s|es)?' : '';
        const re = new RegExp('(?:^|[^a-z0-9])' + escapeRe(phrase) + plural + '(?:$|[^a-z0-9])', 'gi');
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

  /**
   * Extract and rank candidate keywords/phrases from a job description.
   * @returns {Array<{phrase:string, weight:number, count:int}>} sorted desc by weight
   */
  RA.extractKeywords = function (jobText, max) {
    const lines = weightedLines(jobText);
    const merged = dictionaryHits(lines);

    // Drop a shorter candidate if it is wholly contained inside a
    // heavier-weighted longer candidate (e.g. "backend" inside
    // "senior backend engineer").
    const all = Array.from(merged.entries()).sort((a, b) => b[1].weight - a[1].weight);
    const kept = all.filter(([key, val]) => !all.some(([otherKey, otherVal]) =>
      otherKey !== key &&
      (' ' + otherKey + ' ').includes(' ' + key + ' ') &&
      otherVal.weight >= val.weight * 0.5
    ));
    return kept.slice(0, max || 40).map(([, v]) => v);
  };

  function extractYearsRequirement(jobText) {
    for (const item of weightedLines(jobText)) {
      if (item.weight < 1.4) continue;
      const m = item.line.match(/(\d{1,2})\+?\s*(?:-\s*\d{1,2})?\s*years?/i);
      if (m) return Number(m[1]);
    }
    return null;
  }

  function titleContext(jobText, explicitTitle) {
    if (explicitTitle) return explicitTitle;
    const firstLines = String(jobText || '').split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 3);
    return firstLines.join(' ');
  }

  /**
   * Score a resume against a job description. Fully local — no network call.
   * @returns {{score:int, matched:Array, missing:Array, breakdown:object}}
   */
  RA.matchScore = function (jobText, resumeText, profile, jobTitle) {
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
    const wantedTitle = titleContext(jobText, jobTitle);
    const currentTitle = profile && profile.currentTitle;
    const currentTitleNorm = RA.normalize(currentTitle);
    const wantedTitleNorm = RA.normalize(wantedTitle);
    const titleMatch = currentTitle
      ? (currentTitleNorm && wantedTitleNorm &&
          (wantedTitleNorm.includes(currentTitleNorm) || currentTitleNorm.includes(wantedTitleNorm))
        ? 1
        : RA.similarity(currentTitle, wantedTitle))
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
