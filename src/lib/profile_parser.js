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

    const name = plausibleName(topLines[0]);
    if (name) {
      const words = name.split(/\s+/);
      out.firstName = words[0];
      out.lastName = words.slice(1).join(' ');
    }

    const email = firstMatch(text, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
    if (email) out.email = email;

    const phone = firstMatch(text, /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]\d{4}\b/);
    if (phone) out.phone = phone;

    const urls = text.match(/(?:https?:\/\/|www\.)[^\s<>]+/gi) || [];
    for (const raw of urls) {
      const url = cleanUrl(raw);
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
      if (parts[2]) out.country = parts[2];
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
    const gradYear = firstMatch(text, /\b(?:graduated|graduation|class of)\s*:?[ \t]*(20\d{2}|19\d{2})\b/i, 1);
    if (gradYear) out.gradYear = gradYear;

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

  RA.mergeExtractedProfile = function (current, extracted, reviewedKeys) {
    const merged = Object.assign({}, current || {});
    const changed = [];
    const reviewed = reviewedKeys ? new Set(reviewedKeys) : null;
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
      const canFill = reviewed ? !reviewed.has(key) : !String(merged[key] || '').trim();
      if (value !== '' && value != null && canFill) {
        merged[key] = value;
        changed.push(key);
      }
    }
    return { profile: merged, changed: Array.from(new Set(changed)) };
  };
})(typeof self !== 'undefined' ? self : this);
