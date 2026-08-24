/* Minimal PDF text extraction — enough to turn a normal text-based resume PDF
 * into a knowledge base without shipping a parser library. Scanned/image PDFs
 * and exotic font encodings will not extract cleanly; the caller checks the
 * result and asks the user to paste text instead. */
(function (root) {
  const PDF = (root.PDFText = {});

  function latin1(bytes) {
    let out = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return out;
  }

  async function inflate(bytes) {
    for (const format of ['deflate', 'deflate-raw']) {
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
        const buf = await new Response(stream).arrayBuffer();
        return new Uint8Array(buf);
      } catch (e) { /* try the next format */ }
    }
    return null;
  }

  function decodeString(raw) {
    let out = '';
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (c !== '\\') { out += c; continue; }
      const n = raw[++i];
      if (n === 'n') out += '\n';
      else if (n === 'r') out += '\n';
      else if (n === 't') out += '\t';
      else if (n === 'b' || n === 'f') out += ' ';
      else if (n >= '0' && n <= '7') {
        let oct = n;
        while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
        out += String.fromCharCode(parseInt(oct, 8));
      } else out += n;
    }
    return out;
  }

  /** Pull text operators out of one decoded content stream. */
  function textFromContent(content) {
    let out = '';
    const re = /\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|\bTJ\b|\bTj\b|\b'|\bT\*|\bTD\b|\bTd\b|\bET\b/g;
    let m;
    let pending = '';
    while ((m = re.exec(content)) !== null) {
      const tok = m[0];
      if (tok[0] === '(') {
        pending += decodeString(tok.slice(1, -1));
      } else if (tok[0] === '<') {
        const hex = tok.slice(1, -1).replace(/\s+/g, '');
        for (let i = 0; i + 1 < hex.length; i += 2) {
          const code = parseInt(hex.substr(i, 2), 16);
          if (code >= 32 || code === 10) pending += String.fromCharCode(code);
        }
      } else if (tok === 'TJ' || tok === 'Tj' || tok === "'") {
        out += pending;
        pending = '';
      } else {
        out += pending + '\n';
        pending = '';
      }
    }
    return out + pending;
  }

  function looksLikeText(s) {
    if (!s) return false;
    const letters = (s.match(/[A-Za-z]/g) || []).length;
    return letters > 200 && letters / s.length > 0.4;
  }

  /**
   * @param {ArrayBuffer} buffer
   * @returns {Promise<{text:string, ok:boolean}>}
   */
  PDF.extract = async function (buffer) {
    const bytes = new Uint8Array(buffer);
    const raw = latin1(bytes);
    const pieces = [];
    const streamRe = /stream\r?\n?/g;
    let m;
    while ((m = streamRe.exec(raw)) !== null) {
      const start = m.index + m[0].length;
      const end = raw.indexOf('endstream', start);
      if (end < 0) break;
      streamRe.lastIndex = end;

      const dict = raw.slice(Math.max(0, m.index - 600), m.index);
      if (/\/Image|\/DCTDecode|\/JPXDecode/.test(dict)) continue;

      let data = bytes.subarray(start, end);
      if (/\/FlateDecode/.test(dict)) {
        const inflated = await inflate(data);
        if (!inflated) continue;
        data = inflated;
      }
      const content = latin1(data);
      if (!/(TJ|Tj)/.test(content)) continue;
      pieces.push(textFromContent(content));
    }

    const text = pieces
      .join('\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/ *\n */g, '\n')
      .trim();

    return { text, ok: looksLikeText(text) };
  };
})(typeof self !== 'undefined' ? self : this);
