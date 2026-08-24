/* Prompt construction is kept in a small, pure module so the grounding and
 * answer-style rules can be regression-tested without a browser or API call. */
(function (root) {
  const RA = (root.RA = root.RA || {});

  function profileSummary(p) {
    p = p || {};
    const lines = [];
    const push = (k, v) => { if (v !== '' && v != null) lines.push(`${k}: ${v}`); };
    push('Name', [p.firstName, p.lastName].filter(Boolean).join(' '));
    push('Email', p.email);
    push('Phone', p.phone);
    push('Location', [p.city, p.state, p.country].filter(Boolean).join(', '));
    push('LinkedIn', p.linkedin);
    push('GitHub', p.github);
    push('Portfolio', p.portfolio);
    push('Current role', [p.currentTitle, p.currentCompany].filter(Boolean).join(' at '));
    push('Total years of experience', p.totalYearsExperience);
    push('Education', [p.degreeLevel, p.major, p.school, p.gradYear].filter(Boolean).join(', '));
    push('Work authorized', p.workAuthorized);
    push('Requires sponsorship', p.requiresSponsorship);
    push('Work authorization detail', p.workAuthDetail);
    push('Willing to relocate', p.willingToRelocate);
    push('Preferred work mode', p.workMode);
    push('Notice period (days)', p.noticePeriodDays);
    push('Earliest start date', p.earliestStartDate);
    push('Desired compensation', p.desiredSalary);
    if ((p.skills || []).length) {
      push('Skills with years', p.skills.map((s) => `${s.name} (${s.years}y)`).join(', '));
    }
    return lines.join('\n');
  }

  RA.profileSummary = profileSummary;

  RA.buildAnswerSystemPrompt = function (settings, profile, resumeExcerpt, priorAnswers) {
    settings = settings || {};
    return [
      'You fill in job application forms on behalf of one candidate.',
      'You are given the candidate\'s resume knowledge base, a structured profile, and a list of questions taken from an application form.',
      '',
      'Evidence and safety rules:',
      '- Answer only from the resume, the profile, the job description, and previously approved answers. Never invent employers, titles, dates, degrees, certifications, skills, metrics, or company facts.',
      '- If the supplied evidence does not support an answer, return an empty string for `answer` and confidence 0 rather than guessing.',
      '- Do not infer demographic, salary-history, disability, medical, or criminal-record answers. Return an empty string for those.',
      '- Match the requested format exactly: number-only questions get a bare number, yes/no questions get "Yes" or "No", and multiple-choice questions get one offered option verbatim.',
      '- Respect every stated character limit. When no limit is stated, prefer the shortest complete answer.',
      '',
      'Answer-style rules:',
      `- Use a ${settings.tone || 'professional and direct'} tone. Write in first person for prose answers. Do not add greetings, sign-offs, headings, or "As an AI".`,
      '- Experience or skill questions: lead with the honest years/level, then give one specific supporting project or role. Say when experience is adjacent rather than direct.',
      '- "Why this company/role" questions: name one specific priority visible in the supplied job description, connect it to supported candidate experience, and stay under 150 words. Do not invent outside company research.',
      '- Behavioral questions: use a compact situation-action-result flow without STAR labels; state what the candidate personally did and end with a supported result. Stay under 250 words.',
      '- "Tell us about yourself" questions: current role, relevant prior evidence, then why this role; stay between 100 and 200 words unless the field limit is shorter.',
      '- Opinion questions: give a clear view grounded in the candidate\'s demonstrated experience; do not manufacture a personal belief.',
      '- Avoid generic trait claims, keyword stuffing, repeating the job description, and cover-letter-length responses.',
      '- Set confidence from the strength of the cited evidence, not from how polished the answer sounds. In `basis`, identify the resume/profile/prior-answer evidence used.',
      '',
      '=== CANDIDATE PROFILE ===',
      profileSummary(profile),
      '',
      '=== RESUME KNOWLEDGE BASE ===',
      resumeExcerpt || '(empty — return empty answers)',
      priorAnswers ? '\n=== PREVIOUSLY APPROVED ANSWERS (reuse the candidate\'s own wording where relevant) ===\n' + priorAnswers : ''
    ].join('\n');
  };

  RA.buildQuestionBlock = function (questions) {
    return (questions || [])
      .map((q) => {
        const parts = [`id: ${q.id}`, `question: ${q.label}`, `field type: ${q.kind}`];
        if (q.options && q.options.length) {
          parts.push('allowed options: ' + q.options.map((o) => o.label).join(' | '));
        }
        if (q.maxLength) parts.push(`max characters: ${q.maxLength}`);
        if (q.required) parts.push('required: yes');
        return parts.join('\n');
      })
      .join('\n---\n');
  };
})(typeof self !== 'undefined' ? self : this);
