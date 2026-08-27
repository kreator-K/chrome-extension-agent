# Resume Autofill internal QA and 5-Why RCA

Date: 2026-08-27  
Build under test: 0.3.10  
Fixed build: 0.3.11  
Scope: extension internals only; job-portal validation is deferred to the next phase.

## Test inputs

- Knowledge base: `Resume_Knowledge_Base_v2.txt` (39,877 characters)
- Application resume: `Prashant_Kumar_PM.pdf` (113 KB)
- Input files were read from the user-specified local folder and were not copied into git.

## Executive result

Build 0.3.10 failed the supplied-PDF extraction test. Its custom PDF reader produced 8,994 characters of mostly binary/font-encoded data, returned `ok: false`, and exposed only the degree level to the profile parser. Storage APIs also reported success without checking `chrome.runtime.lastError`, and fresh profiles contained assumed legal and sensitive answers that were not present in either source.

Build 0.3.11 replaces raw stream scanning with a vendored, patched Mozilla PDF.js parser, propagates storage failures, removes invented defaults, migrates untouched legacy templates, and adds an exact-file regression test.

## Severity-ranked findings

### QA-001 — PDF text is unreadable for the supplied resume (Critical)

Observed before fix:

- Extractor result: `ok: false`
- Extracted length: 8,994 characters
- Output contained binary control characters and encoded font bytes.
- Structured result from the PDF alone contained only `degreeLevel: Master's`.

Observed after fix:

- Extractor result: `ok: true`
- Clean extracted length: 4,339 characters
- No binary control characters
- The combined KB/PDF result includes name, email, phone, New York/NY/USA, education, May 2027 graduation, current role, current company, and 30 skills.

### QA-002 — Storage writes can fail silently (High)

`RA.storage.set` and `RA.storage.get` ignored `chrome.runtime.lastError`. A quota, invalidated-context, or other Chrome storage failure could therefore be presented as a successful upload while no application resume was persisted.

### QA-003 — Fresh profiles invent legal and sensitive answers (Critical)

The default profile asserted work authorization, no sponsorship requirement, relocation/travel willingness, criminal-history answers, consent answers, and EEO responses without source evidence or user review. These values could be used as deterministic job-application answers.

### QA-004 — Failed extraction lacks actionable diagnostics (Medium)

The UI reduced extractor failures to a generic “no readable text” message. It now preserves the original file for attachment while showing the extraction error separately.

## Five-Why root-cause analysis

Problem statement: fields present in the supplied resume and knowledge base remained blank after upload and rescan.

1. Why were the fields blank?  
   The application-resume record contributed no reliable text to the profile merge.

2. Why did the PDF contribute no reliable text?  
   The custom extractor read bytes from PDF `Tj`/`TJ` content operators directly and treated them as Unicode.

3. Why was that interpretation wrong?  
   Production PDFs frequently store font-specific character codes and subset fonts. Their ToUnicode/font maps must be resolved before text is meaningful.

4. Why was this not caught earlier?  
   Tests covered synthetic content and DOCX workflows, but not a representative PDF using embedded/subset fonts or the user’s exact KB/PDF pair.

5. Why did the issue persist and appear inconsistent?  
   The UI could claim a successful save even when Chrome storage failed, and prefilled profile defaults masked which answers truly came from extraction. The pipeline lacked source-level diagnostics and negative storage tests.

Root cause: an intentionally minimal PDF decoder was used beyond its safe capability, while the persistence layer and test strategy lacked failure propagation and representative PDF coverage.

## Engineering corrections

- Replaced the raw PDF stream parser with Mozilla PDF.js 6.2.108.
- Vendored the browser runtime and worker so the unpacked extension is self-contained.
- Used the security-patched PDF.js release; dependency audit reported zero vulnerabilities after upgrade.
- Added `pdf_core.mjs` so the production extractor can be tested directly.
- Added exact-file regression coverage without committing the private resume files.
- Added storage success/failure tests and rejection on `chrome.runtime.lastError`.
- Changed all ungrounded yes/no, work-mode, consent, legal, and EEO defaults to blank.
- Added a blank “Select…” state to profile dropdowns.
- Added a conservative one-time migration that clears the old assumed template only when every legacy default still matches; reviewed profiles are preserved.
- Improved upload and extraction status messages.

## Regression evidence

Passed:

- Logic/rules tests
- Prompt grounding tests
- Profile extraction and non-destructive merge tests
- Storage success and failure propagation tests
- Anthropic answer and gap-analysis compatibility tests
- Keyword/ATS scoring tests
- Exact supplied-file extraction and merged-profile assertions
- JavaScript/module syntax and `git diff --check`

Exact supplied-file assertions:

- `PRASHANT KUMAR`
- `pk627@cornell.edu`
- `(646) 276-3647`
- `New York`, `NY`, `USA`
- `Master's`, `Business Administration`, `2027`
- `Hotelzify Pvt Ltd`, `Head of Product`
- 30 skills; WhatsApp and Telegram excluded

## Remaining validation gate

Chrome’s automation security policy blocks control of `chrome-extension://` pages, so the live Options-page file pickers could not be operated programmatically. The production parsing, merge, migration, and persistence primitives were exercised locally with the exact files. After build 0.3.11 is reloaded, one manual Options-page upload is required to validate the browser UI wiring. Portal testing must begin only after that gate passes.
