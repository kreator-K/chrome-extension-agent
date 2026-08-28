# Phase 2 portal QA — 2026-08-28

## Scope

Read-only production scans on Greenhouse and Ashby, plus full write-path regressions in isolated Chromium. No live application was submitted and no production form was modified during this pass.

Sources used for extraction regression:

- `Resume_Knowledge_Base_v2.txt`
- `Prashant_Kumar_PM.pdf`

## Results

| Area | Result |
| --- | --- |
| Exact KB + PDF extraction | Pass: 12 expected profile facts and 30 skills |
| Greenhouse launcher and scan | Pass: 26 questions detected |
| Greenhouse deterministic answers | Pass: 12 answers, including New York and Master's |
| Ashby launcher without a `<form>` | Pass after fix |
| Ashby scan | Pass: 11 questions detected |
| Ashby custom Yes/No controls | Pass after fix; sponsorship resolves to No |
| Per-question prose generation affordance | Pass on both portals |
| Resume attachment implementation | Pass in isolated Chromium |
| Fill-all implementation | Pass in isolated Chromium; preserves existing values |
| Submission | Not attempted by design |

## Root causes and fixes

### Why were known Greenhouse fields blank?

1. `Degree` did not match because the rule required a word after “degree”.
2. `Location (City)` did not match the narrower city/location patterns.
3. Older stored profiles could remain partially blank even after source-parsing improvements.
4. Portal scans only read the stored profile, not a fresh conservative merge of both sources.
5. AI answer generation also retrieved evidence from only the knowledge base.

Fix: broaden the exact mechanical mappings, conservatively re-derive blank facts from both stored documents at scan time, and retrieve AI evidence from the combined KB and application-resume text.

### Why did Ashby not show or scan completely?

1. The launcher counted only controls nested in a semantic `<form>`.
2. Ashby renders its application as SPA-controlled inputs without a `<form>`.
3. Its Yes/No fields use visible buttons backed by a zero-size checkbox.
4. The scanner correctly ignored invisible inputs but had no adapter for the visible button group.
5. Therefore the launcher was absent and two required questions were omitted.

Fix: detect visible application controls page-wide on allow-listed job portals and add a button-group scanner/filler that selects real offered options.

## Remaining live-write gate

The next test is a non-submitting production fill on a disposable application page. It will write personal contact details and attach the resume to the selected employer's ATS, so it requires an explicit action-time confirmation before execution.
