# AllinVim — Privacy Policy (source)

> Canonical public URL for the Chrome Web Store listing: the deployed site page
> `website/privacy.html` (e.g. `https://<your-vercel-domain>/privacy`), or — guaranteed
> to exist after push — `https://github.com/B-Eddie/allinvim/blob/main/website/privacy.html`.
> Keep this file and `website/privacy.html` in sync.

Effective: September 16, 2026 · Applies to the AllinVim browser extension.

AllinVim works fully offline. We operate no servers, include no analytics or tracking
SDKs, and collect nothing about you.

## Data stored on your device

- **Settings, key mappings, exclusion rules, and marks** are kept in `chrome.storage`.
  Settings and marks use synced storage, so Chrome carries them across your own signed-in
  devices via your Google account — we never see them.
- **Session data** (recently viewed tabs, in-memory UI state) lives only in
  `chrome.storage.session` and disappears when the browser session ends.
- **Backups you export** are JSON files you save yourself, wherever you choose.

## Data read locally, never transmitted

- **History, bookmarks, and open tabs** are read on-device to power Vomnibar suggestions,
  tab commands, and recently-closed-tab restore. Matching happens locally; this data is
  never sent anywhere.
- **Page content** is processed in memory by content scripts to provide navigation and Vim
  editing. Text you edit stays in the page. Nothing is exfiltrated.
- **Clipboard** is written only when you explicitly invoke a copy command (e.g. copy
  current URL); the extension never reads your clipboard.
- **Notifications** are used solely for the one-time “extension upgraded” notice, which you
  can disable in Options.

## Network connections

- The extension makes **no connections to developer-operated servers** — there are none.
- If you use Vomnibar search completion, your keystrokes are sent to the **search engine
  you configured** to fetch suggestions — exactly as typing in that engine's own site
  would. This only happens for engines you set up, and only while you use completion.
- All other requests target the extension's own internal (`chrome-extension://`)
  resources, such as its stylesheet and key-motion configuration.

## Sharing and sale

We do not sell, rent, share, or otherwise disclose any data — there is no data pipeline
to disclose from. The extension requests broad host access (`<all_urls>`) solely so
keyboard navigation and editing work on every site you visit.

## Children's privacy

AllinVim collects no personal information from anyone, including children under 13.

## Changes

If this policy changes, the updated version will be posted here with a new effective
date. Material changes will also be noted in the extension's release notes.

## Contact

Questions? Open an issue at https://github.com/B-Eddie/allinvim/issues.
