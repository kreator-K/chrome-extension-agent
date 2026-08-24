/* DOM layer: find application questions on the page, read their labels and
 * options, and write answers back in a way React/Angular form state notices. */
(function (root) {
  const RA = (root.RA = root.RA || {});

  const TEXT_TYPES = ['text', 'email', 'tel', 'url', 'number', 'search', 'date', 'month', ''];
  const SKIP_NAME = /(^|[^a-z])(search|query|q|filter|coupon|promo|otp|captcha)([^a-z]|$)/i;

  function visible(el) {
    if (!el || !el.isConnected) return false;
    if (el.disabled || el.readOnly) return false;
    if (el.type === 'hidden') return false;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function textOf(node) {
    if (!node) return '';
    return String(node.innerText || node.textContent || '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function fromAriaLabelledBy(el) {
    const ids = (el.getAttribute('aria-labelledby') || '').trim();
    if (!ids) return '';
    return ids
      .split(/\s+/)
      .map((id) => textOf(el.ownerDocument.getElementById(id)))
      .filter(Boolean)
      .join(' ');
  }

  function fromLabelFor(el) {
    if (!el.id) return '';
    const esc = (window.CSS && CSS.escape) ? CSS.escape(el.id) : el.id.replace(/"/g, '\\"');
    const label = el.ownerDocument.querySelector(`label[for="${esc}"]`);
    return textOf(label);
  }

  function prettifyName(name) {
    return String(name || '')
      .replace(/^.*[.\[\]]/, '')
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Climb ancestors looking for a container whose own text reads like a question. */
  function fromAncestorText(el) {
    let node = el.parentElement;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      const legend = node.querySelector(':scope > legend, :scope > .fieldset-legend');
      if (legend) {
        const t = textOf(legend);
        if (t) return t;
      }
      const heading = node.querySelector(':scope > label, :scope > span[id], :scope > div > label, :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > p');
      if (heading && !heading.contains(el)) {
        const t = textOf(heading);
        if (t.length > 2 && t.length < 400) return t;
      }
      const own = textOf(node);
      if (own && own.length > 4 && own.length < 300 && node.querySelectorAll('input, select, textarea').length <= 3) {
        return own;
      }
    }
    return '';
  }

  function labelFor(el) {
    const candidates = [
      fromAriaLabelledBy(el),
      fromLabelFor(el),
      textOf(el.closest('label')),
      el.getAttribute('aria-label') || '',
      fromAncestorText(el),
      el.getAttribute('placeholder') || '',
      prettifyName(el.getAttribute('name') || el.id)
    ];
    for (const c of candidates) {
      const t = String(c || '').replace(/\s+/g, ' ').trim();
      if (t && t.length >= 2) return t.slice(0, 400);
    }
    return '';
  }

  function optionsOfSelect(el) {
    return Array.from(el.options)
      .filter((o) => o.value !== '' || /select|choose/i.test(o.text) === false)
      .map((o) => ({ label: textOf(o) || o.value, value: o.value }));
  }

  function radioGroups(rootEl) {
    const groups = new Map();
    rootEl.querySelectorAll('input[type="radio"]').forEach((input) => {
      if (!visible(input)) return;
      const key = (input.form ? (input.form.id || 'form') : 'doc') + '::' + (input.name || labelFor(input));
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(input);
    });
    return Array.from(groups.values()).filter((g) => g.length > 1);
  }

  function groupLabel(inputs) {
    const fieldset = inputs[0].closest('fieldset');
    if (fieldset) {
      const legend = fieldset.querySelector('legend');
      const t = textOf(legend);
      if (t) return t;
      const aria = fromAriaLabelledBy(fieldset);
      if (aria) return aria;
    }
    const group = inputs[0].closest('[role="radiogroup"], [role="group"]');
    if (group) {
      const aria = fromAriaLabelledBy(group) || group.getAttribute('aria-label') || '';
      if (aria) return aria;
    }
    // Fall back to the shared ancestor of the whole group.
    let node = inputs[0].parentElement;
    for (let d = 0; node && d < 8; d++, node = node.parentElement) {
      if (inputs.every((i) => node.contains(i))) {
        const heading = node.querySelector(':scope > legend, :scope > label, :scope > span, :scope > p, :scope > h1, :scope > h2, :scope > h3, :scope > h4');
        const t = textOf(heading);
        if (t && t.length > 2) return t;
        break;
      }
    }
    return prettifyName(inputs[0].name);
  }

  let seq = 0;
  const registry = new Map(); // fieldId -> { kind, el | inputs }

  /**
   * Scan a document for answerable application fields.
   * @returns {Array} serialisable field descriptors
   */
  RA.scanFields = function (doc) {
    doc = doc || document;
    registry.clear();
    seq = 0;
    const out = [];
    const claimed = new Set();

    for (const inputs of radioGroups(doc)) {
      const id = 'f' + ++seq;
      inputs.forEach((i) => claimed.add(i));
      const options = inputs.map((i) => ({
        label: labelFor(i) || i.value,
        value: i.value
      }));
      const current = inputs.find((i) => i.checked);
      registry.set(id, { kind: 'radio', inputs });
      out.push({
        id,
        kind: 'radio',
        label: groupLabel(inputs),
        options,
        value: current ? (labelFor(current) || current.value) : '',
        required: inputs.some((i) => i.required)
      });
    }

    doc.querySelectorAll('input, textarea, select').forEach((el) => {
      if (claimed.has(el) || !visible(el)) return;
      const tag = el.tagName.toLowerCase();
      const type = (el.type || '').toLowerCase();
      if (tag === 'input' && !TEXT_TYPES.includes(type) && type !== 'checkbox') return;
      if (SKIP_NAME.test(el.name || '') || SKIP_NAME.test(el.id || '')) return;
      if (el.closest('[role="search"], nav, header')) return;

      const id = 'f' + ++seq;
      const label = labelFor(el);
      if (!label) return;

      let kind = 'text';
      let options = null;
      if (tag === 'select') { kind = 'select'; options = optionsOfSelect(el); }
      else if (tag === 'textarea') kind = 'textarea';
      else if (type === 'checkbox') { kind = 'checkbox'; options = [{ label: 'Yes', value: 'yes' }, { label: 'No', value: 'no' }]; }
      else if (type === 'number') kind = 'number';
      else if (type === 'date' || type === 'month') kind = 'date';

      registry.set(id, { kind, el });
      out.push({
        id,
        kind,
        label,
        options,
        value: kind === 'checkbox' ? (el.checked ? 'Yes' : '') : (el.value || ''),
        maxLength: el.maxLength && el.maxLength > 0 ? el.maxLength : null,
        required: !!el.required,
        placeholder: el.getAttribute('placeholder') || ''
      });
    });

    return out;
  };

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value');
    if (setter && setter.set) setter.set.call(el, value);
    else el.value = value;
  }

  function fire(el, types) {
    for (const t of types) {
      el.dispatchEvent(new Event(t, { bubbles: true }));
    }
  }

  /**
   * Write an answer into a previously scanned field.
   * @returns {{ok:boolean, applied?:string, reason?:string}}
   */
  RA.fillField = function (fieldId, value) {
    const entry = registry.get(fieldId);
    if (!entry) return { ok: false, reason: 'field no longer on page' };

    if (entry.kind === 'radio') {
      const options = entry.inputs.map((i) => ({ label: labelFor(i) || i.value, value: i.value, input: i }));
      const pick = RA.bestOption(options, value) || RA.bestOption(options, /^y/i.test(value) ? 'yes' : 'no');
      if (!pick) return { ok: false, reason: 'no matching option' };
      pick.input.focus();
      pick.input.click();
      fire(pick.input, ['input', 'change']);
      return { ok: true, applied: pick.label };
    }

    const el = entry.el;
    if (!el || !el.isConnected) return { ok: false, reason: 'field no longer on page' };

    if (entry.kind === 'select') {
      const options = Array.from(el.options).map((o, idx) => ({
        label: (o.textContent || '').trim() || o.value, value: o.value, idx
      }));
      const pick = RA.bestOption(options, value);
      if (!pick) return { ok: false, reason: 'no matching option' };
      el.focus();
      setNativeValue(el, pick.value);
      el.selectedIndex = pick.idx;
      fire(el, ['input', 'change']);
      fire(el, ['blur']);
      return { ok: true, applied: pick.label };
    }

    if (entry.kind === 'checkbox') {
      const want = /^(y|true|1|agree|accept)/i.test(String(value).trim());
      if (el.checked !== want) { el.focus(); el.click(); }
      fire(el, ['change']);
      return { ok: true, applied: want ? 'checked' : 'unchecked' };
    }

    let text = String(value);
    if (el.maxLength && el.maxLength > 0 && text.length > el.maxLength) {
      text = text.slice(0, el.maxLength);
    }
    el.focus();
    setNativeValue(el, text);
    fire(el, ['input', 'change']);
    fire(el, ['blur']);
    return { ok: true, applied: text };
  };

  RA.highlightField = function (fieldId, on) {
    const entry = registry.get(fieldId);
    if (!entry) return;
    const el = entry.kind === 'radio' ? entry.inputs[0] : entry.el;
    if (!el || !el.isConnected) return;
    const target = el.closest('label, div, fieldset') || el;
    target.classList.toggle('ra-highlight', !!on);
    if (on) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };
})(typeof self !== 'undefined' ? self : this);
