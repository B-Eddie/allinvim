(function () {
  // Authentic Vim bottom bar:
  //  - Left: mode text ("-- INSERT --", "-- VISUAL --", "-- VISUAL LINE --", "-- REPLACE --", "-- (insert) --", "-- COMMAND --")
  //    In Vim, normal mode shows nothing; showmode only displays INSERT/VISUAL/REPLACE.
  //  - Right: showcmd (pending keys, e.g. "d", "2d", "f", `"a`, "g", "<C-W>")
  //  - When command-line is active ("/" "?" ":"), the entire bar becomes the
  //    command line: ":" or "/" or "?" prompt + typed text + block cursor.
  //  - Messages/errors appear on the left in the message area and auto-fade.
  class VimUIV2Internal {
    constructor() {
      this.theme = 'vim';
      this.modeText = 'normal';
      this.showCmdText = '';
      this.tempNormal = false;
      // Command-line state
      this.cmdline = null; // { type: ':'|'/'|'?', text: '', pos: 0 }
      this.message = null; // { text, isError, timer }
      this.ind = null;
      this._barLeft = null;
      this._barRight = null;
      this._msgTimer = null;
      this._cmdCursorBlink = null;
      // Perf: coalesce cursor style work + cache caret measurements.
      this._cursorRaf = 0;
      this._lastCursorMode = null;
      this._lastCaretH = 0;
      this._lastCaretHAt = 0;
      this.ensureIndicator();
      this.applyTheme();
    }

    _cacheBarEls() {
      try {
        if (!this.ind) return;
        if (!this._barLeft || !this._barLeft.isConnected) {
          this._barLeft = this.ind.querySelector('.vim-bar-left');
        }
        if (!this._barRight || !this._barRight.isConnected) {
          this._barRight = this.ind.querySelector('.vim-bar-right');
        }
      } catch (_) {}
    }

    ensureIndicator() {
      if (this.ind) return;
      this.ind = document.createElement('div');
      this.ind.id = 'vim-for-docs-indicator';
      // Vim-like structure: [left: mode/msg/cmdline] ... [right: showcmd]
      this.ind.innerHTML =
        '<div class="vim-bar-left"></div><div class="vim-bar-right"></div>';
      // Keep caret observer regardless of theme so block cursor works
      try { document.body.appendChild(this.ind); } catch (_) {
        try { document.documentElement.appendChild(this.ind); } catch (_) {}
      }
      try { this._cacheBarEls(); } catch (_) {}
      try { this._injectCursorStyle(); } catch (_) {}
      try { this._ensureCaretObserver(); } catch (_) {}
    }

    _injectCursorStyle() {
      if (document.getElementById('vim-cursor-style')) return;
      var s = document.createElement('style');
      s.id = 'vim-cursor-style';
      // Ensure block cursor stays visible in normal/visual; Vim never blinks it away
      s.textContent = [
        'html[data-vim-mode="normal"] .kix-cursor,',
        'html[data-vim-mode="visual"] .kix-cursor,',
        'html[data-vim-mode="visualLine"] .kix-cursor,',
        'html[data-vim-mode="command"] .kix-cursor {',
        '  visibility: visible !important;',
        '  opacity: 1 !important;',
        '}',
        'html[data-vim-mode="normal"] .kix-cursor-caret,',
        'html[data-vim-mode="visual"] .kix-cursor-caret,',
        'html[data-vim-mode="visualLine"] .kix-cursor-caret,',
        'html[data-vim-mode="command"] .kix-cursor-caret {',
        '  visibility: visible !important;',
        '  opacity: 1 !important;',
        '  border-left-style: solid !important;',
        '}',
        // Bottom bar: ensure text events don't select the indicator and that
        // Docs' bottom floating toolbar (e.g. word count) doesn't overlap
        '#vim-for-docs-indicator { user-select: none; -webkit-user-select: none; }'
      ].join('\n');
      try { document.documentElement.appendChild(s); } catch (_) {
        try { document.head.appendChild(s); } catch (_) {}
      }
    }

    _syncModeAttr() {
      try {
        var m = this.cmdline ? 'command' : (this.modeText || 'normal');
        document.documentElement.setAttribute('data-vim-mode', m);
        if (document.body) document.body.setAttribute('data-vim-mode', m);
      } catch (_) {}
    }

    setTheme(t) {
      this.theme = t || 'vim';
      this.applyTheme();
      this.render();
      this._syncModeAttr();
      try { this.updateCursorStyle(); } catch (_) {}
    }

    setMode(m) {
      this.modeText = m || 'normal';
      this.render();
      this._syncModeAttr();
      try { this.updateCursorStyle(); } catch (_) {}
      try { this._ensureCaretObserver(); } catch (_) {}
    }

    setTempNormal(v) {
      this.tempNormal = !!v;
      this.render();
      this._syncModeAttr();
      try { this.updateCursorStyle(); } catch (_) {}
    }

    // showcmd: pending operator/count/register e.g. "d", "2dw", "\"a"
    setShowCmd(s) { this.showCmdText = s || ''; this.render(); }
    // Backcompat alias used by content.js: bufferText == showcmd
    setBufferText(s) { this.setShowCmd(s); }

    // Command-line
    setCmdline(type, text, pos) {
      if (type == null) {
        this.cmdline = null;
        this.render();
        this._syncModeAttr();
        try { this.updateCursorStyle(); } catch (_) {}
        return;
      }
      this.cmdline = { type: type, text: text || '', pos: (typeof pos === 'number' ? pos : (text || '').length) };
      // Clear any lingering message when opening cmdline
      if (this.message) { this.clearMessage(); }
      this.render();
      this._syncModeAttr();
    }
    updateCmdline(text, pos) {
      if (!this.cmdline) return;
      this.cmdline.text = (typeof text === 'string' ? text : this.cmdline.text);
      if (typeof pos === 'number') this.cmdline.pos = pos;
      this.render();
    }
    clearCmdline() { this.setCmdline(null); }

    // Message area (ex command output, errors, search info)
    setMessage(text, isError) {
      if (!text) { this.clearMessage(); return; }
      this.message = { text: String(text), isError: !!isError };
      this.render();
      var self = this;
      if (self._msgTimer) try { clearTimeout(self._msgTimer); } catch (_) {}
      // Vim keeps messages until the next key/command; we auto-clear after 4s
      // unless it's an error (keeps longer).
      var ttl = isError ? 4000 : 2500;
      self._msgTimer = setTimeout(function () { try { self.clearMessage(); } catch (_) {} }, ttl);
    }
    clearMessage() {
      this.message = null;
      if (this._msgTimer) { try { clearTimeout(this._msgTimer); } catch (_) {} this._msgTimer = null; }
      this.render();
    }

    applyTheme() {
      if (!this.ind) return;
      // Recreate structure after we wiped it in render paths
      if (!this.ind.querySelector('.vim-bar-left')) {
        this.ind.innerHTML =
          '<div class="vim-bar-left"></div><div class="vim-bar-right"></div>';
        this._barLeft = null;
        this._barRight = null;
      }
      this._cacheBarEls();
      var left = this._barLeft;
      var right = this._barRight;

      if (this.theme === 'vim') {
        // True Vim: bottom line, dark terminal background, light text,
        // monospace so it reads as Vim's last screen line. Slight top
        // border like Vim's tiled divider. Not a Google Docs card.
        Object.assign(this.ind.style, {
          position: 'fixed',
          bottom: '0',
          left: '0',
          right: '0',
          height: '22px',
          minHeight: '22px',
          maxHeight: '22px',
          backgroundColor: '#1d2021',
          color: '#ebdbb2',
          padding: '0 8px',
          fontFamily: '"Courier New", Courier, ui-monospace, "Cascadia Code", Menlo, monospace',
          fontSize: '13px',
          lineHeight: '22px',
          fontWeight: '400',
          letterSpacing: '0',
          justifyContent: 'space-between',
          alignItems: 'stretch',
          zIndex: '9999',
          display: 'flex',
          borderTop: '1px solid #32302f',
          boxShadow: 'none',
          whiteSpace: 'nowrap',
          overflow: 'hidden'
        });
        if (left) Object.assign(left.style, {
          flex: '1 1 auto',
          overflow: 'hidden',
          textOverflow: 'clip',
          whiteSpace: 'pre',
          display: 'flex',
          alignItems: 'center'
        });
        if (right) Object.assign(right.style, {
          flex: '0 0 auto',
          fontFamily: '"Courier New", Courier, ui-monospace, monospace',
          color: '#a89984',
          paddingLeft: '12px',
          display: 'flex',
          alignItems: 'center',
          letterSpacing: '0.3px'
        });
      } else {
        this.ind.style.height = '';
        this.ind.style.minHeight = '';
        this.ind.style.maxHeight = '';
        this.ind.style.left = '';
        this.ind.style.right = '';
        Object.assign(this.ind.style, {
          position: 'fixed',
          bottom: '20px',
          right: '20px',
          padding: '8px 16px',
          borderRadius: '16px',
          fontFamily: 'Roboto, Arial, sans-serif',
          fontSize: '14px',
          fontWeight: '500',
          letterSpacing: '0.2px',
          zIndex: '9999',
          display: 'block',
          backgroundColor: '',
          color: '',
          borderTop: 'none',
          boxShadow: '0 1px 3px rgba(60,64,67,0.3), 0 4px 8px rgba(60,64,67,0.15)',
          lineHeight: '1.3',
          whiteSpace: 'nowrap'
        });
        if (left) { left.style.flex = ''; left.style.display = ''; }
        if (right) { right.style.flex = ''; right.style.display = ''; }
      }
    }

    // Format mode line like Vim :h showmode
    _modeLabel() {
      if (this.tempNormal && this.modeText === 'normal') return '-- (insert) --';
      switch (this.modeText) {
        case 'insert': return this._replaceMode ? '-- REPLACE --' : '-- INSERT --';
        case 'visual': return '-- VISUAL --';
        case 'visualLine': return '-- VISUAL LINE --';
        case 'visualBlock': return '-- VISUAL BLOCK --';
        default: return ''; // Vim shows nothing in NORMAL
      }
    }

    // Allow executor/content to toggle REPLACE without going through setMode
    setReplaceMode(v) { this._replaceMode = !!v; this.render(); }

    render() {
      if (!this.ind) return;
      this._cacheBarEls();
      var left = this._barLeft;
      var right = this._barRight;
      if (!left || !right) {
        this.ind.innerHTML =
          '<div class="vim-bar-left"></div><div class="vim-bar-right"></div>';
        this._barLeft = null;
        this._barRight = null;
        this._cacheBarEls();
        left = this._barLeft;
        right = this._barRight;
      }
      if (!left || !right) return;

      if (this.theme !== 'vim') {
        // Default floating pill: keep it minimal and compatible with old theme
        this.ind.innerHTML = '';
        var text = document.createElement('div');
        var disp = (this.modeText === 'visualLine') ? 'VISUAL LINE' : (this.modeText || '').toUpperCase();
        if (this.cmdline) text.textContent = this.cmdline.type + this.cmdline.text;
        else if (this.message && this.message.text) text.textContent = this.message.text;
        else if (this.showCmdText) text.textContent = disp + '  ' + this.showCmdText;
        else text.textContent = disp;
        this.ind.appendChild(text);
        if (this.modeText === 'normal') { this.ind.style.backgroundColor = '#F0F4F9'; this.ind.style.color = '#1f1f1f'; }
        else if (this.modeText === 'insert') { this.ind.style.backgroundColor = '#D9EAD3'; this.ind.style.color = '#274e13'; }
        else { this.ind.style.backgroundColor = '#D9D2E9'; this.ind.style.color = '#351c75'; }
        if (this.cmdline) { this.ind.style.backgroundColor = '#1d2021'; this.ind.style.color = '#ebdbb2'; }
        if (this.message && this.message.isError) { this.ind.style.backgroundColor = '#cc241d'; this.ind.style.color = '#fbf1c7'; }
        return;
      }

      // Vim theme
      // Command-line owns the entire bar (Vim does this)
      if (this.cmdline) {
        var t = this.cmdline.type || ':';
        var txt = this.cmdline.text || '';
        var pos = this.cmdline.pos;
        // Clamp pos
        if (pos < 0) pos = 0;
        if (pos > txt.length) pos = txt.length;
        var before = txt.slice(0, pos);
        var at = txt.slice(pos, pos + 1);
        var after = txt.slice(pos + 1);
        // Render prompt + text with a block cursor over the character at pos
        // Exactly like Vim's command-line cursor.
        left.textContent = '';
        left.style.color = '#ebdbb2';
        // Build spans so the cursor is a solid block like Vim's
        var prompt = document.createElement('span');
        prompt.textContent = t;
        prompt.style.color = '#fe8019';
        left.appendChild(prompt);
        var bSpan = document.createElement('span');
        bSpan.textContent = before;
        left.appendChild(bSpan);
        var cur = document.createElement('span');
        // Vim block cursor: invert colors over the character under cursor
        cur.style.backgroundColor = '#ebdbb2';
        cur.style.color = '#1d2021';
        cur.style.display = 'inline-block';
        cur.style.minWidth = at ? '' : '7px';
        cur.style.paddingRight = '';
        if (at) cur.textContent = at;
        else {
          cur.textContent = ' ';
          cur.style.opacity = '0.95';
        }
        left.appendChild(cur);
        if (after) {
          var aSpan = document.createElement('span');
          aSpan.textContent = after;
          left.appendChild(aSpan);
        }
        right.textContent = '';
        // No showcmd while cmdline is open (matches Vim)
        return;
      }

      // Message (e.g. "E486: Pattern not found: foo" or "3 substitutions on 3 lines")
      if (this.message && this.message.text) {
        left.textContent = this.message.text;
        left.style.color = this.message.isError ? '#fb4934' : '#ebdbb2';
        if (this.message.isError) left.style.fontWeight = '700';
        else left.style.fontWeight = '400';
        right.textContent = this.showCmdText || '';
        right.style.color = '#a89984';
        return;
      }

      // Normal mode-line + showcmd
      var ml = this._modeLabel();
      left.textContent = ml;
      left.style.fontWeight = ml ? '700' : '400';
      // Color the mode like Vim's mode indicator highlight groups
      if (ml.indexOf('INSERT') !== -1) left.style.color = '#b8bb26';
      else if (ml.indexOf('VISUAL') !== -1) left.style.color = '#d3869b';
      else if (ml.indexOf('REPLACE') !== -1) left.style.color = '#fb4934';
      else if (ml.indexOf('(insert)') !== -1) left.style.color = '#83a598';
      else left.style.color = '#ebdbb2';

      right.textContent = this.showCmdText || '';
      right.style.color = '#a89984';
    }

    // Coalesced entry point: rapid mode/selection events become one rAF.
    requestCursorUpdate() {
      if (this._cursorRaf) return;
      var self = this;
      try {
        this._cursorRaf = requestAnimationFrame(function () {
          self._cursorRaf = 0;
          try { self.updateCursorStyle(); } catch (_) {}
        });
      } catch (_) {
        try { self.updateCursorStyle(); } catch (_) {}
      }
    }

    // ----- Block cursor (kept from previous impl, tweaked) -----
    updateCursorStyle() {
      var isInsert = false;
      try {
        // In command-line mode, show a thin cursor in the document but keep
        // normal block styling — Vim still shows the document cursor when
        // typing ":". We map cmdline -> normal cursor here for consistency.
        isInsert = (this.cmdline ? false : (this.modeText === 'insert' && !this._replaceMode));
      } catch (_) { isInsert = (this.modeText === 'insert'); }
      var modeKey = (this.cmdline ? 'command' : this.modeText) + (isInsert ? ':i' : ':n');
      // Skip redundant block-cursor recompute (measurement needs layout).
      // Always re-apply in non-insert (Docs recreates caret), but avoid
      // getComputedStyle chain when we just measured a good height.
      var now = Date.now();
      var caret = null;
      var wrapper = null;
      try {
        caret = document.querySelector('.kix-cursor-caret');
        wrapper = document.querySelector('.kix-cursor');
      } catch (_) {}
      if (!caret) {
        if (wrapper && !isInsert) {
          try {
            if (wrapper.style.display === 'none') wrapper.style.display = '';
            if (wrapper.style.visibility === 'hidden') wrapper.style.visibility = 'visible';
            if (wrapper.style.opacity === '0') wrapper.style.opacity = '1';
            wrapper.style.visibility = 'visible';
            wrapper.style.opacity = '1';
          } catch (_) {}
        }
        try { this._scheduleCursorRetry(); } catch (_) {}
        return;
      }
      if (!isInsert && wrapper) {
        try {
          if (wrapper.style.display === 'none') wrapper.style.display = '';
          if (wrapper.style.visibility === 'hidden') wrapper.style.visibility = 'visible';
          if (wrapper.style.opacity === '0') wrapper.style.opacity = '1';
          wrapper.style.visibility = 'visible';
          wrapper.style.opacity = '1';
        } catch (_) {}
      }
      try {
        if (caret.style.display === 'none') caret.style.display = '';
        if (caret.style.visibility === 'hidden') caret.style.visibility = 'visible';
        if (caret.style.opacity === '0') caret.style.opacity = '1';
        caret.style.visibility = isInsert ? caret.style.visibility : 'visible';
        if (!isInsert) caret.style.opacity = '1';
      } catch (_) {}
      if (isInsert) {
        try {
          caret.style.borderWidth = '2px';
          caret.style.borderLeftWidth = '2px';
          caret.style.borderLeftStyle = '';
          caret.style.width = '';
          caret.style.backgroundColor = '';
          if (caret.dataset && caret.dataset.vimBlockHeight === '1') {
            try { caret.style.height = ''; } catch (_) {}
            delete caret.dataset.vimBlockHeight;
          }
        } catch (_) {}
        return;
      }
      var h = 0;
      try { h = parseFloat((caret.style.height || '').slice(0, -2)); } catch (_) {}
      // Reuse recent good measurement: caret height rarely changes per doc.
      if ((!h || isNaN(h) || h <= 0) && this._lastCaretH > 0 && (now - this._lastCaretHAt) < 5000) {
        h = this._lastCaretH;
      }
      if (!h || isNaN(h) || h <= 0) { try { h = caret.getBoundingClientRect().height; } catch (_) {} }
      if (!h || isNaN(h) || h <= 0) { try { h = caret.offsetHeight; } catch (_) {} }
      if (!h || isNaN(h) || h <= 0) { try { h = parseFloat(getComputedStyle(caret).height); } catch (_) {} }
      if (!h || isNaN(h) || h <= 0) {
        try {
          var wh = wrapper ? parseFloat(getComputedStyle(wrapper).height) : 0;
          if (wh && !isNaN(wh) && wh > 0) h = wh;
        } catch (_) {}
      }
      if (h && !isNaN(h) && h > 0) { this._lastCaretH = h; this._lastCaretHAt = now; }
      var usedFallbackH = false;
      if (!h || isNaN(h) || h <= 0) {
        try {
          var line = document.querySelector('.kix-lineview');
          if (line) {
            var lh = line.getBoundingClientRect().height;
            if (lh && lh > 0 && lh < 40) h = lh;
            else if (lh && lh > 0) {
              var cs = getComputedStyle(line);
              var lhh = parseFloat(cs.lineHeight);
              if (lhh && lhh > 0) h = lhh;
            }
          }
        } catch (_) {}
      }
      if (!h || isNaN(h) || h <= 0) {
        try {
          var cs2 = getComputedStyle(caret);
          var fs = parseFloat(cs2.fontSize);
          if (fs && fs > 0) h = Math.round(fs * 1.35);
        } catch (_) {}
      }
      if (!h || isNaN(h) || h <= 0) { h = 18; usedFallbackH = true; }
      else if (h < 10) {
        var fallback = 18;
        try {
          var cs3 = getComputedStyle(caret);
          var fs2 = parseFloat(cs3.fontSize);
          if (fs2 && fs2 > 10) h = Math.round(fs2 * 1.35);
          else h = fallback;
        } catch (_) { h = fallback; }
        usedFallbackH = true;
      }
      if (usedFallbackH) {
        try {
          var curH = caret.style.height;
          var curVal = parseFloat(curH);
          if (!curH || isNaN(curVal) || curVal <= 0 || curVal < 8) {
            caret.style.height = h + 'px';
            if (caret.dataset) caret.dataset.vimBlockHeight = '1';
          }
        } catch (_) {}
      } else {
        try { if (caret.dataset && caret.dataset.vimBlockHeight === '1') delete caret.dataset.vimBlockHeight; } catch (_) {}
      }
      var w = Math.max(7, Math.round(0.416 * h));
      try {
        caret.style.borderWidth = w + 'px';
        caret.style.borderLeftWidth = w + 'px';
        caret.style.borderLeftStyle = 'solid';
        try {
          var cs4 = getComputedStyle(caret);
          var col = cs4 && cs4.borderLeftColor;
          if (!col || col === 'rgba(0, 0, 0, 0)' || col === 'transparent') {
            caret.style.borderLeftColor = '#ebdbb2';
          }
        } catch (_) { try { caret.style.borderLeftColor = '#ebdbb2'; } catch (_) {} }
        caret.style.visibility = 'visible';
        caret.style.opacity = '1';
        caret.style.display = caret.style.display === 'none' ? '' : caret.style.display;
        if (wrapper) {
          try { wrapper.style.visibility = 'visible'; wrapper.style.opacity = '1'; wrapper.style.display = wrapper.style.display === 'none' ? '' : wrapper.style.display; } catch (_) {}
        }
        if (usedFallbackH) try { this._scheduleCursorRetry(); } catch (_) {}
      } catch (_) {
        try { caret.style.borderWidth = '7px'; caret.style.borderLeftWidth = '7px'; caret.style.borderLeftStyle = 'solid'; caret.style.visibility = 'visible'; caret.style.opacity = '1'; } catch (_) {}
        try { this._scheduleCursorRetry(); } catch (_) {}
      }
    }

    _scheduleCursorRetry() {
      if (this._cursorRetry) return;
      this._cursorRetry = true;
      var attempts = 0;
      var self = this;
      var tick = function () {
        attempts++;
        try { self.updateCursorStyle(); } catch (_) {}
        var caret = document.querySelector('.kix-cursor-caret');
        var h = 0;
        try { h = caret ? parseFloat((caret.style.height || '').slice(0, -2)) || parseFloat(getComputedStyle(caret).height) || caret.getBoundingClientRect().height : 0; } catch (_) {}
        var needMore = (!h || h < 8) && self.modeText !== 'insert' && attempts < 22;
        if (needMore) {
          setTimeout(tick, attempts < 6 ? 30 : (attempts < 12 ? 80 : 150));
        } else {
          self._cursorRetry = false;
          if (self.modeText !== 'insert') setTimeout(function () { try { self.updateCursorStyle(); } catch (_) {} }, 80);
        }
      };
      try { requestAnimationFrame(tick); } catch (_) { setTimeout(tick, 0); }
      setTimeout(function () { self._cursorRetry = false; }, 4500);
    }

    _ensureCaretObserver() {
      if (this._caretObserver) return;
      try {
        var self = this;
        var apply = function () { self.requestCursorUpdate(); };
        var lastApply = 0;
        var debouncedApply = function () {
          var n = Date.now();
          if (n - lastApply < 100) return; // coalesce bursts
          lastApply = n;
          apply();
        };
        this._caretObserver = new MutationObserver(function (mutations) {
          var touched = false;
          for (var i = 0; i < mutations.length; i++) {
            var m = mutations[i];
            if (m.type === 'childList') {
              for (var a = 0; a < m.addedNodes.length; a++) {
                var n = m.addedNodes[a];
                if (n.nodeType === 1 && (n.matches && (n.matches('.kix-cursor-caret') || n.matches('.kix-cursor')) || (n.querySelector && n.querySelector('.kix-cursor-caret, .kix-cursor')))) { touched = true; break; }
              }
              if (touched) break;
              for (var r = 0; r < m.removedNodes.length; r++) {
                var nn = m.removedNodes[r];
                if (nn.nodeType === 1 && (nn.matches && (nn.matches('.kix-cursor-caret') || nn.matches('.kix-cursor')) || (nn.querySelector && nn.querySelector('.kix-cursor-caret, .kix-cursor')))) { touched = true; break; }
              }
              if (touched) break;
            } else if (m.type === 'attributes' && m.target && m.target.matches && m.target.matches('.kix-cursor-caret, .kix-cursor')) {
              touched = true; break;
            }
          }
          if (touched) debouncedApply();
        });
        this._caretObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
      } catch (_) {}
      try {
        var self2 = this;
        var doApply = function () {
          if (self2.modeText !== 'insert' || self2.cmdline) {
            self2.requestCursorUpdate();
          }
        };
        document.addEventListener('selectionchange', doApply, { passive: true });
        var attachIframe = function () {
          try {
            var iframe = document.querySelector('.docs-texteventtarget-iframe');
            var idoc = iframe && iframe.contentDocument;
            if (idoc && !idoc.__vimSelAttached) {
              idoc.__vimSelAttached = true;
              idoc.addEventListener('selectionchange', doApply, { passive: true });
            }
          } catch (_) {}
        };
        attachIframe();
        try {
          var lastIv = 0;
          var ivObs = new MutationObserver(function () {
            var n = Date.now();
            if (n - lastIv < 1000) return;
            lastIv = n;
            attachIframe();
          });
          ivObs.observe(document.documentElement, { childList: true, subtree: true });
        } catch (_) {}
      } catch (_) {}
    }
  }
  window.VimUIV2 = VimUIV2Internal;
})();
