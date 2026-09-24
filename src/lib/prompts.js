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
      push('Skills', p.skills.map((s) =>
        s.years === '' || s.years == null ? s.name : `${s.name} (${s.years}y)`
      ).join(', '));
    }
    return lines.join('\n');
  }

  RA.profileSummary = profileSummary;

  RA.claudeRequestConfig = function (settings, maxTokens, schema) {
    settings = settings || {};
    const model = settings.model || 'claude-opus-5';
    const supportsAdaptiveThinking = !/haiku/i.test(model);
    const outputConfig = {
      format: { type: 'json_schema', schema }
    };
    if (supportsAdaptiveThinking) outputConfig.effort = settings.effort || 'medium';
    const config = {
      model,
      max_tokens: maxTokens,
      output_config: outputConfig
    };
    if (supportsAdaptiveThinking) config.thinking = { type: 'adaptive' };
    return config;
  };

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

  RA.buildNetworkingPrompt = function (settings, profile, evidence, context, intent, angle) {
    settings = settings || {};
    context = context || {};
    const custom = intent === 'Custom' ? (context.customIntent || '') : '';
    return [
      'You write one personalized networking message for the candidate.',
      'Use only the supplied candidate evidence and visible recipient/page context. Never invent a recipient fact, relationship, shared connection, employer, role, school, project, achievement, conversation history, or user experience.',
      'The intent describes what the user wants to accomplish. The angle describes how the user wants to approach the recipient. Both are material: shape the purpose, structure, tone, and call to action around them.',
      'Use the strongest truthful connection between THEM, ME, and the intent. Do not force personalization when no meaningful connection is present.',
      'Avoid generic lines such as "I came across your impressive profile" or "pick your brain" unless the supplied context makes them genuinely appropriate.',
      'Keep the message concise, specific, natural, and editable. Do not add a subject line, greeting, sign-off, or meta-commentary unless the context calls for it.',
      `Use a ${settings.tone || 'professional and direct'} tone.`,
      'Use intent-specific priorities: Referral emphasizes role/company/shared background and a low-pressure ask; Potential Cofounder emphasizes genuine skill complement, specific work, or exploring fit; Guidance emphasizes why this person and one focused topic; Resume Review emphasizes the recipient\'s relevance and a small review ask; Custom follows the user instruction first.',
      'For Referral, do not ask directly for a referral when the angle is Learn First, Referral Second. For Potential Cofounder, do not disclose unnecessary project details when the angle is Explore Fit First.',
      '', `=== NETWORKING INTENT ===\n${intent || 'Custom'}\n=== NETWORKING ANGLE ===\n${angle || 'Custom'}${custom ? `\n=== CUSTOM INSTRUCTION ===\n${custom}` : ''}`,
      '', '=== RECIPIENT AND PAGE CONTEXT ===', JSON.stringify(context),
      '', '=== RELEVANT CANDIDATE EVIDENCE ===', evidence || '(empty — do not make personal claims)'
    ].join('\n');
  };
})(typeof self !== 'undefined' ? self : this);
