/* Dependency-free DOCX writer for generated career documents. The resume
 * layout mirrors the uploaded one-page source: US Letter, compact Calibri,
 * centered section headings, right-aligned dates/locations, and real bullets. */
(function (root) {
  const RA = (root.RA = root.RA || {});
  const enc = new TextEncoder();

  function xml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
    }[c]));
  }

  function crc32(bytes) {
    let crc = -1;
    for (const byte of bytes) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ -1) >>> 0;
  }

  function u16(value) { return [value & 255, (value >>> 8) & 255]; }
  function u32(value) { return [...u16(value & 65535), ...u16((value >>> 16) & 65535)]; }

  function storedZip(files) {
    const local = [];
    const central = [];
    let offset = 0;
    for (const file of files) {
      const name = enc.encode(file.name);
      const data = typeof file.data === 'string' ? enc.encode(file.data) : file.data;
      const crc = crc32(data);
      const header = new Uint8Array([
        ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)
      ]);
      local.push(header, name, data);
      const c = new Uint8Array([
        ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
        ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0),
        ...u16(0), ...u16(0), ...u32(0), ...u32(offset)
      ]);
      central.push(c, name);
      offset += header.length + name.length + data.length;
    }
    const centralSize = central.reduce((n, part) => n + part.length, 0);
    const end = new Uint8Array([
      ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
      ...u32(centralSize), ...u32(offset), ...u16(0)
    ]);
    const parts = [...local, ...central, end];
    const total = parts.reduce((n, part) => n + part.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) { out.set(part, at); at += part.length; }
    return out;
  }

  const run = (text, props) => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
  const para = (content, props) => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${content}</w:p>`;
  const textPara = (text, props, runProps) => para(run(text, runProps), props);
  const center = '<w:jc w:val="center"/>';
  const tight = '<w:spacing w:before="0" w:after="0" w:line="222" w:lineRule="auto"/>';
  const keep = '<w:keepNext/><w:keepLines/>';
  const rightTab = '<w:tabs><w:tab w:val="right" w:pos="9300"/></w:tabs>';
  const bold = '<w:b/>';
  const italic = '<w:i/>';

  function heading(text) {
    return textPara(String(text || '').toUpperCase(), `${keep}${center}<w:spacing w:before="80" w:after="20"/>`, `${bold}<w:sz w:val="24"/>`);
  }

  function twoColumn(left, right, leftProps, rightProps) {
    const rightRunProps = rightProps == null ? bold : rightProps;
    const rightRun = `<w:r>${rightRunProps ? `<w:rPr>${rightRunProps}</w:rPr>` : ''}<w:tab/><w:t>${xml(right || '')}</w:t></w:r>`;
    return para(
      run(left || '', leftProps == null ? bold : leftProps) + rightRun,
      `${keep}${rightTab}${tight}`
    );
  }

  function bullet(text) {
    return textPara(text, `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>${tight}<w:ind w:left="240" w:hanging="180"/>`, '');
  }

  function hyperlinks(profile) {
    const links = [];
    const rels = [];
    let id = 10;
    for (const [label, url] of [['LinkedIn', profile.linkedin], ['GitHub', profile.github]]) {
      if (!url) continue;
      const relId = `rId${id++}`;
      rels.push(`<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xml(url)}" TargetMode="External"/>`);
      links.push(`<w:hyperlink r:id="${relId}">${run(label, '<w:color w:val="0563C1"/><w:u w:val="single"/>')}</w:hyperlink>`);
    }
    return { links, rels };
  }

  function baseFiles(documentXml, extraRels) {
    const now = new Date().toISOString();
    const relationships = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;
    const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${(extraRels || []).join('')}</Relationships>`;
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>${tight}</w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style></w:styles>`;
    const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="240"/></w:tabs><w:ind w:left="240" w:hanging="180"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
    return [
      { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>` },
      { name: '_rels/.rels', data: relationships },
      { name: 'word/document.xml', data: documentXml },
      { name: 'word/_rels/document.xml.rels', data: docRels },
      { name: 'word/styles.xml', data: styles },
      { name: 'word/numbering.xml', data: numbering },
      { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>Tailored Resume</dc:title><dc:creator>Resume Autofill</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>` },
      { name: 'docProps/app.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Resume Autofill</Application></Properties>' }
    ];
  }

  RA.resumeDraftText = function (draft) {
    const lines = [];
    for (const entry of draft.education || []) lines.push(entry.school, entry.degree, ...(entry.bullets || []));
    for (const skill of draft.skills || []) lines.push(`${skill.label}: ${skill.text}`);
    for (const job of draft.experience || []) lines.push(job.company, job.title, job.summary, ...(job.bullets || []));
    for (const project of draft.projects || []) lines.push(project.name, project.description);
    lines.push(...(draft.additional || []));
    return lines.filter(Boolean).join('\n');
  };

  RA.buildResumeDocx = function (draft, profile) {
    profile = profile || {};
    const { links, rels } = hyperlinks(profile);
    const body = [];
    body.push(textPara([profile.firstName, profile.lastName].filter(Boolean).join(' ').toUpperCase(), `${center}<w:spacing w:after="20"/>`, `${bold}<w:sz w:val="32"/>`));
    const contactParts = [[profile.city, profile.state].filter(Boolean).join(', '), profile.phone, profile.email].filter(Boolean);
    let contactRuns = run(contactParts.join(' | '));
    for (const link of links) contactRuns += run(' | ') + link;
    body.push(para(contactRuns, `${center}<w:spacing w:after="30"/>`));
    if ((draft.education || []).length) {
      body.push(heading('Education'));
      for (const item of draft.education) {
        body.push(twoColumn(item.school, item.location));
        body.push(twoColumn(item.degree, item.date, '', bold));
        for (const value of item.bullets || []) body.push(bullet(value));
      }
    }
    if ((draft.skills || []).length) {
      body.push(heading('Technical Proficiency'));
      for (const item of draft.skills) body.push(para(run(`${item.label}: `, bold) + run(item.text), tight));
    }
    if ((draft.experience || []).length) {
      body.push(heading('Professional Experience'));
      for (const item of draft.experience) {
        body.push(twoColumn(item.company, item.location));
        body.push(twoColumn(item.title, item.date));
        if (item.summary) body.push(textPara(item.summary, `${keep}${tight}`, italic));
        for (const value of item.bullets || []) body.push(bullet(value));
      }
    }
    if ((draft.projects || []).length) {
      body.push(heading('Projects'));
      for (const item of draft.projects) body.push(para(run(`${item.name}: `, `${bold}<w:color w:val="0563C1"/><w:u w:val="single"/>`) + run(item.description), tight));
    }
    if ((draft.additional || []).length) {
      body.push(heading('Additional Information'));
      for (const value of draft.additional) body.push(bullet(value));
    }
    const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="650" w:right="690" w:bottom="600" w:left="690" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`;
    return storedZip(baseFiles(doc, rels));
  };

  RA.buildCoverLetterDocx = function (draft, profile) {
    profile = profile || {};
    const body = [];
    body.push(textPara([profile.firstName, profile.lastName].filter(Boolean).join(' '), '<w:spacing w:after="20"/>', `${bold}<w:sz w:val="30"/>`));
    body.push(textPara([[profile.city, profile.state].filter(Boolean).join(', '), profile.phone, profile.email].filter(Boolean).join(' | '), '<w:spacing w:after="240"/>'));
    body.push(textPara(draft.date || new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }), '<w:spacing w:after="180"/>'));
    if (draft.company) body.push(textPara(draft.company, tight));
    if (draft.role) body.push(textPara(`Re: ${draft.role}`, '<w:spacing w:after="180"/>', bold));
    body.push(textPara(draft.salutation || 'Dear Hiring Team,', '<w:spacing w:after="180"/>'));
    for (const value of draft.paragraphs || []) body.push(textPara(value, '<w:spacing w:after="180" w:line="276" w:lineRule="auto"/>'));
    body.push(textPara(draft.closing || 'Sincerely,', '<w:spacing w:before="80" w:after="180"/>'));
    body.push(textPara([profile.firstName, profile.lastName].filter(Boolean).join(' '), tight, bold));
    const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`;
    return storedZip(baseFiles(doc));
  };

  RA.downloadDocx = function (bytes, fileName) {
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
})(typeof self !== 'undefined' ? self : this);
