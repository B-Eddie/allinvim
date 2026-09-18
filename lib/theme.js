// Everything Vim themes.
//
// Every extension surface -- the options page, the toolbar popup, the Vomnibar, the HUD, the help
// dialog, the command listing, the in-page hint markers, the mode indicator and the AI window --
// is painted from a single set of CSS custom properties. This file is the only place where those
// properties are given values, so the themes cannot drift apart between surfaces.
//
// The properties are applied to `document.documentElement` as inline styles. Custom properties
// inherit, so this reaches shadow DOM (the hint markers and Vomnibar wrappers) and iframes that
// have already had their own theme applied. Stylesheets only carry a default-theme fallback so
// that nothing renders unstyled before this runs.
//
// This file is loaded three ways, so it must stay a plain script (no import/export):
//   - as a content script, on every frame (see manifest.json);
//   - as a synchronously-executing <script> in the <head> of every extension page, which gives us
//     the theme before first paint;
//   - via `import` from page modules that need to apply it after settings load.
// The guard at the bottom keeps the second and third loads from redefining the API.

// The settings key holding the selected theme's name (see lib/settings.js).
const THEME_SETTING_NAME = "theme";

// The theme used when nothing has been chosen, or when an unknown name is stored.
const DEFAULT_THEME_NAME = "trigger-dark";

// A synchronously-readable cache of the selected theme, so extension pages can paint correctly
// before chrome.storage answers. Only extension pages have a meaningful localStorage; in a content
// script localStorage belongs to the visited page, so we never touch it there.
const THEME_CACHE_KEY = "everythingVimTheme";
// Theme cache key used before the "Everything Vim" rename; read once for a seamless upgrade,
// then forgotten.
const LEGACY_THEME_CACHE_KEY = "generalVimTheme";

const isExtensionPage = () => {
  const protocol = globalThis.location?.protocol;
  return protocol == "chrome-extension:" || protocol == "moz-extension:";
};

// Every theme defines the same property names, so switching themes can never leave a stale value
// behind. `label` is the name shown in the options dropdown.
const themes = {
  "trigger-dark": {
    label: "Trigger (default)",
    properties: {
      "--surface-canvas": "#1c1e21",
      "--surface-inset": "#121317",
      "--surface-card": "#1c1e21",
      "--surface-accent": "#a8ff53",
      "--color-slate-canvas": "#1c1e21",
      "--color-ink-well": "#121317",
      "--color-steel-border": "#272a2e",
      "--color-graphite-hairline": "#3b3e45",
      "--color-ash-text": "#b5b8c0",
      "--color-fog-text": "#878c99",
      "--color-cloud-text": "#d7d9dd",
      "--color-bone-text": "#e5e7eb",
      "--color-signal-lime": "#a8ff53",
      "--color-accent-ink": "#121317",
      "--color-syntax-violet": "#9c9af2",
      "--color-syntax-pink": "#fa3abf",
      "--color-syntax-orange": "#fe8019",
      "--color-event-violet": "#7655fd",
      "--color-loop-green": "#afec73",
      "--color-key-lime": "#d9f07c",
      "--color-tag-magenta": "#e888f8",
      "--color-mute-red": "#f43f5e",
      "--color-warning": "#ff5300",
      "--color-input-hint-bg": "rgba(168, 255, 83, 0.16)",
      "--color-input-hint-selected-bg": "rgba(156, 154, 242, 0.28)",
      "--color-hover-wash": "rgba(229, 231, 235, 0.08)",
    },
  },

  catppuccin: {
    label: "Catppuccin Mocha",
    properties: {
      "--surface-canvas": "#1e1e2e",
      "--surface-inset": "#181825",
      "--surface-card": "#1e1e2e",
      "--surface-accent": "#a6e3a1",
      "--color-slate-canvas": "#1e1e2e",
      "--color-ink-well": "#181825",
      "--color-steel-border": "#313244",
      "--color-graphite-hairline": "#45475a",
      "--color-ash-text": "#a6adc8",
      "--color-fog-text": "#7f849c",
      "--color-cloud-text": "#bac2de",
      "--color-bone-text": "#cdd6f4",
      "--color-signal-lime": "#a6e3a1",
      "--color-accent-ink": "#1e1e2e",
      "--color-syntax-violet": "#cba6f7",
      "--color-syntax-pink": "#f5c2e7",
      "--color-syntax-orange": "#fab387",
      "--color-event-violet": "#b4befe",
      "--color-loop-green": "#a6e3a1",
      "--color-key-lime": "#f9e2af",
      "--color-tag-magenta": "#f5c2e7",
      "--color-mute-red": "#f38ba8",
      "--color-warning": "#f9e2af",
      "--color-input-hint-bg": "rgba(166, 227, 161, 0.16)",
      "--color-input-hint-selected-bg": "rgba(203, 166, 247, 0.28)",
      "--color-hover-wash": "rgba(205, 214, 244, 0.08)",
    },
  },

  dracula: {
    label: "Dracula",
    properties: {
      "--surface-canvas": "#282a36",
      "--surface-inset": "#21222c",
      "--surface-card": "#282a36",
      "--surface-accent": "#50fa7b",
      "--color-slate-canvas": "#282a36",
      "--color-ink-well": "#21222c",
      "--color-steel-border": "#44475a",
      "--color-graphite-hairline": "#6272a4",
      "--color-ash-text": "#c3c4d1",
      "--color-fog-text": "#6272a4",
      "--color-cloud-text": "#e2e2e8",
      "--color-bone-text": "#f8f8f2",
      "--color-signal-lime": "#50fa7b",
      "--color-accent-ink": "#282a36",
      "--color-syntax-violet": "#bd93f9",
      "--color-syntax-pink": "#ff79c6",
      "--color-syntax-orange": "#ffb86c",
      "--color-event-violet": "#bd93f9",
      "--color-loop-green": "#50fa7b",
      "--color-key-lime": "#f1fa8c",
      "--color-tag-magenta": "#ff79c6",
      "--color-mute-red": "#ff5555",
      "--color-warning": "#ffb86c",
      "--color-input-hint-bg": "rgba(80, 250, 123, 0.16)",
      "--color-input-hint-selected-bg": "rgba(189, 147, 249, 0.28)",
      "--color-hover-wash": "rgba(248, 248, 242, 0.08)",
    },
  },

  gruvbox: {
    label: "Gruvbox Dark",
    properties: {
      "--surface-canvas": "#1d2021",
      "--surface-inset": "#282828",
      "--surface-card": "#1d2021",
      "--surface-accent": "#b8bb26",
      "--color-slate-canvas": "#1d2021",
      "--color-ink-well": "#282828",
      "--color-steel-border": "#3c3836",
      "--color-graphite-hairline": "#504945",
      "--color-ash-text": "#bdae93",
      "--color-fog-text": "#a89984",
      "--color-cloud-text": "#d5c4a1",
      "--color-bone-text": "#ebdbb2",
      "--color-signal-lime": "#b8bb26",
      "--color-accent-ink": "#1d2021",
      "--color-syntax-violet": "#d3869b",
      "--color-syntax-pink": "#d3869b",
      "--color-syntax-orange": "#fe8019",
      "--color-event-violet": "#d3869b",
      "--color-loop-green": "#b8bb26",
      "--color-key-lime": "#fabd2f",
      "--color-tag-magenta": "#d3869b",
      "--color-mute-red": "#fb4934",
      "--color-warning": "#fabd2f",
      "--color-input-hint-bg": "rgba(184, 187, 38, 0.16)",
      "--color-input-hint-selected-bg": "rgba(211, 134, 155, 0.28)",
      "--color-hover-wash": "rgba(235, 219, 178, 0.08)",
    },
  },

  "tokyo-night": {
    label: "Tokyo Night",
    properties: {
      "--surface-canvas": "#1a1b26",
      "--surface-inset": "#16161e",
      "--surface-card": "#1a1b26",
      "--surface-accent": "#9ece6a",
      "--color-slate-canvas": "#1a1b26",
      "--color-ink-well": "#16161e",
      "--color-steel-border": "#292e42",
      "--color-graphite-hairline": "#3b4261",
      "--color-ash-text": "#9aa5ce",
      "--color-fog-text": "#565f89",
      "--color-cloud-text": "#a9b1d6",
      "--color-bone-text": "#c0caf5",
      "--color-signal-lime": "#9ece6a",
      "--color-accent-ink": "#1a1b26",
      "--color-syntax-violet": "#bb9af7",
      "--color-syntax-pink": "#f7768e",
      "--color-syntax-orange": "#ff9e64",
      "--color-event-violet": "#bb9af7",
      "--color-loop-green": "#9ece6a",
      "--color-key-lime": "#e0af68",
      "--color-tag-magenta": "#bb9af7",
      "--color-mute-red": "#f7768e",
      "--color-warning": "#e0af68",
      "--color-input-hint-bg": "rgba(158, 206, 106, 0.16)",
      "--color-input-hint-selected-bg": "rgba(187, 154, 247, 0.28)",
      "--color-hover-wash": "rgba(192, 202, 245, 0.08)",
    },
  },

  nord: {
    label: "Nord",
    properties: {
      "--surface-canvas": "#2e3440",
      "--surface-inset": "#272c36",
      "--surface-card": "#2e3440",
      "--surface-accent": "#a3be8c",
      "--color-slate-canvas": "#2e3440",
      "--color-ink-well": "#272c36",
      "--color-steel-border": "#434c5e",
      "--color-graphite-hairline": "#4c566a",
      "--color-ash-text": "#a9b4c8",
      "--color-fog-text": "#7f8b9e",
      "--color-cloud-text": "#d8dee9",
      "--color-bone-text": "#eceff4",
      "--color-signal-lime": "#a3be8c",
      "--color-accent-ink": "#2e3440",
      "--color-syntax-violet": "#b48ead",
      "--color-syntax-pink": "#b48ead",
      "--color-syntax-orange": "#d08770",
      "--color-event-violet": "#81a1c1",
      "--color-loop-green": "#a3be8c",
      "--color-key-lime": "#ebcb8b",
      "--color-tag-magenta": "#b48ead",
      "--color-mute-red": "#bf616a",
      "--color-warning": "#ebcb8b",
      "--color-input-hint-bg": "rgba(163, 190, 140, 0.16)",
      "--color-input-hint-selected-bg": "rgba(180, 142, 173, 0.28)",
      "--color-hover-wash": "rgba(216, 222, 233, 0.08)",
    },
  },
};

// The theme currently applied, so repeat calls are cheap no-ops.
let appliedThemeName = null;

// Returns the theme for `name`, falling back to the default when the name is unknown or missing.
// Unknown names matter: an old settings backup may carry a theme this build no longer ships.
function resolveTheme(name) {
  const theme = themes[name];
  return theme ? { name, ...theme } : { name: DEFAULT_THEME_NAME, ...themes[DEFAULT_THEME_NAME] };
}

function readCachedTheme() {
  try {
    if (!isExtensionPage()) return null;
    const cached = globalThis.localStorage?.getItem(THEME_CACHE_KEY) ?? null;
    if (cached != null) return cached;
    // One-time upgrade from the pre-rename cache key.
    const legacy = globalThis.localStorage?.getItem(LEGACY_THEME_CACHE_KEY) ?? null;
    if (legacy != null) {
      globalThis.localStorage?.setItem(THEME_CACHE_KEY, legacy);
      globalThis.localStorage?.removeItem(LEGACY_THEME_CACHE_KEY);
    }
    return legacy;
  } catch (_error) {
    // localStorage can be unavailable (e.g. under a test harness). Not fatal: settings still win.
    return null;
  }
}

function writeCachedTheme(name) {
  try {
    if (!isExtensionPage()) return;
    globalThis.localStorage?.setItem(THEME_CACHE_KEY, name);
  } catch (_error) {
    // Ignore: the cache is an optimization, never a source of truth.
  }
}

// Applies `name` to the current document. With `cache` set (the default), also remembers the choice
// in localStorage so the next page load can paint the right colors before storage answers.
function applyTheme(name, { cache = true } = {}) {
  const theme = resolveTheme(name);
  try {
    const root = document.documentElement;
    if (!root) return;
    if (appliedThemeName == theme.name && root.dataset.everythingvimTheme == theme.name) return;
    for (const [property, value] of Object.entries(theme.properties)) {
      root.style.setProperty(property, value);
    }
    root.dataset.everythingvimTheme = theme.name;
    appliedThemeName = theme.name;
    if (cache) writeCachedTheme(theme.name);
  } catch (_error) {
    // A missing documentElement is not worth throwing over; the stylesheet defaults still apply.
  }
}

// Repaints from the settings, and keeps repainting if the user changes the theme elsewhere (the
// options page, or another device syncing settings down).
function watchTheme() {
  // The flag lives on the shared API object, because this file can be evaluated more than once in
  // a document (once as a plain <script>, then again via `import`).
  const api = globalThis.EverythingVimTheme;
  if (api.watching) return;
  api.watching = true;

  const refresh = () => {
    try {
      if (Settings.isLoaded()) applyTheme(Settings.get(THEME_SETTING_NAME));
    } catch (_error) {
      // Ignore: a torn-down context (extension reloaded) or pre-load access. Nothing to apply.
    }
  };

  Settings.addEventListener("change", refresh);

  Settings.onLoaded().then(refresh).catch(() => {
    // The content script may outlive the extension (it was reloaded or updated). Leave the theme
    // showing whatever it already had rather than surfacing an unhandled rejection.
  });
}

const EverythingVimTheme = {
  settingName: THEME_SETTING_NAME,
  defaultThemeName: DEFAULT_THEME_NAME,
  themes,
  watching: false,
  isExtensionPage,
  resolve: resolveTheme,
  apply: applyTheme,
  readCachedTheme,
  watch: watchTheme,
};

// Boot the theme on the first evaluation of this file in a document; a later evaluation (the
// `import` path in extension pages) must not redo any of this.
if (globalThis.EverythingVimTheme == null) {
  globalThis.EverythingVimTheme = EverythingVimTheme;

  // Paint immediately, before first layout. In an extension page this comes from the localStorage
  // cache, which is synchronous, so even the very first frame is themed.
  if (isExtensionPage()) {
    const cached = readCachedTheme();
    if (cached != null) applyTheme(cached, { cache: false });
  }
}

// Start following settings as soon as they exist.
// - A content script loads this file immediately after lib/settings.js, so this fires on load.
// - An extension page loads this file from a <script> in the <head>, where Settings does not exist
//   yet, and then again via `import "../lib/theme.js"` from its own module once the settings
//   modules are in place, which is when this fires. Starting the watch twice is a no-op.
if (typeof Settings != "undefined" && Settings != null) {
  watchTheme();
}
