//
// General Vim — unified vim editing for any place that requires typing.
//
// Embeds the Vim-For-Textarea engine (parser + direct-manipulation executor)
// and the Vim-For-Docs engine (synthetic-key executor for Google Docs canvas)
// inside Vimium page navigation, without touching Vimium's navigation modes.
//
// Strategy: a single window-capture keydown listener registered BEFORE
// vimium_frontend.js installs its own listeners (see manifest.json ordering).
// When focus is inside a text editor and our vim state is non-insert, we
// handle the key via the vim parser and call stopImmediatePropagation() so
// Vimium's NormalMode (j/k scroll, f hints, etc.) never sees it. When focus
// is NOT in an editor, we do nothing and Vimium handles page navigation.
//
// Handoff matrix (flawless by construction):
//   - Page (no editor focused) ......... Vimium navigation owns keys.
//   - Plain textarea/input/contenteditable . Direct executor, boots INSERT,
//     Esc -> NORMAL, second Esc blurs back to page navigation.
//   - Google Docs canvas ............... Synthetic-key executor, boots NORMAL
//     always (Docs is always editing); insert ops tracked for '.' repeat.
//   - Complex frameworks (CodeMirror 5/6, Monaco, ProseMirror, Lexical,
//     Slate, Quill, Ace, Draft, CKEditor, TinyMCE) .. Esc escalates to our
//     OWN overlay textarea where the engine is exact; Esc commits once,
//     Ctrl-C discards. Framework models are never touched mid-keystroke.
//   - Vimium overlays visible (link hints, vomnibar, help, HUD) .. we yield,
//     except the overlay editor which owns the keyboard outright.
//   - IME composition (keyCode 229), privileged Ctrl/Meta chords, function
//     keys, orphaned contexts after extension reload .. all pass through or
//     retire quietly, never breaking the page.
//

(() => {
  if (globalThis.__GENERALVIM_EDIT_MODE_LOADED__) return;
  globalThis.__GENERALVIM_EDIT_MODE_LOADED__ = true;
  // Back-compat for pages that probed the old flag name.
  globalThis.__ALLINVIM_EDIT_MODE_LOADED__ = true;

  let parser = null;
  let executor = null;
  let docsExecutor = null;
  let mode = "insert"; // "insert" | "normal" | "visual" | "visualLine"
  let tempNormal = false;
  let replaceMode = false;
  let currentEditor = null;
  // True only while a text editor actually holds focus. The indicator and
  // block caret paint only then — blurring the field hides them instead of
  // leaving a stale mode chip on screen. (Google Docs is exempt: its focus
  // lives in a hidden iframe, so focus events can't track it.)
  let editorHasFocus = false;
  let insertOps = null; // Docs '.'-repeat tracking {text, bs}
  const editorModes = new WeakMap();
  const handledKeyEvents = new WeakSet();

  // ---------- indicator preferences ----------
  // position: "corner" (bottom-right chip) | "field" (anchored to the active
  // textbox) | "hidden". docsStyle: "bar" (full-width Vim-style bottom bar) |
  // "chip" (small bottom-right card). Loaded from extension settings; content
  // defaults here so the router works before settings arrive.
  const prefs = { position: "corner", docsStyle: "bar" };
  // Last pending-key buffer, preserved across scroll/resize re-renders.
  let lastPending = "";
  // Google Docs: keystrokes land in a hidden same-origin iframe, but the engine belongs to the
  // TOP frame -- the only frame holding the Docs toolbar and the braille/screen-reader text
  // mirror that the executor reads, and the only frame that can own the visible caret and mode
  // indicator. Child frames therefore forward keys (handleForwardedDocsKey) and keep no state of
  // their own. Nothing is synced back: a child frame has no mode to report, and publishing its
  // boot-time default as if it were the engine's mode is what used to override the top frame.

  // ---------- Docs command-line (ported from Vim-For-Docs src/content.js) ----------
  // VFD's most visible feature: an authentic Vim command line. ":", "/" and
  // "?" take over the bottom bar with their own editable buffer and cursor;
  // <CR> runs the Ex command / search, <Esc> aborts, history is per type.
  // Without this layer Docs lost :s, :g, :reg, :marks, /word and n/N entirely.
  let docsCmdline = null; // { type, text, pos, histIndex, savedText }
  const docsSearchHist = [];
  const docsExHist = [];
  const DOCS_MAX_HIST = 50;
  let docsPendingOperatorCmdline = null; // { operator, count, register } for d/pattern
  let docsMessage = null; // { text, isError }
  let docsMessageTimer = 0;
  // Ctrl chords the Docs parser is willing to consume. Anything outside this
  // set falls through to Docs/browser shortcuts, exactly like VFD.
  let docsBoundCtrlTokens = new Set([
    "<C-E>", "<C-Y>", "<C-B>", "<C-F>", "<C-D>", "<C-U>",
    "<C-R>", "<C-I>", "<C-O>", "<C-A>", "<C-X>", "<C-C>",
    "<C-H>", "<C-W>", "<C-J>", "<C-T>", "<C-N>", "<C-P>",
    "<C-[>",
  ]);

  function rebuildDocsBoundCtrlTokens(cfg) {
    if (!cfg) return;
    const next = new Set(docsBoundCtrlTokens);
    next.add("<C-[>");
    try {
      for (const section of ["motions", "commands"]) {
        for (const entry of cfg[section] || []) {
          for (const k of entry.keys || []) {
            if (typeof k === "string" && k.startsWith("<C-")) next.add(k);
          }
        }
      }
    } catch (_) {}
    docsBoundCtrlTokens = next;
  }

  // Docs message area: VFD shows Ex output and errors on the bottom line.
  function docsShowMessage(text, isError) {
    try {
      if (!text) {
        docsMessage = null;
      } else {
        docsMessage = { text: String(text), isError: !!isError };
      }
      if (docsMessageTimer) {
        try { clearTimeout(docsMessageTimer); } catch (_) {}
        docsMessageTimer = 0;
      }
      if (docsMessage) {
        const ttl = docsMessage.isError ? 4000 : 2500;
        docsMessageTimer = setTimeout(() => {
          docsMessageTimer = 0;
          docsMessage = null;
          try { renderIndicator(); } catch (_) {}
        }, ttl);
      }
      renderIndicator();
    } catch (_) {}
  }

  function docsPushHist(list, entry) {
    if (!entry) return;
    const idx = list.indexOf(entry);
    if (idx !== -1) list.splice(idx, 1);
    list.unshift(entry);
    if (list.length > DOCS_MAX_HIST) list.pop();
  }

  // Refocus Docs' editing surface so typing continues after the cmdline closes.
  function docsFocusEditor() {
    try {
      const iframe = document.querySelector(".docs-texteventtarget-iframe");
      const win = iframe && iframe.contentWindow;
      const doc = win && win.document;
      if (win && typeof win.focus === "function") {
        try { win.focus(); } catch (_) {}
      }
      if (!doc) return;
      const root =
        doc.querySelector('[contenteditable="true"]') || doc.body || doc.documentElement;
      try { root && root.focus && root.focus({ preventScroll: true }); } catch (_) {
        try { root && root.focus && root.focus(); } catch (_) {}
      }
    } catch (_) {}
  }

  function docsOpenCmdline(type, initialText) {
    try {
      const seed = initialText != null ? String(initialText) : "";
      // Pending operator (e.g. the "d" of "d/pat") rides along so "/" becomes
      // an operator-pending search that deletes to the match, like Vim.
      let opBuf = null;
      try {
        if (parser && parser.buffer && parser.buffer.length && type !== ":") {
          const hasOp = !!parser.haveOperator;
          if (hasOp) {
            let cnt = 1;
            try { cnt = parser._countVal ? parser._countVal() : 1; } catch (_) {}
            opBuf = {
              keys: parser.buffer.slice(),
              operator: parser.operatorMeta ? parser.operatorMeta.id : null,
              count: cnt,
              register: parser.register || null,
            };
          }
        }
      } catch (_) {}
      try { if (parser) parser.reset(); } catch (_) {}
      docsCmdline = {
        type,
        text: seed,
        pos: seed.length,
        histIndex: null,
        savedText: seed,
      };
      docsPendingOperatorCmdline = opBuf;
      docsMessage = null;
      if (docsMessageTimer) {
        try { clearTimeout(docsMessageTimer); } catch (_) {}
        docsMessageTimer = 0;
      }
      lastPending = "";
      renderIndicator();
    } catch (_) {}
  }

  function docsCloseCmdline() {
    docsCmdline = null;
    try { renderIndicator(); } catch (_) {}
    try { docsFocusEditor(); } catch (_) {}
  }

  function docsCmdIns(ch) {
    if (!docsCmdline) return;
    const t = docsCmdline.text;
    const p = docsCmdline.pos;
    docsCmdline.text = t.slice(0, p) + ch + t.slice(p);
    docsCmdline.pos = p + ch.length;
    docsCmdline.histIndex = null;
  }
  function docsCmdBackspace() {
    if (!docsCmdline || docsCmdline.pos === 0) return;
    const t = docsCmdline.text;
    const p = docsCmdline.pos;
    docsCmdline.text = t.slice(0, p - 1) + t.slice(p);
    docsCmdline.pos = p - 1;
    docsCmdline.histIndex = null;
  }
  function docsCmdDel() {
    if (!docsCmdline) return;
    const t = docsCmdline.text;
    const p = docsCmdline.pos;
    if (p >= t.length) return;
    docsCmdline.text = t.slice(0, p) + t.slice(p + 1);
  }
  function docsCmdKillWord() {
    if (!docsCmdline || docsCmdline.pos === 0) return;
    let p = docsCmdline.pos;
    const t = docsCmdline.text;
    // Vim's c_CTRL-W: delete the word before the cursor (non-space run).
    while (p > 0 && t[p - 1] === " ") p--;
    while (p > 0 && t[p - 1] !== " ") p--;
    docsCmdline.text = t.slice(0, p) + t.slice(docsCmdline.pos);
    docsCmdline.pos = p;
  }
  function docsCmdKillLine() {
    if (!docsCmdline) return;
    // Vim's c_CTRL-U: kill to the beginning of the line.
    docsCmdline.text = docsCmdline.text.slice(docsCmdline.pos);
    docsCmdline.pos = 0;
  }
  function docsCmdMoveLeft() {
    if (!docsCmdline || docsCmdline.pos === 0) return;
    docsCmdline.pos--;
  }
  function docsCmdMoveRight() {
    if (!docsCmdline || docsCmdline.pos >= docsCmdline.text.length) return;
    docsCmdline.pos++;
  }
  function docsCmdMoveHome() {
    if (!docsCmdline) return;
    docsCmdline.pos = 0;
  }
  function docsCmdMoveEnd() {
    if (!docsCmdline) return;
    docsCmdline.pos = docsCmdline.text.length;
  }
  function docsCmdHist(dir) {
    if (!docsCmdline) return;
    const list = docsCmdline.type === ":" ? docsExHist : docsSearchHist;
    if (!list.length) return;
    if (dir === "up") {
      if (docsCmdline.histIndex == null) {
        docsCmdline.savedText = docsCmdline.text;
        docsCmdline.histIndex = 0;
      } else if (docsCmdline.histIndex < list.length - 1) {
        docsCmdline.histIndex++;
      } else {
        return;
      }
      docsCmdline.text = list[docsCmdline.histIndex];
      docsCmdline.pos = docsCmdline.text.length;
    } else if (dir === "down") {
      if (docsCmdline.histIndex == null) return;
      if (docsCmdline.histIndex > 0) {
        docsCmdline.histIndex--;
        docsCmdline.text = list[docsCmdline.histIndex];
      } else {
        docsCmdline.histIndex = null;
        docsCmdline.text = docsCmdline.savedText || "";
      }
      docsCmdline.pos = docsCmdline.text.length;
    }
  }

  // Ex dispatcher — ported from Vim-For-Docs src/content.js. The heavy lifting
  // (:s, :g, :reg, :marks, :jumps, :set, :sort) lives in the Docs executor,
  // which owns the selection and can talk to Docs safely.
  function docsExecExLine(line) {
    const t = String(line || "").trim();
    if (!t) return;
    const ex = docsExecutor || executor;

    // ":42" — jump to line 42.
    if (/^[0-9]+$/.test(t)) {
      const n = parseInt(t, 10);
      try {
        if (ex && ex.exGotoLine) ex.exGotoLine(n);
        else docsShowMessage(String(n), false);
      } catch (_) {}
      try { scheduleDocsCaretSolidWhileMoving(); } catch (_) {}
      return;
    }

    // parseSub: [range]s<delim>pat<delim>rep<delim>[flags]
    const parseSub = (s) => {
      const delim = s[0];
      if (!delim) return null;
      let i = 1;
      let esc = false;
      const parts = ["", ""];
      let idx = 0;
      for (; i < s.length; i++) {
        const ch = s[i];
        if (esc) { parts[idx] += ch; esc = false; continue; }
        if (ch === "\\") { esc = true; continue; }
        if (ch === delim) {
          if (idx === 0) { idx = 1; continue; }
          return { pat: parts[0], rep: parts[1], flags: s.slice(i + 1).trim(), delim };
        }
        parts[idx] += ch;
      }
      if (idx === 1) return { pat: parts[0], rep: parts[1], flags: "", delim };
      if (idx === 0 && parts[0] !== "") return { pat: parts[0], rep: "", flags: "", delim };
      return null;
    };

    // ":[range]s/pat/rep/[g][i][c]" and ":%s/..."
    let rangePart = "";
    let restAfterRange = t;
    const pr = /^(%|[0-9]+(?:,[0-9]+)?)\s*(.*)$/.exec(t);
    if (pr && /^(%|[0-9])/.test(pr[1]) && /^s[^a-zA-Z0-9]/.test(pr[2])) {
      rangePart = pr[1];
      restAfterRange = pr[2];
    }
    if (/^s[^a-zA-Z0-9]/.test(restAfterRange)) {
      const real = parseSub(restAfterRange.slice(1));
      if (real) {
        const flags = String(real.flags || "").toLowerCase();
        try {
          if (ex && ex.exSubstitute) {
            ex.exSubstitute({
              pat: real.pat,
              rep: real.rep,
              range: rangePart || "",
              global: flags.indexOf("g") !== -1,
              ignorecase: flags.indexOf("i") !== -1,
              confirm: flags.indexOf("c") !== -1,
              flags,
            });
            try { scheduleDocsCaretSolidWhileMoving(); } catch (_) {}
          } else {
            docsShowMessage("E492: Not an editor command: " + line, true);
          }
        } catch (_) {}
        return;
      }
    }

    // ":g/pat/d"
    const gm = /^\s*g([^\w\s])(.+)\1\s*(d(?:elete)?)?\s*$/.exec(t);
    if (gm) {
      try {
        if (ex && ex.exGlobalDelete) ex.exGlobalDelete(gm[2]);
        try { scheduleDocsCaretSolidWhileMoving(); } catch (_) {}
      } catch (_) {}
      return;
    }

    const first = t.split(/\s+/)[0] || "";
    const args = t.slice(first.length).trim();
    const bang = first.endsWith("!");
    const baseCmd = (bang ? first.slice(0, -1) : first).replace(/^:/, "");
    const isBase = (abbr, full) =>
      baseCmd === abbr || baseCmd === full ||
      (full.indexOf(baseCmd) === 0 && baseCmd.length >= abbr.length);

    if (isBase("w", "write") || isBase("wq", "wq") || baseCmd === "x" ||
        isBase("exi", "exit") || isBase("wa", "wall")) {
      docsShowMessage('"' + (document.title || "document") + '" written', false);
      return;
    }
    if (isBase("q", "quit") || baseCmd === "qa" || baseCmd === "wqa" || baseCmd === "xa") {
      docsShowMessage("", false);
      return;
    }
    if (isBase("e", "edit") || isBase("enew", "enew")) {
      docsShowMessage("", false);
      return;
    }
    if (isBase("noh", "nohlsearch") || isBase("nohl", "nohlsearch")) {
      try { if (ex && ex.clearSearchHighlight) ex.clearSearchHighlight(); } catch (_) {}
      docsShowMessage("", false);
      return;
    }
    if (isBase("h", "help") || baseCmd === "help!" || baseCmd === "helpgrep") {
      try {
        const url = "https://vimhelp.org/";
        if (args) window.open(url + encodeURIComponent(args) + ".txt.html", "_blank");
        else window.open("https://vim.rtorr.com/", "_blank");
      } catch (_) {}
      return;
    }
    if (isBase("reg", "registers") || baseCmd === "reg" || baseCmd === "di" ||
        isBase("dis", "display")) {
      try { if (ex && ex.exShowRegisters) ex.exShowRegisters(); } catch (_) {}
      return;
    }
    if (isBase("marks", "marks")) {
      try { if (ex && ex.exShowMarks) ex.exShowMarks(); } catch (_) {}
      return;
    }
    if (isBase("ju", "jumps") || baseCmd === "jumps") {
      try { if (ex && ex.exShowJumps) ex.exShowJumps(); } catch (_) {}
      return;
    }
    if (isBase("se", "set")) {
      const a = String(args || "").trim();
      if (!a) {
        docsShowMessage("Options: hlsearch number relativenumber ignorecase wrap", false);
        return;
      }
      const canon = {
        nu: "number", rnu: "relativenumber", hls: "hlsearch", ic: "ignorecase",
        wrap: "wrap", et: "expandtab", number: "number",
        relativenumber: "relativenumber", hlsearch: "hlsearch",
        ignorecase: "ignorecase", expandtab: "expandtab",
      };
      for (const raw of a.replace(/\s+/g, " ").trim().split(" ")) {
        let tok = raw.trim();
        if (!tok) continue;
        const tokBang = tok.endsWith("!");
        const tokAmp = tok.endsWith("&");
        if (tokBang || tokAmp) tok = tok.slice(0, -1);
        let neg = false;
        if (tok.startsWith("no")) { neg = true; tok = tok.slice(2); }
        const key = canon[tok] || tok;
        try {
          if (ex && ex.exSetOption) ex.exSetOption(key, neg ? false : true, tokBang, tokAmp);
        } catch (_) {}
      }
      return;
    }
    if (isBase("sort", "sort")) {
      try { if (ex && ex.exSort) ex.exSort(args); } catch (_) {}
      try { scheduleDocsCaretSolidWhileMoving(); } catch (_) {}
      return;
    }
    if (/^[0-9]+,[0-9]+/.test(t) || /^%/.test(t) || /^\$/.test(t) || /^\.s/.test(t)) {
      docsShowMessage("E492: Not an editor command: " + line, true);
      return;
    }
    docsShowMessage("E492: Not an editor command: " + line, true);
  }

  function docsExecCmdline() {
    if (!docsCmdline) return;
    const type = docsCmdline.type;
    const raw = docsCmdline.text;
    const ex = docsExecutor || executor;
    docsCloseCmdline();

    if (type === "/" || type === "?") {
      const pat = String(raw || "").trim();
      if (!pat) {
        // Bare "/" repeats the last search, like Vim.
        const last = ex && ex._lastSearch && ex._lastSearch.pattern;
        if (last) {
          const dir = type === "/" ? "forward" : "backward";
          try { ex._searchFindAndMove(last, dir, 1, false); } catch (_) {}
          try { scheduleDocsCaretSolidWhileMoving(); } catch (_) {}
        } else {
          docsShowMessage("E35: No previous regular expression", true);
        }
        return;
      }
      let patForSearch = pat;
      let forceIgnore = null;
      if (pat.indexOf("\\c") !== -1) {
        forceIgnore = true;
        patForSearch = patForSearch.replace(/\\c/g, "");
      }
      if (pat.indexOf("\\C") !== -1) {
        forceIgnore = false;
        patForSearch = patForSearch.replace(/\\C/g, "");
      }
      docsPushHist(docsSearchHist, pat);
      const dir = type === "/" ? "forward" : "backward";
      try {
        const pending = docsPendingOperatorCmdline;
        docsPendingOperatorCmdline = null;
        if (ex && typeof ex.searchOperatorPending === "function" && pending && pending.operator) {
          // Operator-pending search: "d/pat<CR>" deletes to the match.
          ex.searchOperatorPending(
            pending.operator, patForSearch, dir, pending.count, pending.register, forceIgnore
          );
        } else if (ex && ex._searchFindAndMove) {
          if (forceIgnore != null) ex._searchIgnoreCaseOverride = forceIgnore;
          ex._searchFindAndMove(patForSearch, dir, 1, false);
          ex._searchIgnoreCaseOverride = null;
        }
        try { scheduleDocsCaretSolidWhileMoving(); } catch (_) {}
      } catch (_) {}
      return;
    }

    if (type === ":") {
      const line = String(raw || "").trim();
      if (!line) return;
      docsPushHist(docsExHist, line);
      docsExecExLine(line);
    }
  }

  // Keys while the Docs command line is open: it owns the keyboard outright.
  // Mirrors Vim-For-Docs src/content.js handleCmdlineKeydown — every key is
  // swallowed, printable keys edit the buffer, C-W/C-U/BS/Hist edit, <CR> runs.
  function docsHandleCmdlineKeydown(e, token) {
    if (!docsCmdline) return;
    // Own the key no matter what — Docs must not see cmdline typing.
    try { suppress(e); } catch (_) {
      try { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); } catch (_) {}
    }
    let changed = false;
    if (token === "<ESC>" || token === "<C-C>" || token === "<C-[>") {
      // Vim aborts the command line on Esc / Ctrl-C.
      docsPendingOperatorCmdline = null;
      docsCloseCmdline();
      try { if (parser) parser.reset(); } catch (_) {}
      try { renderIndicator(""); } catch (_) {}
      return;
    }
    if (token === "<CR>" || e.key === "Enter") {
      docsExecCmdline();
      return;
    }
    if (token === "<BS>" || token === "<C-H>") {
      // Backspacing past the prompt aborts, like Vim.
      if (docsCmdline.pos === 0 && docsCmdline.text.length === 0) {
        docsPendingOperatorCmdline = null;
        docsCloseCmdline();
        try { if (parser) parser.reset(); } catch (_) {}
        try { renderIndicator(""); } catch (_) {}
        return;
      }
      docsCmdBackspace();
      changed = true;
    } else if (token === "<Del>") {
      docsCmdDel();
      changed = true;
    } else if (token === "<C-W>") {
      docsCmdKillWord();
      changed = true;
    } else if (token === "<C-U>") {
      docsCmdKillLine();
      changed = true;
    } else if (token === "<Left>" || token === "<C-B>") {
      docsCmdMoveLeft();
      changed = true;
    } else if (token === "<Right>") {
      docsCmdMoveRight();
      changed = true;
    } else if (token === "<Home>" || token === "<C-A>") {
      docsCmdMoveHome();
      changed = true;
    } else if (token === "<End>" || token === "<C-E>") {
      // Inside the cmdline c_CTRL-E is end-of-line (it also means scroll_down
      // in normal mode; VFD resolves the same conflict the same way).
      docsCmdMoveEnd();
      changed = true;
    } else if (token === "<Up>" || token === "<C-P>") {
      docsCmdHist("up");
      changed = true;
    } else if (token === "<Down>" || token === "<C-N>") {
      docsCmdHist("down");
      changed = true;
    } else if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      docsCmdIns(e.key);
      changed = true;
    } else {
      // Any other key is swallowed silently, exactly like Vim's cmdline.
      return;
    }
    if (changed) {
      try { renderIndicator(); } catch (_) {}
    }
  }

  function loadPrefsFromObject(obj) {
    try {
      if (!obj || typeof obj !== "object") return false;
      let changed = false;
      const pos = obj.generalVimIndicatorPosition;
      if (pos === "corner" || pos === "field" || pos === "hidden") {
        if (prefs.position !== pos) { prefs.position = pos; changed = true; }
      }
      const style = obj.generalVimDocsIndicator;
      if (style === "bar" || style === "chip") {
        if (prefs.docsStyle !== style) { prefs.docsStyle = style; changed = true; }
      }
      return changed;
    } catch (_) {
      return false;
    }
  }

  async function initPrefs() {
    try {
      if (globalThis.Settings && typeof Settings.onLoaded === "function") {
        await Settings.onLoaded();
        loadPrefsFromObject(Settings.getSettings());
      } else if (typeof chrome !== "undefined" && chrome.storage) {
        const data = await new Promise((resolve) => {
          try {
            chrome.storage.sync.get(
              ["generalVimIndicatorPosition", "generalVimDocsIndicator"],
              (d) => resolve(d || {})
            );
          } catch (_) {
            resolve({});
          }
        });
        loadPrefsFromObject(data);
      }
    } catch (_) {}
    try {
      renderIndicator();
    } catch (_) {}
  }

  function watchPrefs() {
    try {
      if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.onChanged) return;
      chrome.storage.onChanged.addListener((changes, area) => {
        try {
          if (area !== "sync" || !changes) return;
          const obj = {};
          if (changes.generalVimIndicatorPosition) {
            obj.generalVimIndicatorPosition =
              changes.generalVimIndicatorPosition.newValue;
          }
          if (changes.generalVimDocsIndicator) {
            obj.generalVimDocsIndicator = changes.generalVimDocsIndicator.newValue;
          }
          if (loadPrefsFromObject(obj)) renderIndicator();
          // Exclusion rules just saved (popup "exclude keys on this page"):
          // refresh immediately so the page goes dead without a reload.
          // Pass the just-saved value straight through: our listener can run
          // ahead of Settings' own reload, so a Settings read here would be
          // stale.
          if (changes.exclusionRules) {
            try {
              refreshEditEnabledState(changes.exclusionRules.newValue);
            } catch (_) {}
          }
        } catch (_) {}
      });
    } catch (_) {}
  }

  function passthroughDocs() {
    try { if (parser) parser.reset(); } catch (_) {}
    try { renderIndicator(""); } catch (_) {}
  }

  function injectDocsPageScript() {
    try {
      if (!isGoogleDocs()) return;
      // Top frame only: the engine (and therefore the page script's message
      // target) lives there, so a child Docs frame must not inject its own.
      if (window.top !== window) return;
      if (document.getElementById("__generalvim_page_script__")) return;
      const url = (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL)
        ? chrome.runtime.getURL("content_scripts/vim_edit/vim_docs_page_script.js")
        : null;
      if (!url) return;
      const s = document.createElement("script");
      s.id = "__generalvim_page_script__";
      s.src = url;
      s.async = false;
      (document.documentElement || document.head || document.body).appendChild(s);
    } catch (_) {}
  }

  // ---------- exclusion gate (popup "exclude keys on this page") ----------
  //
  // Vimium's own key handling is gated by isEnabledForUrl from the
  // background page. The edit router installs a separate listener, so it
  // must enforce the same gate — otherwise an excluded page loses navigation
  // but keeps full vim editing. Only absolute exclusions (matching rule with
  // empty passKeys) disable editing; partial passKeys rules leave it alone.

  let editEnabledForUrl = true;

  function contentTabUrl() {
    try {
      if (window.top && window.top !== window) return window.top.location.href;
    } catch (_) {
      // Cross-origin embedder: fall through to the frame's own URL.
    }
    try {
      return location.href;
    } catch (_) {
      return "";
    }
  }

  // Local mirror of background exclusions.getRule/isEnabledForUrl (pattern
  // '*' → '.*'; any matching rule with empty passKeys = absolute exclusion).
  // Fallback for when the background round-trip is unavailable.
  function computeLocalExclusion(url, rules) {
    try {
      const list = Array.isArray(rules) ? rules : [];
      for (const r of list) {
        if (!r || !r.pattern) continue;
        let re = null;
        try {
          re = new RegExp("^" + String(r.pattern).replace(/\*/g, ".*") + "$");
        } catch (_) {
          continue;
        }
        let hit = false;
        try {
          hit = re.test(url);
        } catch (_) {
          hit = false;
        }
        if (hit && !r.passKeys) return false;
      }
    } catch (_) {}
    return true;
  }

  function applyEditEnabledState() {
    try {
      if (!editEnabledForUrl) {
        // Never strand an open overlay on a page vim just left.
        if (overlayIsOpen()) closeOverlay(false);
        hideBlockCaret();
        updateBlockCaretVisible();
      }
      renderIndicator();
    } catch (_) {}
  }

  async function refreshEditEnabledState(freshRules) {
    // 1. Instant local apply from the just-saved rules (same tick as the
    // storage event — no round-trip). This kills the save→test race where
    // the user hits Esc before the background worker cold-starts.
    if (freshRules !== undefined) {
      try {
        editEnabledForUrl = computeLocalExclusion(contentTabUrl(), freshRules);
        applyEditEnabledState();
      } catch (_) {}
    }
    // 2. Background confirm: authoritative state plus fresh toolbar icon and
    // a forced nav-layer re-check in every frame of the tab. The just-saved
    // rules ride along so the answer can't come from a stale Settings copy.
    try {
      if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id != null) {
        const msg = { handler: "refreshEnabledState" };
        if (freshRules !== undefined) {
          try {
            msg.rules = JSON.parse(JSON.stringify(freshRules));
          } catch (_) {}
        }
        const resp = await chrome.runtime.sendMessage(msg);
        if (resp && typeof resp.isEnabledForUrl === "boolean") {
          editEnabledForUrl = resp.isEnabledForUrl;
          applyEditEnabledState();
          return editEnabledForUrl;
        }
      }
    } catch (_) {
      // Fall through to a direct storage read below.
    }
    // 3. Fallback when the background is unreachable: read storage directly
    // (never via the in-memory Settings copy, which may not have reloaded
    // yet when our listener runs ahead of its own).
    if (freshRules === undefined) {
      try {
        const data = await new Promise((resolve) => {
          try {
            chrome.storage.sync.get(["exclusionRules"], (d) => resolve(d || {}));
          } catch (_) {
            resolve({});
          }
        });
        editEnabledForUrl = computeLocalExclusion(contentTabUrl(), data.exclusionRules);
        applyEditEnabledState();
      } catch (_) {}
    }
    return editEnabledForUrl;
  }

  globalThis.__VIM_CURRENT_EDITOR__ = () => currentEditor;

  // ---------- context detection ----------

  // Memoized in two layers: the URL part is keyed by href (a navigation
  // always changes it), while the DOM-marker fallback revalidates at most
  // once per second — Docs renders its editor markers after our
  // document_start boot, so a sticky negative would blind us forever.
  let docsUrlHref = null;
  let docsUrlValue = false;
  let docsDomAt = 0;
  let docsDomValue = false;
  function isGoogleDocs() {
    let href = "";
    try {
      href = location.href;
    } catch (_) {}
    if (href !== docsUrlHref) {
      docsUrlHref = href;
      docsUrlValue = false;
      try {
        if (
          location.hostname === "docs.google.com" &&
          location.pathname.startsWith("/document")
        ) {
          docsUrlValue = true;
        } else if (window.top && window.top !== window) {
          const th = window.top.location.hostname;
          if (
            th === "docs.google.com" &&
            window.top.location.pathname.startsWith("/document")
          )
            docsUrlValue = true;
        }
      } catch (_) {
        // cross-origin iframe: fall through to DOM markers
      }
      docsDomAt = 0; // new document: re-validate markers
    }
    if (docsUrlValue) return true;
    const now = Date.now();
    if (docsDomAt !== 0 && now - docsDomAt < 1000) return docsDomValue;
    docsDomAt = now;
    docsDomValue = false;
    try {
      if (
        document.querySelector(
          ".docs-texteventtarget-iframe, .kix-page-paginated, .docs-text-ui"
        )
      )
        docsDomValue = true;
    } catch (_) {}
    return docsDomValue;
  }

  // Browsers only expose selection APIs on these input types; the rest
  // (number, date, range, color, …) throw InvalidStateError on
  // selectionStart/setSelectionRange. vi.js documents the same allowlist.
  const EDITABLE_INPUT_TYPES = new Set([
    "text", "search", "url", "tel", "password", "",
  ]);

  function isTextEditor(el) {
    if (!el) return false;
    try {
      if (el.disabled || el.readOnly) return false;
    } catch (_) {}
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      // Hidden fallbacks (e.g. ChatGPT's hidden prompt-textarea) must
      // never resolve as the editor: they can't hold visible focus and
      // poison editor resolution/motion targets. The plain
      // getClientRects().length===0 check was too aggressive — it also
      // rejects a normal focused field when Chrome hasn't painted it yet
      // (or when a zero-rect stub like jsdom is the only harness).
      // Gate on *invisible* only: rects==0 plus the element is actually
      // display:none/visibility:hidden or not visibly focused.
      try {
        if (el.getClientRects && el.getClientRects().length === 0) {
          let hiddenStyle = false;
          try {
            const cs = getComputedStyle(el);
            hiddenStyle = (cs && (cs.display === 'none' || cs.visibility === 'hidden'));
          } catch (_) { hiddenStyle = false; }
          // If rects are 0 but the element holds document focus, it's the
          // user's real field (not a background mirror) — don't reject.
          let hasFocus = false;
          try { hasFocus = (document.activeElement === el) || (el.contains && el.contains(document.activeElement)); } catch (_) {}
          if (hiddenStyle || !hasFocus) return false;
        }
      } catch (_) {
        return false;
      }
    }
    if (el.tagName === "TEXTAREA") return true;
    if (el.tagName === "INPUT") {
      try {
        const t = (el.type || "").toLowerCase();
        if (!EDITABLE_INPUT_TYPES.has(t)) return false;
        return true;
      } catch (_) {
        return false;
      }
    }
    if (el.isContentEditable) return true;
    try {
      const role = (el.getAttribute("role") || "").toLowerCase();
      if (role === "textbox" || role === "searchbox") return true;
    } catch (_) {}
    return false;
  }

  // Rich-editor frameworks own their DOM model; in-place key surgery
  // desyncs it (the same reason Surfingkeys opens an ACE overlay and
  // wasavi swaps in its own surface instead of editing in place).
  // Returns a kind string, or null for natively-editable elements.
  function detectComplexEditor(el) {
    if (!el || isGoogleDocs()) return null;
    try {
      let node = el, depth = 0;
      while (node && depth < 8) {
        if (node.nodeType === 1) {
          const cls = node.classList;
          const has = (c) => { try { return cls && cls.contains(c); } catch (_) { return false; } };
          const attr = (a) => { try { return node.hasAttribute(a); } catch (_) { return false; } };
          if (has("CodeMirror")) return "codemirror5";
          if (has("cm-editor") || has("cm-content")) return "codemirror6";
          if (has("monaco-editor") || has("monaco-mouse-cursor-text")) return "monaco";
          if (has("ProseMirror")) return "prosemirror";
          if (has("ql-editor")) return "quill";
          if (has("ace_editor") || has("ace_text-input")) return "ace";
          if (has("DraftEditor-root")) return "draftjs";
          if (attr("data-lexical-editor")) return "lexical";
          if (attr("data-slate-editor") || has("slate-editor")) return "slate";
          if (has("ck-editor__editable") || has("ck-content")) return "ckeditor";
          if (has("mce-content-body")) return "tinymce";
        }
        node = node.parentNode;
        depth++;
      }
    } catch (_) {}
    return null;
  }

  // True event target, piercing open shadow roots. A retargeted e.target
  // inside a shadow tree is the host element, which never resolves to an
  // editor — composedPath()[0] is the real inner node. Closed shadows redact
  // the path; this degrades gracefully to e.target.
  function eventTrueTarget(e) {
    try {
      if (e && typeof e.composedPath === "function") {
        const p = e.composedPath();
        if (p && p.length) {
          const first = p[0];
          if (first && first.nodeType === 3) {
            return (first.parentElement || e.target) || null;
          }
          if (first && first.nodeType === 1) return first;
        }
      }
    } catch (_) {}
    try {
      return (e && e.target) || null;
    } catch (_) {
      return null;
    }
  }

  function getDeepActiveElement() {
    let el = null;
    try {
      el = document.activeElement;
      let guard = 0;
      while (el && el.shadowRoot && el.shadowRoot.activeElement && guard++ < 8) {
        el = el.shadowRoot.activeElement;
      }
    } catch (_) {}
    return el;
  }

  // Climb from any node to the element vim should drive: the node itself, a
  // text-editor ancestor (events retarget inside complex editors), or the
  // host's inner editor across an open shadow boundary.
  function editorFromNode(node) {
    try {
      let el = node && node.nodeType === 3 ? node.parentElement : node;
      let guard = 0;
      while (el && guard++ < 12) {
        if (el.nodeType === 1 && isTextEditor(el)) return el;
        if (el === document.body || el === document.documentElement) break;
        const parent = el.parentElement;
        if (parent) {
          el = parent;
          continue;
        }
        // Cross open shadow boundary to the host, then keep climbing.
        try {
          const root = el.getRootNode ? el.getRootNode() : null;
          if (root && root.host) el = root.host;
          else break;
        } catch (_) {
          break;
        }
      }
    } catch (_) {}
    return null;
  }

  function findEditor(preferred) {
    // 1. Explicit node first (true event target pierces shadow retargeting).
    if (preferred) {
      const hit = editorFromNode(preferred);
      if (hit) return hit;
    }
    // 2. Deep active element (shadow-DOM aware).
    try {
      const deep = getDeepActiveElement();
      if (deep) {
        const hit = editorFromNode(deep);
        if (hit) return hit;
      }
    } catch (_) {}
    // 3. Legacy fallback.
    try {
      const el = document.activeElement;
      if (el && isTextEditor(el)) return el;
    } catch (_) {}
    return null;
  }

  function inEditingContext() {
    if (isGoogleDocs()) return true;
    return findEditor() != null;
  }

  // True when a key event belongs to a NATIVE Docs UI field rather than the
  // document canvas — the Find bar (input.docs-findinput-input inside
  // #docs-findbar-id), Find-and-replace, comment/reply boxes, the rename
  // field, and similar real text fields in THIS document. Those fields own
  // their keys outright: typing, Enter (next match), Escape (dismiss) and
  // shortcuts must reach Docs, never the vim engine.
  //
  // The canvas itself can never match here: its keystrokes arrive via the
  // hidden editing iframe (handleForwardedDocsKey), while this document's
  // active element is the iframe element — which is not a text editor. So
  // anything that DOES resolve is UI chrome whose keystrokes must pass
  // through untouched. Without this, opening native Find while in normal
  // mode — or pressing Esc inside it — wedges the field because every key
  // is swallowed by the engine.
  function docsNativeFieldHasFocus(e) {
    try {
      // Only the top frame hosts Docs UI; the hidden editing iframe has none.
      if (window.top !== window) return false;
      let node = null;
      try {
        node = eventTrueTarget(e);
      } catch (_) {
        node = null;
      }
      if (node && node.nodeType === 1) {
        try {
          if (typeof node.closest === "function" && node.closest("#docs-findbar-id")) {
            return true;
          }
        } catch (_) {}
        try {
          if (editorFromNode(node)) return true;
        } catch (_) {}
      }
      try {
        if (findEditor()) return true;
      } catch (_) {}
    } catch (_) {}
    return false;
  }

  // Yield to Vimium's link-hints / vomnibar / help / HUD only while they
  // are actually VISIBLE. NOTE: .vimium-clickable must NOT be used here:
  // hud.init() adds it on the first HUD.show() and the iframe then stays
  // in the DOM forever, which permanently poisoned every Esc decision.
  function vimiumOverlayActive() {
    try {
      if (
        document.querySelector(
          ".vimiumHintMarker, .vimiumFindMode, " +
            "iframe.vimium-hud-frame.vimium-ui-component-visible, " +
            "iframe.vomnibar-frame.vimium-ui-component-visible, " +
            "iframe.vimium-help-dialog-frame.vimium-ui-component-visible"
        )
      )
        return true;
    } catch (_) {}
    return false;
  }

  // ---------- key tokenization (mirrors Vim-For-Textarea) ----------

  function mapCtrlKeyName(key) {
    const value = typeof key === "string" ? key : "";
    const specials = {
      " ": "SPACE",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
      Escape: "ESC",
      Enter: "CR",
      Backspace: "BS",
      Tab: "TAB",
    };
    if (specials[value]) return specials[value];
    if (value.length === 1) return value.toUpperCase();
    return value;
  }

  function isEscapeEvent(e) {
    return (
      !!e &&
      (e.key === "Escape" ||
        e.key === "Esc" ||
        e.code === "Escape" ||
        e.keyCode === 27 ||
        e.which === 27)
    );
  }

  function eventToToken(e) {
    if (!e) return null;
    const key = typeof e.key === "string" ? e.key : "";
    if (
      e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey &&
      !e.metaKey &&
      (key === "[" || e.keyCode === 219 || e.which === 219)
    ) {
      return "<C-[>";
    }
    if (isEscapeEvent(e)) return "<ESC>";
    if (e.key === "Delete" || e.key === "Del") return "<Del>";
    if (e.metaKey) return null;
    if (e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey) {
      if (!key) return null;
      return `<C-${mapCtrlKeyName(key)}>`;
    }
    if (key.length === 1) return key;
    return (
      {
        Enter: "<CR>",
        Backspace: "<BS>",
        Tab: "<TAB>",
        Delete: "<Del>",
        ArrowLeft: "<Left>",
        ArrowRight: "<Right>",
        ArrowUp: "<Up>",
        ArrowDown: "<Down>",
        Home: "<Home>",
        End: "<End>",
      }[key] || null
    );
  }

  // ---------- vim block caret (normal/visual modes) ----------
  //
  // A real block cursor drawn over the caret position. The native caret is
  // hidden via caret-color while the block shows, and restored on exit.
  // Textareas use a mirror-div measurement; contenteditables use the live
  // range rect plus a canvas-measured character width.

  let blockCaretEl = null;
  let mirrorEl = null;
  let measureCtx = null;
  const measureFontCache = new WeakMap();
  let caretHiddenEl = null;
  let caretHiddenPrev = "";
  // Perf: selectionchange/scroll/resize can fire many times per frame.
  // Coalesce block-caret repaints onto one rAF so rapid caret moves cost a
  // single mirror measurement + style write.
  let caretRafPending = false;

  // Blink when idle, solid while moving (normal/visual modes).
  // While a caret-moving action runs, the block caret is shown solid (no
  // blink) so the user can track exactly where it lands. ~250ms after the
  // last move it resumes blinking — matching native textarea behavior.
  let movementTimeout = null;

  function isMovementInProgress() {
    return movementTimeout !== null;
  }

  function scheduleCaretSolidWhileMoving() {
    try {
      if (movementTimeout) clearTimeout(movementTimeout);
      movementTimeout = setTimeout(() => {
        movementTimeout = null;
        // Re-apply blink animation now that movement has settled
        if (blockCaretEl) {
          try {
            blockCaretEl.style.animation = BLINK_ANIM;
          } catch (_) {}
        }
      }, 250);
      // Make caret solid immediately
      if (blockCaretEl) {
        try {
          blockCaretEl.style.animation = "none";
          // Force the style to apply immediately AND restart from fully
          // visible: without the opacity reset the block can resume mid
          // "off" phase of the old blink cycle and look stuck-invisible.
          blockCaretEl.style.opacity = "0.85";
          void blockCaretEl.offsetWidth; // force reflow
        } catch (_) {}
      }
    } catch (_) {}
  }

  // True when a parsed result moves the caret in any way. Plain motions,
  // operators and text-object selections always count (even when blocked at
  // a boundary — the user is still doing a movement action). Commands count
  // too, except the ones that never move the caret (mark setting, mode
  // switches, exits, overlays).
  const NON_MOVING_COMMAND_IDS = new Set([
    "set_mark",
    "insert_before", "insert_start_line", "append_after", "append_end_line",
    "open_below", "open_above", "replace_mode",
    "insert_temp_normal", "insert_delete_char_back", "insert_delete_word",
    "insert_line_break", "insert_indent", "insert_dedent",
    "insert_autocomplete_next", "insert_autocomplete_prev", "insert_register",
    "insert_replace_char",
    "visual_mode", "visual_line_mode",
    "exit_mode", "exit_mode_normal", "exit_mode_normal_ctrl_c",
    "exit_mode_ctrl_bracket", "exit_visual", "exit_visual_ctrl_c",
    "exit_insert", "exit_insert_ctrl_c",
    "open_overlay", "focus_next",
    "search_forward", "search_backward",
  ]);

  function resultMovesCaret(result) {
    try {
      if (!result || !result.kind) return false;
      if (
        result.kind === "motion" ||
        result.kind === "operator_motion" ||
        result.kind === "operator_self" ||
        result.kind === "operator_textobj" ||
        result.kind === "visual_textobj"
      ) {
        return true;
      }
      if (result.kind !== "command") return false;
      const id = result.command && result.command.id;
      if (!id) return false;
      if (id.indexOf("exit_") === 0) return false;
      return !NON_MOVING_COMMAND_IDS.has(id);
    } catch (_) {
      return false;
    }
  }

  // Google Docs counterpart: Docs draws its own `.kix-cursor-caret`, blinked
  // via CSS. While moving we set `data-generalvim-moving="1"` on <html>;
  // the Docs cursor stylesheet (see ensureDocsCursorStyle) turns the blink
  // off while that attribute is present, so the block stays solid. Newly
  // recreated caret nodes pick it up automatically via CSS.
  let docsMovementTimeout = 0;

  function scheduleDocsCaretSolidWhileMoving() {
    try {
      if (!docsTopFrame()) return;
      try { ensureDocsCursorStyle(); } catch (_) {}
      const root = document.documentElement;
      if (!root) return;
      try {
        root.setAttribute("data-generalvim-moving", "1");
      } catch (_) {}
      if (docsMovementTimeout) {
        try { clearTimeout(docsMovementTimeout); } catch (_) {}
      }
      docsMovementTimeout = setTimeout(() => {
        docsMovementTimeout = 0;
        try {
          if (document.documentElement) {
            document.documentElement.removeAttribute("data-generalvim-moving");
          }
        } catch (_) {}
      }, 250);
    } catch (_) {}
  }

  // Both surfaces at once (runExec is shared by plain + Docs executors).
  function notifyCaretMoved(result) {
    try {
      if (!resultMovesCaret(result)) return;
    } catch (_) {
      return;
    }
    try { scheduleCaretSolidWhileMoving(); } catch (_) {}
    try { scheduleDocsCaretSolidWhileMoving(); } catch (_) {}
  }

  // Vim-style hard blink: solid, then gone (step-end, ~1s period).
  const BLINK_ANIM = "generalvim-block-blink 1.06s step-end infinite";

  function ensureCaretBlinkStyle() {
    try {
      if (document.getElementById("generalvim-caret-blink")) return;
      const st = document.createElement("style");
      st.id = "generalvim-caret-blink";
      st.textContent =
        "@keyframes generalvim-block-blink{0%,49%{opacity:1;}50%,100%{opacity:0;}}" +
        "@media (prefers-reduced-motion:reduce){" +
        "[data-generalvim-block-caret]{animation:none !important;}}";
      (document.head || document.documentElement).appendChild(st);
    } catch (_) {}
  }

  function ensureBlockCaret() {
    if (blockCaretEl || !document.documentElement) return;
    try {
      ensureCaretBlinkStyle();
      blockCaretEl = document.createElement("div");
      blockCaretEl.setAttribute("data-generalvim-block-caret", "1");
      blockCaretEl.style.cssText =
        "position:fixed;z-index:2147483645;pointer-events:none;display:none;" +
        "background:var(--color-signal-lime);opacity:0.85;border-radius:1px;" +
        "animation:" + BLINK_ANIM + ";";
      document.documentElement.appendChild(blockCaretEl);
    } catch (_) {
      blockCaretEl = null;
    }
  }

  const MIRROR_PROPS = [
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch",
    "fontVariant", "letterSpacing", "textTransform", "wordSpacing",
    "textIndent", "lineHeight", "paddingTop", "paddingRight",
    "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth",
    "borderBottomWidth", "borderLeftWidth", "boxSizing", "tabSize",
    "direction",
  ];

  function ensureMirror() {
    if (mirrorEl || !document.documentElement) return;
    try {
      mirrorEl = document.createElement("div");
      mirrorEl.setAttribute("data-generalvim-mirror", "1");
      mirrorEl.style.cssText =
        "position:fixed;visibility:hidden;pointer-events:none;" +
        "top:0;left:0;overflow:hidden;white-space:pre-wrap;" +
        "word-wrap:break-word;overflow-wrap:break-word;z-index:-1;";
      document.documentElement.appendChild(mirrorEl);
    } catch (_) {
      mirrorEl = null;
    }
  }

  function measureCharWidth(el, ch) {
    try {
      if (!measureCtx) {
        const canvas = document.createElement("canvas");
        measureCtx = canvas.getContext("2d");
      }
      if (!measureCtx) return 0;
      // Perf: getComputedStyle + font string rebuild on every keystroke
      // forces style recalc. Cache per element; editors rarely change fonts.
      const cached = measureFontCache.get(el);
      let font = cached || null;
      if (!font) {
        const cs = getComputedStyle(el);
        font =
          `${cs.fontStyle} ${cs.fontVariant} ${cs.fontWeight} ` +
          `${cs.fontSize} ${cs.fontFamily}`;
        // WeakMap is unbounded-safe; cap not needed (one entry per editor).
        measureFontCache.set(el, font);
      }
      measureCtx.font = font;
      const w = measureCtx.measureText(ch || " ").width;
      return Number.isFinite(w) && w > 0 ? w : 0;
    } catch (_) {
      return 0;
    }
  }

  // Viewport coords of the caret in a textarea/input, plus the width of
  // the character under it. Null when not measurable.
  function textareaCaretGeom(el, pos) {
    try {
      ensureMirror();
      if (!mirrorEl) return null;
      const cs = getComputedStyle(el);
      for (const p of MIRROR_PROPS) {
        try {
          mirrorEl.style[p] = cs[p];
        } catch (_) {}
      }
      try {
        mirrorEl.style.whiteSpace = "pre-wrap";
        mirrorEl.style.wordWrap = "break-word";
        const er = el.getBoundingClientRect();
        mirrorEl.style.width = Math.max(1, er.width) + "px";
        mirrorEl.style.left = er.left + "px";
        mirrorEl.style.top = er.top + "px";
      } catch (_) {
        return null;
      }
      const text = el.value || "";
      const caret = Math.max(0, Math.min(pos, text.length));
      while (mirrorEl.firstChild) {
        try {
          mirrorEl.removeChild(mirrorEl.firstChild);
        } catch (_) {
          break;
        }
      }
      const pre = document.createElement("span");
      pre.textContent = text.slice(0, caret);
      const mark = document.createElement("span");
      const under = text.slice(caret, caret + 1);
      mark.textContent = under || " ";
      mirrorEl.appendChild(pre);
      mirrorEl.appendChild(mark);
      try {
        mirrorEl.scrollTop = el.scrollTop;
        mirrorEl.scrollLeft = el.scrollLeft;
      } catch (_) {}
      let mr = null;
      try {
        mr = mark.getBoundingClientRect();
      } catch (_) {
        return null;
      }
      if (!mr || (mr.width === 0 && mr.height === 0 && !under)) return null;
      let h = mr.height;
      if (!h) {
        try {
          const fs = parseFloat(cs.fontSize);
          h = Number.isFinite(fs) && fs > 0 ? fs * 1.2 : 16;
        } catch (_) {
          h = 16;
        }
      }
      return { left: mr.left, top: mr.top, height: h, width: Math.max(2, mr.width || measureCharWidth(el, under)) };
    } catch (_) {
      return null;
    }
  }

  function ceCaretGeom() {
    try {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount) return null;
      const r = sel.getRangeAt(0).cloneRange();
      r.collapse(true);
      let rects = null;
      try {
        rects = r.getClientRects();
      } catch (_) {
        return null;
      }
      const rc = rects && rects[0];
      if (!rc || (rc.width === 0 && rc.height === 0)) return null;
      let h = rc.height;
      let anchor = r.startContainer;
      try {
        if (anchor && anchor.nodeType !== 1) anchor = anchor.parentNode;
        if (anchor && anchor.nodeType === 1) {
          const cs = getComputedStyle(anchor);
          if (!h) {
            const fs = parseFloat(cs.fontSize);
            h = Number.isFinite(fs) && fs > 0 ? fs * 1.2 : 16;
          }
          const w = measureCharWidth(anchor, " ");
          return { left: rc.left, top: rc.top, height: h, width: Math.max(2, w || 8) };
        }
      } catch (_) {}
      return { left: rc.left, top: rc.top, height: h || 16, width: 8 };
    } catch (_) {
      return null;
    }
  }

  function hideNativeCaret(el) {
    try {
      if (!el || caretHiddenEl === el) return;
      restoreNativeCaret();
      caretHiddenEl = el;
      try {
        caretHiddenPrev = el.style.caretColor || "";
      } catch (_) {
        caretHiddenPrev = "";
      }
      el.style.caretColor = "transparent";
    } catch (_) {}
  }

  function restoreNativeCaret() {
    try {
      if (caretHiddenEl) {
        try {
          caretHiddenEl.style.caretColor = caretHiddenPrev;
        } catch (_) {}
      }
    } catch (_) {}
    caretHiddenEl = null;
    caretHiddenPrev = "";
  }

  function updateBlockCaretVisible() {
    try {
      if (!blockCaretEl) return;
      if (!editEnabledForUrl) {
        hideBlockCaret();
        return;
      }
      if (!editorHasFocus && !isGoogleDocs()) {
        hideBlockCaret();
        return;
      }
      const show =
        (mode === "normal" || mode === "visual" || mode === "visualLine" || tempNormal) &&
        !isGoogleDocs();
      blockCaretEl.style.display = show ? "block" : "none";
    } catch (_) {}
  }

  function hideBlockCaret() {
    try {
      if (blockCaretEl) blockCaretEl.style.display = "none";
    } catch (_) {}
    restoreNativeCaret();
  }

  function updateBlockCaret() {
    try {
      ensureBlockCaret();
      if (!blockCaretEl) return;
      if (!editEnabledForUrl) {
        hideBlockCaret();
        return;
      }
      if (!editorHasFocus && !isGoogleDocs()) {
        hideBlockCaret();
        return;
      }
      // Block caret is shown in non-insert modes (normal, visual, visualLine)
      // and while in temporary normal mode during a motion selection, but not
      // in insert mode or on Google Docs (which keeps its own caret).
      const show =
        (mode === "normal" || mode === "visual" || mode === "visualLine" || tempNormal) &&
        !isGoogleDocs();
      let el = null;
      try {
        el = currentEditor;
        if (!el || !document.contains(el)) el = findEditor();
      } catch (_) {
        el = null;
      }
      if (!show || !el || !isTextEditor(el)) {
        hideBlockCaret();
        return;
      }
      let geom = null;
      try {
        if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
          const pos = Math.min(el.selectionStart || 0, (el.value || "").length);
          geom = textareaCaretGeom(el, pos);
        } else if (el.isContentEditable) {
          geom = ceCaretGeom();
        }
      } catch (_) {
        geom = null;
      }
      if (!geom) {
        hideBlockCaret();
        return;
      }
      // Off-screen caret: hide rather than paint a stray block.
      try {
        if (
          geom.left < -50 || geom.top < -50 ||
          geom.left > window.innerWidth + 50 ||
          geom.top > window.innerHeight + 50
        ) {
          hideBlockCaret();
          return;
        }
      } catch (_) {}
      blockCaretEl.style.display = "block";
      blockCaretEl.style.left = geom.left + "px";
      blockCaretEl.style.top = geom.top + "px";
      blockCaretEl.style.width = geom.width + "px";
      blockCaretEl.style.height = geom.height + "px";      blockCaretEl.style.background =
        mode === "normal" ? "var(--color-signal-lime)" : "var(--color-syntax-violet)";

      // When a movement is in progress, the caret stays solid so the user
      // can see exactly where it is. The blink resumes after movement settles
      // (handled by scheduleCaretSolidWhileMoving's timeout).
      if (isMovementInProgress()) {
        try {
          blockCaretEl.style.animation = "none";
        } catch (_) {}
      }

      hideNativeCaret(el);

    } catch (_) {}

    updateBlockCaretVisible();
  }

  function scheduleBlockCaret() {
    try {
      if (caretRafPending) return;
      caretRafPending = true;
      const paint = () => {
        caretRafPending = false;
        try {
          updateBlockCaret();
        } catch (_) {}
      };


      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(paint);
      } else {
        paint();
      }
    } catch (_) {}
  }

  // ---------- Google Docs block cursor ----------
  //
  // Docs draws its own caret (a 2px `.kix-cursor-caret` line); our overlay
  // block can't work there. Instead widen Docs' caret into a block in
  // non-insert modes and restore the thin caret in insert (Vim-For-Docs
  // technique). Docs recreates caret nodes constantly, so application is
  // rAF-coalesced, retried with backoff, and re-triggered by a
  // MutationObserver. Top frame only: editing keys land in a hidden iframe
  // whose document has no visible caret; it forwards state and the top
  // frame owns all cursor styling.

  function docsTopFrame() {
    try {
      return isGoogleDocs() && window.top === window;
    } catch (_) {
      return false;
    }
  }

  function syncDocsCursorAttr(stateMode) {
    try {
      if (!isGoogleDocs()) return;
      const m = stateMode || mode;
      if (document.documentElement) {
        document.documentElement.setAttribute("data-generalvim-mode", m);
      }
      if (document.body) {
        try {
          document.body.setAttribute("data-generalvim-mode", m);
        } catch (_) {}
      }
    } catch (_) {}
  }

  function ensureDocsCursorStyle() {
    try {
      if (!docsTopFrame()) return;
      if (document.getElementById("generalvim-docs-cursor")) return;
      const blockSel =
        'html[data-generalvim-mode="normal"] .kix-cursor-caret,' +
        'html[data-generalvim-mode="visual"] .kix-cursor-caret,' +
        'html[data-generalvim-mode="visualLine"] .kix-cursor-caret';
      const st = document.createElement("style");
      st.id = "generalvim-docs-cursor";
      st.textContent =
        '@keyframes generalvim-docs-block-blink{0%,49%{opacity:1}50%,100%{opacity:0}}' +
        'html[data-generalvim-mode="normal"] .kix-cursor,' +
        'html[data-generalvim-mode="visual"] .kix-cursor,' +
        'html[data-generalvim-mode="visualLine"] .kix-cursor,' +
        blockSel +
        '{visibility:visible !important;}' +
        // Blink the block ourselves. NOTE: deliberately NO `opacity:1
        // !important` here — an important author declaration outranks
        // animations in the cascade, so pinning opacity was exactly what left
        // the block sitting there solid instead of blinking. Insert mode
        // matches none of these rules, so Docs' own thin blinking caret
        // returns untouched.
        blockSel +
        '{animation:generalvim-docs-block-blink 1.06s step-end infinite !important;}' +
        // Solid while moving: idle blinks, caret-moving actions hold solid.
        // Higher-specificity + later in the stylesheet, so it wins over the
        // blink above while `data-generalvim-moving="1"` is set. Reduced-
        // motion users already get a solid caret; this keeps them solid.
        'html[data-generalvim-moving="1"] .kix-cursor-caret{' +
        'animation:none !important;opacity:1 !important;visibility:visible !important;}' +
        '@media (prefers-reduced-motion:reduce){' + blockSel + '{animation:none !important;}}';
      (document.head || document.documentElement).appendChild(st);
    } catch (_) {}
  }

  let docsCursorRaf = false;
  let docsCursorRetry = false;
  let docsCursorObs = null;
  let docsLastCaretH = 0;
  let docsLastCaretHAt = 0;

  function requestDocsCursorUpdate() {
    if (!docsTopFrame()) return;
    if (docsCursorRaf) return;
    docsCursorRaf = true;
    const run = () => {
      docsCursorRaf = false;
      try {
        updateDocsBlockCursor();
      } catch (_) {}
    };
    try {
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
      else run();
    } catch (_) {
      docsCursorRaf = false;
    }
  }

  function docsCaretHeight(caret, wrapper) {
    let h = 0;
    try {
      h = parseFloat((caret.style.height || "").slice(0, -2));
    } catch (_) {}
    const now = Date.now();
    if ((!h || isNaN(h) || h <= 0) && docsLastCaretH > 0 && now - docsLastCaretHAt < 5000) {
      h = docsLastCaretH;
    }
    if (!h || isNaN(h) || h <= 0) {
      try {
        h = caret.getBoundingClientRect().height;
      } catch (_) {}
    }
    if (!h || isNaN(h) || h <= 0) {
      try {
        h = caret.offsetHeight;
      } catch (_) {}
    }
    if (!h || isNaN(h) || h <= 0) {
      try {
        h = parseFloat(getComputedStyle(caret).height);
      } catch (_) {}
    }
    if (!h || isNaN(h) || h <= 0) {
      try {
        const line = document.querySelector(".kix-lineview");
        if (line) {
          const lh = line.getBoundingClientRect().height;
          if (lh && lh > 0 && lh < 40) h = lh;
        }
      } catch (_) {}
    }
    if (!h || isNaN(h) || h <= 0) {
      try {
        const fs = parseFloat(getComputedStyle(caret).fontSize);
        if (fs && fs > 0) h = Math.round(fs * 1.35);
      } catch (_) {}
    }
    if (!h || isNaN(h) || h <= 0) h = 18;
    docsLastCaretH = h;
    docsLastCaretHAt = now;
    return h;
  }

  function updateDocsBlockCursor() {
    if (!docsTopFrame()) return;
    const effMode = mode;
    const isInsert = effMode === "insert";
    let caret = null;
    let wrapper = null;
    try {
      caret = document.querySelector(".kix-cursor-caret");
      wrapper = document.querySelector(".kix-cursor");
    } catch (_) {}
    if (!caret) {
      if (wrapper && !isInsert) {
        try {
          wrapper.style.visibility = "visible";
          wrapper.style.opacity = "1";
        } catch (_) {}
      }
      scheduleDocsCursorRetry();
      return;
    }
    // Steady-state guard: skip DOM writes when styling already matches, so
    // per-keystroke observer callbacks stay cheap while typing.
    //
    // It must compare against the width ACTUALLY rendered, not just our
    // bookkeeping: Docs rewrites the caret's inline styles whenever it
    // re-renders or repositions it, and when that happened the dataset flag
    // survived while the block did not. Trusting the flag alone suppressed the
    // re-apply forever, so the caret sat there as a thin bar in normal/visual
    // mode — "the caret is not changing between block and bar".
    const flagged = (() => {
      try {
        return !!(caret.dataset && caret.dataset.generalvimBlock === "1");
      } catch (_) {
        return false;
      }
    })();
    const measuredBlock = (() => {
      try {
        const inline = parseFloat(caret.style.borderLeftWidth);
        if (!isNaN(inline) && inline >= 7) return true;
      } catch (_) {}
      try {
        const cs = getComputedStyle(caret);
        const computed = parseFloat(cs && cs.borderLeftWidth);
        if (!isNaN(computed) && computed >= 7) return true;
      } catch (_) {}
      return false;
    })();
    // Only skip when bookkeeping and the rendered caret agree.
    if (!isInsert && flagged && measuredBlock) return;
    if (isInsert && !flagged && !measuredBlock) return;
    if (isInsert) {
      // Thin blinking caret again.
      try {
        caret.style.borderWidth = "2px";
        caret.style.borderLeftWidth = "2px";
        caret.style.borderLeftStyle = "";
        caret.style.width = "";
        caret.style.backgroundColor = "";
        if (caret.dataset && caret.dataset.generalvimBlockHeight === "1") {
          try {
            caret.style.height = "";
          } catch (_) {}
          delete caret.dataset.generalvimBlockHeight;
        }
        if (caret.dataset) delete caret.dataset.generalvimBlock;
      } catch (_) {}
      return;
    }
    // Non-insert: widen the caret line into a solid block.
    try {
      const h = docsCaretHeight(caret, wrapper);
      const w = Math.max(7, Math.round(0.416 * h));
      caret.style.borderWidth = w + "px";
      caret.style.borderLeftWidth = w + "px";
      caret.style.borderLeftStyle = "solid";
      try {
        const cs = getComputedStyle(caret);
        const col = cs && cs.borderLeftColor;
        if (!col || col === "rgba(0, 0, 0, 0)" || col === "transparent") {
          caret.style.borderLeftColor = "var(--color-signal-lime)";
        }
      } catch (_) {
        try {
          caret.style.borderLeftColor = "var(--color-signal-lime)";
        } catch (_) {}
      }
      caret.style.visibility = "visible";
      caret.style.opacity = "1";
      if (caret.dataset) caret.dataset.generalvimBlock = "1";
      if (wrapper) {
        try {
          wrapper.style.visibility = "visible";
          wrapper.style.opacity = "1";
        } catch (_) {}
      }
    } catch (_) {
      try {
        caret.style.borderWidth = "7px";
        caret.style.borderLeftWidth = "7px";
        caret.style.borderLeftStyle = "solid";
        caret.style.visibility = "visible";
        caret.style.opacity = "1";
        if (caret.dataset) caret.dataset.generalvimBlock = "1";
      } catch (_) {}
      scheduleDocsCursorRetry();
    }
  }

  function scheduleDocsCursorRetry() {
    if (!docsTopFrame() || docsCursorRetry) return;
    docsCursorRetry = true;
    let attempts = 0;
    const tick = () => {
      attempts++;
      try {
        updateDocsBlockCursor();
      } catch (_) {}
      let needMore = false;
      try {
        const effMode = mode;
        const caret = document.querySelector(".kix-cursor-caret");
        needMore = effMode !== "insert" && !caret && attempts < 10;
      } catch (_) {}
      if (needMore) {
        setTimeout(tick, attempts < 4 ? 60 : 150);
      } else {
        docsCursorRetry = false;
      }
    };
    try {
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(tick);
      else setTimeout(tick, 0);
    } catch (_) {
      setTimeout(tick, 0);
    }
  }

  function watchDocsCursor() {
    if (!docsTopFrame() || docsCursorObs) return;
    try {
      ensureDocsCursorStyle();
    } catch (_) {}
    try {
      docsCursorObs = new MutationObserver(() => {
        // Docs recreates the caret on (almost) every edit; re-assert the
        // block coalesced onto rAF. updateDocsBlockCursor no-ops when the
        // styling already matches, so steady-state typing stays cheap.
        requestDocsCursorUpdate();
      });
      const root = document.documentElement || document.body;
      if (root) docsCursorObs.observe(root, { childList: true, subtree: true });
    } catch (_) {
      docsCursorObs = null;
    }
    try {
      requestDocsCursorUpdate();
    } catch (_) {}
  }

  // ---------- lightweight mode indicator ----------

  let indicatorEl = null;
  function ensureIndicator() {
    if (indicatorEl || !document.documentElement) return;
    try {
      indicatorEl = document.createElement("div");
      indicatorEl.setAttribute("data-generalvim-indicator", "1");
      // Trigger: flat terminal status chip. Mono tracked uppercase, no shadow.
      // Deliberately compact (10px / tight tracking / 3px padding): the chip
      // parks in the bottom-right corner of every page, so a chunky badge
      // covered neighbouring UI. Keep this in sync with the "chip" layout in
      // paintIndicator().
      indicatorEl.style.cssText =
        "position:fixed;z-index:2147483646;right:10px;bottom:10px;" +
        "font-family:'Geist Mono','JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace;" +
        "font-size:10px;line-height:1;letter-spacing:1px;text-transform:uppercase;" +
        "padding:3px 6px;border-radius:3px;" +
        "background:var(--surface-inset);color:var(--color-cloud-text);border:1px solid var(--color-steel-border);" +
        "pointer-events:none;opacity:0.95;display:none;";
      document.documentElement.appendChild(indicatorEl);
    } catch (_) {
      indicatorEl = null;
    }
  }

  function hideIndicator() {
    try {
      if (indicatorEl) indicatorEl.style.display = "none";
    } catch (_) {}
  }

  function modeLabelFor(state) {
    const m = state.mode;
    if (m === "visualLine") return "VISUAL LINE";
    if (m === "visual") return "VISUAL";
    if (m === "insert") return state.replaceMode ? "REPLACE" : "INSERT";
    if (state.tempNormal) return "TEMP";
    return "NORMAL";
  }

  function modeColorFor(label) {
    if (label === "NORMAL") return "var(--color-signal-lime)";
    if (label === "VISUAL" || label === "VISUAL LINE") return "var(--color-syntax-violet)";
    return "var(--color-cloud-text)";
  }

  function currentState() {
    return {
      mode,
      pending: lastPending,
      tempNormal,
      replaceMode,
    };
  }

  // Skip redundant DOM writes: renders fire per keystroke and per scroll.
  let lastPaintKey = null;
  // Make sure the html->body document chrome for the bottom bar exists.
  function ensureDocsBarChrome() {
    try {
      if (document.getElementById("generalvim-docs-bar-style")) return;
      const st = document.createElement("style");
      st.id = "generalvim-docs-bar-style";
      st.textContent =
        "#generalvim-indicator-caret{display:inline-block;min-width:7px;background:var(--color-bone-text);color:var(--surface-canvas);}" ;
      (document.head || document.documentElement).appendChild(st);
    } catch (_) {}
  }
  // The compact indicator layouts (the bottom-right card and the label anchored to the active
  // textbox) live in the corner of the page, so they show a single letter per mode rather than
  // spelling the mode out. The Docs bar has the whole screen width and keeps the full name.
  function compactModeLabel(label) {
    if (label === "NORMAL") return "N";
    // Visual and visual-line are both visual mode; the pending keys say what is selected.
    if (label === "VISUAL" || label === "VISUAL LINE") return "V";
    if (label === "INSERT") return "I";
    if (label === "REPLACE") return "R";
    if (label === "TEMP") return "T";
    return label;
  }

  function paintIndicator(layout, label, pending, color) {
    // Compact layouts abbreviate; "bar" shows the mode name in full.
    const text = layout === "bar" ? label : compactModeLabel(label);
    const key = layout + "|" + text + "|" + pending + "|" + color;
    const base = {
      position: "fixed",
      zIndex: "2147483646",
      fontFamily: "'Geist Mono','JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace",
      pointerEvents: "none",
      opacity: "0.95",
      display: "block",
      margin: "0",
      boxShadow: "none",
      textTransform: "uppercase",
    };
    if (layout === "bar") {
      Object.assign(indicatorEl.style, base, {
        left: "0px",
        right: "0px",
        top: "auto",
        bottom: "0px",
        width: "auto",
        padding: "5px 12px",
        borderRadius: "0px",
        border: "none",
        borderTop: "1px solid var(--color-steel-border)",
        background: "var(--surface-inset)",
        fontSize: "13px",
        letterSpacing: "1.5px",
      });
    } else {
      // "chip": small bottom-right card (Docs chip, corner) or editor-anchored.
      // Compact on purpose — see the matching note in ensureIndicator().
      Object.assign(indicatorEl.style, base, {
        width: "auto",
        padding: "3px 6px",
        borderRadius: "3px",
        border: "1px solid var(--color-steel-border)",
        borderTop: "1px solid var(--color-steel-border)",
        background: "var(--surface-inset)",
        fontSize: "10px",
        lineHeight: "1",
        letterSpacing: "1px",
      });
      if (layout !== "field") {
        Object.assign(indicatorEl.style, {
          left: "auto",
          top: "auto",
          right: "10px",
          bottom: "10px",
        });
      }
    }
    if (key !== lastPaintKey) {
      lastPaintKey = key;
      indicatorEl.textContent = "";
      if (layout === "bar") {
        const left = document.createElement("span");
        left.textContent = text;
        left.style.color = color;
        const right = document.createElement("span");
        right.textContent = pending;
        right.style.color = "var(--color-fog-text)";
        right.style.marginLeft = "auto";
        indicatorEl.appendChild(left);
        indicatorEl.appendChild(right);
        indicatorEl.style.display = "flex";
      } else {
        indicatorEl.style.display = "block";
        indicatorEl.style.color = color;
        indicatorEl.textContent = pending ? text + "  " + pending : text;
      }
    } else if (layout === "bar") {
      indicatorEl.style.display = "flex";
    } else {
      indicatorEl.style.display = "block";
    }
  }

  // Paint the indicator when the Docs command line is active or a Docs
  // message is showing — owns the whole bar like Vim's last screen line
  // (prompt + editable text + block cursor / message text).
  function paintDocsBarWithCmdlineAndMessage(state) {
    ensureIndicator();
    if (!indicatorEl) return false;
    ensureDocsBarChrome();
    // Command line owns the entire bar. docsCmdline/docsMessage are the only
    // source of this state: the engine runs here, so there is no peer frame.
    const cl = (state && state.cmdline) || docsCmdline;
    const msg = (state && state.message) || docsMessage;
    // cmdline takes precedence over message
    if (cl) {
      const t = cl.type || ":";
      const txt = String(cl.text || "");
      let pos = typeof cl.pos === "number" ? cl.pos : txt.length;
      pos = Math.max(0, Math.min(pos, txt.length));
      const before = txt.slice(0, pos);
      const at = txt.slice(pos, pos + 1);
      const after = txt.slice(pos + 1);
      Object.assign(indicatorEl.style, {
        position: "fixed",
        zIndex: "2147483646",
        left: "0px",
        right: "0px",
        bottom: "0px",
        top: "auto",
        width: "auto",
        display: "flex",
        alignItems: "center",
        padding: "5px 12px",
        background: "var(--surface-inset)",
        color: "var(--color-bone-text)",
        fontFamily: "'Courier New', Courier, monospace",
        fontSize: "13px",
        letterSpacing: "0",
        textTransform: "none",
        border: "none",
        borderTop: "1px solid var(--color-steel-border)",
        borderRadius: "0px",
        opacity: "0.98",
      });
      indicatorEl.textContent = "";
      const wrap = document.createElement("span");
      wrap.style.display = "flex";
      wrap.style.alignItems = "center";
      wrap.style.whiteSpace = "pre";
      const prompt = document.createElement("span");
      prompt.textContent = t;
      prompt.style.color = "var(--color-syntax-orange)";
      wrap.appendChild(prompt);
      const bSpan = document.createElement("span");
      bSpan.textContent = before;
      bSpan.style.color = "var(--color-bone-text)";
      wrap.appendChild(bSpan);
      const cur = document.createElement("span");
      cur.id = "generalvim-indicator-caret";
      if (at) cur.textContent = at;
      else { cur.textContent = " "; cur.style.opacity = "0.95"; }
      wrap.appendChild(cur);
      if (after) {
        const aSpan = document.createElement("span");
        aSpan.textContent = after;
        aSpan.style.color = "var(--color-bone-text)";
        wrap.appendChild(aSpan);
      }
      indicatorEl.appendChild(wrap);
      const right = document.createElement("span");
      right.style.marginLeft = "auto";
      indicatorEl.appendChild(right);
      return true;
    }
    if (msg && msg.text) {
      const isErr = !!msg.isError;
      Object.assign(indicatorEl.style, {
        position: "fixed",
        zIndex: "2147483646",
        left: "0px",
        right: "0px",
        bottom: "0px",
        top: "auto",
        width: "auto",
        display: "flex",
        alignItems: "center",
        padding: "5px 12px",
        background: "var(--surface-inset)",
        color: isErr ? "var(--color-mute-red)" : "var(--color-bone-text)",
        fontFamily: "'Courier New', Courier, monospace",
        fontSize: "13px",
        letterSpacing: "0",
        textTransform: "none",
        border: "none",
        borderTop: "1px solid var(--color-steel-border)",
        borderRadius: "0px",
        opacity: "0.98",
        fontWeight: isErr ? "700" : "400",
      });
      indicatorEl.textContent = String(msg.text);
      return true;
    }
    return false;
  }

  function positionIndicatorAtField() {
    let ed = null;
    try {
      ed =
        currentEditor && document.contains(currentEditor)
          ? currentEditor
          : findEditor();
    } catch (_) {
      ed = null;
    }
    if (!ed) return false;
    let r = null;
    try {
      r = ed.getBoundingClientRect();
    } catch (_) {
      r = null;
    }
    if (!r || (r.width === 0 && r.height === 0)) return false;
    let w = 64;
    let h = 24;
    try {
      w = indicatorEl.offsetWidth || w;
      h = indicatorEl.offsetHeight || h;
    } catch (_) {}
    let vw = 1024;
    let vh = 768;
    try {
      vw = window.innerWidth || vw;
      vh = window.innerHeight || vh;
    } catch (_) {}
    // Pin to the field's top-right (inside when room, above otherwise).
    let left = r.right - w - 6;
    let top = r.top - h - 6;
    if (top < 4) top = Math.min(vh - h - 4, r.bottom + 6);
    if (left < 4) left = 4;
    if (left > vw - w - 4) left = Math.max(4, vw - w - 4);
    if (top < 4) top = 4;
    if (top > vh - h - 4) top = Math.max(4, vh - h - 4);
    try {
      indicatorEl.style.left = left + "px";
      indicatorEl.style.top = top + "px";
      indicatorEl.style.right = "auto";
      indicatorEl.style.bottom = "auto";
    } catch (_) {}
    return true;
  }

  function renderIndicator(pendingKeys) {
    if (arguments.length > 0) lastPending = pendingKeys || "";
    ensureIndicator();
    if (!indicatorEl) return;
    try {
      if (!editEnabledForUrl) {
        indicatorEl.style.display = "none";
        return;
      }
      if (!editorHasFocus && !isGoogleDocs()) {
        // Blurred out of the field: no stale chip.
        indicatorEl.style.display = "none";
        return;
      }
      if (prefs.position === "hidden") {
        indicatorEl.style.display = "none";
        return;
      }
      // Google Docs always uses the Docs style (bar or chip). This frame owns
      // the visible indicator, because it is the frame running the engine.
      if (isGoogleDocs()) {
        renderDocsIndicator(currentState());
        return;
      }
      if (!inEditingContext()) {
        indicatorEl.style.display = "none";
        return;
      }
      const label = modeLabelFor(currentState());
      if (prefs.position === "field") {
        paintIndicator("field", label, lastPending, modeColorFor(label));
        if (!positionIndicatorAtField()) {
          // Field not measurable (detached/hidden): hide rather than float.
          indicatorEl.style.display = "none";
        }
        return;
      }
      paintIndicator("chip", label, lastPending, modeColorFor(label));
    } catch (_) {}
  }

  // Render Docs state into THIS document. Called locally and (in the top
  // frame) for peer messages from the hidden editing iframe.
  function renderDocsIndicator(state) {
    ensureIndicator();
    if (!indicatorEl) return;
    try {
      // Late-bootstrapping: Docs renders its markers after our
      // document_start init, so install the cursor watcher on first sight.
      try {
        watchDocsCursor();
      } catch (_) {}
      // Cmdline and messages own the whole bar — handle before the normal
      // mode label so ":", "/", "?" and Ex output are visible.
      if (paintDocsBarWithCmdlineAndMessage(state)) return;
      const label = modeLabelFor(state);
      const color = modeColorFor(label);
      if (prefs.docsStyle === "bar") {
        paintIndicator("bar", label, state.pending || "", color);
        return;
      }
      paintIndicator("chip", label, state.pending || "", color);
    } catch (_) {}
  }

  function setMode(newMode) {
    mode = newMode;
    try {
      if (parser && typeof parser.setMode === "function")
        parser.setMode(newMode);
    } catch (_) {}
    renderIndicator("");
    // When entering normal/visual mode from insert, start the caret blinking
    // (unless a movement is currently in progress).
    if (newMode === "normal" || newMode === "visual" || newMode === "visualLine") {
      if (!isMovementInProgress() && blockCaretEl) {
        try {
          blockCaretEl.style.animation = BLINK_ANIM;
        } catch (_) {}
      }
    }
    updateBlockCaret();
    // NOTE: no Vimium HUD popup here. The edit indicator above is the single
    // mode signal; HUD.show duplicated it on every mode change.
    // Google Docs: mirror the mode onto the document (drives caret CSS) and
    // re-assert the block caret (top frame owns the visible styling).
    try {
      if (isGoogleDocs()) {
        syncDocsCursorAttr(newMode);
        requestDocsCursorUpdate();
      }
    } catch (_) {}
  }

  // ---------- Docs insert-op tracking for '.' repeat ----------

  // Insert repeat bookkeeping for Docs '.' — array shape copied from
  // Vim-For-Docs src/content.js so docsExecutor.finishInsert (copied from
  // Vim-For-Docs src/executor.js) receives what it expects.
  function resetInsertOps() {
    insertOps = [];
  }
  resetInsertOps();

  function appendOpText(s) {
    if (!s) return;
    if (!insertOps) resetInsertOps();
    const last = insertOps[insertOps.length - 1];
    if (last && last.type === "text") last.value += s;
    else insertOps.push({ type: "text", value: s });
  }
  function appendOpBs() {
    if (!insertOps) resetInsertOps();
    const last = insertOps[insertOps.length - 1];
    if (last && last.type === "text" && last.value.length > 0) {
      last.value = last.value.slice(0, -1);
      if (!last.value) insertOps.pop();
      return;
    }
    if (last && last.type === "bs") last.count++;
    else insertOps.push({ type: "bs", count: 1 });
  }

  function activeExecutor() {
    return isGoogleDocs() ? docsExecutor || executor : executor;
  }

  function runExec(result) {
    const ex = activeExecutor();
    if (!ex) return;
    const out = ex.exec(result);
    dkeys(`post-exec mode=${mode} caret=${caretSnapshot()}`);
    // Keep the caret visible in growing/scroll-snapping fields (Google AI
    // Mode style). Element-local scroll only; never touches page scroll.
    try {
      ensureCaretVisible();
    } catch (_) {}
    // Blink when idle, solid while moving: only caret-moving actions
    // hold the caret solid; everything else leaves the blink alone.
    // The blink resumes ~250ms after the last move.
    try {
      notifyCaretMoved(result);
    } catch (_) {}
    try {
      updateBlockCaret();
    } catch (_) {}
    // Docs executor is async (waits for Docs round-trip); textarea is sync.
    if (out && typeof out.then === "function") {
      out.catch((err) => {
        try {
          if (window.__VIM_DEBUG__) console.error("[GeneralVim] exec error", err);
        } catch (_) {}
      });
    }
  }

  // Nudge the focused field's own scroll so the caret stays in view after
  // a motion. Read-only geometry; clamps, never page scroll.
  function ensureCaretVisible() {
    try {
      if (isGoogleDocs()) return;
      const el = currentEditor;
      if (!el || !document.contains(el)) return;
      let focused = null;
      try {
        focused = findEditor();
      } catch (_) {}
      if (focused && focused !== el) return;
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
        if (el.scrollHeight <= el.clientHeight + 1) return;
        let lh = 0;
        try {
          const cs = getComputedStyle(el);
          const v = parseFloat(cs.lineHeight);
          if (Number.isFinite(v) && v > 0) lh = v;
          else {
            const fs = parseFloat(cs.fontSize);
            if (Number.isFinite(fs) && fs > 0) lh = fs * 1.2;
          }
        } catch (_) {}
        if (!lh) return;
        const text = el.value || "";
        const pos = Math.max(0, Math.min(el.selectionStart || 0, text.length));
        const lineNo = (text.slice(0, pos).match(/\n/g) || []).length;
        const top = lineNo * lh;
        if (top < el.scrollTop) el.scrollTop = top;
        else if (top + lh > el.scrollTop + el.clientHeight) {
          el.scrollTop = top + lh - el.clientHeight;
        }
      } else if (el.isContentEditable) {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return;
        let r = null;
        try {
          r = sel.getRangeAt(0).getBoundingClientRect();
        } catch (_) {
          return;
        }
        let er = null;
        try {
          er = el.getBoundingClientRect();
        } catch (_) {
          return;
        }
        if (!r || !er || (r.width === 0 && r.height === 0)) return;
        if (r.bottom > er.bottom) el.scrollTop += r.bottom - er.bottom + 4;
        else if (r.top < er.top) el.scrollTop -= er.top - r.top + 4;
      }
    } catch (_) {}
  }

  // Browsers blur shadow-embedded inputs on Escape as an *uncancelable*
  // default action (verified: preventDefault + stopImmediatePropagation on
  // window capture still loses focus to the host). Without a restore, every
  // normal-mode key after that finds no editor and vim appears "broken" on
  // sites embedding fields in shadow DOM. Refocuses on the next task when
  // focus was lost unintentionally. Never steals focus from another editor,
  // and never runs when the blur was intended (second-Esc in normal mode).
  function scheduleFocusRestore(skip) {
    if (skip) return;
    let ed = null;
    try {
      ed = currentEditor;
    } catch (_) {}
    if (!ed) return;
    try {
      if (!ed.isConnected) return;
    } catch (_) {
      return;
    }
    setTimeout(() => {
      try {
        const deep = getDeepActiveElement();
        if (deep && (deep === ed || isTextEditor(deep))) return;
        try {
          ed.focus({ preventScroll: true });
        } catch (_) {
          try {
            ed.focus();
          } catch (_) {}
        }
      } catch (_) {}
    }, 0);
  }

  // Follow-on events for a consumed keydown (keypress/keyup/beforeinput):
  // framework editors insert characters via these even when keydown died.
  const suppressedKeys = new Set();
  let suppressTimer = 0;

  function markSuppressed(e) {
    try {
      const k = (e.code || "") + "|" + (e.key || "") + "|" + (e.keyCode || 0);
      suppressedKeys.add(k);
      if (suppressTimer) clearTimeout(suppressTimer);
      suppressTimer = setTimeout(() => {
        suppressedKeys.clear();
      }, 700);
    } catch (_) {}
  }

  function onSuppressibleEvent(e) {
    // Suppress echo events for keys consumed in non-insert modes. Insert
    // mode never consumes (typing must flow), so it never suppresses.
    try {
      if (!e.isTrusted) return;
      if (!parser || !executor) return;
      if (isGoogleDocs()) return;
      if (mode === "insert" && !tempNormal) return;
      const k = (e.code || "") + "|" + (e.key || "") + "|" + (e.keyCode || 0);
      if (suppressedKeys.has(k)) suppress(e);
    } catch (_) {}
  }

  function finishParsedCommand(result) {
    const wasNormal = mode === "normal";
    runExec(result);
    renderIndicator("");
    const id = result && result.command && result.command.id;
    if (id && id.startsWith("exit_")) {
      tempNormal = false;
      replaceMode = false;
      // Second-Esc ergonomics: Esc in normal blurs back to page navigation.
      // Deferred so a site focusout listener can't reset the selection back
      // to line start before our caret fix lands (Google Generative AI does
      // exactly this on Esc).
      if (wasNormal && currentEditor && currentEditor.blur) {
        const ed = currentEditor;
        setTimeout(() => {
          try {
            if (ed.blur) ed.blur();
          } catch (_) {}
        }, 0);
      }
    } else if (id === "insert_temp_normal") {
      return;
    } else if (tempNormal) {
      tempNormal = false;
      setMode("insert");
    }
  }

  function feedConfiguredToken(token) {
    const result = parser.feed(token);
    if (!result) return true;
    dkeys(
      `feed -> kind=${result.kind}`,
      `id=${(result.command || result.motion || {}).id || "-"}`,
      `caret=${caretSnapshot()}`
    );
    if (result.kind === "invalid") {
      renderIndicator("");
      // In normal mode swallow the key so it never types into the page.
      return true;
    }
    if (result.kind === "prefix" || result.kind === "await_char") {
      renderIndicator((result.keys || []).join(""));
      return true;
    }
    if (result.kind === "command") {
      finishParsedCommand(result);
    } else {
      runExec(result);
      renderIndicator("");
      if (tempNormal) {
        tempNormal = false;
        setMode("insert");
      }
    }
    return true;
  }

  function suppress(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation(); // preempt Vimium's own window listener
  }

  // Key-decision tracing for site-specific diagnosis. Enable in the page
  // console with: window.__GENERALVIM_DEBUG_KEYS = 1
  // then reproduce and read the [GeneralVim:keys] lines.
  function dkeys(...args) {
    try {
      if (window.__GENERALVIM_DEBUG_KEYS) {
        console.log("[GeneralVim:keys]", ...args);
      }
    } catch (_) {}
  }

  function describeEditor(el) {
    try {
      if (!el) return "none";
      let s = el.tagName || "?";
      try {
        if (el.id) s += "#" + el.id;
      } catch (_) {}
      try {
        const c = String(el.className || "").slice(0, 40);
        if (c) s += "." + c;
      } catch (_) {}
      return s;
    } catch (_) {
      return "?";
    }
  }

  function caretSnapshot() {
    try {
      const el = currentEditor;
      if (!el) return "-";
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
        return `${el.selectionStart}:${el.selectionEnd}`;
      }
      return "ce";
    } catch (_) {
      return "?";
    }
  }

  // ---------- main key handler ----------

  function onKeyDown(e) {
    try {
      if (!e.isTrusted || handledKeyEvents.has(e)) return;
      if (!editEnabledForUrl) {
        // Excluded page ("No Vimium keys are enabled"): pass everything
        // through. Never strand an open overlay behind.
        try {
          if (overlayIsOpen()) closeOverlay(false);
        } catch (_) {}
        return;
      }
      // IME composition (CJK, autocomplete, keyCode 229): the browser owns
      // these keystrokes. Intercepting them breaks composition windows.
      if (e.isComposing || e.keyCode === 229) return;
      handledKeyEvents.add(e);
      // Docs routes real keystrokes into its hidden editing iframe. That frame
      // has no engine of its own to speak of (see the Docs-engine note below
      // handleForwardedDocsKey), so never gate its forwarding on parser/executor.
      const docsChild = window.top !== window && isGoogleDocs();
      if (!docsChild && (!parser || !executor)) {
        dkeys(`early-return parser=${!!parser} executor=${!!executor}`);
        return;
      }
      // Overlay owns the keyboard while open — before any yield checks,
      // so a visible HUD/vomnibar can never swallow overlay keys.
      if (overlayIsOpen()) {
        if (overlayTrap(e)) return;
        currentEditor = overlayArea;
        if (isEscapeEvent(e)) {
          suppress(e);
          closeOverlay(true);
          return;
        }
        const ovToken = eventToToken(e);
        if (ovToken === "<C-C>") {
          suppress(e);
          closeOverlay(false);
          return;
        }
        if (ovToken === "<C-[>") {
          suppress(e);
          closeOverlay(true);
          return;
        }
        // Fall through to the normal engine (overlay textarea is plain,
        // so in-place handling is exact there).
      } else if (vimiumOverlayActive()) {
        dkeys(`yield key=${e.key} (vimium overlay visible)`);
        return; // let link-hints win
      }

      const docs = isGoogleDocs();

      if (docs) {
        if (docsChild) {
          // Hidden Docs editing iframe: it owns the keystroke but not the
          // engine. Ask the top frame's engine and swallow the key only when
          // it consumed it (unconsumed keys must still type into Docs).
          if (!editEnabledForUrl) return; // excluded page: pass everything through
          let consumed = false;
          try {
            const topHandler = window.top && window.top.__GENERALVIM_HANDLE_DOCS_KEY__;
            if (typeof topHandler === "function") consumed = !!topHandler(docsKeyPayload(e));
          } catch (_) {
            consumed = false; // top frame unavailable/cross-origin: never trap keys
          }
          if (consumed) suppress(e);
          return;
        }
        handleDocsKey(e);
        return;
      }

      const token = eventToToken(e);
      if (!token) return;
      dkeys(`mode=${mode}`, `token=${token}`, `editor=${describeEditor(currentEditor || findEditor())}`, `caret=${caretSnapshot()}`);

      if (mode === "insert") {
        // Complex editors can't be driven in place (framework-owned DOM).
        // Esc escalates to the overlay editor instead of a broken normal
        // mode — the Surfingkeys/wasavi pattern.
        if (isEscapeEvent(e) && !vimiumOverlayActive() && !(parser.buffer && parser.buffer.length > 0)) {
          try {
            const ed = findEditor(eventTrueTarget(e));
            const kind = ed && detectComplexEditor(ed);
            if (ed && kind) {
              suppress(e);
              currentEditor = ed;
              if (!openOverlay(ed, kind)) {
                setMode("normal");
              }
              return;
            }
          } catch (_) {}
        }
        const commandMeta =
          parser.commandMetaForToken && parser.commandMetaForToken(token);
        const commandStart = parser.isCommandBinding(token);
        const commandPending = parser.buffer && parser.buffer.length > 0;
        const isReplaceChar =
          commandMeta && commandMeta.id === "insert_replace_char";
        if (
          commandPending ||
          (commandStart &&
            (!isReplaceChar || replaceMode) &&
            !(isEscapeEvent(e) && vimiumOverlayActive()))
        ) {
          // Resolve via the true event target first: focusin may never have
          // fired (programmatic focus, retargeted shadow focus), leaving a
          // stale/null editor that would make this command silently no-op —
          // or drive the WRONG field and visibly jump its caret.
          try {
            const ed0 = findEditor(eventTrueTarget(e));
            if (ed0) currentEditor = ed0;
          } catch (_) {}
          suppress(e);
          markSuppressed(e);
          feedConfiguredToken(token);
          // Exiting insert via keyboard can blur shadow-embedded editors as
          // an uncancelable browser default — restore focus (never intended
          // here; the intentional second-Esc blur lives in normal mode).
          scheduleFocusRestore(false);
        }
        return; // otherwise let the page type normally
      }

      // normal / visual / visualLine: resolve via event target first
      // (shadow-aware), then the deep active element.
      const trueTarget = eventTrueTarget(e);
      const editor = findEditor(trueTarget);
      if (!editor) return;
      currentEditor = editor;

      // Let browser/Vimium handle privileged chords (C-t, C-w, C-l...).
      if (
        (e.ctrlKey || e.metaKey || e.altKey) &&
        !parser.isBinding(token)
      ) {
        return;
      }
      if (token === "<TAB>" && !parser.isCommandBinding(token)) return;
      if (e.ctrlKey && !parser.isBinding(token)) return;
      if (isEscapeEvent(e) && vimiumOverlayActive()) return;

      if (!token) return;
      // Pending multi-key sequences (counts, `"a`, `d`, `g`, `f` awaiting
      // char, `di` awaiting `"`, ...) must always reach feed(): the next
      // key is a continuation, not a fresh binding, and gating on
      // isBinding() alone drops e.g. the `"` in `di"`, the `(` in `f(`,
      // or the `0` in `10`.
      let hasPending = false;
      try {
        hasPending = typeof parser.hasPending === "function" ? parser.hasPending() : !!(parser.buffer && parser.buffer.length);
      } catch (_) {
        hasPending = false;
      }
      // In vim-normal, non-bindings must NOT reach the page (else they'd type).
      if (!hasPending && !parser.isBinding(token)) {
        // Swallow printable keys so normal mode never inserts text,
        // but let function keys / navigation pass through.
        if (token.length === 1 || token === "<CR>" || token === "<BS>" || token === "<TAB>" || token === "<Del>") {
          suppress(e);
        }
        return;
      }

      suppress(e);
      markSuppressed(e);
      // A consumed key must keep focus, except the intentional second-Esc
      // blur in normal mode (shadow Esc-blur defaults are uncancelable).
      const escLike = token === "<ESC>" || token === "<C-C>" || token === "<C-[>";
      const skipRestore = mode === "normal" && escLike;
      try {
        feedConfiguredToken(token);
      } catch (err) {
        try {
          if (window.__VIM_DEBUG__)
            console.error("[GeneralVim] parser error", err);
        } catch (_) {}
      }
      scheduleFocusRestore(skipRestore);
    } catch (_) {
      // Never break the page or Vimium on adapter errors.
    }
  }

  // ---------- Docs engine placement: run in the TOP frame ----------
  //
  // Google Docs routes real keystrokes into a hidden, same-origin editing
  // iframe (`.docs-texteventtarget-iframe`). Our content script runs in every
  // frame, so that iframe used to own the Docs engine — but the iframe holds
  // neither the Docs toolbar (undo/redo click their toolbar buttons) nor the
  // braille/screen-reader text mirror (GDocsNavigator reads it via
  // `getExecIframe()`, which looks for `.docs-texteventtarget-iframe` in its
  // OWN document and finds nothing there). Every motion therefore became a
  // silent no-op: "u" could not undo, "b" could not move a word back, and so
  // on. Vim-For-Docs sidesteps this by running the engine only in the top
  // frame and attaching its keydown handler to the editing iframe
  // (src/content.js attachKeyListener). We do the equivalent: the child frame
  // forwards the key to the top frame's engine and swallows it only when that
  // engine consumed it, so ordinary typing still reaches Docs.

  function docsKeyPayload(e) {
    try {
      return {
        key: typeof e.key === "string" ? e.key : "",
        code: typeof e.code === "string" ? e.code : "",
        keyCode: e.keyCode || 0,
        which: e.which || 0,
        ctrlKey: !!e.ctrlKey,
        altKey: !!e.altKey,
        shiftKey: !!e.shiftKey,
        metaKey: !!e.metaKey,
      };
    } catch (_) {
      return null;
    }
  }

  // Top frame only: process a key forwarded from the hidden editing iframe.
  // Returns true when the key was consumed, which tells the child frame to
  // swallow the event.
  function handleForwardedDocsKey(payload) {
    if (!payload) return false;
    // Overlays (vomnibar, hint markers, find bar, help) live in THIS frame;
    // while one is visible Docs keys belong to Vimium, exactly as they do on
    // the local path in onKeyDown.
    if (vimiumOverlayActive()) return false;
    let consumed = false;
    try {
      const fake = {
        key: payload.key || "",
        code: payload.code || "",
        keyCode: payload.keyCode || 0,
        which: payload.which || 0,
        ctrlKey: !!payload.ctrlKey,
        altKey: !!payload.altKey,
        shiftKey: !!payload.shiftKey,
        metaKey: !!payload.metaKey,
        isTrusted: true,
        isComposing: false,
        target: null,
        composedPath: () => [],
        // handleDocsKey() consumes a key by calling suppress(e). Route that to
        // a flag so the child frame learns whether to swallow the event.
        preventDefault() { consumed = true; },
        stopPropagation() {},
        stopImmediatePropagation() {},
      };
      handleDocsKey(fake);
    } catch (_) {}
    return consumed;
  }

  function handleDocsKey(e) {
    if (!e.isTrusted) return; // ignore our own synthetic events
    if (!editEnabledForUrl) return;
    // Native Docs UI field (Find bar, dialog, comment, ...) focused: its
    // keys belong to Docs, never to vim — pass through with no suppress,
    // no '.'-repeat op tracking, and no mode change.
    if (docsNativeFieldHasFocus(e)) {
      try {
        if (parser) parser.reset();
      } catch (_) {}
      if (docsCmdline) {
        // Our own : / ? line was somehow open: drop it silently WITHOUT
        // refocusing the canvas (docsCloseCmdline would steal focus back
        // from the native field).
        docsCmdline = null;
        docsPendingOperatorCmdline = null;
      }
      try {
        renderIndicator("");
      } catch (_) {}
      return;
    }
    const token = eventToToken(e);
    if (!token) return;
    // Cmdline mode owns the keyboard outright (even for "unbound" keys).
    if (docsCmdline) {
      docsHandleCmdlineKeydown(e, token);
      return;
    }
    // Unbound Ctrl chords fall through to Docs/browser (VFD behavior).
    if (e.ctrlKey && !e.altKey && !e.metaKey && !docsBoundCtrlTokens.has(token)) {
      try { if (parser) parser.reset(); } catch (_) {}
      try { renderIndicator(""); } catch (_) {}
      return;
    }
    // ":", "/", "?" open the command line from normal/visual (never insert).
    if (token === ":" && (mode === "normal" || mode === "visual" || mode === "visualLine")) {
      suppress(e);
      docsOpenCmdline(":");
      return;
    }
    if ((token === "/" || token === "?") && mode !== "insert") {
      suppress(e);
      docsOpenCmdline(token);
      return;
    }

    if (mode === "insert") {
      if (
        token === "<ESC>" ||
        token === "<C-C>" ||
        token === "<C-[>"
      ) {
        suppress(e);
        try {
          if (docsExecutor && docsExecutor.finishInsert)
            docsExecutor.finishInsert(insertOps);
        } catch (_) {}
        resetInsertOps();
        setMode("normal");
        replaceMode = false;
        return;
      }
      if (token === "<C-O>") {
        suppress(e);
        tempNormal = true;
        setMode("normal");
        return;
      }
      // Insert-mode Ctrl editing, copied from Vim-For-Docs src/content.js:
      // <C-H>/<C-W>/<C-J>/<C-T>/<C-D>/<C-N>/<C-P>/<C-R> feed the parser and
      // executor (with '.'-repeat op tracking), instead of reaching Docs.
      const INSERT_CTRL_TOKENS = ["<C-H>","<C-W>","<C-J>","<C-T>","<C-D>","<C-N>","<C-P>","<C-R>"];
      if ((parser && parser.awaitingCharFor) || INSERT_CTRL_TOKENS.indexOf(token) !== -1) {
        suppress(e);
        markSuppressed(e);
        let res = null;
        try {
          res = parser.feed(token);
        } catch (_) {
          res = null;
        }
        if (!res) return;
        if (res.kind === "invalid") {
          renderIndicator("");
          return;
        }
        if (res.kind === "prefix" || res.kind === "await_char") {
          renderIndicator((res.keys || []).join(""));
          return;
        }
        renderIndicator("");
        if (res.kind === "command" && res.command) {
          const cid = res.command.id;
          if (cid === "insert_delete_char_back") appendOpBs();
          else if (cid === "insert_line_break") appendOpText("\n");
          else if (cid === "insert_indent") appendOpText("\t");
          else if (cid === "insert_delete_word") {
            if (!insertOps) resetInsertOps();
            insertOps.push({ type: "delete_word" });
          }
          else if (cid === "insert_dedent") {
            if (!insertOps) resetInsertOps();
            insertOps.push({ type: "dedent" });
          }
          else if (cid === "insert_register") {
            try {
              const nm = (res.command.args && res.command.args.char) || '"';
              const ex = docsExecutor || executor;
              const tv = ex && ex.getRegisterText ? ex.getRegisterText(nm) : "";
              if (tv) appendOpText(tv);
            } catch (_) {}
          }
        }
        runExec(res);
        return;
      }
      if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        appendOpText(e.key);
      } else if (token === "<CR>" && !replaceMode) {
        appendOpText("\n");
      } else if (token === "<BS>") {
        appendOpBs();
      }
      if (
        replaceMode &&
        e.key &&
        e.key.length === 1 &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        suppress(e);
        runExec({
          kind: "command",
          command: {
            id: "insert_replace_char",
            args: { char: e.key },
            modes: ["insert"],
          },
          count: 1,
        });
        return;
      }
      return; // let Docs type
    }

    // Docs non-insert: handle Esc/<C-[> like VFD (reset/exit + tempNormal),
    // then suppress tokenized keys and feed vim bindings. Pending
    // continuations (counts, `di"`, `f(`, `"a`, ...) must reach feed().
    if (token === "<ESC>" || token === "<C-[>") {
      suppress(e);
      try { if (parser) parser.reset(); } catch (_) {}
      try { renderIndicator(""); } catch (_) {}
      if (tempNormal) {
        tempNormal = false;
        try { if (docsExecutor && docsExecutor.finishInsert) docsExecutor.finishInsert(insertOps); } catch (_) {}
        resetInsertOps();
        setMode("normal");
        replaceMode = false;
        try { docsFocusEditor(); } catch (_) {}
        return;
      }
      tempNormal = false;
      replaceMode = false;
      runExec({ kind: "command", command: { id: "exit_mode" }, count: 1 });
      try { docsFocusEditor(); } catch (_) {}
      return;
    }
    suppress(e);
    try {
      let docsPending = false;
      try {
        docsPending = typeof parser.hasPending === "function" ? parser.hasPending() : !!(parser.buffer && parser.buffer.length);
      } catch (_) {
        docsPending = false;
      }
      // Invalid sequences: Vim-style "E492: Not an editor command" on the
      // bottom line + parser reset, not a silent no-op.
      const looksInvalid = !docsPending && !parser.isBinding(token) && parser.buffer && parser.buffer.length;
      if (!docsPending && !parser.isBinding(token)) {
        if (looksInvalid) {
          const keys = (parser.buffer || []).join("");
          try { if (parser) parser.reset(); } catch (_) {}
          docsShowMessage("E492: Not an editor command: " + keys, true);
          return;
        }
        try { renderIndicator(""); } catch (_) {}
        return;
      }
      const resOk = feedConfiguredToken(token);
      // After a successful command in tempNormal, return to insert like VFD.
      if (resOk !== false && tempNormal) {
        const saved = insertOps;
        tempNormal = false;
        setMode("insert");
        insertOps = saved;
      }
    } catch (err) {
      try {
        if (window.__VIM_DEBUG__) console.error("[GeneralVim:Docs] error", err);
      } catch (_) {}
    }
  }

  // ---------- overlay vim editor (complex editors) ----------
  //
  // Industry pattern (Surfingkeys' ACE popup, wasavi's swap-and-write-back,
  // CodeMirror's own fromTextArea/save): edit in OUR OWN plain textarea —
  // where the engine is exact — then commit once. No framework model is
  // ever touched mid-keystroke, so ProseMirror/Lexical/Monaco/CodeMirror
  // can't desync. Esc commits, Ctrl-C discards.

  let overlayHost = null;
  let overlayArea = null;
  let overlayTarget = null; // original element being edited
  let overlayTargetKind = null;
  let overlayTargetCaret = 0;

  function overlayIsOpen() {
    return !!overlayHost && !!overlayArea;
  }

  function overlayInput() {
    try {
      return (window.__allinVimInput) || null;
    } catch (_) {
      return null;
    }
  }

  function readOriginalText(el, kind) {
    try {
      if (!el) return "";
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
        return el.value || "";
      }
      // Rendered text with block line breaks; full-replace on commit.
      return el.innerText != null ? el.innerText : (el.textContent || "");
    } catch (_) {
      return "";
    }
  }

  function openOverlay(target, kind) {
    if (overlayIsOpen() || !parser) return false;
    try {
      if (!document.documentElement || !document.body) return false;
      overlayTarget = target;
      overlayTargetKind = kind;
      try {
        overlayTargetCaret = target.selectionStart || 0;
      } catch (_) {
        overlayTargetCaret = 0;
      }
      const initial = readOriginalText(target, kind);

      overlayHost = document.createElement("div");
      overlayHost.setAttribute("data-generalvim-overlay", "1");
      let shadow = null;
      try {
        shadow = overlayHost.attachShadow({ mode: "open" });
      } catch (_) {
        overlayHost = null;
        overlayTarget = null;
        return false;
      }

      const style = document.createElement("style");
      style.textContent =
        ":host{position:fixed;inset:0;z-index:2147483646;display:flex;" +
        "align-items:center;justify-content:center;" +
        "background:rgba(0,0,0,.6);font-family:Inter,-apple-system," +
        "BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}" +
        ".aiv-panel{width:min(680px,92vw);max-height:80vh;display:flex;" +
        "flex-direction:column;background:var(--surface-canvas);border:1px solid var(--color-steel-border);" +
        "border-radius:8px;overflow:hidden;}" +
        ".aiv-chrome{display:flex;align-items:center;gap:8px;" +
        "background:var(--surface-inset);padding:10px 12px;}" +
        ".aiv-dot{width:10px;height:10px;border-radius:50%;}" +
        ".aiv-title{margin-left:8px;font-size:11px;letter-spacing:2.2px;" +
        "text-transform:uppercase;color:var(--color-cloud-text);flex-grow:1;}" +
        ".aiv-btn{background:transparent;color:var(--color-bone-text);border:1px solid var(--color-graphite-hairline);" +
        "border-radius:4px;font-size:12px;padding:4px 10px;cursor:pointer;}" +
        ".aiv-btn.save{background:var(--color-signal-lime);color:var(--surface-inset);border:none;" +
        "font-weight:500;}" +
        ".aiv-area{flex:1;min-height:240px;background:var(--surface-inset);color:var(--color-bone-text);" +
        "border:none;outline:none;resize:vertical;padding:12px;" +
        "font-family:'Geist Mono','JetBrains Mono',ui-monospace,SFMono-Regular,Menlo," +
        "monospace;font-size:13px;line-height:1.5;}" +
        ".aiv-status{background:var(--surface-canvas);color:var(--color-fog-text);font-size:11px;" +
        "letter-spacing:2.2px;text-transform:uppercase;padding:6px 12px;" +
        "border-top:1px solid var(--color-steel-border);}" +
        ".aiv-status b{color:var(--color-signal-lime);font-weight:400;}";
      const panel = document.createElement("div");
      panel.className = "aiv-panel";
      const chrome = document.createElement("div");
      chrome.className = "aiv-chrome";
      ["#ff5f57", "#febc20", "#28c840"].forEach((c) => {
        const d = document.createElement("div");
        d.className = "aiv-dot";
        d.style.background = c;
        chrome.appendChild(d);
      });
      const title = document.createElement("div");
      title.className = "aiv-title";
      title.textContent = "General Vim · " + (kind || "editor");
      chrome.appendChild(title);
      const discardBtn = document.createElement("button");
      discardBtn.className = "aiv-btn";
      discardBtn.textContent = "Discard";
      discardBtn.addEventListener("click", (ev) => {
        try { ev.stopPropagation(); } catch (_) {}
        closeOverlay(false);
      });
      const saveBtn = document.createElement("button");
      saveBtn.className = "aiv-btn save";
      saveBtn.textContent = "Save";
      saveBtn.addEventListener("click", (ev) => {
        try { ev.stopPropagation(); } catch (_) {}
        closeOverlay(true);
      });
      chrome.appendChild(discardBtn);
      chrome.appendChild(saveBtn);
      panel.appendChild(chrome);

      overlayArea = document.createElement("textarea");
      overlayArea.className = "aiv-area";
      overlayArea.setAttribute("spellcheck", "false");
      overlayArea.value = initial;
      panel.appendChild(overlayArea);

      const status = document.createElement("div");
      status.className = "aiv-status";
      status.innerHTML = "<b>ESC</b>&nbsp;save &nbsp;·&nbsp; <b>CTRL-C</b>&nbsp;discard";
      panel.appendChild(status);

      shadow.appendChild(style);
      shadow.appendChild(panel);
      document.documentElement.appendChild(overlayHost);

      // Drive the proven plain-textarea path with our own surface.
      currentEditor = overlayArea;
      try { parser.reset(); } catch (_) {}
      tempNormal = false;
      replaceMode = false;
      setMode("normal");
      try {
        overlayArea.focus();
        overlayArea.setSelectionRange(0, 0);
      } catch (_) {}
      renderIndicator("");
      return true;
    } catch (_) {
      try {
        if (overlayHost && overlayHost.remove) overlayHost.remove();
      } catch (_) {}
      overlayHost = null;
      overlayArea = null;
      overlayTarget = null;
      return false;
    }
  }

  function commitOverlayText(target, kind, text) {
    if (!target) return;
    try {
      // CodeMirror 5 hides its textarea: go through its API (setValue +
      // save flushes back into the textarea, per CM docs).
      if (kind === "codemirror5") {
        try {
          const box = target.closest ? target.closest(".CodeMirror") : null;
          const cm = (box && box.CodeMirror) ||
            (target.CodeMirror) ||
            (target.nextElementSibling && target.nextElementSibling.CodeMirror);
          if (cm && typeof cm.setValue === "function") {
            cm.setValue(text);
            try { if (typeof cm.save === "function") cm.save(); } catch (_) {}
            try { if (typeof cm.focus === "function") cm.focus(); } catch (_) {}
            return;
          }
        } catch (_) {}
      }
      if (target.tagName === "TEXTAREA" || target.tagName === "INPUT") {
        const inp = overlayInput();
        const caret = Math.max(0, Math.min(overlayTargetCaret, text.length));
        if (inp && inp.commitInputValue) {
          inp.commitInputValue(target, text, caret, "insertFromPaste", text);
        } else {
          try { target.value = text; } catch (_) {}
          try { target.setSelectionRange(caret, caret); } catch (_) {}
          try {
            target.dispatchEvent(new Event("input", { bubbles: true }));
          } catch (_) {}
        }
        try { target.focus({ preventScroll: true }); } catch (_) { try { target.focus(); } catch (_) {} }
        return;
      }
      // Complex contenteditable: single full-replace through the browser
      // editing pipeline so the framework model stays consistent.
      // Afterwards fire input+change (the chatgpt-bridge pattern): some
      // app shells only enable send/submit once they observe a change.
      const fireCommitEvents = () => {
        try {
          const inp = overlayInput();
          if (inp) inp.fireInputEvents(target, "insertFromPaste", text);
          else target.dispatchEvent(new Event("input", { bubbles: true }));
        } catch (_) {}
        try {
          target.dispatchEvent(new Event("change", { bubbles: true }));
        } catch (_) {}
      };
      try { target.focus({ preventScroll: true }); } catch (_) { try { target.focus(); } catch (_) {} }
      let done = false;
      try {
        const sel = window.getSelection();
        if (sel) {
          const r = document.createRange();
          r.selectNodeContents(target);
          sel.removeAllRanges();
          sel.addRange(r);
          try { done = document.execCommand("insertText", false, text); } catch (_) { done = false; }
        }
      } catch (_) { done = false; }
      if (done) {
        fireCommitEvents();
      } else {
        try {
          const inp = overlayInput();
          if (inp) {
            inp.fireInputEvents(target, "insertFromPaste", text);
          } else {
            target.dispatchEvent(new Event("input", { bubbles: true }));
          }
          try {
            target.dispatchEvent(new Event("change", { bubbles: true }));
          } catch (_) {}
        } catch (_) {}
      }
    } catch (_) {}
  }

  function closeOverlay(commit) {
    let text = "";
    try {
      if (commit && overlayArea) text = overlayArea.value;
    } catch (_) {}
    const target = overlayTarget;
    const kind = overlayTargetKind;
    try {
      if (overlayHost && overlayHost.remove) overlayHost.remove();
    } catch (_) {}
    overlayHost = null;
    overlayArea = null;
    overlayTarget = null;
    overlayTargetKind = null;
    try { parser.reset(); } catch (_) {}
    tempNormal = false;
    replaceMode = false;
    if (commit && target) commitOverlayText(target, kind, text);
    currentEditor = null;
    try {
      if (target && document.contains(target)) {
        currentEditor = isTextEditor(target) ? target : null;
        setMode("insert");
      } else {
        setMode("insert");
      }
    } catch (_) {
      setMode("insert");
    }
    renderIndicator("");
  }

  function overlayTrap(e) {
    // While open, no key may reach the page or Vimium: the overlay owns
    // the keyboard. Typing itself is never preventDefaulted.
    try {
      const t = e.target;
      const inside = !!overlayArea && (t === overlayArea || (t && t.getRootNode && t.getRootNode() === overlayHost.shadowRoot));
      if (!inside) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        try { overlayArea.focus(); } catch (_) {}
        return true;
      }
      e.stopPropagation();
      e.stopImmediatePropagation();
      return false; // let our engine handle it below
    } catch (_) {
      return false;
    }
  }

  // ---------- focus tracking ----------

  function attachListeners() {
    // Capture on BOTH window and document: some pages register capture
    // listeners on document before our content script runs; window capture
    // fires first in the propagation path (window -> document -> target),
    // so intercepting there wins regardless of registration order.
    // (Manifest orders this file before vimium_frontend.js in each world.)
    window.addEventListener("keydown", onKeyDown, true);
    try {
      document.addEventListener("keydown", onKeyDown, true);
    } catch (_) {}
    // Swallow the echo events for consumed keys (framework editors insert
    // via keypress/beforeinput even when keydown died).
    try {
      window.addEventListener("keypress", onSuppressibleEvent, true);
      document.addEventListener("keypress", onSuppressibleEvent, true);
      window.addEventListener("keyup", onSuppressibleEvent, true);
      document.addEventListener("keyup", onSuppressibleEvent, true);
      window.addEventListener("beforeinput", onSuppressibleEvent, true);
      document.addEventListener("beforeinput", onSuppressibleEvent, true);
    } catch (_) {}

    document.addEventListener(
      "focusin",
      (e) => {
        try {
          if (overlayIsOpen()) {
            if (e.target === overlayArea) {
              currentEditor = overlayArea;
            } else {
              try { overlayArea.focus(); } catch (_) {}
            }
            return;
          }
          // Google Docs top frame: leaving the editing iframe focuses
          // toolbars/menus (non-editors). Re-render local state so a stale
          // peer display from the iframe doesn't stick.
          if (isGoogleDocs() && window.top === window) {
            renderIndicator();
          }
          // e.target may be a shadow host; resolve via the composed path to
          // the real inner editor.
          const target = eventTrueTarget(e);
          const editor = findEditor(target);
          if (!editor) {
            // Focus landed outside any editor (page body, button, link):
            // the field blurred, so drop the indicator instead of showing
            // a stale mode. (Docs keeps its own display; see above.)
            if (!isGoogleDocs()) {
              editorHasFocus = false;
              hideIndicator();
              updateBlockCaretVisible();
              scheduleBlockCaret();
            }
            return;
          }
          editorHasFocus = true;
          if (currentEditor && currentEditor !== editor) {
            editorModes.set(currentEditor, mode);
          }
          currentEditor = editor;
          const saved = editorModes.get(editor);
          setMode(saved !== undefined ? saved : "insert");
        } catch (_) {}
      },
      true
    );

    document.addEventListener(
      "focusout",
      (e) => {
        try {
          if (overlayIsOpen()) return;
          let blurredEditor = null;
          try {
            blurredEditor = editorFromNode(eventTrueTarget(e));
          } catch (_) {
            blurredEditor = null;
          }
          if (blurredEditor || e.target === currentEditor) {
            if (blurredEditor && isTextEditor(blurredEditor)) {
              editorModes.set(blurredEditor, mode);
            } else if (currentEditor && isTextEditor(currentEditor)) {
              editorModes.set(currentEditor, mode);
            }
            // The field blurred: hide the indicator and block caret now.
            // (The matching focusin re-shows them when focus lands in a
            // field; Docs is exempt and keeps its display.)
            if (!isGoogleDocs()) {
              editorHasFocus = false;
              hideIndicator();
            }
          }
          scheduleBlockCaret();
        } catch (_) {}
      },
      true
    );

    // Caret tracking: reposition the block on native caret moves (mouse
    // drags, IME, page scripts). Coalesced onto rAF: selectionchange can fire
    // per-keystroke, and updateBlockCaret no-ops immediately unless we're in
    // a non-insert mode with a focused editor.
    document.addEventListener("selectionchange", () => {
      try {
        scheduleBlockCaret();
      } catch (_) {}
    });

    document.addEventListener(
      "scroll",
      () => {
        renderIndicator();
        try {
          scheduleBlockCaret();
        } catch (_) {}
      },
      true
    );
    window.addEventListener("resize", () => {
      renderIndicator();
      try {
        scheduleBlockCaret();
      } catch (_) {}
    });
  }

  // ---------- init ----------

  async function init() {
    try {
      // Orphaned by an extension reload: extension resources can no longer
      // load. Bail silently; the fresh content script takes over after the
      // tab reloads.
      try {
        if (chrome.runtime?.id == null) return;
      } catch (_) {
        return;
      }
      // Indicator prefs (position/style). Prefs load async and re-render on
      // arrival; the engine boots immediately.
      try {
        watchPrefs();
      } catch (_) {}
      try {
        watchDocsCursor();
      } catch (_) {}
      try {
        initPrefs();
      } catch (_) {}
      // Exclusion state for this page (popup "exclude keys on this page").
      // Runs before the engine boots so an excluded page never arms vim.
      try {
        await refreshEditEnabledState();
      } catch (_) {}
      // Prefer the inlined config (vim_motions_inline.js, loaded via the
      // manifest before this file). A runtime fetch() is CSP-blocked on
      // strict sites (GitHub et al.), so it is only a fallback.
      let cfg = null;
      try {
        cfg = window.__GENERALVIM_MOTIONS || window.__ALLINVIM_MOTIONS || null;
      } catch (_) {
        cfg = null;
      }
      if (!cfg) {
        const url = chrome.runtime.getURL(
          "content_scripts/vim_edit/vim_motions.json"
        );
        const res = await fetch(url, { cache: "no-cache" });
        cfg = await res.json();
      }
      parser = new window.VimMotionParser(cfg);
      rebuildDocsBoundCtrlTokens(cfg);
      injectDocsPageScript();
      try {
        // Expose the Docs key handler for the hidden editing iframe. Only the
        // top frame runs the Docs engine (toolbar + text mirror live here).
        if (isGoogleDocs() && window.top === window) {
          window.__GENERALVIM_HANDLE_DOCS_KEY__ = handleForwardedDocsKey;
        }
      } catch (_) {}
      try {
        window.__VIM_SHOWMSG__ = function (t, isErr) { docsShowMessage(t, !!isErr); };
        window.__VIM_UI__ = {
          setMessage: function (t, isErr) { docsShowMessage(t, !!isErr); },
          setShowCmd: function (s) { try { lastPending = s || ""; renderIndicator(); } catch (_) {} },
          clearMessage: function () { docsShowMessage("", false); },
        };
      } catch (_) {}

      const modeAPI = {
        setMode: (m) => setMode(m),
        getMode: () => mode,
        isVisual: () => mode === "visual" || mode === "visualLine",
        getReplaceMode: () => replaceMode,
        setReplaceMode: (v) => {
          replaceMode = !!v;
        },
        setTempNormal: (v) => {
          tempNormal = !!v;
        },
        // Manual escape hatch (Ctrl+; → open_overlay command): open the
        // overlay for the focused field even when auto-detection missed
        // its framework. Falls back to in-place normal if it can't open.
        openOverlay: () => {
          try {
            const ed =
              currentEditor && document.contains(currentEditor)
                ? currentEditor
                : findEditor();
            if (!ed) return;
            currentEditor = ed;
            const kind = detectComplexEditor(ed) || "manual";
            if (!openOverlay(ed, kind)) setMode("normal");
          } catch (_) {}
        },
        focusNext: () => {
          try {
            const focusable = document.querySelectorAll(
              'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
            );
            const arr = Array.from(focusable);
            const idx = arr.indexOf(document.activeElement);
            const next = arr[(idx + 1) % arr.length];
            if (next) next.focus();
          } catch (_) {}
        },
      };
      const settingsAPI = { getUseDisplayLines: () => false };

      if (window.createVimExecutor) {
        executor = window.createVimExecutor(modeAPI, settingsAPI);
      }
      if (window.createVimDocsExecutor) {
        try {
          docsExecutor = window.createVimDocsExecutor(modeAPI, settingsAPI);
        } catch (_) {
          docsExecutor = null;
        }
      }

      // Boot in insert mode, for Docs as well as text fields. Google Docs is a document you
      // type into, so loading in normal mode was wrong on both counts: the caret showed up as
      // a block, and the first keystroke went to the engine instead of into the document.
      // Insert mode is also what puts Docs' own thin blinking caret back (see
      // updateDocsBlockCursor).
      setMode("insert");
      const editor = findEditor();
      if (editor) {
        currentEditor = editor;
        editorHasFocus = true;
      }
      renderIndicator("");
    } catch (err) {
      try {
        const message = (err && err.message) || String(err || "");
        // Orphaned content script after an extension reload: stay silent.
        if (/extension context invalidated/i.test(message)) return;
        if (typeof chrome !== "undefined" && chrome.runtime?.id == null) return;
        console.error("[GeneralVim] failed to init edit mode", err);
      } catch (_) {}
    }
  }

  attachListeners();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
