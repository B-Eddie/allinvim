(() => {
  const IS_BROWSER = typeof browser !== "undefined";
  const API = IS_BROWSER ? browser : chrome;

  function repeat(n, fn) {
    for (let i = 0; i < (n || 1); i++) fn(i);
  }

  function getEditor() {
    try {
      return window.__VIM_CURRENT_EDITOR__ ? window.__VIM_CURRENT_EDITOR__() : null;
    } catch (_) { return null; }
  }

  function isTextareaOrInput(el) {
    if (!el) return false;
    return el.tagName === "TEXTAREA" || el.tagName === "INPUT";
  }

  function isContentEditable(el) {
    if (!el) return false;
    return el.isContentEditable === true;
  }

  // Collapse the DOCUMENT selection to its end — but only when that cannot
  // steal a textarea/input caret. Pages like Google keep a live document
  // range (autocomplete overlay); a bare collapseToEnd() there yanked a 6:6
  // textarea caret to 0:0 on Esc. Textareas/inputs own their selection via
  // selectionStart and must never be touched here.
  function collapseDocSelectionToEnd() {
    try {
      const el = getEditor();
      if (el && !isContentEditable(el)) return;
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return;
      if (el && sel.anchorNode && !el.contains(sel.anchorNode)) return;
      sel.collapseToEnd();
    } catch (_) {}
  }

  function dispatchInputEvent(el) {
    try {
      el.dispatchEvent(new Event("input", { bubbles: true, cancelable: false }));
    } catch (_) {}
  }

  // Framework-safe <textarea>/<input> writes. Direct `el.value = x` bypasses
  // the property setter that React/Vue/Svelte wrap, so controlled inputs
  // revert our edits (or lose undo). Using the *native* setter plus a real
  // InputEvent with inputType/data keeps every framework in sync.
  function nativeValueSetter(el) {
    try {
      const proto = el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement && window.HTMLInputElement.prototype;
      const desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && typeof desc.set === "function") return desc.set;
    } catch (_) {}
    return null;
  }

  function fireBeforeInput(el, inputType, data) {
    try {
      const ev = new InputEvent("beforeinput", {
        bubbles: true, cancelable: true, composed: true,
        inputType: inputType || "insertText", data: data == null ? null : String(data),
      });
      return el.dispatchEvent(ev);
    } catch (_) {}
    return true;
  }

  function fireInput(el, inputType, data) {
    const type = inputType || "insertText";
    const payload = data == null ? null : String(data);
    try {
      el.dispatchEvent(new InputEvent("input", {
        bubbles: true, cancelable: false, composed: true,
        inputType: type, data: payload,
      }));
    } catch (_) {
      dispatchInputEvent(el);
    }
  }

  function fireInputEvents(el, inputType, data) {
    fireInput(el, inputType, data);
    return true;
  }

  function commitInputValue(el, newValue, caret, inputType, data) {
    // beforeinput first: a canceled edit must not mutate the value.
    if (!fireBeforeInput(el, inputType, data)) return false;
    const setter = nativeValueSetter(el);
    try {
      if (setter) setter.call(el, newValue);
      else el.value = newValue;
    } catch (_) {
      try { el.value = newValue; } catch (_) {}
    }
    try {
      const pos = Math.max(0, Math.min(caret, (el.value || "").length));
      el.setSelectionRange(pos, pos);
    } catch (_) {}
    fireInput(el, inputType, data);
    return true;
  }

  // Replace [lo,hi) with `insert`, place caret after inserted text, and
  // notify frameworks. Returns the new caret offset.
  function spliceInput(el, start, end, insert, inputType) {
    const text = el.value || "";
    const lo = Math.max(0, Math.min(start, end));
    const hi = Math.min(text.length, Math.max(start, end));
    const data = insert || "";
    const type = inputType || (data ? "insertText" : "deleteContentBackward");
    const ok = commitInputValue(el, text.substring(0, lo) + data + text.substring(hi), lo + data.length, type, data || null);
    if (!ok) {
      try { el.setSelectionRange(lo, lo); } catch (_) {}
      return lo;
    }
    return lo + data.length;
  }

  // ---- contenteditable text model --------------------------------------
  // Treats block boundaries (<p>/<div>/<li>/…​) and <br> as "\n" so every
  // motion can reuse the exact textarea index math on one canonical string.
  // Only ONE DOM read per motion and ONE selection write — no per-character
  // Selection.modify() loops (which fight rich editors and force layout).
  const CE_BLOCK_TAGS = new Set([
    "P", "DIV", "LI", "UL", "OL", "BLOCKQUOTE", "PRE",
    "H1", "H2", "H3", "H4", "H5", "H6", "SECTION", "ARTICLE",
    "HEADER", "FOOTER", "NAV", "ASIDE", "MAIN", "FIGURE", "FIGCAPTION",
    "TABLE", "THEAD", "TBODY", "TR", "HR", "ADDRESS", "DL", "DT", "DD",
  ]);

  function ceIsBlock(node) {
    return !!node && node.nodeType === 1 && CE_BLOCK_TAGS.has(node.tagName);
  }

  // { text, segs, starts, ends, total }
  // segs: {t:"text",node,start,len} | {t:"br",node,parent,idx,start} |
  //       {t:"blockEnd",node,start}  ("\n" each, occupying [start,start+1))
  function ceCollectModel(root) {
    const segs = [];
    const starts = new Map();
    const ends = new Map();
    let text = "";
    const rec = (node, isRoot) => {
      if (!node) return 0;
      if (node.nodeType === 3) {
        const len = (node.nodeValue || "").length;
        if (len > 0) {
          starts.set(node, text.length);
          segs.push({ t: "text", node, start: text.length, len });
          text += node.nodeValue;
        }
        ends.set(node, text.length);
        return len;
      }
      if (node.nodeType !== 1) return 0;
      starts.set(node, text.length);
      if (node.tagName === "BR") {
        const parent = node.parentNode;
        let idx = 0;
        try { idx = Array.prototype.indexOf.call(parent.childNodes, node); } catch (_) {}
        segs.push({ t: "br", node, parent, idx, start: text.length });
        text += "\n";
        ends.set(node, text.length);
        return 1;
      }
      let len = 0;
      try {
        for (const child of node.childNodes) len += rec(child, false);
      } catch (_) {}
      if (!isRoot && ceIsBlock(node)) {
        segs.push({ t: "blockEnd", node, start: text.length });
        text += "\n";
        len += 1;
      }
      ends.set(node, text.length);
      return len;
    };
    try { rec(root, true); } catch (_) {}
    return { text, segs, starts, ends, total: text.length };
  }

  function ceSubtreeLen(node) {
    if (!node) return 0;
    if (node.nodeType === 3) return (node.nodeValue || "").length;
    if (node.nodeType !== 1) return 0;
    if (node.tagName === "BR") return 1;
    let len = 0;
    try {
      for (const child of node.childNodes) len += ceSubtreeLen(child);
    } catch (_) {}
    if (ceIsBlock(node)) len += 1;
    return len;
  }

  // Caret (container,offset) -> model index. Falls back to -1 when the
  // selection lives outside the model (e.g. shadow-DOM editors).
  function ceOffsetOfPoint(model, container, offset) {
    if (!container) return -1;
    try {
      if (container.nodeType === 3) {
        for (const s of model.segs) {
          if (s.t === "text" && s.node === container) {
            return s.start + Math.max(0, Math.min(offset, s.len));
          }
        }
        return -1;
      }
      if (container.nodeType === 1) {
        let base = model.starts.get(container);
        if (base == null) return -1;
        let idx = base;
        const kids = container.childNodes;
        const n = Math.max(0, Math.min(offset, kids ? kids.length : 0));
        for (let i = 0; i < n; i++) idx += ceSubtreeLen(kids[i]);
        return idx;
      }
    } catch (_) {}
    return -1;
  }

  function ceCaretOffset(el, model) {
    try {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return -1;
      const r = sel.getRangeAt(0);
      const idx = ceOffsetOfPoint(model || ceCollectModel(el), r.startContainer, r.startOffset);
      return idx;
    } catch (_) {}
    return -1;
  }

  function ceAnchorOffset(el, model) {
    try {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return -1;
      return ceOffsetOfPoint(model || ceCollectModel(el), sel.anchorNode, sel.anchorOffset);
    } catch (_) {}
    return -1;
  }

  // Model index -> (node, offset). Block-end "\n" maps to end-of-block so
  // the caret stays visible; the following index resolves into next content.
  function ceIndexToPoint(model, root, index) {
    const i = Math.max(0, Math.min(index, model.total));
    // End of text (or empty editor): collapse after all content.
    if (i >= model.total) {
      try {
        if (root) return { node: root, offset: root.childNodes ? root.childNodes.length : 0 };
      } catch (_) {}
      return null;
    }
    for (const s of model.segs) {
      if (i < s.start || i >= s.start + (s.t === "text" ? s.len : 1)) continue;
      if (s.t === "text") return { node: s.node, offset: i - s.start };
      if (s.t === "br") {
        try {
          if (i === s.start) return { node: s.parent, offset: Math.max(0, s.idx) };
          return { node: s.parent, offset: Math.max(0, s.idx + 1) };
        } catch (_) { return null; }
      }
      // blockEnd
      try {
        const n = s.node.childNodes ? s.node.childNodes.length : 0;
        return { node: s.node, offset: n };
      } catch (_) { return null; }
    }
    // Past the end (or empty editor): collapse to end of root.
    try {
      if (root) {
        // Prefer last text position so empty blocks still accept a caret.
        for (let k = model.segs.length - 1; k >= 0; k--) {
          const s = model.segs[k];
          if (s.t === "text") return { node: s.node, offset: s.len };
        }
        return { node: root, offset: root.childNodes ? root.childNodes.length : 0 };
      }
    } catch (_) {}
    return null;
  }

  function ceSetCaret(el, model, index) {
    try {
      const pt = ceIndexToPoint(model, el, index);
      if (!pt || !pt.node) return false;
      const sel = window.getSelection();
      if (!sel) return false;
      const r = document.createRange();
      r.setStart(pt.node, pt.offset);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
      return true;
    } catch (_) {}
    return false;
  }

  function ceSelectRange(el, model, a, b) {
    try {
      const lo = Math.max(0, Math.min(a, b));
      const hi = Math.min(model.total, Math.max(a, b));
      const p1 = ceIndexToPoint(model, el, lo);
      const p2 = ceIndexToPoint(model, el, hi);
      if (!p1 || !p2 || !p1.node || !p2.node) return false;
      const sel = window.getSelection();
      if (!sel) return false;
      sel.setBaseAndExtent(p1.node, p1.offset, p2.node, p2.offset);
      return true;
    } catch (_) {}
    return false;
  }

  // Raw (non-collapsed-whitespace) text of the current CE selection.
  function ceSelectionText() {
    try {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return "";
      return sel.getRangeAt(0).cloneRange().toString();
    } catch (_) {}
    return "";
  }

  // Delete selected CE content through the browser editing pipeline
  // (fires beforeinput/input with real inputTypes so ProseMirror/TipTap/
  // Lexical stay in sync). Falls back to DOM removal + InputEvent.
  function ceDeleteSelection(inputType) {
    const type = inputType || "deleteContentBackward";
    try {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return false;
      if (sel.getRangeAt(0).collapsed) return true;
      let done = false;
      try { done = document.execCommand("delete", false, null); } catch (_) { done = false; }
      if (!done) {
        try {
          sel.getRangeAt(0).deleteContents();
          const el = getEditor();
          if (el) fireInputEvents(el, type, null);
          done = true;
        } catch (_) { done = false; }
      } else {
        try {
          const el = getEditor();
          if (el) fireInputEvents(el, type, null);
        } catch (_) {}
      }
      return done;
    } catch (_) {}
    return false;
  }

  // One visual-line step for gj/gk in contenteditable. Anchors the current
  // caret x and probes a line above/below via caretRangeFromPoint.
  function ceVisualStep(el, dir, withShift) {
    try {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return false;
      const r = sel.getRangeAt(0).cloneRange();
      r.collapse(dir < 0);
      let rect = null;
      try { rect = r.getClientRects()[0] || r.getBoundingClientRect(); } catch (_) {}
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        try {
          const node = r.startContainer;
          const tmp = document.createRange();
          if (node.nodeType === 3) {
            const off = Math.max(0, dir < 0 ? r.startOffset - 1 : r.startOffset);
            tmp.setStart(node, Math.min(off, (node.nodeValue || "").length));
            tmp.collapse(true);
          } else tmp.selectNodeContents(el);
          rect = tmp.getBoundingClientRect();
        } catch (_) {}
      }
      if (!rect) return false;
      const lh = (() => {
        try {
          const cs = window.getComputedStyle(r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentNode);
          const v = parseFloat(cs.lineHeight);
          if (Number.isFinite(v) && v > 0) return v;
          const fs = parseFloat(cs.fontSize);
          if (Number.isFinite(fs) && fs > 0) return fs * 1.4;
        } catch (_) {}
        return 20;
      })();
      const x = rect.left + Math.min(rect.width, 2);
      const y = (dir < 0 ? rect.top : rect.bottom) + dir * lh * 0.6;
      let target = null;
      try {
        if (document.caretRangeFromPoint) target = document.caretRangeFromPoint(x, y);
        else if (document.caretPositionFromPoint) {
          const p = document.caretPositionFromPoint(x, y);
          if (p) { target = document.createRange(); target.setStart(p.offsetNode, p.offset); target.collapse(true); }
        }
      } catch (_) {}
      if (!target) return false;
      if (withShift) {
        try {
          sel.extend(target.startContainer, target.startOffset);
          return true;
        } catch (_) { return false; }
      }
      sel.removeAllRanges();
      sel.addRange(target);
      return true;
    } catch (_) {}
    return false;
  }

  const Adapter = {
    left(opts = {}) {
      const el = getEditor();
      if (!el) return;
      const shift = opts.shift || false;
      if (isTextareaOrInput(el)) {
        const start = el.selectionStart, end = el.selectionEnd;
        if (shift) el.setSelectionRange(Math.max(0, start - 1), end);
        else { const pos = Math.max(0, Math.min(start, end) - 1); el.setSelectionRange(pos, pos); }
      } else if (isContentEditable(el)) {
        const model = ceCollectModel(el);
        const idx = ceCaretOffset(el, model);
        if (idx < 0) return;
        if (shift) {
          const anchor = ceAnchorOffset(el, model);
          ceSelectRange(el, model, anchor < 0 ? idx : anchor, Math.max(0, idx - 1));
        } else ceSetCaret(el, model, Math.max(0, idx - 1));
      }
    },
    right(opts = {}) {
      const el = getEditor();
      if (!el) return;
      const shift = opts.shift || false;
      if (isTextareaOrInput(el)) {
        const start = el.selectionStart, end = el.selectionEnd, max = el.value.length;
        if (shift) el.setSelectionRange(start, Math.min(max, end + 1));
        else { const pos = Math.min(max, Math.max(start, end) + 1); el.setSelectionRange(pos, pos); }
      } else if (isContentEditable(el)) {
        const model = ceCollectModel(el);
        const idx = ceCaretOffset(el, model);
        if (idx < 0) return;
        if (shift) {
          const anchor = ceAnchorOffset(el, model);
          ceSelectRange(el, model, anchor < 0 ? idx : anchor, Math.min(model.total, idx + 1));
        } else ceSetCaret(el, model, Math.min(model.total, idx + 1));
      }
    },
    // Logical-line motion (matches textarea j/k). Visual-line stepping for
    // gj/gk lives in displayUp/displayDown below.
    up(opts = {}) {
      const el = getEditor();
      if (!el) return;
      const shift = opts.shift || false;
      if (isTextareaOrInput(el)) {
        const pos = el.selectionStart, text = el.value;
        const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
        if (lineStart === 0) return;
        const prevLineEnd = lineStart - 1;
        const prevLineStart = text.lastIndexOf("\n", prevLineEnd - 1) + 1;
        const col = pos - lineStart;
        const target = Math.min(prevLineStart + col, prevLineEnd);
        el.setSelectionRange(shift ? el.selectionStart : target, target);
      } else if (isContentEditable(el)) {
        const model = ceCollectModel(el);
        const idx = ceCaretOffset(el, model);
        if (idx < 0) return;
        const text = model.text;
        const lineStart = text.lastIndexOf("\n", idx - 1) + 1;
        if (lineStart === 0) return;
        const prevLineEnd = lineStart - 1;
        const prevLineStart = text.lastIndexOf("\n", prevLineEnd - 1) + 1;
        const col = idx - lineStart;
        const target = Math.min(prevLineStart + col, prevLineEnd);
        if (shift) {
          const anchor = ceAnchorOffset(el, model);
          ceSelectRange(el, model, anchor < 0 ? idx : anchor, target);
        } else ceSetCaret(el, model, target);
      }
    },
    down(opts = {}) {
      const el = getEditor();
      if (!el) return;
      const shift = opts.shift || false;
      if (isTextareaOrInput(el)) {
        const pos = el.selectionStart, text = el.value;
        const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
        const lineEnd = text.indexOf("\n", pos);
        const nextLineStart = lineEnd === -1 ? text.length : lineEnd + 1;
        if (nextLineStart >= text.length) return;
        const nextLineEnd = text.indexOf("\n", nextLineStart);
        const end = nextLineEnd === -1 ? text.length : nextLineEnd;
        const col = pos - lineStart;
        const target = Math.min(nextLineStart + col, end);
        el.setSelectionRange(shift ? el.selectionStart : target, target);
      } else if (isContentEditable(el)) {
        const model = ceCollectModel(el);
        const idx = ceCaretOffset(el, model);
        if (idx < 0) return;
        const text = model.text;
        const lineStart = text.lastIndexOf("\n", idx - 1) + 1;
        const lineEnd = text.indexOf("\n", idx);
        const nextLineStart = lineEnd === -1 ? text.length : lineEnd + 1;
        if (nextLineStart >= text.length) return;
        const nextLineEnd = text.indexOf("\n", nextLineStart);
        const end = nextLineEnd === -1 ? text.length : nextLineEnd;
        const col = idx - lineStart;
        const target = Math.min(nextLineStart + col, end);
        if (shift) {
          const anchor = ceAnchorOffset(el, model);
          ceSelectRange(el, model, anchor < 0 ? idx : anchor, target);
        } else ceSetCaret(el, model, target);
      }
    },
    displayUp(opts = {}) {
      const el = getEditor();
      if (!el) return;
      if (isContentEditable(el)) {
        if (ceVisualStep(el, -1, !!opts.shift)) return;
      }
      this.up(opts);
    },
    displayDown(opts = {}) {
      const el = getEditor();
      if (!el) return;
      if (isContentEditable(el)) {
        if (ceVisualStep(el, 1, !!opts.shift)) return;
      }
      this.down(opts);
    },
    home(opts = {}) {
      const el = getEditor();
      if (!el) return;
      const shift = opts.shift || false;
      if (isTextareaOrInput(el)) {
        const lineStart = el.value.lastIndexOf("\n", el.selectionStart - 1) + 1;
        el.setSelectionRange(lineStart, shift ? el.selectionEnd : lineStart);
      } else if (isContentEditable(el)) {
        const model = ceCollectModel(el);
        const idx = ceCaretOffset(el, model);
        if (idx < 0) return;
        const lineStart = model.text.lastIndexOf("\n", idx - 1) + 1;
        if (shift) {
          const anchor = ceAnchorOffset(el, model);
          ceSelectRange(el, model, anchor < 0 ? idx : anchor, lineStart);
        } else ceSetCaret(el, model, lineStart);
      }
    },
    end(opts = {}) {
      const el = getEditor();
      if (!el) return;
      const shift = opts.shift || false;
      if (isTextareaOrInput(el)) {
        const lineEnd = el.value.indexOf("\n", el.selectionStart);
        const pos = lineEnd === -1 ? el.value.length : lineEnd;
        el.setSelectionRange(shift ? el.selectionStart : pos, pos);
      } else if (isContentEditable(el)) {
        const model = ceCollectModel(el);
        const idx = ceCaretOffset(el, model);
        if (idx < 0) return;
        const lineEnd = model.text.indexOf("\n", idx);
        const pos = lineEnd === -1 ? model.total : lineEnd;
        if (shift) {
          const anchor = ceAnchorOffset(el, model);
          ceSelectRange(el, model, anchor < 0 ? idx : anchor, pos);
        } else ceSetCaret(el, model, pos);
      }
    },
    pageUp(opts = {}) { this.up(opts); },
    pageDown(opts = {}) { this.down(opts); },
    ctrlLeft(opts = {}) {
      const el = getEditor();
      if (!el) return;
      const shift = opts.shift || false;
      if (isTextareaOrInput(el)) {
        let pos = el.selectionStart;
        const text = el.value;
        if (pos > 0) pos--;
        while (pos > 0 && /\s/.test(text[pos])) pos--;
        while (pos > 0 && !/\s/.test(text[pos - 1])) pos--;
        el.setSelectionRange(pos, shift ? el.selectionEnd : pos);
      } else if (isContentEditable(el)) {
        const model = ceCollectModel(el);
        const idx = ceCaretOffset(el, model);
        if (idx < 0) return;
        let pos = idx;
        const text = model.text;
        if (pos > 0) pos--;
        while (pos > 0 && /\s/.test(text[pos])) pos--;
        while (pos > 0 && !/\s/.test(text[pos - 1])) pos--;
        if (shift) {
          const anchor = ceAnchorOffset(el, model);
          ceSelectRange(el, model, anchor < 0 ? idx : anchor, pos);
        } else ceSetCaret(el, model, pos);
      }
    },
    ctrlRight(opts = {}) {
      const el = getEditor();
      if (!el) return;
      const shift = opts.shift || false;
      if (isTextareaOrInput(el)) {
        let pos = el.selectionStart;
        const text = el.value;
        while (pos < text.length && /\s/.test(text[pos])) pos++;
        while (pos < text.length && !/\s/.test(text[pos])) pos++;
        el.setSelectionRange(shift ? el.selectionStart : pos, pos);
      } else if (isContentEditable(el)) {
        const model = ceCollectModel(el);
        const idx = ceCaretOffset(el, model);
        if (idx < 0) return;
        let pos = idx;
        const text = model.text;
        while (pos < text.length && /\s/.test(text[pos])) pos++;
        while (pos < text.length && !/\s/.test(text[pos])) pos++;
        if (shift) {
          const anchor = ceAnchorOffset(el, model);
          ceSelectRange(el, model, anchor < 0 ? idx : anchor, pos);
        } else ceSetCaret(el, model, pos);
      }
    },
    ctrlHome(opts = {}) {
      const el = getEditor();
      if (!el) return;
      const shift = opts.shift || false;
      if (isTextareaOrInput(el)) el.setSelectionRange(0, shift ? el.selectionEnd : 0);
      else if (isContentEditable(el)) {
        const sel = window.getSelection();
        if (sel) { const range = document.createRange(); range.selectNodeContents(el); if (!shift) range.collapse(true); sel.removeAllRanges(); sel.addRange(range); }
      }
    },
    ctrlEnd(opts = {}) {
      const el = getEditor();
      if (!el) return;
      const shift = opts.shift || false;
      if (isTextareaOrInput(el)) { const len = el.value.length; el.setSelectionRange(shift ? el.selectionStart : len, len); }
      else if (isContentEditable(el)) {
        const sel = window.getSelection();
        if (sel) { const range = document.createRange(); range.selectNodeContents(el); if (!shift) range.collapse(false); sel.removeAllRanges(); sel.addRange(range); }
      }
    },
    ctrlUp(opts = {}) { this.up(opts); },
    ctrlDown(opts = {}) { this.down(opts); },
    backspace(opts = {}) {
      const el = getEditor();
      if (!el) return;
      if (isTextareaOrInput(el)) {
        const start = el.selectionStart, end = el.selectionEnd;
        if (start === end && start > 0) {
          spliceInput(el, start - 1, end, "", "deleteContentBackward");
        } else if (start !== end) {
          spliceInput(el, start, end, "", "deleteContentBackward");
        }
      } else if (isContentEditable(el)) {
        try {
          const sel = window.getSelection();
          if (!sel || sel.rangeCount === 0) return;
          if (sel.getRangeAt(0).collapsed) {
            const model = ceCollectModel(el);
            const idx = ceCaretOffset(el, model);
            if (idx > 0) ceSelectRange(el, model, idx - 1, idx);
            else return;
          }
          ceDeleteSelection("deleteContentBackward");
        } catch (_) {}
      }
    },
    delete(opts = {}) {
      const el = getEditor();
      if (!el) return;
      if (isTextareaOrInput(el)) {
        const start = el.selectionStart, end = el.selectionEnd;
        if (start === end && start < el.value.length) {
          spliceInput(el, start, end + 1, "", "deleteContentForward");
        } else if (start !== end) {
          spliceInput(el, start, end, "", "deleteContentForward");
        }
      } else if (isContentEditable(el)) {
        try {
          const sel = window.getSelection();
          if (!sel || sel.rangeCount === 0) return;
          if (sel.getRangeAt(0).collapsed) {
            const model = ceCollectModel(el);
            const idx = ceCaretOffset(el, model);
            if (idx < 0 || idx >= model.total) return;
            if (!ceSelectRange(el, model, idx, idx + 1)) return;
          }
          ceDeleteSelection("deleteContentForward");
        } catch (_) {}
      }
    },
  };

  class TextNavigator {
    constructor(getEditorFn) {
      this.getEditor = getEditorFn;
      this.MAX_SCAN = 2048;
    }

    isWhitespace(ch) { return !ch || /\s/.test(ch); }
    isNewline(ch) { return ch === "\n"; }
    isWordChar(ch) { return /[A-Za-z0-9_]/.test(ch || ""); }

    classify(ch, kind) {
      if (this.isWhitespace(ch)) return "ws";
      if (kind === "WORD") return "nonws";
      return this.isWordChar(ch) ? "word" : "punct";
    }

    peekRightCharN(n) {
      const el = this.getEditor();
      if (!el) return null;
      if (isTextareaOrInput(el)) {
        const pos = el.selectionStart;
        return (pos + n - 1 < el.value.length) ? el.value[pos + n - 1] || null : null;
      } else if (isContentEditable(el)) {
        const tp = this.textAndPos();
        if (!tp) return null;
        return (tp.pos + n - 1 < tp.text.length) ? tp.text[tp.pos + n - 1] || null : null;
      }
      return null;
    }

    peekLeftCharN(n) {
      const el = this.getEditor();
      if (!el) return null;
      if (isTextareaOrInput(el)) {
        const pos = el.selectionStart;
        return (pos - n >= 0) ? el.value[pos - n] || null : null;
      } else if (isContentEditable(el)) {
        const tp = this.textAndPos();
        if (!tp) return null;
        return (tp.pos - n >= 0) ? tp.text[tp.pos - n] || null : null;
      }
      return null;
    }

    moveRightBy(n, withShift) {
      if (n <= 0) return;
      const el = this.getEditor();
      if (!el) return;
      if (isTextareaOrInput(el)) {
        const start = el.selectionStart, end = el.selectionEnd;
        if (withShift) el.setSelectionRange(start, Math.min(el.value.length, end + n));
        else { const pos = Math.min(el.value.length, Math.max(start, end) + n); el.setSelectionRange(pos, pos); }
      } else if (isContentEditable(el)) {
        const tp = this.textAndPos();
        if (!tp) return;
        const { text, pos } = tp;
        if (withShift) this.selectModelRange(tp, tp.pos, Math.min(text.length, pos + n), true);
        else this.setCaretIndex(Math.min(text.length, pos + n), false);
      }
    }

    moveLeftBy(n, withShift) {
      if (n <= 0) return;
      const el = this.getEditor();
      if (!el) return;
      if (isTextareaOrInput(el)) {
        const start = el.selectionStart, end = el.selectionEnd;
        if (withShift) el.setSelectionRange(Math.max(0, start - n), end);
        else { const pos = Math.max(0, Math.min(start, end) - n); el.setSelectionRange(pos, pos); }
      } else if (isContentEditable(el)) {
        const tp = this.textAndPos();
        if (!tp) return;
        if (withShift) this.selectModelRange(tp, tp.pos, Math.max(0, tp.pos - n), true);
        else this.setCaretIndex(Math.max(0, tp.pos - n), false);
      }
    }

    caretIndex() {
      const el = this.getEditor();
      if (!el) return { index: -1, min: 0, max: 0 };
      if (isTextareaOrInput(el)) return { index: el.selectionStart, min: 0, max: el.value.length };
      if (isContentEditable(el)) {
        try {
          const model = ceCollectModel(el);
          const idx = ceCaretOffset(el, model);
          if (idx < 0) return { index: -1, min: 0, max: model.total };
          return { index: idx, min: 0, max: model.total };
        } catch (_) { return { index: -1, min: 0, max: 0 }; }
      }
      return { index: -1, min: 0, max: 0 };
    }

    setCaretIndex(absIndex, withShift) {
      const el = this.getEditor();
      if (!el) return false;
      if (isTextareaOrInput(el)) {
        const target = Math.max(0, Math.min(absIndex, el.value.length));
        el.setSelectionRange(withShift ? el.selectionStart : target, target);
        return true;
      }
      if (isContentEditable(el)) {
        try {
          const model = ceCollectModel(el);
          const target = Math.max(0, Math.min(absIndex, model.total));
          if (withShift) {
            const anchor = ceAnchorOffset(el, model);
            const idx = ceCaretOffset(el, model);
            return ceSelectRange(el, model, anchor < 0 ? (idx < 0 ? target : idx) : anchor, target);
          }
          return ceSetCaret(el, model, target);
        } catch (_) { return false; }
      }
      return false;
    }

    // Canonical (text, caret) for the focused editor. Contenteditable DOM
    // is projected through the block-aware model so every consumer below
    // runs identical index math on both editor kinds.
    textAndPos() {
      const el = this.getEditor();
      if (!el) return null;
      if (isTextareaOrInput(el)) return { el, text: el.value || "", pos: el.selectionStart };
      if (isContentEditable(el)) {
        try {
          const model = ceCollectModel(el);
          const idx = ceCaretOffset(el, model);
          if (idx < 0) return null;
          return { el, model, text: model.text, pos: idx };
        } catch (_) { return null; }
      }
      return null;
    }

    // Place a (possibly ranged) selection from model indices.
    selectModelRange(tp, a, b, withShift) {
      const el = tp.el;
      if (isTextareaOrInput(el)) {
        if (withShift) el.setSelectionRange(Math.min(a, el.selectionStart), Math.max(b, el.selectionEnd));
        else el.setSelectionRange(a, b);
        return true;
      }
      if (isContentEditable(el) && tp.model) {
        if (withShift) {
          const anchor = ceAnchorOffset(el, tp.model);
          const cur = ceCaretOffset(el, tp.model);
          return ceSelectRange(el, tp.model, anchor < 0 ? (cur < 0 ? a : cur) : anchor, b);
        }
        if (a === b) return ceSetCaret(el, tp.model, a);
        return ceSelectRange(el, tp.model, a, b);
      }
      return false;
    }

    prevLineBoundaryDelta() {
      const el = this.getEditor();
      if (!el) return 0;
      if (isTextareaOrInput(el)) {
        const pos = el.selectionStart, text = el.value;
        let n = 0;
        while (pos - n > 0 && text[pos - n - 1] !== "\n") { n++; if (n > this.MAX_SCAN) break; }
        return n;
      }
      if (isContentEditable(el)) {
        const tp = this.textAndPos();
        if (!tp) return 0;
        const { text, pos } = tp;
        let n = 0;
        while (pos - n > 0 && text[pos - n - 1] !== "\n") { n++; if (n > this.MAX_SCAN) break; }
        return n;
      }
      return 0;
    }

    whitespaceForwardDelta() {
      const el = this.getEditor();
      if (!el) return 0;
      if (isTextareaOrInput(el)) {
        let n = 0, i = el.selectionStart;
        while (i < el.value.length && this.classify(el.value[i], "word") === "ws") { n++; i++; if (n > this.MAX_SCAN) break; }
        return n;
      }
      if (isContentEditable(el)) {
        const tp = this.textAndPos();
        if (!tp) return 0;
        const { text, pos } = tp;
        let n = 0, i = pos;
        while (i < text.length && this.classify(text[i], "word") === "ws") { n++; i++; if (n > this.MAX_SCAN) break; }
        return n;
      }
      return 0;
    }

    firstNonBlankForwardDelta() {
      const el = this.getEditor();
      if (!el) return 0;
      if (isTextareaOrInput(el)) {
        let n = 0, i = el.selectionStart;
        while (i < el.value.length && this.isWhitespace(el.value[i])) {
          if (this.isNewline(el.value[i])) return 0;
          n++; i++; if (n > this.MAX_SCAN) break;
        }
        return n;
      }
      if (isContentEditable(el)) {
        const tp = this.textAndPos();
        if (!tp) return 0;
        const { text, pos } = tp;
        let n = 0, i = pos;
        while (i < text.length && this.isWhitespace(text[i])) {
          if (this.isNewline(text[i])) return 0;
          n++; i++; if (n > this.MAX_SCAN) break;
        }
        return n;
      }
      return 0;
    }

    nextStartDelta(kind) {
      const el = this.getEditor();
      if (!el) return 0;
      if (isTextareaOrInput(el)) {
        const pos = el.selectionStart, text = el.value;
        if (pos >= text.length) return 0;
        let i = pos, n = 0;
        const firstT = this.classify(text[i], kind);
        if (firstT !== "ws") { while (i < text.length && this.classify(text[i], kind) === firstT) { n++; i++; if (n > this.MAX_SCAN) break; } }
        let seenNL = false;
        while (i < text.length && this.classify(text[i], kind) === "ws") {
          n++; i++;
          if (this.isNewline(text[i - 1])) { if (seenNL) { n = Math.max(n - 1, 0); break; } seenNL = true; }
          if (n > this.MAX_SCAN) break;
        }
        return n;
      }
      if (isContentEditable(el)) {
        const tp = this.textAndPos();
        if (!tp) return 0;
        const { text, pos } = tp;
        if (pos >= text.length) return 0;
        let i = pos, n = 0;
        const firstT = this.classify(text[i], kind);
        if (firstT !== "ws") { while (i < text.length && this.classify(text[i], kind) === firstT) { n++; i++; if (n > this.MAX_SCAN) break; } }
        let seenNL = false;
        while (i < text.length && this.classify(text[i], kind) === "ws") {
          n++; i++;
          if (this.isNewline(text[i - 1])) { if (seenNL) { n = Math.max(n - 1, 0); break; } seenNL = true; }
          if (n > this.MAX_SCAN) break;
        }
        return n;
      }
      return 0;
    }

    nextEndDelta(kind) {
      const el = this.getEditor();
      const classifyAt = (text, idx) => this.classify(text[idx], kind);
      const endDeltaFor = (text, pos) => {
        if (pos >= text.length) return 0;
        let i = pos, n = 0;
        while (i < text.length && this.classify(text[i], kind) === "ws") {
          n++; i++;
          if (n > this.MAX_SCAN) return Math.max(n - 1, 0);
        }
        if (i >= text.length) return Math.max(n - 1, 0);
        const t = this.classify(text[i], kind);
        const skippedWs = (i !== pos);
        // Vim `e`: on the last char of a word, go to the end of the NEXT
        // word (not 0). Detect at-end when no ws was skipped and the next
        // char is a different class.
        if (!skippedWs) {
          const atEnd = (pos + 1 >= text.length) || (this.classify(text[pos + 1], kind) !== t);
          if (atEnd) {
            while (i < text.length && this.classify(text[i], kind) === t) { n++; i++; if (n > this.MAX_SCAN) break; }
            while (i < text.length && this.classify(text[i], kind) === "ws") { n++; i++; if (n > this.MAX_SCAN) break; }
            if (i >= text.length) return 0;
            const t2 = this.classify(text[i], kind);
            let m = 0;
            while (i < text.length && this.classify(text[i], kind) === t2) { m++; i++; if (n + m > this.MAX_SCAN) break; }
            return n + Math.max(m - 1, 0);
          }
        }
        let m = 0;
        while (i < text.length && this.classify(text[i], kind) === t) { m++; i++; if (n + m > this.MAX_SCAN) break; }
        return n + Math.max(m - 1, 0);
      };
      if (!el) return 0;
      if (isTextareaOrInput(el)) {
        return endDeltaFor(el.value || "", el.selectionStart);
      }
      if (isContentEditable(el)) {
        const tp = this.textAndPos();
        if (!tp) return 0;
        return endDeltaFor(tp.text, tp.pos);
      }
      return 0;
    }

    prevStartDelta(kind) {
      const el = this.getEditor();
      if (!el) return 0;
      if (isTextareaOrInput(el)) {
        const pos = el.selectionStart, text = el.value;
        if (pos <= 0) return 0;
        let i = pos - 1, n = 0;
        while (i >= 0 && this.classify(text[i], kind) === "ws") { n++; i--; if (n > this.MAX_SCAN || i < 0) return n; }
        if (i < 0) return n;
        const t = this.classify(text[i], kind);
        while (i >= 0 && this.classify(text[i], kind) === t) { n++; i--; if (n > this.MAX_SCAN) break; }
        return n;
      }
      if (isContentEditable(el)) {
        const tp = this.textAndPos();
        if (!tp) return 0;
        const { text, pos } = tp;
        if (pos <= 0) return 0;
        let i = pos - 1, n = 0;
        while (i >= 0 && this.classify(text[i], kind) === "ws") { n++; i--; if (n > this.MAX_SCAN || i < 0) return n; }
        if (i < 0) return n;
        const t = this.classify(text[i], kind);
        while (i >= 0 && this.classify(text[i], kind) === t) { n++; i--; if (n > this.MAX_SCAN) break; }
        return n;
      }
      return 0;
    }

    prevEndDelta(kind) {
      const el = this.getEditor();
      if (!el) return 0;
      if (isTextareaOrInput(el)) {
        const pos = el.selectionStart, text = el.value;
        if (pos <= 0) return 0;
        let i = pos - 1, n = 0;
        while (i >= 0 && this.classify(text[i], kind) === "ws") { n++; i--; if (i < 0 || n > this.MAX_SCAN) return Math.max(n - 1, 0); }
        if (i < 0) return Math.max(n - 1, 0);
        const t = this.classify(text[i], kind);
        while (i >= 0 && this.classify(text[i], kind) === t) { n++; i--; if (n > this.MAX_SCAN) break; }
        return Math.max(n - 1, 0);
      }
      if (isContentEditable(el)) {
        const tp = this.textAndPos();
        if (!tp) return 0;
        const { text, pos } = tp;
        if (pos <= 0) return 0;
        let i = pos - 1, n = 0;
        while (i >= 0 && this.classify(text[i], kind) === "ws") { n++; i--; if (i < 0 || n > this.MAX_SCAN) return Math.max(n - 1, 0); }
        if (i < 0) return Math.max(n - 1, 0);
        const t = this.classify(text[i], kind);
        while (i >= 0 && this.classify(text[i], kind) === t) { n++; i--; if (n > this.MAX_SCAN) break; }
        return Math.max(n - 1, 0);
      }
      return 0;
    }

    findRightDelta(target, till) {
      const el = this.getEditor();
      if (!el) return 0;
      if (isTextareaOrInput(el)) {
        const idx = el.value.indexOf(target, el.selectionStart + 1);
        if (idx === -1) return 0;
        const d = idx - el.selectionStart;
        return till ? Math.max(d - 1, 0) : d;
      }
      if (isContentEditable(el)) {
        const tp = this.textAndPos();
        if (!tp) return 0;
        const idx = tp.text.indexOf(target, tp.pos + 1);
        if (idx === -1) return 0;
        const d = idx - tp.pos;
        return till ? Math.max(d - 1, 0) : d;
      }
      return 0;
    }

    findLeftDelta(target, till) {
      const el = this.getEditor();
      if (!el) return 0;
      if (isTextareaOrInput(el)) {
        const idx = el.value.lastIndexOf(target, el.selectionStart - 1);
        if (idx === -1) return 0;
        const d = el.selectionStart - idx;
        return till ? Math.max(d - 1, 0) : d;
      }
      if (isContentEditable(el)) {
        const tp = this.textAndPos();
        if (!tp) return 0;
        const idx = tp.text.lastIndexOf(target, tp.pos - 1);
        if (idx === -1) return 0;
        const d = tp.pos - idx;
        return till ? Math.max(d - 1, 0) : d;
      }
      return 0;
    }

    matchPairMove(withShift) {
      const pairs = { "(": ")", "[": "]", "{": "}", "<": ">" };
      const rev = { ")": "(", "]": "[", "}": "{", ">": "<" };
      const right = this.peekRightCharN(1);
      const left = this.peekLeftCharN(1);
      let dir, opener, closer;
      // Caret ON an opener -> jump forward to its match.
      if (right && pairs[right]) { dir = "right"; opener = right; closer = pairs[right]; }
      // Caret ON a closer -> jump back to its match.
      else if (right && rev[right]) { dir = "left"; opener = rev[right]; closer = right; }
      // Caret just AFTER a closer -> jump back to its match.
      else if (left && rev[left]) { dir = "left"; opener = rev[left]; closer = left; }
      else return false;
      const tp = this.textAndPos();
      if (!tp) return false;
      const { text, pos } = tp;
      if (dir === "right") {
        let depth = 0;
        for (let i = pos; i < text.length; i++) {
          if (text[i] === opener) depth++;
          else if (text[i] === closer) { depth--; if (depth === 0) { this.moveRightBy(i - pos, withShift); return true; } }
        }
      } else {
        // Scan back over the closer under/before the caret.
        let depth = 0;
        for (let i = pos - (right && rev[right] ? 0 : 1); i >= 0; i--) {
          if (text[i] === closer) depth++;
          else if (text[i] === opener) { depth--; if (depth === 0) { this.moveLeftBy(pos - i, withShift); return true; } }
        }
      }
      return false;
    }

    getSelAndRange() {
      const el = this.getEditor();
      if (!el || !isContentEditable(el)) return { sel: null, range: null };
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return { sel: null, range: null };
      return { sel, range: sel.getRangeAt(0).cloneRange() };
    }

    getFocusPathAndOffset() { return null; }
    resolvePath() { return null; }
    setSelectionByPath() { return false; }
    extractDocumentText() {
      const el = this.getEditor();
      if (!el) return "";
      if (isTextareaOrInput(el)) return el.value;
      if (isContentEditable(el)) return el.textContent || "";
      return "";
    }
  }

  class MotionExecutor {
    constructor(modeAPI, settingsAPI) {
      this.modeAPI = modeAPI;
      this.settingsAPI = settingsAPI || { getUseDisplayLines: () => false };
      this.nav = new TextNavigator(getEditor);
      this.lastFind = null;
      this.vlDisp = null;
      this.registers = { '"': { text: "", type: "char" } };
      this._lastSelType = "char";
      this._lastChange = null;
      this.marks = {};
      this._prevPos = null;
      this._jumpList = [];
      this._jumpIdx = -1;
      this._changeList = [];
      this._changeIdx = -1;
      this._lastExitPos = null;
      this._lastSearch = null;
      this._undoStack = [];
      this._redoStack = [];
      try {
        const key = "vim_last_exit:" + (location && location.pathname ? location.pathname : "");
        const raw = window.localStorage ? window.localStorage.getItem(key) : null;
        if (raw) { const obj = JSON.parse(raw); if (obj && typeof obj.index === "number") this._lastExitPos = obj; }
      } catch (_) {}
    }

    _saveUndoState() {
      const el = getEditor();
      if (!el || !isTextareaOrInput(el)) return;
      this._undoStack.push({ value: el.value, s: el.selectionStart, e: el.selectionEnd });
      this._redoStack = [];
      if (this._undoStack.length > 200) this._undoStack.shift();
    }

    _performUndo() {
      const el = getEditor();
      if (!el || !isTextareaOrInput(el)) { document.execCommand("undo"); return; }
      if (this._undoStack.length === 0) return;
      this._redoStack.push({ value: el.value, s: el.selectionStart, e: el.selectionEnd });
      const st = this._undoStack.pop();
      commitInputValue(el, st.value, st.s, "historyUndo", null);
    }

    _performRedo() {
      const el = getEditor();
      if (!el || !isTextareaOrInput(el)) { document.execCommand("redo"); return; }
      if (this._redoStack.length === 0) return;
      this._undoStack.push({ value: el.value, s: el.selectionStart, e: el.selectionEnd });
      const st = this._redoStack.pop();
      commitInputValue(el, st.value, st.s, "historyRedo", null);
    }

    exec(result) {
      const el = getEditor();
      if (el) { try { el.focus({ preventScroll: true }); } catch (_) { try { el.focus(); } catch (_) {} } }
      if (!el) return;
      if (!result || !result.kind) return;
      switch (result.kind) {
        case "motion": return this.execMotion(result.motion.id, result.count || 1, this.modeAPI.isVisual(), result.motion.args || {});
        case "operator_motion": return this.execOperatorMotion(result);
        case "operator_self": return this.execOperatorSelf(result);
        case "operator_textobj": return this.execOperatorTextObj(result);
        case "visual_textobj": this.selectTextObject(result.textobj); return;
        case "command": {
          const curMode = this.modeAPI.getMode();
          const modes = result.command && result.command.modes;
          if (modes && !modes.includes(curMode)) return;
          return this.execCommand(result.command.id, result);
        }
        default: return;
      }
    }

    setLastChange(change) { this._lastChange = change; }

    replayLastChange(overrideCount) {
      const c = this._lastChange;
      if (!c) return false;
      const useCount = overrideCount && overrideCount > 0 ? overrideCount : c.count || 1;
      switch (c.type) {
        case "operator_motion": return this.execOperatorMotion({ operator: c.operator, motion: c.motion, count: useCount, register: c.register });
        case "operator_self": return this.execOperatorSelf({ operator: c.operator, count: useCount, register: c.register });
        case "operator_textobj": return this.execOperatorTextObj({ operator: c.operator, textobj: c.textobj, register: c.register });
        case "command": return this.execCommand(c.id, { count: useCount, register: c.register, command: { id: c.id, args: c.args || {}, modes: ["normal"] } });
        default: return false;
      }
    }

    _recordJumpBeforeMove() {
      const ci = this.nav.caretIndex();
      if (!ci || ci.index < 0) return;
      this._prevPos = { index: ci.index };
      const last = this._jumpList[this._jumpList.length - 1];
      if (!last || last.index !== ci.index) this._jumpList.push({ index: ci.index });
      this._jumpIdx = this._jumpList.length - 1;
    }

    _recordLastExit() {
      try {
        const ci = this.nav.caretIndex();
        if (!ci || ci.index < 0) return;
        this._lastExitPos = { index: ci.index };
        window.localStorage?.setItem("vim_last_exit:" + (location?.pathname || ""), JSON.stringify(this._lastExitPos));
      } catch (_) {}
    }

    moveToCaretIndex(targetIndex) {
      const ci = this.nav.caretIndex();
      if (!ci || ci.index < 0) return;
      this.nav.setCaretIndex(Math.max(ci.min, Math.min(targetIndex, ci.max)), false);
    }

    jumpToPosition(pos) { if (pos) this.moveToCaretIndex(pos.index); }
    pushChangePosition() { this._saveUndoState(); }

    execMotion(id, count, withShift, args = {}) {
      const S = withShift ? { shift: true } : {};
      const nav = this.nav;
      const curMode = this.modeAPI.getMode();
      if (curMode === "visualLine") {
        if (["left","right","line_start","line_end","first_non_blank","last_non_blank","match_pair"].includes(id) || id.startsWith("word_") || id.startsWith("WORD_") || id.startsWith("find_") || id.startsWith("till_") || id === "repeat_ft" || id === "repeat_ft_back") return;
      }
      switch (id) {
        case "left": repeat(count, () => Adapter.left(S)); break;
        case "right": repeat(count, () => Adapter.right(S)); break;
        case "up": if (curMode === "visualLine") { this.visualLineUp(count); break; } repeat(count, () => Adapter.up(S)); break;
        case "down": if (curMode === "visualLine") { this.visualLineDown(count); break; } repeat(count, () => Adapter.down(S)); break;
        case "display_up": repeat(count, () => Adapter.displayUp(S)); break;
        case "display_down": repeat(count, () => Adapter.displayDown(S)); break;
        case "line_start": Adapter.home(S); break;
        case "first_non_blank": { Adapter.home({ shift: withShift }); const d = nav.firstNonBlankForwardDelta(); if (d > 0) nav.moveRightBy(d, withShift); break; }
        case "first_non_blank_down": { if (count > 1) repeat(count - 1, () => Adapter.down(S)); Adapter.home({ shift: withShift }); const d = nav.firstNonBlankForwardDelta(); if (d > 0) nav.moveRightBy(d, withShift); break; }
        case "line_end": Adapter.end(S); break;
        case "last_non_blank": { Adapter.end(S); let d = 0; while (true) { const ch = nav.peekLeftCharN(d + 1); if (ch == null || !nav.isWhitespace(ch)) break; d++; if (d > nav.MAX_SCAN) break; } if (d > 0) nav.moveLeftBy(d, withShift); break; }
        case "word_start_fwd": for (let i = 0; i < count; i++) { const d = nav.nextStartDelta("word"); if (d > 0) nav.moveRightBy(d, withShift); } break;
        case "WORD_start_fwd": for (let i = 0; i < count; i++) { const d = nav.nextStartDelta("WORD"); if (d > 0) nav.moveRightBy(d, withShift); } break;
        case "word_end_fwd": for (let i = 0; i < count; i++) { const d = nav.nextEndDelta("word"); if (d > 0) nav.moveRightBy(d, withShift); } break;
        case "WORD_end_fwd": for (let i = 0; i < count; i++) { const d = nav.nextEndDelta("WORD"); if (d > 0) nav.moveRightBy(d, withShift); } break;
        case "word_start_back": for (let i = 0; i < count; i++) { const d = nav.prevStartDelta("word"); if (d > 0) nav.moveLeftBy(d, withShift); } break;
        case "WORD_start_back": for (let i = 0; i < count; i++) { const d = nav.prevStartDelta("WORD"); if (d > 0) nav.moveLeftBy(d, withShift); } break;
        case "word_end_back": for (let i = 0; i < count; i++) { const d = nav.prevEndDelta("word"); if (d > 0) nav.moveLeftBy(d, withShift); } break;
        case "WORD_end_back": for (let i = 0; i < count; i++) { const d = nav.prevEndDelta("WORD"); if (d > 0) nav.moveLeftBy(d, withShift); } break;
        case "first_line": Adapter.ctrlHome(S); break;
        case "last_line": Adapter.ctrlEnd(S); break;
        case "screen_top": Adapter.pageUp(S); break;
        case "screen_middle": break;
        case "screen_bottom": Adapter.pageDown(S); break;
        case "scroll_down": Adapter.down({...S}); break;
        case "scroll_up": Adapter.up({...S}); break;
        case "page_up": Adapter.pageUp(S); break;
        case "page_down": Adapter.pageDown(S); break;
        case "half_page_down": Adapter.pageDown(S); break;
        case "half_page_up": Adapter.pageUp(S); break;
        case "match_pair": nav.matchPairMove(withShift); break;
        case "find_next": { const ch = args.char; if (!ch) break; this.lastFind = { dir: "right", target: ch, till: false }; for (let i = 0; i < count; i++) { const d = nav.findRightDelta(ch, false); if (d > 0) nav.moveRightBy(d, withShift); } break; }
        case "till_next": { const ch = args.char; if (!ch) break; this.lastFind = { dir: "right", target: ch, till: true }; for (let i = 0; i < count; i++) { const d = nav.findRightDelta(ch, true); if (d > 0) nav.moveRightBy(d, withShift); } break; }
        case "find_prev": { const ch = args.char; if (!ch) break; this.lastFind = { dir: "left", target: ch, till: false }; for (let i = 0; i < count; i++) { const d = nav.findLeftDelta(ch, false); if (d > 0) nav.moveLeftBy(d, withShift); } break; }
        case "till_prev": { const ch = args.char; if (!ch) break; this.lastFind = { dir: "left", target: ch, till: true }; for (let i = 0; i < count; i++) { const d = nav.findLeftDelta(ch, true); if (d > 0) nav.moveLeftBy(d, withShift); } break; }
        case "paragraph_fwd": repeat(count, () => Adapter.ctrlDown(S)); break;
        case "paragraph_back": repeat(count, () => Adapter.ctrlUp(S)); break;
        case "repeat_ft": { const lf = this.lastFind; if (!lf) break; for (let i = 0; i < count; i++) { const d = lf.dir === "right" ? nav.findRightDelta(lf.target, lf.till) : nav.findLeftDelta(lf.target, lf.till); if (d > 0) { if (lf.dir === "right") nav.moveRightBy(d, withShift); else nav.moveLeftBy(d, withShift); } } break; }
        case "repeat_ft_back": { const lf = this.lastFind; if (!lf) break; for (let i = 0; i < count; i++) { const d = lf.dir === "right" ? nav.findLeftDelta(lf.target, lf.till) : nav.findRightDelta(lf.target, lf.till); if (d > 0) { if (lf.dir === "right") nav.moveLeftBy(d, withShift); else nav.moveRightBy(d, withShift); } } break; }
        default: break;
      }
      // Vim inclusive motions (e/E/f/F/%/ge/gE) include the target char,
      // but shift-selections are end-exclusive. Extend once so visual `ve`
      // and operators `de`/`df(` take the target. Exclusive motions
      // (w/W/t/T/0/^/$) need no adjustment ($ already ends exclusive).
      // Only when a selection was actually made (target found).
      if (withShift) {
        try {
          let inclusive = false;
          if (id === "word_end_fwd" || id === "WORD_end_fwd" ||
              id === "word_end_back" || id === "WORD_end_back" ||
              id === "find_next" || id === "find_prev" ||
              id === "match_pair") {
            inclusive = true;
          } else if (id === "repeat_ft" || id === "repeat_ft_back") {
            const lf = this.lastFind;
            if (lf && !lf.till) inclusive = true;
          }
          if (inclusive) {
            const el = getEditor();
            if (el && isTextareaOrInput(el)) {
              const s = el.selectionStart, e = el.selectionEnd;
              if (e > s && e < (el.value || "").length) {
                try { el.setSelectionRange(s, e + 1); } catch (_) {}
              }
            } else if (el && isContentEditable(el)) {
              try { this.nav.moveRightBy(1, true); } catch (_) {}
            }
          }
        } catch (_) {}
      }
    }

    selectByMotion(motion, count) { this.execMotion(motion.id, count, true, motion.args || {}); }

    applyOperator(op, register) {
      const el = getEditor();
      if (!el) return;
      const setReg = (name, text, type) => {
        const r = name && typeof name === "string" ? name : '"';
        const obj = { text: text || "", type: type || "char" };
        this.registers[r] = obj; this.registers['"'] = obj;
      };
      const getSelText = () => isTextareaOrInput(el) ? el.value.substring(el.selectionStart, el.selectionEnd) : ceSelectionText();

      switch (op) {
        case "delete": { const s = getSelText(); if (s && s.length) { setReg(register, s, this._lastSelType || "char"); this.insertReplacementText(""); } else Adapter.delete({}); return; }
        case "yank": { const s = getSelText(); if (s && s.length) setReg(register, s, this._lastSelType || "char"); try { if (s && s.length && navigator.clipboard) navigator.clipboard.writeText(s).catch(() => {}); else document.execCommand("copy"); } catch (_) {} if (isContentEditable(el)) { const sel = window.getSelection(); if (sel?.collapseToEnd) sel.collapseToEnd(); } else if (isTextareaOrInput(el)) el.setSelectionRange(el.selectionEnd, el.selectionEnd); return; }
        case "change": { const s = getSelText(); if (s && s.length) { setReg(register, s, this._lastSelType || "char"); this.insertReplacementText(""); } else Adapter.delete({}); this.modeAPI.setMode("insert"); return; }
        case "indent": { this.insertReplacementText("\t"); return; }
        case "dedent": { if (isTextareaOrInput(el)) { const pos = el.selectionStart, text = el.value, ls = text.lastIndexOf("\n", pos - 1) + 1; const fix = (rm) => { try { const c = Math.max(ls, pos - rm); el.setSelectionRange(c, c); } catch (_) {} }; if (text[ls] === "\t") { spliceInput(el, ls, ls + 1, "", "deleteContentBackward"); fix(1); } else if (text.substring(ls, ls + 2) === "  ") { spliceInput(el, ls, ls + 2, "", "deleteContentBackward"); fix(2); } } return; }
        case "reindent": { const s = getSelText(); if (!s || !s.length) return; this.insertReplacementText(this.indentBlock(s, this.computeCurrentLineIndent() || "")); return; }
        case "reflow": { const s = getSelText(); if (s && s.length) this.insertReplacementText(this.reflowString(s)); return; }
        case "toggle_case": { const s = getSelText(); if (s && s.length) { this.insertReplacementText(Array.from(s).map(c => { const l = c.toLowerCase(), u = c.toUpperCase(); return c === l && c !== u ? u : c === u && c !== l ? l : c; }).join("")); } return; }
        case "lowercase": { const s = getSelText(); if (s && s.length) this.insertReplacementText(s.toLowerCase()); return; }
        case "uppercase": { const s = getSelText(); if (s && s.length) this.insertReplacementText(s.toUpperCase()); return; }
        default: return;
      }
    }

    execOperatorMotion(result) {
      const { operator, count = 1, opCount } = result;
      let motion = result.motion;
      const times = opCount || count || 1;
      this._lastSelType = "char";
      // Vim quirk: 'cw' and 'cW' behave like 'ce' and 'cE' so trailing
      // whitespace is preserved (matches vim_docs_executor.js).
      if (operator === "change") {
        if (motion && motion.id === "word_start_fwd") {
          motion = { id: "word_end_fwd", args: motion.args || {} };
        } else if (motion && motion.id === "WORD_start_fwd") {
          motion = { id: "WORD_end_fwd", args: motion.args || {} };
        }
      }
      this.selectByMotion(motion, times);
      // Inclusive adjustment lives in execMotion (withShift): shift-selections
      // are end-exclusive, so `e`/`f`/`%` extend by one there. No extra work
      // here to avoid double-counting.
      setTimeout(() => this.applyOperator(operator, result.register), 20);
      this.setLastChange({ type: "operator_motion", operator, motion: { id: motion.id, args: motion.args || {} }, count: times, register: result.register });
    }

    // Park the textarea caret on the first non-blank of its line
    // (line start when the line is empty), like Vim after dd/>>/p.
    _parkOnFirstNonBlank() {
      try {
        const el = getEditor();
        if (!el || !isTextareaOrInput(el)) return;
        const text = el.value || "";
        const pos = Math.max(0, Math.min(el.selectionStart, text.length));
        const ls = text.lastIndexOf("\n", pos - 1) + 1;
        let le = text.indexOf("\n", pos); if (le === -1) le = text.length;
        let p = ls;
        while (p < le && (text[p] === " " || text[p] === "\t")) p++;
        try { el.setSelectionRange(p, p); } catch (_) {}
      } catch (_) {}
    }

    // Whole-line range [ls, le) for `count` lines at the caret, Vim-style:
    // the range includes the trailing newline except on the last line.
    // Returns null when there is no editor.
    _wholeLineRange(count) {
      try {
        const el = getEditor();
        if (!el) return null;
        if (isTextareaOrInput(el)) {
          const text = el.value || "";
          const pos = Math.max(0, Math.min(el.selectionStart, text.length));
          const ls = text.lastIndexOf("\n", pos - 1) + 1;
          let le = text.indexOf("\n", pos); if (le === -1) le = text.length;
          for (let i = 1; i < (count || 1); i++) { const ne = text.indexOf("\n", le + 1); le = ne === -1 ? text.length : ne; }
          const hasBreak = le < text.length;
          if (hasBreak) le++;
          return { ls, le, hasBreak, text: text.substring(ls, le) };
        }
        const tp = this.nav.textAndPos();
        if (!tp) return null;
        const { text, pos } = tp;
        const ls = text.lastIndexOf("\n", pos - 1) + 1;
        let le = text.indexOf("\n", pos); if (le === -1) le = text.length;
        for (let i = 1; i < (count || 1); i++) { const ne = text.indexOf("\n", le + 1); le = ne === -1 ? text.length : ne; }
        const hasBreak = le < text.length;
        if (hasBreak) le++;
        return { ls, le, hasBreak, text: text.substring(ls, le), tp };
      } catch (_) {}
      return null;
    }

    // Contenteditable: after a whole-line delete, drop up to `maxRemove`
    // empty blocks at the caret. DOM ranges remove text but not structural
    // breaks, so without this dd blanks lines instead of removing them.
    // Never removes the editor's last surviving block.
    _ceCollapseEmptyBlocks(maxRemove) {
      try {
        const el = getEditor();
        if (!el || !isContentEditable(el)) return;
        let removed = 0, guard = 0;
        while (removed < maxRemove && guard++ < 32) {
          const sel = window.getSelection();
          if (!sel || !sel.rangeCount) return;
          let node = sel.getRangeAt(0).startContainer;
          if (!node) return;
          if (node.nodeType === 3) node = node.parentNode;
          while (node && node !== el && !(node.nodeType === 1 && ceIsBlock(node))) {
            try { node = node.parentNode; } catch (_) { node = null; }
          }
          if (!node || node === el) return;
          let empty = true;
          try {
            if ((node.textContent || "").length > 0) empty = false;
            else {
              const kids = node.childNodes || [];
              for (let i = 0; i < kids.length; i++) {
                if (kids[i].nodeType === 1 && kids[i].tagName !== "BR") { empty = false; break; }
              }
            }
          } catch (_) { empty = false; }
          if (!empty) return;
          // Keep one block: an emptied editor still needs a caret home.
          let others = false;
          try {
            const parent = node.parentNode;
            if (parent) {
              const sibs = parent.childNodes || [];
              for (let i = 0; i < sibs.length; i++) {
                if (sibs[i] === node) continue;
                const s = sibs[i];
                if (s.nodeType === 3 ? (s.nodeValue || "").length > 0 : true) { others = true; break; }
              }
              if (!others && parent !== el) others = true;
            }
          } catch (_) { others = false; }
          if (!others) return;
          try {
            const parent = node.parentNode;
            let idx = 0;
            try { idx = Array.prototype.indexOf.call(parent.childNodes, node); } catch (_) {}
            parent.removeChild(node);
            try { fireInputEvents(el, "deleteContentBackward", null); } catch (_) {}
            removed++;
            try {
              const r = document.createRange();
              r.setStart(parent, Math.max(0, Math.min(idx, parent.childNodes.length)));
              r.collapse(true);
              sel.removeAllRanges();
              sel.addRange(r);
            } catch (_) {}
          } catch (_) { return; }
        }
      } catch (_) {}
    }

    // Contenteditable: after cc over N > 1 lines, keep the caret's empty
    // line and drop up to `n` empty block siblings after it.
    _ceDropEmptyBlocksAfterCaret(n) {
      try {
        const el = getEditor();
        if (!el || !isContentEditable(el) || !(n > 0)) return;
        for (let i = 0; i < n; i++) {
          const sel = window.getSelection();
          if (!sel || !sel.rangeCount) return;
          let node = sel.getRangeAt(0).startContainer;
          if (!node) return;
          if (node.nodeType === 3) node = node.parentNode;
          while (node && node !== el && !(node.nodeType === 1 && ceIsBlock(node))) {
            try { node = node.parentNode; } catch (_) { node = null; }
          }
          if (!node || node === el) return;
          let sib = null;
          try {
            let s = node.nextSibling;
            while (s) {
              if (s.nodeType === 1 && ceIsBlock(s)) { sib = s; break; }
              if (s.nodeType === 1 || ((s.nodeValue || "").length > 0)) break;
              s = s.nextSibling;
            }
          } catch (_) { sib = null; }
          if (!sib) return;
          let empty = true;
          try {
            if ((sib.textContent || "").length > 0) empty = false;
            else {
              const kids = sib.childNodes || [];
              for (let k = 0; k < kids.length; k++) {
                if (kids[k].nodeType === 1 && kids[k].tagName !== "BR") { empty = false; break; }
              }
            }
          } catch (_) { empty = false; }
          if (!empty) return;
          try { sib.parentNode && sib.parentNode.removeChild(sib); } catch (_) { return; }
          try { fireInputEvents(el, "deleteContentBackward", null); } catch (_) {}
        }
      } catch (_) {}
    }

    execOperatorSelf(result) {
      // Vim: counts before and after the operator both apply (2dd and d2d
      // delete two lines). The parser splits them into count/opCount.
      const { operator, count = 1 } = result;
      const times = result.opCount || count || 1;
      const el = getEditor();
      if (!el) return;
      const regName = result.register && typeof result.register === "string" ? result.register : '"';
      const setLineReg = (s) => {
        if (!s || !s.length) return;
        const obj = { text: s, type: "line" };
        this.registers[regName] = obj; this.registers['"'] = obj;
      };
      if (operator === "delete") {
        const left = this.nav.peekLeftCharN(1), right = this.nav.peekRightCharN(1);
        if ((left == null || this.nav.isNewline(left)) && (right == null || this.nav.isNewline(right))) {
          this._saveUndoState();
          Adapter.backspace({}); this._lastSelType = "line";
          this._parkOnFirstNonBlank();
          this.setLastChange({ type: "operator_self", operator, count: times, register: result.register }); return;
        }
      }
      const range = this._wholeLineRange(times);
      if (!range) return;
      this._lastSelType = "line";
      setLineReg(range.text);
      const done = (extra) => {
        this.setLastChange(Object.assign({ type: "operator_self", operator, count: times, register: result.register }, extra || {}));
      };
      switch (operator) {
        case "delete": {
          this._saveUndoState();
          if (isTextareaOrInput(el)) {
            // Last line carries no trailing newline: extend over the
            // preceding one so we delete exactly one line (Vim never eats
            // the neighbor's break, and never leaves one behind).
            let { ls, le } = range;
            if (!range.hasBreak && ls > 0 && el.value[ls - 1] === "\n") ls -= 1;
            if (le > ls) spliceInput(el, ls, le, "", "deleteContentBackward");
            this._parkOnFirstNonBlank();
          } else if (isContentEditable(el)) {
            if (range.le > range.ls) {
              const tp = range.tp || this.nav.textAndPos();
              if (tp) this.nav.selectModelRange(tp, range.ls, range.le, false);
              Adapter.backspace({});
              // DOM ranges remove text but not structural breaks: the
              // emptied <p>/<div> linger as blank lines. Re-anchor the caret
              // onto the emptied line (deletion leaves it at the range end
              // in some engines) and collapse the leftovers so dd removes
              // lines instead of blanking them.
              try {
                const fresh = this.nav.textAndPos();
                if (fresh) {
                  const at = Math.min(range.ls, fresh.text.length);
                  this.nav.selectModelRange(fresh, at, at, false);
                }
              } catch (_) {}
              this._ceCollapseEmptyBlocks(times);
            }
          }
          done(); return;
        }
        case "yank": {
          // No text change: leave the caret on the yanked line.
          if (isTextareaOrInput(el)) {
            try { el.setSelectionRange(range.ls, range.ls); } catch (_) {}
          } else if (isContentEditable(el)) {
            const tp = range.tp || this.nav.textAndPos();
            if (tp) this.nav.selectModelRange(tp, range.ls, range.ls, false);
          }
          done(); return;
        }
        case "change": {
          this._saveUndoState();
          if (isTextareaOrInput(el)) {
            // Empty the lines but keep them (middle lines keep their break).
            spliceInput(el, range.ls, range.le, range.hasBreak ? "\n" : "", "insertReplacementText");
            try { el.setSelectionRange(range.ls, range.ls); } catch (_) {}
          } else if (isContentEditable(el)) {
            if (range.le > range.ls) {
              const tp = range.tp || this.nav.textAndPos();
              if (tp) this.nav.selectModelRange(tp, range.ls, range.le, false);
              Adapter.backspace({});
              // Re-anchor the caret onto the kept empty line, then drop any
              // extras after it (Ncc with N > 1 keeps exactly one).
              try {
                const fresh = this.nav.textAndPos();
                if (fresh) {
                  const at = Math.min(range.ls, fresh.text.length);
                  this.nav.selectModelRange(fresh, at, at, false);
                }
              } catch (_) {}
              this._ceDropEmptyBlocksAfterCaret(Math.max(0, times - 1));
            }
          }
          this.modeAPI.setMode("insert");
          done(); return;
        }
        case "indent":
        case "dedent":
        case "reindent":
        case "toggle_case":
        case "lowercase":
        case "uppercase": {
          const s = range.text;
          if (!s || !s.length) { done(); return; }
          let out = s;
          if (operator === "indent") {
            out = s.split("\n").map((ln, i, arr) => (i === arr.length - 1 && ln === "" ? ln : "\t" + ln)).join("\n");
          } else if (operator === "dedent") {
            out = s.split("\n").map((ln) => ln.startsWith("\t") ? ln.slice(1) : ln.replace(/^ {1,2}/, "")).join("\n");
          } else if (operator === "reindent") {
            // Reuse the visual-mode rule (first line's indent wins) so ==
            // matches the rest of the engine instead of deleting text.
            if (isTextareaOrInput(el)) {
              try { el.setSelectionRange(range.ls, range.le); } catch (_) {}
              out = this.indentBlock(s, this.computeCurrentLineIndent() || "");
            } else {
              out = s;
            }
          } else if (operator === "lowercase") {
            out = s.toLowerCase();
          } else if (operator === "uppercase") {
            out = s.toUpperCase();
          } else {
            out = Array.from(s).map(c => { const l = c.toLowerCase(), u = c.toUpperCase(); return c === l && c !== u ? u : c === u && c !== l ? l : c; }).join("");
          }
          this._saveUndoState();
          if (isTextareaOrInput(el)) {
            spliceInput(el, range.ls, range.le, out, "insertReplacementText");
            // splice leaves the caret after the replaced region; rewind to
            // the first line so we park on it, like Vim.
            try { el.setSelectionRange(range.ls, range.ls); } catch (_) {}
            this._parkOnFirstNonBlank();
          } else if (isContentEditable(el)) {
            const tp = range.tp || this.nav.textAndPos();
            if (tp) this.nav.selectModelRange(tp, range.ls, range.le, false);
            this.insertReplacementText(out);
          }
          done(); return;
        }
        default: {
          done(); return;
        }
      }
    }

    execOperatorTextObj(result) {
      const { operator, textobj } = result;
      if (!textobj?.type) return;
      if (!this.selectTextObject(textobj)) return;
      this._lastSelType = (textobj.type === "paragraph_inner" || textobj.type === "paragraph_around") ? "line" : "char";
      setTimeout(() => this.applyOperator(operator, result.register), 10);
      this.setLastChange({ type: "operator_textobj", operator, textobj, register: result.register });
    }

    selectTextObject(textobj) {
      const t = textobj.type, del = textobj.delims || [];
      switch (t) {
        case "word": return this.selectWordLike("word", false);
        case "word_around": return this.selectWordLike("word", true);
        case "WORD": return this.selectWordLike("WORD", false);
        case "WORD_around": return this.selectWordLike("WORD", true);
        case "paren_inner": return this.selectDelims(del[0] || "(", del[1] || ")", false);
        case "paren_around": return this.selectDelims(del[0] || "(", del[1] || ")", true);
        case "quote_inner": return del[0] ? this.selectQuote(del[0], false) : false;
        case "quote_around": return del[0] ? this.selectQuote(del[0], true) : false;
        case "paragraph_inner": return this.selectParagraph(false);
        case "paragraph_around": return this.selectParagraph(true);
        case "sentence_inner": return this.selectSentence(false);
        case "sentence_around": return this.selectSentence(true);
        case "tag_inner": return this.selectTag(false);
        case "tag_around": return this.selectTag(true);
        default: return false;
      }
    }

    selectWordLike(kind, around) {
      const nav = this.nav;
      const cu = nav.peekRightCharN(1), cb = nav.peekLeftCharN(1);
      const isAtStart = cu && nav.classify(cu, kind) !== "ws" && (!cb || nav.classify(cb, kind) === "ws" || nav.classify(cb, kind) !== nav.classify(cu, kind));
      if (!isAtStart) { const d = nav.prevStartDelta(kind); if (d > 0) nav.moveLeftBy(d, false); }
      let r = nav.nextEndDelta(kind); if (r <= 0) return false;
      nav.moveRightBy(r, true);
      if (around) { let ex = 0, g = 0; while (true) { const ch = nav.peekRightCharN(ex + 1); if (ch == null || !nav.isWhitespace(ch)) break; ex++; if (++g > nav.MAX_SCAN) break; } if (ex > 0) nav.moveRightBy(ex, true); }
      return true;
    }

    selectDelims(open, close, includeDelims) {
      const ld = this.findEnclosingOpenDelta(open, close);
      if (ld == null) return false;
      this.nav.moveLeftBy(ld, false);
      if (!includeDelims) this.nav.moveRightBy(1, false);
      const rd = this.findMatchingCloseFromHere(open, close, includeDelims);
      if (rd == null) return false;
      this.nav.moveRightBy(rd, true);
      return true;
    }

    selectQuote(q, includeDelim) {
      const el = getEditor();
      if (!el) return false;
      const tp = this.nav.textAndPos();
      if (!tp) return false;
      const { text, pos } = tp;
      let li = -1; for (let i = pos - 1; i >= 0; i--) { if (text[i] === q) { li = i; break; } }
      if (li === -1) return false;
      let ri = -1; for (let i = li + 1; i < text.length; i++) { if (text[i] === q) { ri = i; break; } }
      if (ri === -1) return false;
      return this.nav.selectModelRange(tp, includeDelim ? li : li + 1, includeDelim ? ri + 1 : ri, false);
    }

    selectParagraph(around) {
      const el = getEditor();
      if (!el) return false;
      const tp = this.nav.textAndPos();
      if (!tp) return false;
      const { text, pos } = tp;
      if (isTextareaOrInput(el)) {
        const ls = text.lastIndexOf("\n", pos - 1) + 1;
        let ps = ls; for (let i = ls - 1; i >= 1; i--) { if (text[i] === "\n" && text[i - 1] === "\n") { ps = i + 1; break; } }
        if (ls === 0) ps = 0;
        let pe = text.indexOf("\n\n", pos); if (pe === -1) pe = text.length;
        if (!around) { while (ps < pe && text[ps] === "\n") ps++; }
        el.setSelectionRange(ps, pe); return true;
      }
      // Rich text: each block is a paragraph (model joins blocks with \n).
      const ls = text.lastIndexOf("\n", pos - 1) + 1;
      let le = text.indexOf("\n", pos); if (le === -1) le = text.length;
      if (around && le < text.length) le++;
      return this.nav.selectModelRange(tp, ls, le, false);
    }

    selectSentence(around) {
      const isEnd = c => c === "." || c === "!" || c === "?";
      const el = getEditor();
      if (!el) return false;
      const tp = this.nav.textAndPos();
      if (!tp) return false;
      const { text, pos } = tp;
      let s = pos; for (let i = pos - 1; i >= 0; i--) { if (isEnd(text[i])) { s = i + 1; break; } if (i === 0) s = 0; }
      let e = pos; for (let i = pos; i < text.length; i++) { if (isEnd(text[i])) { e = i + 1; break; } if (i === text.length - 1) e = text.length; }
      if (!around) { while (s < e && text[s] === " ") s++; }
      return this.nav.selectModelRange(tp, s, e, false);
    }

    selectTag(around) {
      const el = getEditor();
      if (!el) return false;
      if (isTextareaOrInput(el)) {
        const tp = this.nav.textAndPos();
        if (!tp) return false;
        const { text, pos } = tp;
        let li = -1; for (let i = pos - 1; i >= 0; i--) { if (text[i] === "<") { li = i; break; } }
        if (li === -1) return false;
        let tn = ""; for (let i = li + 1; i < text.length; i++) { if (/\s|>|\//.test(text[i])) break; tn += text[i]; }
        if (!tn) return false;
        const op = `<${tn}`, cp = `</${tn}`;
        let depth = 0, ri = -1;
        for (let i = li; i < text.length; i++) {
          if (text.substring(i, i + op.length) === op) depth++;
          if (text.substring(i, i + cp.length) === cp) { if (depth === 1) { ri = i + cp.length; break; } depth--; }
        }
        if (ri === -1) return false;
        el.setSelectionRange(around ? li : li + 1, around ? ri : ri - 1); return true;
      }
      // Rich text has real elements: it/vit select the nearest ancestor
      // element's contents (inner) or the element itself (around).
      if (isContentEditable(el)) {
        try {
          const sel = window.getSelection();
          if (!sel || sel.rangeCount === 0) return false;
          let node = sel.getRangeAt(0).startContainer;
          if (node.nodeType === 3) node = node.parentNode;
          while (node && node !== el && node.nodeType === 1) {
            if (/^(B|I|U|EM|STRONG|A|CODE|SPAN|P|DIV|LI|H1|H2|H3|H4|H5|H6|BLOCKQUOTE|PRE|TD|TH)$/.test(node.tagName)) {
              const r = document.createRange();
              if (around) r.selectNode(node);
              else r.selectNodeContents(node);
              sel.removeAllRanges();
              sel.addRange(r);
              return true;
            }
            node = node.parentNode;
          }
        } catch (_) {}
        return false;
      }
      return false;
    }

    findEnclosingOpenDelta(open, close) {
      const tp = this.nav.textAndPos();
      if (!tp) return null;
      const { text, pos } = tp;
      let depth = 0;
      for (let i = pos - 1; i >= 0; i--) { if (text[i] === close) depth++; else if (text[i] === open) { if (depth === 0) return pos - i; depth--; } }
      return null;
    }

    findMatchingCloseFromHere(open, close, includeDelims) {
      const tp = this.nav.textAndPos();
      if (!tp) return null;
      const { text, pos } = tp;
      let depth = 0;
      for (let i = pos; i < text.length; i++) { if (text[i] === open) depth++; else if (text[i] === close) { if (depth === 0) return includeDelims ? i - pos + 1 : i - pos; depth--; } }
      return null;
    }

    selectWholeLines(count) {
      const el = getEditor();
      if (!el) return;
      const tp = this.nav.textAndPos();
      if (!tp) return;
      const { text, pos } = tp;
      if (isTextareaOrInput(el)) {
        const ls = text.lastIndexOf("\n", pos - 1) + 1;
        let le = text.indexOf("\n", pos); if (le === -1) le = text.length;
        for (let i = 1; i < count; i++) { const ne = text.indexOf("\n", le + 1); le = ne === -1 ? text.length : ne; }
        if (le < text.length) le++;
        el.setSelectionRange(ls, le);
      } else if (isContentEditable(el)) {
        const ls = text.lastIndexOf("\n", pos - 1) + 1;
        let le = text.indexOf("\n", pos); if (le === -1) le = text.length;
        for (let i = 1; i < count; i++) { const ne = text.indexOf("\n", le + 1); le = ne === -1 ? text.length : ne; }
        if (le < text.length) le++;
        this.nav.selectModelRange(tp, ls, le, false);
      }
    }

    // Vim-faithful insert-exit: the cursor moves left 1 unless at the
    // beginning of a line/document — clamped to LINE start so Esc at column
    // 0 never jumps to the previous line. Textarea/input carets are driven
    // ONLY via selectionStart (never via the document selection, which pages
    // like Google keep alive in overlays and which yanked carets to 0).
    _parkCaretAfterInsert() {
      try {
        const el = getEditor();
        if (!el) return;
        if (isTextareaOrInput(el)) {
          const pos = typeof el.selectionStart === "number" ? el.selectionStart : 0;
          const text = el.value || "";
          const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
          if (pos > 0 && pos > lineStart) {
            const np = pos - 1;
            try { el.setSelectionRange(np, np); } catch (_) {}
          } else {
            try { el.setSelectionRange(pos, pos); } catch (_) {}
          }
        } else if (isContentEditable(el)) {
          collapseDocSelectionToEnd();
          try {
            const ch = this.nav.peekLeftCharN(1);
            if (ch != null && !this.nav.isNewline(ch)) Adapter.left({});
          } catch (_) {}
        }
      } catch (_) {}
    }

    execCommand(id, result) {
      const count = result.count || 1;
      switch (id) {
        case "insert_temp_normal": {
          if (this.modeAPI?.setTempNormal) this.modeAPI.setTempNormal(true);
          this.modeAPI.setMode("normal");
          return;
        }
        case "focus_next": {
          if (this.modeAPI?.focusNext) this.modeAPI.focusNext();
          return;
        }
        case "open_overlay": {
          // Manual escape hatch: open the overlay editor for the current
          // field regardless of framework auto-detection (Ctrl+;).
          if (this.modeAPI?.openOverlay) this.modeAPI.openOverlay();
          return;
        }
        case "insert_before": this._saveUndoState(); this.modeAPI.setMode("insert"); return;
        case "insert_start_line": Adapter.home({}); this._saveUndoState(); this.modeAPI.setMode("insert"); return;
        case "append_after": Adapter.right({}); this._saveUndoState(); this.modeAPI.setMode("insert"); return;
        case "append_end_line": Adapter.end({}); this._saveUndoState(); this.modeAPI.setMode("insert"); return;
        case "open_below": {
          const el = getEditor();
          if (isTextareaOrInput(el)) {
            this._saveUndoState(); const pos = el.selectionStart, text = el.value;
            const le = text.indexOf("\n", pos); const ip = le === -1 ? text.length : le;
            spliceInput(el, ip, ip, "\n", "insertLineBreak");
          } else { Adapter.end({}); document.execCommand("insertText", false, "\n"); }
          this.modeAPI.setMode("insert"); return;
        }
        case "open_above": {
          const el = getEditor();
          if (isTextareaOrInput(el)) {
            this._saveUndoState(); const pos = el.selectionStart, text = el.value;
            const ls = text.lastIndexOf("\n", pos - 1) + 1;
            spliceInput(el, ls, ls, "\n", "insertLineBreak");
          } else { Adapter.home({}); document.execCommand("insertText", false, "\n"); Adapter.up({}); }
          this.modeAPI.setMode("insert"); return;
        }
        case "append_end_word": this.execMotion("word_end_fwd", 1, false); this._saveUndoState(); this.modeAPI.setMode("insert"); return;
        case "insert_register": {
          const name = result.command?.args?.char || '"';
          const reg = this.registers[name] || this.registers['"'];
          const tv = typeof reg === "string" ? reg : reg?.text || "";
          if (tv) this.insertReplacementText(tv);
          return;
        }
        case "replace_char": {
          const ch = result.command?.args?.char; if (!ch) return;
          const times = Math.max(1, result.count || 1);
          const el = getEditor();
          if (isTextareaOrInput(el)) {
            this._saveUndoState(); const s = el.selectionStart;
            spliceInput(el, s, Math.min(s + times, el.value.length), ch.repeat(times), "insertReplacementText");
            try { el.setSelectionRange(s, s + times); } catch (_) {}
          } else { repeat(times, () => Adapter.right({ shift: true })); this.insertReplacementText(ch.repeat(times)); }
          this.setLastChange({ type: "command", id: "replace_char", count: times, args: { char: ch } }); return;
        }
        case "replace_mode": { this._saveUndoState(); if (this.modeAPI?.setReplaceMode) this.modeAPI.setReplaceMode(true); this.modeAPI.setMode("insert"); return; }
        case "join_lines": { for (let i = 0; i < count; i++) this.joinOnce(true); this.setLastChange({ type: "command", id: "join_lines", count }); return; }
        case "join_lines_no_space": { for (let i = 0; i < count; i++) this.joinOnce(false); this.setLastChange({ type: "command", id: "join_lines_no_space", count }); return; }
        case "substitute_char": {
          this._saveUndoState(); const el = getEditor();
          if (isTextareaOrInput(el)) { const s = el.selectionStart; if (s < el.value.length) { spliceInput(el, s, s + 1, "", "deleteContentForward"); } }
          else { repeat(count, () => Adapter.right({ shift: true })); this.insertReplacementText(""); }
          this.modeAPI.setMode("insert"); this.setLastChange({ type: "command", id: "substitute_char", count }); return;
        }
        case "insert_replace_char": {
          const ch = result.command?.args?.char; if (!ch) return;
          const next = this.nav.peekRightCharN(1);
          if (next != null && !this.nav.isNewline(next)) { this._saveUndoState(); Adapter.delete({}); }
          this.insertReplacementText(ch);
          this.setLastChange({ type: "command", id: "insert_replace_char", args: { char: ch }, count: 1 }); return;
        }
        case "substitute_line": {
          this.selectWholeLines(count);
          const sel = getEditor();
          // Empty the lines but keep them (Vim S never joins lines).
          let keep = "";
          try {
            const cur = sel && isTextareaOrInput(sel)
              ? sel.value.substring(sel.selectionStart, sel.selectionEnd)
              : ceSelectionText();
            keep = cur && cur.endsWith("\n") ? "\n" : "";
          } catch (_) { keep = ""; }
          this._saveUndoState();
          this.insertReplacementText(keep);
          try {
            if (sel && isTextareaOrInput(sel)) {
              // insertReplacementText leaves the caret after `keep`; pull it
              // back onto the emptied line.
              const at = Math.max(0, Math.min(sel.selectionStart - keep.length, sel.value.length));
              sel.setSelectionRange(at, at);
            }
          } catch (_) {}
          this.modeAPI.setMode("insert"); this.setLastChange({ type: "command", id: "substitute_line", count }); return;
        }
        case "change_to_eol": { Adapter.end({ shift: true }); if (count > 1) repeat(count - 1, () => { Adapter.right({ shift: true }); Adapter.end({ shift: true }); }); this._lastSelType = "char"; this.applyOperator("change", result.register); this.setLastChange({ type: "command", id: "change_to_eol", count }); return; }
        case "delete_to_eol": { Adapter.end({ shift: true }); if (count > 1) repeat(count - 1, () => { Adapter.right({ shift: true }); Adapter.end({ shift: true }); }); this._lastSelType = "char"; this.applyOperator("delete", result.register); this.setLastChange({ type: "command", id: "delete_to_eol", count }); return; }
        case "yank_to_eol": { Adapter.end({ shift: true }); if (count > 1) repeat(count - 1, () => { Adapter.right({ shift: true }); Adapter.end({ shift: true }); }); this._lastSelType = "char"; this.applyOperator("yank", result.register); return; }
        case "delete_char": this.pushChangePosition(); repeat(count, () => Adapter.delete({})); this.setLastChange({ type: "command", id: "delete_char", count }); return;
        case "delete_char_back": this.pushChangePosition(); repeat(count, () => Adapter.backspace({})); this.setLastChange({ type: "command", id: "delete_char_back", count }); return;
        case "toggle_case_char": {
          this.pushChangePosition(); this._lastSelType = "char";
          const el = getEditor();
          if (isTextareaOrInput(el)) { const p = el.selectionStart; if (p < el.value.length) { const c = el.value[p], l = c.toLowerCase(), u = c.toUpperCase(); spliceInput(el, p, p + 1, (c === l && c !== u ? u : c === u && c !== l ? l : c), "insertReplacementText"); } }
          else { repeat(count, () => Adapter.right({ shift: true })); setTimeout(() => this.applyOperator("toggle_case", result.register), 20); setTimeout(() => Adapter.left({}), 20); }
          this.setLastChange({ type: "command", id: "toggle_case_char", count }); return;
        }

        case "paste_after": this.pasteFromRegister(result.register, { before: false, times: count }); this.setLastChange({ type: "command", id: "paste_after", count, register: result.register }); return;
        case "paste_before": this.pasteFromRegister(result.register, { before: true, times: count }); this.setLastChange({ type: "command", id: "paste_before", count, register: result.register }); return;
        case "paste_after_cursor_stay": this.pasteFromRegister(result.register, { before: false, cursorStay: true, times: count }); this.setLastChange({ type: "command", id: "paste_after_cursor_stay", count, register: result.register }); return;
        case "paste_before_cursor_stay": this.pasteFromRegister(result.register, { before: true, cursorStay: true, times: count }); this.setLastChange({ type: "command", id: "paste_before_cursor_stay", count, register: result.register }); return;
        case "paste_adjust_indent": this.pasteFromRegister(result.register, { before: false, adjustIndent: true, times: count }); this.setLastChange({ type: "command", id: "paste_adjust_indent", count, register: result.register }); return;
        case "increment": this.incDecNumber(count); this.setLastChange({ type: "command", id: "increment", count }); return;
        case "decrement": this.incDecNumber(-count); this.setLastChange({ type: "command", id: "decrement", count }); return;
        case "undo": for (let i = 0; i < count; i++) this._performUndo(); return;
        case "undo_line": this._performUndo(); return;
        case "redo": for (let i = 0; i < count; i++) this._performRedo(); return;
        case "repeat": this.replayLastChange(result.count || 1); return;
        case "set_mark": { const ch = result.command?.args?.char; const ci = this.nav.caretIndex(); if (!ch || !ci || ci.index < 0) return; this.marks[ch] = { index: ci.index }; return; }
        case "jump_mark": { const ch = result.command?.args?.char; const m = ch && this.marks[ch]; if (!m) return; this._recordJumpBeforeMove(); this.moveToCaretIndex(m.index); return; }
        case "jump_prev_pos": { if (!this._prevPos?.index == null) return; const cur = this.nav.caretIndex(); if (cur?.index === this._prevPos.index) return; this._recordJumpBeforeMove(); this.moveToCaretIndex(this._prevPos.index); return; }
        case "jump_older": { if (!this._jumpList?.length || this._jumpIdx <= 0) return; this._jumpIdx--; this.jumpToPosition(this._jumpList[this._jumpIdx]); return; }
        case "jump_newer": { if (!this._jumpList?.length || this._jumpIdx >= this._jumpList.length - 1) return; this._jumpIdx++; this.jumpToPosition(this._jumpList[this._jumpIdx]); return; }
        case "change_prev": { if (!this._changeList?.length || this._changeIdx <= 0) return; this._recordJumpBeforeMove(); this._changeIdx--; this.jumpToPosition(this._changeList[this._changeIdx]); return; }
        case "change_next": { if (!this._changeList?.length || this._changeIdx >= this._changeList.length - 1) return; this._recordJumpBeforeMove(); this._changeIdx++; this.jumpToPosition(this._changeList[this._changeIdx]); return; }
        case "jump_last_change": { if (!this._changeList?.length) return; this._recordJumpBeforeMove(); this.jumpToPosition(this._changeList[this._changeList.length - 1]); return; }
        case "jump_last_edit_pos": { if (!this._changeList?.length) return; this._recordJumpBeforeMove(); this.jumpToPosition(this._changeList[this._changeList.length - 1]); return; }
        case "jump_last_exit": {
          if (!this._lastExitPos) { try { const k = "vim_last_exit:" + (location?.pathname || ""); const r = window.localStorage?.getItem(k); if (r) this._lastExitPos = JSON.parse(r); } catch (_) {} }
          if (!this._lastExitPos || typeof this._lastExitPos.index !== "number") return;
          this._recordJumpBeforeMove(); this.jumpToPosition(this._lastExitPos); return;
        }
        case "record_last_exit": this._recordLastExit(); return;
        case "search_forward": case "search_backward": {
          const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", code: "KeyF", bubbles: true, ctrlKey: !isMac, metaKey: isMac }));
          return;
        }
        case "visual_mode": { const cm = this.modeAPI.getMode(); if (cm === "visual") { collapseDocSelectionToEnd(); this.modeAPI.setMode("normal"); } else this.modeAPI.setMode("visual"); return; }
        case "visual_line_mode": {
          const cm = this.modeAPI.getMode();
          if (cm === "visualLine") { collapseDocSelectionToEnd(); this.modeAPI.setMode("normal"); this.vlDisp = null; }
          else { this.modeAPI.setMode("visualLine"); Adapter.home({}); Adapter.end({ shift: true }); this.vlDisp = 0; }
          return;
        }
        case "visual_other_end": { const sel = window.getSelection(); if (sel?.rangeCount) { try { const aN = sel.anchorNode, aO = sel.anchorOffset, fN = sel.focusNode, fO = sel.focusOffset; if (aN && fN) sel.setBaseAndExtent(fN, fO, aN, aO); } catch (_) {} } return; }
        case "visual_yank": { this._lastSelType = this.modeAPI.getMode() === "visualLine" ? "line" : "char"; this.applyOperator("yank", result.register); this.modeAPI.setMode("normal"); return; }
        case "visual_delete": { this._lastSelType = this.modeAPI.getMode() === "visualLine" ? "line" : "char"; this.applyOperator("delete", result.register); this.modeAPI.setMode("normal"); return; }
        case "visual_change": { this._lastSelType = this.modeAPI.getMode() === "visualLine" ? "line" : "char"; this.applyOperator("change", result.register); return; }
        case "visual_indent": { this._lastSelType = this.modeAPI.getMode() === "visualLine" ? "line" : "char"; this.applyOperator("indent", result.register); this.modeAPI.setMode("normal"); return; }
        case "visual_dedent": { this._lastSelType = this.modeAPI.getMode() === "visualLine" ? "line" : "char"; this.applyOperator("dedent", result.register); this.modeAPI.setMode("normal"); return; }
        case "visual_toggle_case": { const cm = this.modeAPI.getMode(); this._lastSelType = cm === "visualLine" ? "line" : "char"; this.applyOperator("toggle_case", result.register); this.modeAPI.setMode(cm); return; }
        case "visual_lowercase": { this._lastSelType = this.modeAPI.getMode() === "visualLine" ? "line" : "char"; this.applyOperator("lowercase", result.register); this.modeAPI.setMode("normal"); return; }
        case "visual_uppercase": { this._lastSelType = this.modeAPI.getMode() === "visualLine" ? "line" : "char"; this.applyOperator("uppercase", result.register); this.modeAPI.setMode("normal"); return; }
        case "exit_mode": case "exit_mode_normal": case "exit_mode_ctrl_c": case "exit_visual": case "exit_visual_ctrl_c": {
          collapseDocSelectionToEnd(); this.modeAPI.setMode("normal"); this.vlDisp = null; this._recordLastExit(); return;
        }
        case "exit_mode_ctrl_bracket": {
          // C-[ is Esc in every mode. Exiting insert still parks left.
          if (this.modeAPI.getMode() === "insert") {
            this._parkCaretAfterInsert();
          } else {
            collapseDocSelectionToEnd();
          }
          this.modeAPI.setMode("normal"); this.vlDisp = null; this._recordLastExit(); return;
        }
        case "exit_insert": case "exit_insert_ctrl_c": {
          this._parkCaretAfterInsert();
          this.modeAPI.setMode("normal"); this.vlDisp = null; this._recordLastExit(); return;
        }
        default: if (id?.startsWith?.("exit_")) { collapseDocSelectionToEnd(); this.modeAPI.setMode("normal"); this.vlDisp = null; } return;
      }
    }

    visualLineDown(count) {
      for (let i = 0; i < count; i++) {
        if (this.vlDisp === 0) { Adapter.home({}); Adapter.down({ shift: true }); Adapter.end({ shift: true }); }
        else Adapter.down({ shift: true });
        this.vlDisp = (this.vlDisp || 0) + 1;
      }
    }

    visualLineUp(count) {
      for (let i = 0; i < count; i++) {
        if (this.vlDisp === 0) { Adapter.end({}); Adapter.up({ shift: true }); Adapter.home({ shift: true }); }
        else { Adapter.up({ shift: true }); if (this.vlDisp === 1) Adapter.end({ shift: true }); }
        this.vlDisp = (this.vlDisp || 0) - 1;
      }
    }

    pasteFromRegister(register, opts = {}) {
      const name = register && typeof register === "string" ? register : '"';
      const reg = this.registers[name] || this.registers['"'];
      const textVal = typeof reg === "string" ? reg : reg?.text || "";
      const kind = reg?.type || "char";
      if (!textVal) return;
      const el = getEditor();
      if (!el) return;
      const { before = false, cursorStay = false, adjustIndent = false, times = 1 } = opts;

      if (isTextareaOrInput(el)) {
        this._saveUndoState();
        const pos = el.selectionStart, text = el.value;
        if (kind === "line") {
          let unit = textVal; if (!unit.endsWith("\n")) unit += "\n";
          if (adjustIndent) unit = this.indentBlock(unit, this.computeCurrentLineIndent());
          const r = times > 1 ? unit.repeat(times) : unit;
          if (before) {
            const ls = text.lastIndexOf("\n", pos - 1) + 1;
            spliceInput(el, ls, ls, r, "insertFromPaste");
            try { el.setSelectionRange(ls, ls); } catch (_) {}
            this._parkOnFirstNonBlank();
          }
          else if (text.length === 0) {
            spliceInput(el, 0, 0, r, "insertFromPaste");
            try { el.setSelectionRange(0, 0); } catch (_) {}
            this._parkOnFirstNonBlank();
          }
          else {
            // Paste below the current line: insert after its own break.
            // (Inserting "\n"+r at the break itself duplicated the newline
            // and left a blank line behind.)
            const le = text.indexOf("\n", pos);
            let at, str;
            if (le === -1) { str = r.startsWith("\n") ? r : "\n" + r; at = text.length; }
            else { str = r; at = le + 1; }
            spliceInput(el, at, at, str, "insertFromPaste");
            try {
              const first = at + (str.startsWith("\n") ? 1 : 0);
              el.setSelectionRange(first, first);
            } catch (_) {}
            this._parkOnFirstNonBlank();
          }
        } else {
          const p = times > 1 ? textVal.repeat(times) : textVal;
          if (before) { spliceInput(el, pos, pos, p, "insertFromPaste"); try { el.setSelectionRange(pos, pos + p.length); } catch (_) {} }
          else { const after = el.selectionEnd; spliceInput(el, after, after, p, "insertFromPaste"); }
        }
      } else if (isContentEditable(el)) {
        if (kind === "line") {
          let unit = textVal; if (!unit.endsWith("\n")) unit += "\n";
          const r = times > 1 ? unit.repeat(times) : unit;
          if (before) { Adapter.home({}); document.execCommand("insertText", false, r); }
          // Paste below: split the line first, then drop the text in without
          // its trailing break (inserting "\n"+r after line-end duplicated
          // the newline and left a blank line behind).
          else { Adapter.end({}); document.execCommand("insertText", false, "\n" + r.replace(/\n$/, "")); }
        } else {
          const p = times > 1 ? textVal.repeat(times) : textVal;
          if (before) document.execCommand("insertText", false, p);
          else { Adapter.right({}); document.execCommand("insertText", false, p); }
        }
      }
    }

    incDecNumber(delta) {
      const el = getEditor();
      if (!el || !isTextareaOrInput(el)) return;
      const pos = el.selectionStart, text = el.value;
      let ld = 0; while (ld < pos && /\d/.test(text[pos - ld - 1])) ld++;
      let rd = 0; while (pos + rd < text.length && /\d/.test(text[pos + rd])) rd++;
      if (ld + rd === 0) return;
      const hm = pos - ld - 1 >= 0 && text[pos - ld - 1] === "-";
      const start = pos - ld - (hm ? 1 : 0), end = pos + rd;
      const ns = text.substring(start, end);
      if (!/^-?\d+$/.test(ns)) return;
      const cv = parseInt(ns, 10); if (Number.isNaN(cv)) return;
      const nv = cv + delta, w = ns.replace("-", "").length;
      const out = (nv < 0 ? "-" : "") + Math.abs(nv).toString().padStart(w, "0");
      spliceInput(el, start, end, out, "insertReplacementText");
    }

    insertReplacementText(replacement) {
      const el = getEditor();
      if (!el) return;
      this.pushChangePosition();
      if (isTextareaOrInput(el)) {
        const s = el.selectionStart, e = el.selectionEnd;
        spliceInput(el, s, e, replacement, "insertReplacementText");
      } else if (isContentEditable(el)) {
        el.focus();
        let done = false;
        try { done = document.execCommand("insertText", false, replacement); } catch (_) { done = false; }
        if (!done && replacement === "") ceDeleteSelection("deleteContentBackward");
        else if (!done) {
          // Manual fallback: replace selection, then notify pipelines.
          try {
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0) {
              const range = sel.getRangeAt(0);
              range.deleteContents();
              const node = document.createTextNode(replacement);
              range.insertNode(node);
              range.setStartAfter(node);
              range.collapse(true);
              sel.removeAllRanges();
              sel.addRange(range);
              fireInputEvents(el, "insertText", replacement);
            }
          } catch (_) {}
        }
      }
    }

    joinOnce(withSpace) {
      const el = getEditor();
      if (!el || !isTextareaOrInput(el)) return;
      const pos = el.selectionStart, text = el.value;
      const le = text.indexOf("\n", pos);
      if (le === -1 || le + 1 >= text.length) return;
      let wsc = 0; while (le + 1 + wsc < text.length && /\s/.test(text[le + 1 + wsc])) wsc++;
      this._saveUndoState();
      spliceInput(el, le, le + 1 + wsc, " ", "insertReplacementText");
    }

    computeCurrentLineIndent() {
      const el = getEditor();
      if (!el || !isTextareaOrInput(el)) return "";
      const text = el.value, ls = text.lastIndexOf("\n", el.selectionStart - 1) + 1;
      let indent = "";
      for (let i = ls; i < text.length && (text[i] === " " || text[i] === "\t"); i++) indent += text[i];
      return indent;
    }

    reflowString(text) { return text ? text.split(/\n{2,}/).map(p => p.replace(/[\t \r\n]+/g, " ").trim()).join("\n\n") : ""; }
    indentBlock(text, indent) { return !indent ? text : text.split(/\r?\n/).map(line => line ? indent + line.replace(/^[\t ]+/, "") : line).join("\n"); }
  }

  window.createVimExecutor = function(modeAPI, settingsAPI) { return new MotionExecutor(modeAPI, settingsAPI); };
  // Framework-safe input writes, reused by the overlay write-back path.
  window.__everythingVimInput = { commitInputValue, spliceInput, fireInputEvents, fireBeforeInput };
})();
