# Resume Autofill — job application assistant

A Chrome extension (Manifest V3) that reads the questions on a job application
page, answers them from your resume knowledge base, and lets you review every
answer before anything is written into the form.

Built for LinkedIn Easy Apply and the ATS portals behind most "Apply" buttons —
Greenhouse, Lever, Ashby, Workday, Workable, SmartRecruiters, iCIMS, Jobvite,
BambooHR, Breezy, Recruitee, Teamtailor, Taleo and SuccessFactors — plus any
other page, via the toolbar popup.

## How it answers

Three tiers, cheapest first. A question only falls through to the next tier if
the one above it has nothing:

1. **Answer bank** — anything you have saved before. Reused verbatim when the
   same question comes back, matched fuzzily so wording changes don't break it.
2. **Profile rules** — ~45 deterministic rules over a structured profile: name,
   contact, links, work authorization, sponsorship, years of experience per
   skill, notice period, salary expectation, relocation, education, EEO
   defaults. The extension extracts unambiguous fields from the resume and
   knowledge base locally, then leaves the profile visible for review. No model
   call, no cost, no chance of invention.
3. **Claude** — the open-ended ones ("Why this company?", "Describe a time
   you…", "What interests you about this role?"). The service worker sends the
   most relevant slices of your resume, your profile, and your previously
   approved answers, and gets structured JSON back with a confidence score and
   a note on what in the resume the answer came from.

Demographic, salary-history and criminal-record questions are never sent to the
model — they come from your profile defaults or are left for you.

## Resume match score

The panel also scores your resume against the job description on the page —
fully offline, no API key or network call needed:

- **Score (0–100)** — 70% keyword coverage, 15% title match, 15% experience-years match.
- **Matched keywords** — what your resume already has, pulled from a skills/tools
  dictionary plus role-specific phrases lifted from the posting itself
  ("payments platform", "distributed systems").
- **Recommended keywords to add** — what's missing, ranked by importance. Ones
  the posting calls out under "Requirements" or "Qualifications" are marked in
  red — an ATS keyword-matcher weights those far more than the rest of the text.
- **Explain gaps with AI** (optional, needs your API key) — for each missing
  keyword, Claude checks whether your resume already demonstrates it under
  different wording and tells you exactly how to reword an existing bullet to
  surface it — or says plainly that it's a genuine gap. It will not suggest
  adding a skill your resume doesn't support; keyword-stuffing a skills list
  with things you haven't done just gets you screened out at the interview
  instead of the ATS.

If the page's job description isn't auto-detected, paste it into the panel and
press **Score against this**.

## Install

1. Clone this repo.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked**, and pick the repo root.
3. The options page opens on first install. Fill in:
   - **Knowledge base** — upload a `.txt`/`.md`/`.pdf` resume or paste text.
     Put more in than the one-pager: project detail, metrics, stories, phrasing
     you like. This is what the model draws on.
   - **Application resume** — upload the actual `.pdf`, `.doc`, or `.docx` file
     to attach to résumé/CV fields. This is separate from the knowledge base.
   - **Profile** — review the mechanical fields extracted from the resume and
     knowledge base. Existing edits are never overwritten; use **Fill from
     resume & knowledge base** to rescan on demand.
   - **API key** — an [Anthropic API key](https://console.anthropic.com/).
     Press **Test key** to check it.

PDF extraction is built in and handles normal text-based PDFs. Scanned or
image-only PDFs will not extract; the page tells you and you paste instead.

## Using it

On an application page, click the **Resume Autofill** launcher (bottom right)
or the toolbar icon → **Scan this page**. A panel opens listing every question
found, with the proposed answer and where it came from:

| Badge | Meaning |
|---|---|
| `saved answer` | Reused from your answer bank |
| `profile` | Derived from a profile field |
| `application resume` | The locally saved résumé file is ready to attach |
| `AI · 84%` | Written by Claude, with its confidence |
| `left to you` | Sensitive question, deliberately unanswered |

Per question you can **Fill** it, **Attach resume**, **Show field** (scrolls to
and highlights it), or **Save answer** to add it to the bank for next time.
**Fill all** writes every non-empty answer and attaches the saved resume.

Nothing is submitted for you. The extension fills fields; you read and click
Submit.

## Privacy

- Resume text, the original application-resume file, profile, answer bank and
  API key live in `chrome.storage.local` in your browser profile. Nothing syncs
  anywhere.
- The original application-resume file is never sent to Anthropic. Only
  relevant text from the knowledge base is included in an AI request.
- The only network destination is `api.anthropic.com`, and only when you press
  **Answer remaining with AI** or **Explain gaps with AI**. Tiers 1 and 2 of
  answering, and the base resume match score, are fully offline.
- The API key stays in the service worker; content scripts never see it.
- **Export everything (JSON)** omits the API key by design.

## Cost

One AI call per page covers all remaining questions in a single request. Most
application pages are a few cents on Opus 5; switch to Sonnet 5 or Haiku 4.5 in
settings if you are applying at volume.

## Layout

```
manifest.json
src/lib/util.js          storage, text normalisation, fuzzy match, retrieval
src/lib/rules.js         deterministic profile-driven answers
src/lib/fields.js        form scanning, label extraction, framework-safe filling
src/lib/keywords.js      offline resume/JD match scoring and keyword extraction
src/lib/prompts.js       grounded, question-aware AI prompt construction
src/lib/profile_parser.js conservative offline profile extraction
src/content/content.js   in-page orchestration and the review panel
src/background/          Anthropic API calls; the only place the key is used
src/options/             knowledge base, profile, settings, answer bank, PDF text, ATS checklist
src/popup/               status and manual trigger
```

## Tests

```
npm install
npx playwright install chromium
npm test              # all five
npm run test:logic    # rules, matching and retrieval, in Node
npm run test:keywords # ATS/match scoring against fixture job descriptions, in Node
npm run test:dom      # scan + fill against a fixture form in real Chromium
npm run test:panel    # match-score panel rendering against a fixture JD page
npm run test:workflow # fresh profile: upload, extract, scan, fill and attach
npm run test:load     # loads the unpacked extension and pokes the service worker
```

The DOM, panel and load tests use Playwright's Chromium. Playwright is a local
development dependency; its browser runtime is installed separately by the
second command above.

## Known limits

- Custom `div[role="combobox"]` widgets (some Workday and LinkedIn typeaheads)
  are detected only when they expose a real `<input>`; otherwise the answer is
  shown in the panel for you to copy.
- Multi-step forms need a rescan after each step — press **Rescan**.
- Label detection falls back through `aria-labelledby` → `label[for]` →
  wrapping `<label>` → `aria-label` → nearest ancestor text → placeholder →
  field name. Odd markup can still produce a poor label; edit the answer in the
  panel before filling.
- Résumé/CV `<input type="file">` controls are supported. Custom drag-and-drop
  upload widgets without a real file input remain manual; unrelated cover
  letter and work-sample uploads are deliberately ignored.
- The match score is a keyword-overlap heuristic, the same approach real ATS
  keyword-matchers use — not a guarantee of how any specific ATS will score
  you. Treat it as a checklist, not a verdict.
- The dictionary of skills/tools in `src/lib/keywords.js` is deliberately
  broad but not exhaustive; role-specific multi-word phrases outside it are
  still picked up from the posting's own text, just with less precision than a
  dictionary hit.
