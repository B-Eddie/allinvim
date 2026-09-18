// Everything Vim site: nav, reveal, step tabs, and three live demos (hints / vim buffer / vomnibar).
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  /* ---------- toast ---------- */
  const toastEl = $("#toast");
  let toastTimer = 0;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
  }

  /* ---------- mobile nav ---------- */
  const toggle = $(".nav-toggle");
  const mobile = $(".nav-mobile");
  if (toggle && mobile) {
    toggle.addEventListener("click", () => {
      const open = mobile.hasAttribute("hidden");
      if (open) {
        mobile.removeAttribute("hidden");
        toggle.setAttribute("aria-expanded", "true");
      } else {
        mobile.setAttribute("hidden", "");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
    $$("a", mobile).forEach((a) =>
      a.addEventListener("click", () => {
        mobile.setAttribute("hidden", "");
        toggle.setAttribute("aria-expanded", "false");
      })
    );
    window.addEventListener("resize", () => {
      if (window.matchMedia("(min-width: 901px)").matches) {
        mobile.setAttribute("hidden", "");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* ---------- Apple-style scroll reveals (staggered, expo easing) ---------- */
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  $$("[data-stagger]").forEach((group) => {
    $$(".rv", group).forEach((el, i) => {
      el.style.setProperty("--d", `${Math.min(i, 8) * 90}ms`);
    });
  });
  const revealables = $$(".rv, .rv-scale");
  if ("IntersectionObserver" in window && !reduced) {
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            io.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.1, rootMargin: "0px 0px -6% 0px" }
    );
    revealables.forEach((el) => io.observe(el));
  } else {
    revealables.forEach((el) => el.classList.add("is-in"));
  }

  /* ---------- nav depth on scroll + hero parallax (rAF, transform/opacity only) ---------- */
  const navWrap = $(".nav-wrap");
  const heroInner = $(".hero-inner");
  let ticking = false;
  function onScroll() {
    ticking = false;
    const y = window.scrollY || 0;
    if (navWrap) navWrap.classList.toggle("scrolled", y > 24);
    if (heroInner && !reduced && y < window.innerHeight * 1.2) {
      heroInner.style.transform = `translateY(${y * 0.16}px)`;
      heroInner.style.opacity = `${Math.max(0, 1 - y / (window.innerHeight * 0.85))}`;
    }
  }
  window.addEventListener("scroll", () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(onScroll);
    }
  }, { passive: true });
  onScroll();

  /* ---------- step tabs ---------- */
  const tabs = $$('[role="tablist"] .step[data-tab]');
  const panels = {
    navigate: $("#panel-navigate"),
    edit: $("#panel-edit"),
    command: $("#panel-command"),
  };
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => {
        t.classList.toggle("is-active", t === tab);
        t.setAttribute("aria-selected", t === tab ? "true" : "false");
      });
      Object.entries(panels).forEach(([key, panel]) => {
        if (panel) panel.hidden = key !== tab.dataset.tab;
      });
    });
  });

  /* ---------- demo 1: link hints ---------- */
  const mockPage = $("#mockPage");
  const mockLinks = mockPage ? $$(".mock-links a", mockPage) : [];
  const hintStatus = $("#hintStatus");
  const hintMode = $("#hintMode");
  const hintStart = $("#hintStart");
  let hintsOn = false;

  function setHintMode(label, active) {
    if (!hintMode) return;
    hintMode.textContent = label;
    hintMode.classList.toggle("is-live", !!active);
  }
  function showHints() {
    if (!mockPage || hintsOn) return;
    hintsOn = true;
    $(".mock-links", mockPage)?.classList.add("hints-on");
    mockLinks.forEach((a) => {
      if ($(".hint-badge", a)) return;
      const b = document.createElement("span");
      b.className = "hint-badge";
      b.textContent = (a.dataset.hint || "?").toUpperCase();
      a.prepend(b);
    });
    setHintMode("Hints — press a letter", true);
    if (hintStatus) hintStatus.textContent = "Hints are live. Press A, S, D, or F — or Esc to dismiss.";
  }
  function hideHints(msg) {
    if (!hintsOn) return;
    hintsOn = false;
    $(".mock-links", mockPage)?.classList.remove("hints-on");
    $$(".hint-badge", mockPage).forEach((b) => b.remove());
    setHintMode("Idle", false);
    if (hintStatus && msg) hintStatus.textContent = msg;
    else if (hintStatus) hintStatus.textContent = "Tip: this is a miniature web page. Hints work exactly like the extension.";
  }
  function followHint(key, newTab) {
    const link = mockLinks.find((a) => (a.dataset.hint || "").toLowerCase() === key.toLowerCase());
    if (!link) return;
    hideHints();
    toast(newTab ? `Would open “${link.dataset.name}” in a new tab` : `Opened “${link.dataset.name}” (demo)`);
    if (hintStatus) hintStatus.textContent = `Followed “${link.dataset.name}” ${newTab ? "in a new tab" : "in this tab"} — just like f / F.`;
  }
  if (hintStart) hintStart.addEventListener("click", () => {
    if (hintsOn) hideHints();
    else {
      showHints();
      mockPage?.focus({ preventScroll: true });
    }
  });
  if (mockPage) {
    mockPage.addEventListener("keydown", (e) => {
      if (e.key === "f" || e.key === "F") {
        if (!hintsOn && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          showHints();
        } else if (!hintsOn && e.shiftKey) {
          e.preventDefault();
          showHints();
          if (hintStatus) hintStatus.textContent = "Shift+F mode: next letter opens in a new tab (demo).";
          mockPage.dataset.newtab = "1";
        }
        return;
      }
      if (e.key === "Escape") {
        if (hintsOn) { e.preventDefault(); delete mockPage.dataset.newtab; hideHints(); }
        return;
      }
      if (hintsOn && /^[a-zA-Z]$/.test(e.key) && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        followHint(e.key, e.shiftKey || mockPage.dataset.newtab === "1");
        delete mockPage.dataset.newtab;
      }
    });
    mockLinks.forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        if (hintsOn) followHint(a.dataset.hint || "", false);
        else toast(`Opened “${a.dataset.name}” (demo)`);
      });
    });
  }

  /* ---------- demo 2: mini vim buffer ---------- */
  const area = $("#vimBuffer");
  const modePill = $("#editMode");
  const keyLog = $("#keyLog");
  const recentKeys = [];
  function logKey(k) {
    recentKeys.push(k === " " ? "space" : k);
    if (recentKeys.length > 6) recentKeys.shift();
    if (keyLog) keyLog.textContent = recentKeys.join(" ");
  }
  function renderMode(normal) {
    if (!modePill) return;
    modePill.textContent = normal ? "Normal" : "Insert";
    modePill.classList.toggle("is-live", normal);
    if (area) area.classList.toggle("is-normal", normal);
  }

  if (area) {
    let normal = false;
    let pending = ""; // for d/g pending operators
    let undoStack = [];
    let lastChange = null; // {kind:'x'|'dw'|'dd'}
    const isWordChar = (ch) => /[A-Za-z0-9_]/.test(ch || "");

    const snapshot = () => undoStack.push({ value: area.value, pos: area.selectionStart });
    const undo = () => {
      const s = undoStack.pop();
      if (!s) { toast("Nothing to undo (demo)"); return; }
      area.value = s.value;
      area.setSelectionRange(s.pos, s.pos);
    };
    const posToLineCol = (value, pos) => {
      const upto = value.slice(0, pos);
      const line = upto.split("\n").length - 1;
      const col = pos - (upto.lastIndexOf("\n") + 1);
      return { line, col };
    };
    const lineColToPos = (value, line, col) => {
      const lines = value.split("\n");
      line = Math.max(0, Math.min(line, lines.length - 1));
      col = Math.max(0, Math.min(col, lines[line].length));
      let p = 0;
      for (let i = 0; i < line; i++) p += lines[i].length + 1;
      return p + col;
    };
    const moveV = (dir) => { // vertical with goal column
      const v = area.value;
      const { line, col } = posToLineCol(v, area.selectionStart);
      const goal = area._goalCol ?? col;
      const next = lineColToPos(v, line + dir, goal);
      area._goalCol = goal;
      area.setSelectionRange(next, next);
    };
    const resetGoal = () => { area._goalCol = undefined; };
    const forwardWord = (pos) => {
      const v = area.value;
      let i = pos;
      if (isWordChar(v[i])) while (isWordChar(v[i])) i++;
      while (v[i] && !isWordChar(v[i]) && v[i] !== "\n") i++;
      if (v[i] === "\n") i++;
      return Math.min(i, v.length);
    };
    const backwardWord = (pos) => {
      const v = area.value;
      let i = Math.max(0, pos - 1);
      while (i > 0 && !isWordChar(v[i]) && v[i] !== "\n") i--;
      while (i > 0 && isWordChar(v[i - 1])) i--;
      return i;
    };
    const endWord = (pos) => {
      const v = area.value;
      let i = pos + 1;
      while (v[i] && !isWordChar(v[i])) i++;
      while (v[i] && isWordChar(v[i + 1])) i++;
      return Math.min(i, v.length - 1);
    };
    const deleteRange = (from, to, kind) => {
      snapshot();
      const removed = area.value.slice(from, to);
      area.value = area.value.slice(0, from) + area.value.slice(to);
      area.setSelectionRange(from, from);
      if (kind) lastChange = { kind, text: removed, len: to - from };
    };

    renderMode(false);
    area.addEventListener("keydown", (e) => {
      const mod = e.ctrlKey || e.metaKey || e.altKey;
      logKey(e.key === "Escape" ? "esc" : e.key);

      if (!normal) {
        if (e.key === "Escape" && !mod) {
          e.preventDefault();
          normal = true;
          pending = "";
          snapshot();
          resetGoal();
          // move caret left one when entering normal, vim-style
          const p = Math.max(0, area.selectionStart - 1);
          if (area.value[p] !== "\n") area.setSelectionRange(p, p);
          renderMode(true);
          toast("Normal mode — h j k l move, i types again");
        }
        return; // insert: default typing
      }

      // ---- normal mode: consume almost everything ----
      if (mod) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "r") {
          e.preventDefault();
          toast("Redo lives in the extension (demo keeps undo only)");
        }
        return;
      }
      const k = e.key;
      const pos = area.selectionStart;
      const v = area.value;

      if (k === "Escape") {
        e.preventDefault();
        pending = "";
        area.blur();
        toast("Back to page navigation (demo) — second Esc blurs");
        return;
      }
      if (pending === "d" && (k === "w" || k === "d")) {
        e.preventDefault();
        if (k === "w") {
          const end = forwardWord(pos);
          deleteRange(pos, end, "dw");
        } else {
          const { line } = posToLineCol(v, pos);
          const lines = v.split("\n");
          const start = lineColToPos(v, line, 0);
          const end = lineColToPos(v, line, lines[line].length) + (line < lines.length - 1 ? 1 : 0);
          deleteRange(start, Math.min(end, v.length), "dd");
        }
        pending = "";
        resetGoal();
        return;
      }
      if (pending === "g" && (k === "g" || k === "G")) {
        e.preventDefault();
        pending = "";
        area.setSelectionRange(k === "g" ? 0 : v.length, k === "g" ? 0 : v.length);
        resetGoal();
        return;
      }
      pending = "";

      switch (k) {
        case "h": case "ArrowLeft":
          e.preventDefault(); resetGoal();
          area.setSelectionRange(Math.max(0, pos - 1), Math.max(0, pos - 1));
          break;
        case "l": case " ": case "ArrowRight":
          e.preventDefault(); resetGoal();
          area.setSelectionRange(Math.min(v.length, pos + 1), Math.min(v.length, pos + 1));
          break;
        case "j": case "ArrowDown":
          e.preventDefault(); moveV(1); break;
        case "k": case "ArrowUp":
          e.preventDefault(); moveV(-1); break;
        case "w":
          e.preventDefault(); resetGoal();
          area.setSelectionRange(forwardWord(pos), forwardWord(pos));
          break;
        case "b":
          e.preventDefault(); resetGoal();
          area.setSelectionRange(backwardWord(pos), backwardWord(pos));
          break;
        case "e":
          e.preventDefault(); resetGoal();
          area.setSelectionRange(endWord(pos), endWord(pos));
          break;
        case "0":
          e.preventDefault(); resetGoal();
          area.setSelectionRange(lineColToPos(v, posToLineCol(v, pos).line, 0), lineColToPos(v, posToLineCol(v, pos).line, 0));
          break;
        case "$":
          e.preventDefault(); resetGoal();
          {
            const { line } = posToLineCol(v, pos);
            const end = lineColToPos(v, line, v.split("\n")[line].length);
            area.setSelectionRange(Math.max(0, end - 1), Math.max(0, end - 1));
          }
          break;
        case "x":
          e.preventDefault(); resetGoal();
          if (pos < v.length && v[pos] !== "\n") deleteRange(pos, pos + 1, "x");
          break;
        case "X":
          e.preventDefault(); resetGoal();
          if (pos > 0) deleteRange(pos - 1, pos, "x");
          break;
        case "d":
          e.preventDefault(); pending = "d";
          toast("d… press w (word) or d (line)");
          break;
        case "g":
          e.preventDefault(); pending = "g";
          break;
        case "G":
          e.preventDefault(); resetGoal();
          area.setSelectionRange(v.length, v.length);
          break;
        case "u":
          e.preventDefault(); undo(); break;
        case ".":
          e.preventDefault();
          if (!lastChange) { toast("Nothing to repeat yet (demo)"); break; }
          if (lastChange.kind === "x") {
            if (pos < v.length) deleteRange(pos, pos + (lastChange.len || 1), "x");
          } else if (lastChange.kind === "dw") {
            deleteRange(pos, forwardWord(pos), "dw");
          } else if (lastChange.kind === "dd") {
            const { line } = posToLineCol(area.value, area.selectionStart);
            const lines = area.value.split("\n");
            const s = lineColToPos(area.value, line, 0);
            const en = lineColToPos(area.value, line, lines[line].length) + 1;
            deleteRange(s, Math.min(en, area.value.length), "dd");
          }
          break;
        case "i":
          e.preventDefault(); normal = false; renderMode(false); break;
        case "a":
          e.preventDefault();
          area.setSelectionRange(Math.min(v.length, pos + 1), Math.min(v.length, pos + 1));
          normal = false; renderMode(false); break;
        case "o":
          e.preventDefault();
          snapshot();
          {
            const { line } = posToLineCol(v, pos);
            const at = lineColToPos(v, line, v.split("\n")[line].length);
            area.value = area.value.slice(0, at) + "\n" + area.value.slice(at);
            area.setSelectionRange(at + 1, at + 1);
          }
          normal = false; renderMode(false); break;
        case "O":
          e.preventDefault();
          snapshot();
          {
            const { line } = posToLineCol(v, pos);
            const at = lineColToPos(v, line, 0);
            area.value = area.value.slice(0, at) + "\n" + area.value.slice(at);
            area.setSelectionRange(at, at);
          }
          normal = false; renderMode(false); break;
        case "J":
          e.preventDefault();
          snapshot();
          area.value = area.value.replace(/\n(?!\n*$)/, " ");
          area.setSelectionRange(pos, pos);
          break;
        default:
          // Swallow typing in normal mode; hint at what to do.
          if (/^.$/u.test(k)) {
            e.preventDefault();
            toast(`“${k}” is a Normal-mode key — press i to type`);
          }
          break;
      }
    });
    area.addEventListener("focus", () => renderMode(normal));
  }

  /* ---------- demo 3: vomnibar ---------- */
  const ENTRIES = [
    { kind: "tab", title: "Everything Vim — Options", url: "chrome-extension://…/options" },
    { kind: "tab", title: "Inbox (3) — Gmail", url: "mail.google.com" },
    { kind: "bookmark", title: "Vimium commands reference", url: "vimium.github.io/commands" },
    { kind: "bookmark", title: "Google Docs — Q3 planning", url: "docs.google.com/document/…" },
    { kind: "history", title: "Hacker News — front page", url: "news.ycombinator.com" },
    { kind: "history", title: "GitHub — B-Eddie/allinvim", url: "github.com/B-Eddie/allinvim" },
    { kind: "history", title: "MDN — Selection API", url: "developer.mozilla.org/…" },
  ];
  const vomInput = $("#vomInput");
  const vomList = $("#vomList");
  let selIdx = 0;
  function renderVom(filter = "") {
    if (!vomList) return;
    const q = filter.trim().toLowerCase();
    const rows = ENTRIES.filter((e) =>
      !q || e.title.toLowerCase().includes(q) || e.url.toLowerCase().includes(q)
    );
    selIdx = Math.min(selIdx, Math.max(0, rows.length - 1));
    if (!rows.length) {
      vomList.innerHTML = `<li class="vom-empty">No match — press Enter to open “${filter}” as a URL (demo).</li>`;
      return rows;
    }
    vomList.innerHTML = rows
      .map((e, i) => `<li class="${i === selIdx ? "is-sel" : ""}" data-i="${i}"><span class="vom-kind ${e.kind}">${e.kind}</span><span class="vom-title">${e.title}</span><span class="vom-url">${e.url}</span></li>`)
      .join("");
    $$("li", vomList).forEach((li) => {
      li.addEventListener("click", () => {
        const e = rows[+li.dataset.i];
        toast(`Opened “${e.title}” (demo)`);
      });
    });
    return rows;
  }
  if (vomInput && vomList) {
    let rows = renderVom("");
    vomInput.addEventListener("input", () => { selIdx = 0; rows = renderVom(vomInput.value); });
    vomInput.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); selIdx = Math.min((rows?.length || 1) - 1, selIdx + 1); renderVom(vomInput.value); }
      else if (e.key === "ArrowUp") { e.preventDefault(); selIdx = Math.max(0, selIdx - 1); renderVom(vomInput.value); }
      else if (e.key === "Enter") {
        e.preventDefault();
        const hit = rows && rows[selIdx];
        toast(hit ? `Opened “${hit.title}” (demo)` : `Opened “${vomInput.value}” (demo)`);
      }
    });
  }

  /* ---------- help overlay (?) ---------- */
  const backdrop = $("#helpBackdrop");
  const helpOpen = $("#helpOpen");
  const helpClose = $("#helpClose");
  function openHelp() { if (backdrop) backdrop.hidden = false; }
  function closeHelp() { if (backdrop) backdrop.hidden = true; }
  if (helpOpen) helpOpen.addEventListener("click", openHelp);
  if (helpClose) helpClose.addEventListener("click", closeHelp);
  if (backdrop) backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeHelp(); });
  document.addEventListener("keydown", (e) => {
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    const typing = tag === "INPUT" || tag === "TEXTAREA" || (document.activeElement && document.activeElement.isContentEditable);
    if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
      // Let the vim buffer and vomnibar keep their own "?" keystrokes.
      if (document.activeElement === area || document.activeElement === vomInput) return;
      if (typing) return;
      e.preventDefault();
      openHelp();
    } else if (e.key === "Escape" && backdrop && !backdrop.hidden) {
      closeHelp();
    }
  });
})();
