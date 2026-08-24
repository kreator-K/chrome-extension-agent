/* Small, dependency-free DOCX text reader. DOCX files are ZIP containers; this
 * reads the main document plus headers/footers and converts WordprocessingML
 * paragraphs to plain text. The original file remains untouched for upload. */
(function (root) {
  const DOCX = (root.DOCXText = {});

  function findEndOfCentralDirectory(view) {
    const minimum = Math.max(0, view.byteLength - 65557);
    for (let i = view.byteLength - 22; i >= minimum; i--) {
      if (view.getUint32(i, true) === 0x06054b50) return i;
    }
    return -1;
  }

  async function inflate(bytes) {
    for (const format of ['deflate-raw', 'deflate']) {
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (e) { /* try the next wrapper */ }
    }
    throw new Error('Could not decompress the DOCX document.');
  }

  function xmlText(xml) {
    return xml
      .replace(/<w:tab\b[^>]*\/>/gi, '\t')
      .replace(/<w:(?:br|cr)\b[^>]*\/>/gi, '\n')
      .replace(/<\/w:p>/gi, '\n')
      .replace(/<\/w:tr>/gi, '\n')
      .replace(/<\/w:tc>/gi, '\t')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
      .replace(/[^\S\r\n]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  DOCX.extract = async function (buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    const eocd = findEndOfCentralDirectory(view);
    if (eocd < 0) return { text: '', ok: false };

    const entries = view.getUint16(eocd + 10, true);
    let offset = view.getUint32(eocd + 16, true);
    const decoder = new TextDecoder('utf-8');
    const documents = [];

    for (let i = 0; i < entries && offset + 46 <= view.byteLength; i++) {
      if (view.getUint32(offset, true) !== 0x02014b50) break;
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

      if (/^word\/(?:document|header\d*|footer\d*)\.xml$/i.test(name) &&
          localOffset + 30 <= view.byteLength && view.getUint32(localOffset, true) === 0x04034b50) {
        const localNameLength = view.getUint16(localOffset + 26, true);
        const localExtraLength = view.getUint16(localOffset + 28, true);
        const start = localOffset + 30 + localNameLength + localExtraLength;
        const packed = bytes.subarray(start, start + compressedSize);
        const unpacked = method === 0 ? packed : method === 8 ? await inflate(packed) : null;
        if (unpacked) documents.push({ name, xml: decoder.decode(unpacked) });
      }
      offset += 46 + nameLength + extraLength + commentLength;
    }

    documents.sort((a, b) => {
      if (/document\.xml$/i.test(a.name)) return -1;
      if (/document\.xml$/i.test(b.name)) return 1;
      return a.name.localeCompare(b.name);
    });
    const text = documents.map((item) => xmlText(item.xml)).filter(Boolean).join('\n\n').trim();
    const letters = (text.match(/[A-Za-z]/g) || []).length;
    return { text, ok: letters >= 20 };
  };
})(typeof self !== 'undefined' ? self : this);
