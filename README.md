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
   defaults. No model call, no cost, no chance of invention.
3. **Claude** — the open-ended ones ("Why this company?", "Describe a time
   you…", "What interests you about this role?"). The service worker sends the
   most relevant slices of your resume, your profile, and your previously
   approved answers, and gets structured JSON back with a confidence score and
   a note on what in the resume the answer came from.

Demographic, salary-history and criminal-record questions are never sent to the
model — they come from your profile defaults or are left for you.

## Install

1. Clone this repo.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load
   unpacked**, and pick the repo root.
3. The options page opens on first install. Fill in:
   - **Knowledge base** — upload a `.txt`/`.md`/`.pdf` resume or paste text.
     Put more in than the one-pager: project detail, metrics, stories, phrasing
     you like. This is what the model draws on.
   - **Profile** — the mechanical fields, plus your skills with years.
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
| `AI · 84%` | Written by Claude, with its confidence |
| `left to you` | Sensitive question, deliberately unanswered |

Per question you can **Fill** it, **Show field** (scrolls to and highlights it),
or **Save answer** to add it to the bank for next time. **Fill all** writes
every non-empty answer at once.

Nothing is submitted for you. The extension fills fields; you read and click
Submit.

## Privacy

- Resume text, profile, answer bank and API key live in `chrome.storage.local`
  in your browser profile. Nothing syncs anywhere.
- The only network destination is `api.anthropic.com`, and only when you press
  **Answer remaining with AI**. Tiers 1 and 2 are fully offline.
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
src/content/content.js   in-page orchestration and the review panel
src/background/          Anthropic API calls; the only place the key is used
src/options/             knowledge base, profile, settings, answer bank, PDF text
src/popup/               status and manual trigger
```

## Tests

```
npm test            # all three
npm run test:logic  # rules, matching and retrieval, in Node
npm run test:dom    # scan + fill against a fixture form in real Chromium
npm run test:load   # loads the unpacked extension and pokes the service worker
```

The DOM and load tests use Playwright's Chromium. If Playwright is installed
globally rather than in the project, run them with
`NODE_PATH=$(npm root -g) node test/dom.test.js`.

## Known limits

- Custom `div[role="combobox"]` widgets (some Workday and LinkedIn typeaheads)
  are detected only when they expose a real `<input>`; otherwise the answer is
  shown in the panel for you to copy.
- Multi-step forms need a rescan after each step — press **Rescan**.
- Label detection falls back through `aria-labelledby` → `label[for]` →
  wrapping `<label>` → `aria-label` → nearest ancestor text → placeholder →
  field name. Odd markup can still produce a poor label; edit the answer in the
  panel before filling.
