# General Vim — Vim everywhere, on every site

General Vim unifies three proven extensions on top of
[philc/vimium](https://github.com/philc/vimium) (26k+ stars, MIT):

| Layer | Origin | What it does |
|---|---|---|
| Page navigation | `philc/vimium` (`background_scripts/`, `content_scripts/mode_normal.js`, `link_hints.js`, `vomnibar.js`, `marks.js`, …) | `hjkl` scroll, `f/F` link hints, `o/O` Vomnibar, tabs, marks, find, history |
| Text-field editing | `Vim-For-Textarea` (`content_scripts/vim_edit/vim_parser.js` + `vim_executor.js`) | Modal `h/j/k/l`, `w/b/e`, `0/^/$`, `gg/G`, `f/F/t/T`, operators `d/c/y` + text objects, visual modes — in any `textarea`, `input`, or `contenteditable` |
| Google Docs editing | `Vim-For-Docs` (`content_scripts/vim_edit/vim_docs_executor.js`) | Same motions on the Docs canvas via synthetic keys + `Selection.modify` (direct DOM surgery is impossible there). `h`/`j`/`k`/`l` map 1:1 to plain arrow keys (with counts); visual `j`/`k` extend via Shift+arrows |

The router is `content_scripts/mode_edit.js`. The motions config
(`content_scripts/vim_edit/vim_motions.json`, inlined to
`vim_motions_inline.js` via `build_scripts/gen_motions_inline.py`) is shared
by all editing surfaces.

## Handoff — how the three Vims never fight

`mode_edit.js` installs one `window`-capture `keydown` listener **before**
`vimium_frontend.js` (manifest order matters). Routing per keystroke:

1. **Overlay editor open?** It owns the keyboard outright. `Esc` commits,
   `Ctrl-C` discards. Nothing reaches the page or Vimium.
2. **Vimium overlay visible?** (link hints, Vomnibar, help, HUD) → yield, let
   Vimium win — except case 1.
3. **Google Docs?** (memoized `isGoogleDocs()`) → Docs executor. Boots
   **NORMAL** always; `Esc` leaves insert, insert ops tracked for `.` repeat.
   The Docs caret (`.kix-cursor-caret`) is widened into a lime block in
   normal/visual modes and restored thin in insert, driven by a
   `data-generalvim-mode` attribute + MutationObserver (Docs recreates caret
   nodes constantly).
4. **Plain editor focused?** (`textarea` / text-like `input` /
   `contenteditable` / `role=textbox`, Shadow-DOM aware) → direct executor.
   Boots **INSERT**; `Esc` → NORMAL and suppresses the key via
   `stopImmediatePropagation()` so Vimium's `j/k/f` never fires. Second `Esc`
   in NORMAL blurs back to page navigation.
5. **Complex framework?** (CodeMirror 5/6, Monaco, ProseMirror, Lexical,
   Slate, Quill, Ace, Draft, CKEditor, TinyMCE) → `Esc` escalates to our own
   overlay textarea (Surfingkeys/wasavi pattern), commits once on `Esc`.
   Framework models are never touched mid-keystroke, so they can't desync.
6. **Otherwise** → do nothing; Vimium page navigation handles the key.

Guards: IME composition (`keyCode 229`) always passes through; privileged
`Ctrl/Meta` chords pass through unless bound; `Tab` passes unless remapped;
orphaned content scripts after an extension reload retire quietly instead of
logging `Extension context invalidated`. Per-editor mode memory via `WeakMap`;
block caret redraws coalesced on `requestAnimationFrame`; font measurement
cached per element; Docs detection memoized per URL.

## Exclusions ("No Vimium keys are enabled on this page")

The toolbar popup's exclusion button (and the Options exclusion table) gates
both layers. The edit router enforces the same rule as Vimium navigation —
an excluded page passes every key through, hides the indicator and block
caret, and never strands an open overlay. Partial `passKeys` rules leave
text editing alone; only absolute exclusions disable it. Saving new rules
takes effect immediately via `refreshEnabledState` (fresh state pushed to
every frame, toolbar icon updated) — no tab reload required. The content
script additionally applies the just-saved rules locally on the same tick as
the storage event, so there is no save→test race while the background worker
cold-starts, and exclusion still applies if the background is unreachable.
The just-saved rules also ride along on the background message, so re-enabling
a site can never be answered from a stale Settings copy (which previously left
pages stuck disabled until reload).

## Performance

- `run_at: document_start`, `all_frames: true` — the router is in place before
  page scripts type a character.
- Motions config is **inlined** (`vim_motions_inline.js`); no `fetch()` on web
  pages, so strict CSP sites (GitHub et al.) work. Regenerate with
  `python3 build_scripts/gen_motions_inline.py`.
- Link-hint scan uses upstream `querySelectorAll("*")` traversal (so custom-element
  shadow hosts like `<d2l-my-courses-enrollment-card>` are pierced), with cheap
  `getClientRects()` reject before layout-forcing rect reads and hoisted
  AngularJS detection.
- Block caret uses one reused mirror div + canvas measurement; repaints are
  rAF-coalesced; `getComputedStyle` font strings cached per editor.
- No polling, no shadows, flat 1px-hairline UI.

## UI — themes

`lib/theme.js` is the single source of truth for the palette. Six dark themes
ship: Trigger (default), Catppuccin Mocha, Dracula, Gruvbox Dark, Tokyo Night
and Nord. Each one defines the same 26 CSS custom properties (`--surface-*`,
`--color-*`), which `lib/theme.js` writes onto `<html>` as inline styles.
Custom properties inherit, so applying them once reaches every surface:
extension pages, shadow DOMs (hint markers, the Vomnibar wrapper) and iframes.

Pick one under **Options → General Vim → Theme** (the `theme` setting). The
palette values themselves are only in `lib/theme.js` — the stylesheets carry
just the Trigger palette as a pre-script fallback, and rules should reference
tokens rather than literal colors.

Trigger, for reference: matte slate canvas `#1c1e21`, recessed ink well
`#121317`, hairlines `#272a2e`/`#3b3e45`, bone text `#e5e7eb`. Signal lime
`#a8ff53` is the only filled accent (primary CTA, hint-marker borders,
normal-mode caret/indicator); the syntax palette (`#9c9af2` violet, `#fa3abf`
pink, `#afec73`/`#d9f07c` greens, `#e888f8` magenta) lives only in code panes
and icons. Every other theme keeps the same structure and swaps the colors.
4px radii, Geist + Geist Mono, no drop shadows, in all of them.

Extension pages load `lib/theme.js` from a `<script>` in the `<head>`, ahead
of their stylesheets, so the first frame is already themed (from a
`localStorage` cache, which is synchronous); content scripts load it as a
content script and repaint whenever the settings change. `pages/warp_theme.css`
(kept filename for compatibility) holds the page-level rules, and
`content_scripts/vimium.css` the in-page ones, which stay self-contained so
they can be injected.

## Mode indicator (single source of truth)

The edit-mode indicator rendered by `mode_edit.js` is the only mode signal —
no Vimium HUD popup. Labels never use `--` decoration (`NORMAL`, `INSERT`,
`VISUAL`, `VISUAL LINE`, `REPLACE`, `TEMP` plus pending keys).

The compact layouts show one letter per mode instead of the full name — `N`,
`V` (visual and visual line), `I`, `R` (replace), `T` (temp normal) — so the
chip stays small in the corner of the page or next to the active textbox. The
Docs `bar` has the screen width available and keeps the full name.

Options page → General Vim section:

- `generalVimIndicatorPosition`: `corner` (bottom-right chip, default) |
  `field` (small label pinned to the active textbox) | `hidden`.
- `generalVimDocsIndicator`: `bar` (full-width Vim-style bottom bar with mode
  left + pending keys right, default) | `chip` (small bottom-right card).

Editing starts in **insert mode** everywhere, Google Docs included: a document
is something you type into, and insert mode is also what shows Docs' own thin
blinking caret instead of the block caret normal mode draws.

On Google Docs, keystrokes land in a hidden same-origin iframe, but the engine
belongs to the **top frame** — the only frame with Docs' toolbar and the
braille/screen-reader text mirror the executor reads, and the only frame that
can own the visible caret and indicator. Child frames forward *keys* to
`window.__GENERALVIM_HANDLE_DOCS_KEY__` and keep no state of their own; there is
nothing to sync back, because a child has no mode to report. (A child does have
a boot-time `mode` variable, and an earlier design published it as if it were
the engine's mode — that stale value overrode the top frame, which is what left
the caret stuck as a block after entering insert mode.)

Text fields resolve the editor via the true event target
(`composedPath`, shadow-aware) with focus restoration after Esc, matching
Vim-For-Textarea behavior — Esc at end-of-input parks the caret one char
left instead of jumping, and the page's own Esc handlers can't race us.

## Install from source (Chrome/Edge)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder (`manifest.json` lives here).
3. Press `?` on any page for the full binding list; open Options from the
   toolbar popup or `chrome://extensions` → Details → Extension options.

Firefox: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on →
pick any file here (see upstream `CONTRIBUTING.md` for store builds).

## Editing cheatsheet (focused text)

- `Esc` normal mode · `i/a/o/O/A` insert variants · `v/V` visual
- `h/j/k/l`, `w/W/b/B/e/E`, `0/^/$`, `gg/G`, `f/F/t/T` + `;`/`,`
- `d/c/y` + motion or text object (`iw`, `i"`, `a(`, `ip`, …), `x/X`, `p/P`,
  `u`/`Ctrl-R`, `.` repeat, `J`, `~`, `*`/`#`, marks `` m` ``
- Insert: `Ctrl-O` one normal command, `Ctrl-W/H` delete word/char

## Website

`website/` is a dependency-free static site (Trigger.dev styling) ready for
Vercel: `vercel.json` + `cleanUrls`. Deploy: `cd website && vercel --prod`
(or drag the folder into vercel.com). Local preview:
`python3 -m http.server -d website 8000`.

## Credits

- Navigation engine + options/vomnibar/HUD/help: `philc/vimium` (MIT).
  Upstream README bindings below still apply for page navigation.
- Editing engines: `Vim-For-Docs` / `Vim-For-Textarea` authors
  (see `../Vim-For-Docs`, `../Vim-For-Textarea`).
- Perf + unification + Trigger.dev reskin: this folder (`General Vim 1.0.0`).

---

Original Vimium README (page-navigation bindings) follows unchanged.
