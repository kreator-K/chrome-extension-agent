/* Internal regression using caller-supplied, non-committed resume files.
 * Usage: node test/internal_files.test.mjs /path/to/kb.txt /path/to/resume.pdf */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { extractPdfText } from '../src/options/pdf_core.mjs';

const [knowledgeBasePath, resumePath] = process.argv.slice(2);
if (!knowledgeBasePath || !resumePath) {
  throw new Error('Pass the knowledge-base TXT path and application-resume PDF path.');
}

const knowledgeBase = fs.readFileSync(knowledgeBasePath, 'utf8');
const resumeBytes = fs.readFileSync(resumePath);
const pdf = await extractPdfText(new Uint8Array(resumeBytes));

assert.equal(pdf.ok, true, `PDF extraction failed: ${pdf.error || 'unknown error'}`);
assert.ok(pdf.text.length > 1000, 'resume PDF produced too little text');
assert.ok(!/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(pdf.text), 'resume PDF produced binary control characters');

const context = {};
vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL('../src/lib/profile_parser.js', import.meta.url), 'utf8'), context);
const extracted = context.RA.extractProfile(`${knowledgeBase}\n\n${pdf.text}`);

const expected = {
  firstName: 'PRASHANT',
  lastName: 'KUMAR',
  email: 'pk627@cornell.edu',
  phone: '(646) 276-3647',
  city: 'New York',
  state: 'NY',
  country: 'USA',
  degreeLevel: "Master's",
  major: 'Business Administration',
  gradYear: '2027',
  currentCompany: 'Hotelzify Pvt Ltd',
  currentTitle: 'Head of Product'
};

for (const [field, value] of Object.entries(expected)) {
  assert.equal(extracted[field], value, `${field} should merge from the exact KB/PDF pair`);
}

const skills = new Set((extracted.skills || []).map((skill) => skill.name));
for (const skill of ['Product Strategy', 'User Research', 'A/B Testing', 'Python', 'SQL', 'RAG', 'LLM Agents']) {
  assert.ok(skills.has(skill), `expected extracted skill: ${skill}`);
}
assert.ok(!skills.has('WhatsApp'), 'WhatsApp must not be classified as a skill');
assert.ok(!skills.has('Telegram'), 'Telegram must not be classified as a skill');

console.log(JSON.stringify({
  knowledgeBaseChars: knowledgeBase.length,
  resumeTextChars: pdf.text.length,
  extractedFields: expected,
  skillCount: skills.size
}, null, 2));
console.log('\nExact-file internal extraction and merge regression passed');
