/* Reliable PDF text extraction backed by Mozilla PDF.js.
 *
 * Raw PDF text operators contain font-specific character codes, not necessarily
 * Unicode. PDF.js resolves the document's font maps before returning text.
 */
import * as pdfjs from '../../vendor/pdfjs/pdf.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('../../vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;

function pageText(items) {
  let out = '';
  for (const item of items || []) {
    if (!item || typeof item.str !== 'string') continue;
    out += item.str;
    if (item.hasEOL) out += '\n';
    else if (item.str && !/\s$/.test(item.str)) out += ' ';
  }
  return out.trim();
}

function cleanText(text) {
  return String(text || '')
    .replace(/\u0000/g, '')
    .replace(/[^\S\r\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function looksLikeText(text) {
  if (!text) return false;
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  const controls = (text.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g) || []).length;
  return letters >= 20 && letters / text.length > 0.35 && controls / text.length < 0.01;
}

/**
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Promise<{text:string, ok:boolean, error?:string}>}
 */
export async function extractPdfText(buffer) {
  let task;
  try {
    const source = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    // PDF.js may transfer the backing buffer. Keep the caller's bytes intact so
    // the original file can still be saved and attached to an application.
    task = pdfjs.getDocument({ data: source.slice(), useSystemFonts: true, isEvalSupported: false });
    const document = await task.promise;
    const pages = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      pages.push(pageText(content.items));
      page.cleanup();
    }
    const text = cleanText(pages.filter(Boolean).join('\n\n'));
    return looksLikeText(text)
      ? { text, ok: true }
      : { text, ok: false, error: 'The PDF contained no reliable readable text.' };
  } catch (error) {
    return { text: '', ok: false, error: error && error.message ? error.message : String(error) };
  } finally {
    if (task) await task.destroy().catch(() => {});
  }
}
