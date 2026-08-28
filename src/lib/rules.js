/* Deterministic answers for the questions that repeat on every portal.
 * Loaded as a classic script in the content world and the service worker. */
(function (root) {
  const RA = (root.RA = root.RA || {});
  const N = (s) => RA.normalize(s);

  const yn = (v) => (String(v).toLowerCase() === 'yes' ? 'Yes' : 'No');

  function skillYears(profile, skill) {
    const want = N(skill);
    if (!want) return { matched: false, years: null };
    let best = null;
    let matched = false;
    for (const s of profile.skills || []) {
      const name = N(s.name);
      if (!name) continue;
      if (name === want || name.includes(want) || want.includes(name)) {
        matched = true;
        if (s.years === '' || s.years == null) continue;
        const y = Number(s.years);
        if (!isNaN(y) && (best == null || y > best)) best = y;
      }
    }
    return { matched, years: best };
  }

  /* Each rule: id, match (RegExp on the normalized label), answer(ctx). */
  const RULES = [
    {
      id: 'first_name',
      match: /^(first|given)\s*name|^legal first name/,
      answer: (p) => p.firstName
    },
    {
      id: 'last_name',
      match: /^(last|family|sur)\s*name|^legal last name/,
      answer: (p) => p.lastName
    },
    {
      id: 'full_name',
      match: /^(full |legal |your )?name$|^candidate name/,
      answer: (p) => [p.firstName, p.lastName].filter(Boolean).join(' ')
    },
    { id: 'email', match: /e[- ]?mail/, answer: (p) => p.email },
    {
      id: 'phone',
      match: /phone|mobile number|contact number/,
      answer: (p) => p.phone
    },
    { id: 'city', match: /^city\b|^location(?: \(?(?:city)?\)?)?\s*$|city of residence|current city/, answer: (p) => p.city },
    { id: 'state', match: /^state|province|region/, answer: (p) => p.state },
    { id: 'country', match: /^country/, answer: (p) => p.country },
    { id: 'zip', match: /zip|postal code/, answer: (p) => p.postalCode },
    { id: 'address', match: /street address|address line|^address/, answer: (p) => p.addressLine },
    { id: 'location', match: /current location|where are you (currently )?(located|based)/,
      answer: (p) => [p.city, p.state, p.country].filter(Boolean).join(', ') },

    { id: 'linkedin', match: /linkedin/, answer: (p) => p.linkedin },
    { id: 'github', match: /github|git hub/, answer: (p) => p.github },
    {
      id: 'portfolio',
      match: /portfolio|personal (web)?site|your website|website url/,
      answer: (p) => p.portfolio || p.otherUrl
    },

    { id: 'current_title', match: /current (job )?title|current role|present designation/, answer: (p) => p.currentTitle },
    { id: 'current_company', match: /current (employer|company|organization)/, answer: (p) => p.currentCompany },

    {
      id: 'work_auth',
      match: /(legally )?authoriz(ed|ation) to work|eligible to work|right to work|work permit|authorized to be employed/,
      answer: (p) => yn(p.workAuthorized)
    },
    {
      id: 'sponsorship',
      match: /sponsor|visa (support|status)|h-?1b|require.*(immigration|employment) (status|support)/,
      answer: (p) => {
        // "Will you now or in the future require sponsorship?" -> requiresSponsorship
        return yn(p.requiresSponsorship);
      }
    },
    {
      id: 'work_auth_detail',
      match: /what is your (work|visa|immigration) status|describe your work authorization/,
      answer: (p) => p.workAuthDetail || (String(p.workAuthorized).toLowerCase() === 'yes' ? 'Authorized to work without sponsorship' : '')
    },

    {
      id: 'years_of_experience_skill',
      match: /(how many )?years? of (professional |hands[- ]on |relevant |work )?experience (do you have )?(with|in|using|of)\s+(.+)/,
      answer: (p, field) => {
        const m = N(field.label).match(/experience (?:do you have )?(?:with|in|using|of)\s+(.+)/);
        const skill = m ? m[1].replace(/\?.*$/, '').trim() : '';
        const evidence = skillYears(p, skill);
        if (evidence.years != null) return String(evidence.years);
        if (evidence.matched) return '';
        return p.totalYearsExperience ? String(p.totalYearsExperience) : '';
      },
      confidence: (p, field) => {
        const m = N(field.label).match(/experience (?:do you have )?(?:with|in|using|of)\s+(.+)/);
        const evidence = skillYears(p, m ? m[1] : '');
        return evidence.years != null ? 0.95 : evidence.matched ? 0 : 0.55;
      }
    },
    {
      id: 'total_experience',
      match: /(total|overall)?\s*years? of (professional |work |total |relevant )?experience\s*\??$|^experience \(years\)|^years of experience/,
      answer: (p) => (p.totalYearsExperience ? String(p.totalYearsExperience) : '')
    },

    {
      id: 'notice_period',
      match: /notice period|how soon can you (join|start)|availability to start|when can you start|earliest start date|start date/,
      answer: (p, field) => {
        if (/date/.test(N(field.label)) && p.earliestStartDate) return p.earliestStartDate;
        if (p.noticePeriodDays) return `${p.noticePeriodDays} days`;
        return p.earliestStartDate || '';
      }
    },
    {
      id: 'salary_expectation',
      match: /(salary|compensation|ctc|pay).*(expect|desired|requirement)|expected (salary|ctc|compensation)|desired (salary|compensation)/,
      answer: (p) => p.desiredSalary
    },
    {
      id: 'current_salary',
      match: /current (salary|ctc|compensation)/,
      answer: (p) => p.currentSalary
    },

    { id: 'relocate', match: /relocat/, answer: (p) => yn(p.willingToRelocate) },
    { id: 'travel', match: /willing to travel|able to travel|travel requirement/, answer: (p) => yn(p.willingToTravel) },
    {
      id: 'work_mode',
      match: /(remote|hybrid|on[- ]?site|in[- ]?office).*(prefer|comfortable|willing|able)|work (arrangement|preference|model)|commute/,
      answer: (p) => p.workMode
    },

    { id: 'degree', match: /^(highest (level of )?(education|degree)|degree(?: (?:level|attained|name))?|education level)\b/, answer: (p) => p.degreeLevel },
    { id: 'school', match: /^(school|university|college|institution)( name)?\b|^name of (your )?(school|university|college|institution)/, answer: (p) => p.school },
    { id: 'major', match: /^(major|field of study|discipline|specialization)( name)?\b/, answer: (p) => p.major },
    { id: 'grad_year', match: /graduation (year|date)|year of (graduation|passing)/, answer: (p) => p.gradYear },

    { id: 'referral', match: /how did you (hear|find out) about|source|referred by|referral/, answer: (p) => p.referralSource },
    { id: 'previously_employed', match: /(previously|ever been) (employed|worked) (by|at|for|with) (us|this)|former employee/, answer: (p) => yn(p.previouslyEmployedHere) },
    { id: 'related_employee', match: /related to|family member|relative.*(employee|company)|know anyone who works/, answer: (p) => yn(p.relatedToEmployee) },
    { id: 'non_compete', match: /non[- ]?compete|restrictive covenant/, answer: (p) => yn(p.nonCompete) },
    { id: 'criminal', match: /convicted|criminal (record|history|conviction)|felony/, answer: (p) => yn(p.criminalRecord) },
    { id: 'background_check', match: /background (check|screening)/, answer: (p) => yn(p.backgroundCheckConsent) },
    { id: 'drug_test', match: /drug (test|screen)/, answer: (p) => yn(p.drugTestConsent) },

    { id: 'gender', match: /^gender|gender identity/, answer: (p) => p.gender },
    { id: 'hispanic', match: /hispanic|latino/, answer: (p) => p.hispanicLatino },
    { id: 'ethnicity', match: /race|ethnic/, answer: (p) => p.ethnicity },
    { id: 'veteran', match: /veteran|military service|protected veteran/, answer: (p) => p.veteranStatus },
    { id: 'disability', match: /disabilit|self[- ]?identif.*disab/, answer: (p) => p.disabilityStatus }
  ];

  RA.RULES = RULES;

  /**
   * Try to answer a field from the structured profile alone.
   * @param {object} field  { label, type, options }
   * @param {object} profile
   * @returns {{value:string, confidence:number, source:string, ruleId:string}|null}
   */
  RA.answerFromRules = function (field, profile) {
    const label = N(field.label);
    if (!label) return null;
    for (const rule of RULES) {
      if (!rule.match.test(label)) continue;
      let value;
      try {
        value = rule.answer(profile, field);
      } catch (e) {
        value = '';
      }
      if (value == null || String(value).trim() === '') return null;
      const confidence = rule.confidence ? rule.confidence(profile, field) : 0.92;
      return {
        value: String(value),
        confidence,
        source: 'profile',
        ruleId: rule.id
      };
    }
    return null;
  };

  /** Questions the model should not be asked to invent an answer for. */
  RA.isSensitive = function (label) {
    return /gender|race|ethnic|veteran|disabilit|hispanic|latino|criminal|felony|convict|social security|ssn|date of birth|salary/.test(N(label));
  };
})(typeof self !== 'undefined' ? self : this);
