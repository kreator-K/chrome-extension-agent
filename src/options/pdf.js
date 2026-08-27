/* Thin classic-script bridge for the module-based PDF.js extractor. */
(function (root) {
  const PDF = (root.PDFText = {});
  const moduleUrl = new URL('pdf_core.mjs', document.currentScript.src).href;
  let extractorPromise;

  function loadExtractor() {
    if (!extractorPromise) {
      extractorPromise = import(moduleUrl).then((module) => module.extractPdfText);
    }
    return extractorPromise;
  }

  PDF.extract = async function (buffer) {
    try {
      const extract = await loadExtractor();
      return await extract(buffer);
    } catch (error) {
      return { text: '', ok: false, error: error && error.message ? error.message : String(error) };
    }
  };
})(typeof self !== 'undefined' ? self : this);
