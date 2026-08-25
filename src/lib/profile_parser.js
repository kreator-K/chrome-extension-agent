/* Conservative, offline extraction of mechanical profile fields from resume
 * text. Ambiguous facts are intentionally left blank for user review. */
(function (root) {
  const RA = (root.RA = root.RA || {});

  function firstMatch(text, re, group) {
    const m = String(text || '').match(re);
    return m ? String(m[group || 0] || '').trim() : '';
  }

  function cleanUrl(url) {
    return String(url || '').replace(/[\]),.;]+$/, '').replace(/^www\./i, 'https://www.');
  }

  function plainLine(line) {
    return String(line || '')
      .replace(/\[([^\]]+)\]\((?:mailto:)?[^)]+\)/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
      .replace(/^\s*\|\s*|\s*\|\s*$/g, '')
      .replace(/\*\*|__|~~|`/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cleanScalar(value) {
    return plainLine(value)
      .replace(/^\s*[:|–—-]\s*/, '')
      .replace(/\s*\|\s*$/, '')
      .replace(/^["']|["']$/g, '')
      .trim();
  }

  function labelled(lines, labels) {
    const re = new RegExp('^(?:' + labels + ')\\s*(?::|\\||[–—-])\\s*(.+)$', 'i');
    for (const line of lines) {
      const m = line.match(re);
      if (m && cleanScalar(m[1])) return cleanScalar(m[1]);
    }
    return '';
  }

  function namePart(value) {
    value = cleanScalar(value);
    return /^[A-Za-zÀ-ÖØ-öø-ÿ'’-]+$/.test(value) ? value : '';
  }

  function plausibleName(line) {
    const value = cleanScalar(line);
    if (!value || value.length > 60 || /[@/:|\d]/.test(value)) return '';
    if (/\b(resume|résumé|curriculum vitae|knowledge|candidate|contact|identity|profile|summary|experience|education|skills|work|preferences|projects|certifications|awards|engineer|manager|developer|analyst|scientist|university|college|school|institute|how to use)\b/i.test(value)) return '';
    const words = value.split(/\s+/);
    if (words.length < 2 || words.length > 5 || words.some((w) => !/^[A-Za-zÀ-ÖØ-öø-ÿ'’.-]+$/.test(w))) return '';
    return value;
  }

  function putFullName(out, value) {
    const name = plausibleName(value);
    if (!name) return;
    const words = name.split(/\s+/);
    out.firstName = words[0];
    out.lastName = words.slice(1).join(' ');
  }

  function putLocation(out, value) {
    value = cleanScalar(value).replace(/^(?:location|based in)\s*:?\s*/i, '');
    const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
    if (!parts.length) return false;
    const stateZip = (parts[1] || '').match(/^([A-Za-z .'-]{2,40}?)(?:\s+(\d{4,10}(?:-\d{4})?))?$/);
    if (parts.length >= 2 && /^[A-Za-z .'-]+$/.test(parts[0]) && stateZip) {
      out.city = parts[0];
      out.state = stateZip[1].length === 2 ? stateZip[1].toUpperCase() : stateZip[1];
      if (stateZip[2]) out.postalCode = stateZip[2];
      if (parts[2]) out.country = parts.slice(2).join(', ');
      else if (/^[A-Z]{2}$/.test(out.state)) out.country = 'USA';
      return true;
    }
    return false;
  }

  function cleanSchool(value) {
    value = cleanScalar(value)
      .replace(/^(?:school|university|college|institution)\s*:?\s*/i, '')
      .replace(/\s+[—-]\s+(?:MBA|M\.?B\.?A\.?|M(?:aster)?\.?S\.?|B(?:achelor)?\.?\s*(?:Tech|Science|Arts)?).*$/i, '')
      .replace(/\s*,?\s*(?:19|20)\d{2}.*$/, '')
      .trim();
    const part = value.split(/\s*[|;·]\s*/).find((item) =>
      /\b(?:university|college|institute of technology|polytechnic|school of)\b/i.test(item)
    );
    return cleanScalar(part || value);
  }

  const SKILL_ALIASES = [
    ['Product Management', ['product management']],
    ['Product Strategy', ['product strategy']],
    ['Product Discovery', ['product discovery', 'discovery & user research']],
    ['User Research', ['user research']],
    ['A/B Testing', ['a/b testing', 'a-b testing', 'ab testing']],
    ['PLG Onboarding', ['plg onboarding', 'product-led growth onboarding']],
    ['Product-Led Growth', ['product-led growth']],
    ['Amplitude', ['amplitude']],
    ['Mixpanel', ['mixpanel']],
    ['Figma', ['figma']],
    ['Python', ['python']],
    ['SQL', ['sql']],
    ['JavaScript', ['javascript']],
    ['TypeScript', ['typescript']],
    ['RAG', ['rag', 'retrieval-augmented generation', 'retrieval augmented generation']],
    ['Vector Retrieval', ['vector retrieval', 'vector search']],
    ['LLM Applications', ['llm applications', 'large language model applications']],
    ['LLM Agents', ['llm agents', 'multi-agent ai', 'multi agent ai']],
    ['LLM Evals', ['llm evals', 'model evals', 'shipped evals', 'evaluation loop', 'eval rigor']],
    ['Multimodal AI', ['multimodal pipelines', 'multimodal ai']],
    ['AI-assisted Prototyping', ['ai-assisted prototyping', 'ai assisted prototyping']],
    ['Computer Vision', ['computer vision', 'vision model', 'frame analysis']],
    ['OCR', ['ocr']],
    ['OpenCV', ['opencv']],
    ['Whisper', ['whisper']],
    ['Llama', ['llama']],
    ['yt-dlp', ['yt-dlp']],
    ['Next.js', ['next.js']],
    ['Model Context Protocol (MCP)', ['mcp integration', 'model context protocol']],
    ['Kubernetes', ['kubernetes']],
    ['Docker', ['docker']],
    ['AWS', ['aws', 'amazon web services']],
    ['Azure', ['azure']],
    ['GCP', ['gcp', 'google cloud platform']],
    ['Git', ['git']],
    ['Agile', ['agile']],
    ['Scrum', ['scrum']],
    ['Roadmapping', ['roadmapping', 'product roadmap']],
    ['Prioritization', ['prioritization', 'prioritisation']],
    ['Stakeholder Management', ['stakeholder management']],
    ['Usability Testing', ['usability testing']],
    ['Information Architecture', ['information architecture']],
    ['Entity Modeling', ['entity modeling']],
    ['Google Ads', ['google ads', 'google hotel ads']],
    ['Meta Ads', ['meta ads']]
  ];

  function escapedRe(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function mentions(text, phrase) {
    return new RegExp('(?:^|[^A-Za-z0-9+#])' + escapedRe(phrase) + '(?=$|[^A-Za-z0-9+#])', 'i').test(text);
  }

  function addSkill(skillMap, name, years) {
    const key = String(name || '').trim().toLowerCase();
    if (!key) return;
    const existing = skillMap.get(key);
    const next = { name: String(name).trim(), years: years == null ? '' : years };
    if (!existing || (existing.years === '' && next.years !== '')) skillMap.set(key, next);
  }

  function addProjectStackSkills(skillMap, text) {
    // Project headings are a reliable source for named technologies even when
    // the knowledge base does not have a separate skills section.
    const stackRe = /(?:^|\n)\s*[^\n]{2,100}?\s*[—-]\s*([A-Za-z][A-Za-z0-9+#./ -]*(?:,\s*[A-Za-z][A-Za-z0-9+#./ -]*)+),\s*\d+\s+commits?\b/g;
    let match;
    while ((match = stackRe.exec(text)) !== null) {
      for (const item of match[1].split(',')) {
        const skill = item.trim();
        if (skill && skill.length <= 40 && skill.split(/\s+/).length <= 4) addSkill(skillMap, skill, '');
      }
    }
  }

  RA.extractProfile = function (text) {
    text = String(text || '');
    const rawLines = text.split(/\r?\n/).filter((line) => line.trim());
    const lines = rawLines.map(plainLine).filter(Boolean);
    const topLines = lines.slice(0, 20);
    const out = {};

    const fullName = labelled(lines, 'full\\s+name|legal\\s+name|preferred\\s+name|candidate(?:\\s+name)?|name');
    if (fullName) putFullName(out, fullName);
    if (!out.firstName || !out.lastName) {
      const kbTitleName = firstMatch(text, /^\s*Resume Knowledge Base\s*[—-]\s*([^\r\n]+)/im, 1);
      const pdfHeaderName = firstMatch(text, /^\s*([A-Z][A-Z'’-]+(?:\s+[A-Z][A-Z'’-]+){1,3})\s+(?=[A-Z][A-Za-z .'-]+,\s*[A-Z]{2}\b)/m, 1);
      putFullName(out, kbTitleName || pdfHeaderName);
    }
    const labelledFirst = labelled(lines, 'first\\s+name|given\\s+name');
    const labelledLast = labelled(lines, 'last\\s+name|family\\s+name|surname');
    if (labelledFirst && namePart(labelledFirst)) out.firstName = namePart(labelledFirst);
    if (labelledLast && namePart(labelledLast)) out.lastName = namePart(labelledLast);
    if (!out.firstName || !out.lastName) {
      const headingName = rawLines.filter((line) => /^\s*#\s+/.test(line)).map(plausibleName).find(Boolean);
      const fallbackName = headingName || topLines.map(plausibleName).find(Boolean);
      if (fallbackName) {
        const candidate = {};
        putFullName(candidate, fallbackName);
        if (!out.firstName) out.firstName = candidate.firstName;
        if (!out.lastName) out.lastName = candidate.lastName;
      }
    }

    const emailText = text.replace(/mailto:/gi, '').replace(/\s*@\s*/g, '@')
      .replace(/\s*\.\s*(com|org|net|edu|io|co|ai|us|ca|uk)\b/gi, '.$1');
    const email = firstMatch(emailText, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
    if (email) out.email = email;

    const phone = firstMatch(text, /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]\d{4}\b/);
    if (phone) out.phone = phone;

    const urls = text.match(/(?:(?:https?:\/\/|www\.)[^\s<>]+|(?:linkedin\.com\/in|github\.com)\/[^\s<>]+)/gi) || [];
    for (const raw of urls) {
      let url = cleanUrl(raw);
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      if (/linkedin\.com\/in\//i.test(url) && !out.linkedin) out.linkedin = url;
      else if (/github\.com\//i.test(url) && !out.github) out.github = url;
      else if (!out.portfolio && !/linkedin\.com|github\.com/i.test(url)) out.portfolio = url;
    }

    const labelledLocation = labelled(lines, 'location|based\\s+in|city(?:\\s*[\\/&,]\\s*state)?');
    if (labelledLocation) putLocation(out, labelledLocation);
    if (!out.city) {
      const headerLocation = firstMatch(text, /^\s*[A-Z][A-Z'’-]+(?:\s+[A-Z][A-Z'’-]+){1,3}\s+([A-Z][A-Za-z .'-]+,\s*[A-Z]{2}(?:\s+\d{5})?)/m, 1);
      if (headerLocation) putLocation(out, headerLocation);
    }
    if (!out.city) {
      const locationLine = topLines.find((line) => /^[A-Za-z .'-]+,\s*[A-Za-z .'-]{2,40}(?:\s+\d{4,10}(?:-\d{4})?)?(?:,\s*[A-Za-z .'-]+)?$/.test(line));
      if (locationLine) putLocation(out, locationLine);
    }
    const country = labelled(lines, 'country');
    const postalCode = labelled(lines, 'postal\\s+code|zip(?:\\s+code)?');
    const address = labelled(lines, 'street\\s+address|address(?:\\s+line\\s*1)?');
    if (country) out.country = country;
    if (postalCode && /^[A-Za-z0-9 -]{3,12}$/.test(postalCode)) out.postalCode = postalCode;
    if (address) out.addressLine = address;

    const yearsLabel = labelled(lines, 'total\\s+years(?:\\s+of\\s+experience)?|years\\s+of\\s+experience|professional\\s+experience');
    const years = firstMatch(yearsLabel, /\b(\d{1,2})\b/, 1) ||
      firstMatch(text, /\b(\d{1,2})\+?\s+years?(?:\s+of)?\s+(?:professional\s+)?experience\b/i, 1);
    if (years) out.totalYearsExperience = years;

    const degreePatterns = [
      [/\b(?:Ph\.?D\.?|Doctor(?:ate| of Philosophy))\b/i, 'Doctorate'],
      [/\b(?:M\.?S\.?|M\.?A\.?|MBA|Master(?:'s| of [A-Za-z ]+))\b/i, "Master's"],
      [/\b(?:B\.?S\.?|B\.?A\.?|Bachelor(?:'s| of [A-Za-z ]+))\b/i, "Bachelor's"],
      [/\bAssociate(?:'s)?\b/i, "Associate's"]
    ];
    const labelledDegree = labelled(lines, 'highest\\s+degree|degree(?:\\s+level)?|qualification');
    for (const [re, label] of degreePatterns) {
      if (re.test(labelledDegree || text)) { out.degreeLevel = label; break; }
    }
    const degreeLine = lines.find((line) => line.length < 180 && /\b(?:Ph\.?D\.?|Doctor(?:ate| of)|M\.?S\.?|M\.?A\.?|MBA|Master(?:'s| of)|B\.?S\.?|B\.?A\.?|Bachelor(?:'s| of)|Associate(?:'s| degree))\b/i.test(line));
    const labelledMajor = labelled(lines, 'major(?:\\s*\\/\\s*field\\s+of\\s+study)?|field\\s+of\\s+study|concentration|specialization');
    if (labelledMajor) out.major = labelledMajor;
    if (degreeLine && !out.major) {
      const major = firstMatch(degreeLine, /\b(?:in|of)\s+([A-Za-z][A-Za-z &/-]{2,60}?)(?=\s*[|,;·]|\s+(?:19|20)\d{2}\b|$)/i, 1);
      if (major && !/philosophy$/i.test(major)) out.major = major;
    }
    if (!out.major && /\b(?:MBA|Master of Business Administration)\b/i.test(text)) out.major = 'Business Administration';
    const labelledSchool = labelled(lines, 'school|university|college|institution');
    if (labelledSchool && /[A-Za-z]/.test(labelledSchool)) out.school = cleanSchool(labelledSchool);
    if (!out.school) {
      const schoolLine = lines.find((line) => /\b(?:university|college|institute of technology|polytechnic|school of)\b/i.test(line) && line.length < 180);
      if (schoolLine) out.school = cleanSchool(schoolLine);
    }
    const labelledGradYear = labelled(lines, 'graduation\\s+year|graduated|class\\s+of');
    const gradYear = firstMatch(labelledGradYear || degreeLine || text, /\b(19\d{2}|20\d{2})\b/, 1);
    if (gradYear) out.gradYear = gradYear;

    const labelledTitle = labelled(lines, 'current\\s+(?:job\\s+)?title|job\\s+title|current\\s+role|role');
    const labelledCompany = labelled(lines, 'current\\s+(?:employer|company)|employer|company');
    if (labelledTitle) out.currentTitle = labelledTitle;
    if (labelledCompany) out.currentCompany = labelledCompany;
    const numberedRole = rawLines.map((line) => plainLine(line).match(/^\d+\.\d+\s+(.{2,80}?)\s+[—-]\s+(.{2,80})$/)).find(Boolean);
    if (numberedRole) {
      if (!out.currentCompany) out.currentCompany = cleanScalar(numberedRole[1]);
      if (!out.currentTitle) out.currentTitle = cleanScalar(numberedRole[2]);
    }
    const titleWords = /\b(?:engineer|manager|director|developer|analyst|scientist|architect|consultant|designer|specialist|administrator|coordinator|researcher|product lead|team lead|founder|president|officer)\b/i;
    if (!out.currentTitle) {
      const atRole = lines.map((line) => line.match(/^([^|]{3,80}?)\s+at\s+([^|]{2,80})$/i)).find(Boolean);
      if (atRole && titleWords.test(atRole[1])) {
        out.currentTitle = atRole[1].trim();
        if (!out.currentCompany) out.currentCompany = atRole[2].replace(/\s*[|,;·]\s*(?:19|20)\d{2}.*$/, '').trim();
      } else {
        const experienceIndex = lines.findIndex((line) => /^(?:professional\s+)?experience$/i.test(line));
        const candidates = experienceIndex >= 0 ? lines.slice(experienceIndex + 1, experienceIndex + 8) : topLines;
        for (const parts of candidates.map((line) => line.split(/\s*[|;·]\s*/).map((part) => part.trim()).filter(Boolean))) {
          const titlePart = parts.find((part) => titleWords.test(part));
          if (!titlePart) continue;
          out.currentTitle = titlePart.replace(/\s*[,-]?\s*(?:19|20)\d{2}.*$/, '').trim();
          if (!out.currentCompany) {
            const companyPart = parts.find((part) => part !== titlePart && !/(?:19|20)\d{2}|present|current/i.test(part));
            if (companyPart) out.currentCompany = companyPart;
          }
          break;
        }
      }
    }
    if (out.currentTitle && out.currentTitle.length > 100) delete out.currentTitle;
    if (out.currentCompany && out.currentCompany.length > 100) delete out.currentCompany;

    if (/\b(?:authorized|eligible) to work in (?:the )?(?:united states|u\.?s\.?)\b/i.test(text)) out.workAuthorized = 'yes';
    if (/\b(?:(?:do not|don't|does not) require (?:visa )?sponsorship|without (?:the need for )?(?:visa )?sponsorship)\b/i.test(text)) out.requiresSponsorship = 'no';
    else if (/\brequire(?:s|d)? (?:visa )?sponsorship\b/i.test(text)) out.requiresSponsorship = 'yes';

    const skillMap = new Map();
    const skillRe = /\b([A-Za-z][A-Za-z0-9+#./ -]{0,30}?)\s*[(:—-]\s*(\d{1,2})\+?\s*(?:years?|yrs?)\b/gi;
    let match;
    while ((match = skillRe.exec(text)) !== null) {
      const skill = match[1].trim().replace(/^(?:and|with|using)\s+/i, '');
      if (skill.length >= 2 && skill.split(/\s+/).length <= 5) {
        const yearsValue = Number(match[2]);
        addSkill(skillMap, skill, yearsValue);
      }
    }
    // Resumes and knowledge bases usually list skills without claiming an exact
    // duration. Import conservative, recognized names from both sources but do
    // not manufacture years. An explicit duration above always wins.
    for (const [name, aliases] of SKILL_ALIASES) {
      if (!aliases.some((alias) => mentions(text, alias))) continue;
      addSkill(skillMap, name, '');
    }
    addProjectStackSkills(skillMap, text);
    if (skillMap.size) out.skills = Array.from(skillMap.values()).slice(0, 50);
    return out;
  };

  RA.mergeExtractedProfile = function (current, extracted) {
    const merged = Object.assign({}, current || {});
    const changed = [];
    let skillsAdded = 0;
    let skillYearsFilled = 0;
    for (const [key, value] of Object.entries(extracted || {})) {
      if (key === 'skills') {
        const existing = new Map((merged.skills || []).map((s) => [String(s.name).toLowerCase(), s]));
        for (const skill of value || []) {
          const k = String(skill.name).toLowerCase();
          if (!existing.has(k)) {
            existing.set(k, skill);
            changed.push('skills');
            skillsAdded++;
          } else {
            const prior = existing.get(k);
            const priorYears = prior && prior.years;
            if ((priorYears === '' || priorYears == null) && skill.years !== '' && skill.years != null) {
              existing.set(k, Object.assign({}, prior, { years: skill.years }));
              changed.push('skills');
              skillYearsFilled++;
            }
          }
        }
        merged.skills = Array.from(existing.values());
        continue;
      }
      const existingValue = String(merged[key] || '').trim();
      const formattingPolluted = /^[-*+]\s+/.test(existingValue) || /\*\*|__|~~|`/.test(existingValue) ||
        ((key === 'firstName' || key === 'lastName') && /how to use|this file/i.test(existingValue)) ||
        (key === 'school' && /\b(?:MBA|Master|Bachelor|B\.?Tech)\b.*(?:19|20)\d{2}/i.test(existingValue));
      if (value !== '' && value != null && (!existingValue || formattingPolluted)) {
        merged[key] = value;
        changed.push(key);
      }
    }
    const uniqueChanges = Array.from(new Set(changed));
    uniqueChanges.skillsAdded = skillsAdded;
    uniqueChanges.skillYearsFilled = skillYearsFilled;
    return { profile: merged, changed: uniqueChanges };
  };
})(typeof self !== 'undefined' ? self : this);
