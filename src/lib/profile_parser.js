/* Conservative, offline extraction of mechanical profile fields from resume
 * text. Ambiguous facts are intentionally left blank for user review. */
(function (root) {
  const RA = (root.RA = root.RA || {});

  function firstMatch(text, re, group) {
    const m = String(text || '').match(re);
    return m ? String(m[group || 0] || '').trim() : '';
  }

  function cleanUrl(url) {
    return String(url || '').replace(/[),.;]+$/, '').replace(/^www\./i, 'https://www.');
  }

  function plausibleName(line) {
    const value = String(line || '').trim();
    if (!value || value.length > 60 || /[@/:|\d]/.test(value)) return '';
    if (/\b(resume|résumé|curriculum vitae|summary|experience|education|skills|engineer|manager|developer|analyst|scientist)\b/i.test(value)) return '';
    const words = value.split(/\s+/);
    if (words.length < 2 || words.length > 4 || words.some((w) => !/^[A-Za-zÀ-ÖØ-öø-ÿ'’-]+$/.test(w))) return '';
    return value;
  }

  RA.extractProfile = function (text) {
    text = String(text || '');
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const topLines = lines.slice(0, 12);
    const out = {};

    const name = topLines.map(plausibleName).find(Boolean);
    if (name) {
      const words = name.split(/\s+/);
      out.firstName = words[0];
      out.lastName = words.slice(1).join(' ');
    }

    const emailText = text.replace(/\s*@\s*/g, '@').replace(/\s*\.\s*(com|org|net|edu|io|co)\b/gi, '.$1');
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

    const locationLine = topLines.find((line) => /^[A-Za-z .'-]+,\s*[A-Z]{2}(?:\s+\d{5})?(?:,\s*(?:USA|US|United States))?$/i.test(line));
    if (locationLine) {
      const parts = locationLine.split(',').map((part) => part.trim());
      out.city = parts[0] || '';
      const stateZip = (parts[1] || '').match(/^([A-Z]{2})(?:\s+(\d{5}))?$/i);
      if (stateZip) {
        out.state = stateZip[1].toUpperCase();
        if (stateZip[2]) out.postalCode = stateZip[2];
      }
      out.country = parts[2] || (stateZip ? 'USA' : '');
    }

    const years = firstMatch(text, /\b(\d{1,2})\+?\s+years?(?:\s+of)?\s+(?:professional\s+)?experience\b/i, 1);
    if (years) out.totalYearsExperience = years;

    const degreePatterns = [
      [/\b(?:Ph\.?D\.?|Doctor(?:ate| of Philosophy))\b/i, 'Doctorate'],
      [/\b(?:M\.?S\.?|M\.?A\.?|MBA|Master(?:'s| of [A-Za-z ]+))\b/i, "Master's"],
      [/\b(?:B\.?S\.?|B\.?A\.?|Bachelor(?:'s| of [A-Za-z ]+))\b/i, "Bachelor's"],
      [/\bAssociate(?:'s)?\b/i, "Associate's"]
    ];
    for (const [re, label] of degreePatterns) {
      if (re.test(text)) { out.degreeLevel = label; break; }
    }
    const degreeLine = lines.find((line) => /\b(?:Ph\.?D\.?|Doctor|M\.?S\.?|M\.?A\.?|MBA|Master|B\.?S\.?|B\.?A\.?|Bachelor|Associate)\b/i.test(line));
    if (degreeLine) {
      const major = firstMatch(degreeLine, /\b(?:in|of)\s+([A-Za-z][A-Za-z &/-]{2,60}?)(?=\s*[|,;·]|\s+(?:19|20)\d{2}\b|$)/i, 1);
      if (major && !/philosophy$/i.test(major)) out.major = major;
      const yearOnDegree = firstMatch(degreeLine, /\b(19\d{2}|20\d{2})\b/, 1);
      if (yearOnDegree) out.gradYear = yearOnDegree;
    }
    const schoolLine = lines.find((line) => /\b(?:university|college|institute of technology|polytechnic|school of)\b/i.test(line) && line.length < 180);
    if (schoolLine) {
      const schoolPart = schoolLine
        .split(/\s*[|;·]\s*/)
        .find((part) => /\b(?:university|college|institute of technology|polytechnic|school of)\b/i.test(part));
      out.school = String(schoolPart || schoolLine).replace(/\s*,?\s*(?:19|20)\d{2}.*$/, '').trim();
    }
    const gradYear = firstMatch(text, /\b(?:graduated|graduation|class of)\s*:?[ \t]*(20\d{2}|19\d{2})\b/i, 1);
    if (gradYear && !out.gradYear) out.gradYear = gradYear;

    const titleWords = /\b(?:engineer|manager|director|developer|analyst|scientist|architect|consultant|designer|specialist|administrator|coordinator|researcher|product lead|team lead)\b/i;
    const atRole = text.match(/^\s*([^\n|]{3,80}?)\s+at\s+([^\n|]{2,80})\s*$/im);
    if (atRole && titleWords.test(atRole[1])) {
      out.currentTitle = atRole[1].trim();
      out.currentCompany = atRole[2].replace(/\s*[|,;·]\s*(?:19|20)\d{2}.*$/, '').trim();
    } else {
      const experienceIndex = lines.findIndex((line) => /^\s*(?:professional\s+)?experience\s*$/i.test(line));
      const candidates = experienceIndex >= 0 ? lines.slice(experienceIndex + 1, experienceIndex + 8) : topLines;
      for (let i = 0; i < candidates.length && !out.currentTitle; i++) {
        const parts = candidates[i].split(/\s*[|;·]\s*/).map((part) => part.trim()).filter(Boolean);
        const titlePart = parts.find((part) => titleWords.test(part));
        if (!titlePart) continue;
        out.currentTitle = titlePart.replace(/\s*[,-]?\s*(?:19|20)\d{2}.*$/, '').trim();
        const companyPart = parts.find((part) => part !== titlePart && !/(?:19|20)\d{2}|present|current/i.test(part));
        if (companyPart) out.currentCompany = companyPart;
        else {
          const adjacent = [candidates[i - 1], candidates[i + 1]].find((line) =>
            line && line.length < 100 && !titleWords.test(line) && !/(?:19|20)\d{2}|present|current/i.test(line)
          );
          if (adjacent) out.currentCompany = adjacent;
        }
      }
    }

    if (/\b(?:authorized|eligible) to work in (?:the )?(?:united states|u\.?s\.?)\b/i.test(text)) out.workAuthorized = 'yes';
    if (/\b(?:(?:do not|don't|does not) require (?:visa )?sponsorship|without (?:the need for )?(?:visa )?sponsorship)\b/i.test(text)) out.requiresSponsorship = 'no';
    else if (/\brequire(?:s|d)? (?:visa )?sponsorship\b/i.test(text)) out.requiresSponsorship = 'yes';

    const skillMap = new Map();
    const skillRe = /\b([A-Za-z][A-Za-z0-9+#./ -]{0,30}?)\s*[(:—-]\s*(\d{1,2})\+?\s*(?:years?|yrs?)\b/gi;
    let match;
    while ((match = skillRe.exec(text)) !== null) {
      const skill = match[1].trim().replace(/^(?:and|with|using)\s+/i, '');
      if (skill.length >= 2 && skill.split(/\s+/).length <= 5) {
        const key = skill.toLowerCase();
        const yearsValue = Number(match[2]);
        if (!skillMap.has(key) || skillMap.get(key).years < yearsValue) {
          skillMap.set(key, { name: skill, years: yearsValue });
        }
      }
    }
    if (skillMap.size) out.skills = Array.from(skillMap.values()).slice(0, 50);

    return out;
  };

  RA.mergeExtractedProfile = function (current, extracted) {
    const merged = Object.assign({}, current || {});
    const changed = [];
    for (const [key, value] of Object.entries(extracted || {})) {
      if (key === 'skills') {
        const existing = new Map((merged.skills || []).map((s) => [String(s.name).toLowerCase(), s]));
        for (const skill of value || []) {
          const k = String(skill.name).toLowerCase();
          if (!existing.has(k)) { existing.set(k, skill); changed.push('skills'); }
        }
        merged.skills = Array.from(existing.values());
        continue;
      }
      if (value !== '' && value != null && !String(merged[key] || '').trim()) {
        merged[key] = value;
        changed.push(key);
      }
    }
    return { profile: merged, changed: Array.from(new Set(changed)) };
  };
})(typeof self !== 'undefined' ? self : this);
