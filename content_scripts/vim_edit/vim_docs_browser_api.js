/**
 * Browser API Manager
 * 
 * This module provides a unified interface for browser APIs across 
 * different browsers (Chrome and Firefox).
 */

// Detect browser environment
const browserAPI = (() => {
  // Firefox uses the 'browser' namespace, Chrome uses 'chrome'
  const api = typeof browser !== 'undefined' ? browser : chrome;
  
  // Check if we're in a Firefox environment (Promise-based API)
  const isFirefox = typeof browser !== 'undefined';

  // Permissions declared in manifest.json that the extension requires.
  // Keep in sync with manifest.json "permissions".
  const REQUIRED_PERMISSIONS = ['storage'];

  /**
   * Check whether all required permissions are granted.
   * Falls back to feature-detection in contexts (e.g. content scripts)
   * where the permissions API is unavailable.
   * @returns {Promise<boolean>} true if all required permissions are granted
   */
  const hasAllRequiredPermissions = async () => {
    try {
      if (api.permissions && typeof api.permissions.getAll === 'function') {
        const all = isFirefox
          ? await api.permissions.getAll()
          : await new Promise((resolve, reject) => {
              api.permissions.getAll((result) => {
                if (chrome.runtime.lastError) {
                  reject(chrome.runtime.lastError);
                } else {
                  resolve(result);
                }
              });
            });
        const granted = (all && all.permissions) || [];
        return REQUIRED_PERMISSIONS.every((p) => granted.includes(p));
      }
      // Fallback: infer from availability of the corresponding APIs.
      return REQUIRED_PERMISSIONS.every((perm) => {
        if (perm === 'storage') return !!(api.storage && (api.storage.sync || api.storage.local));
        return true;
      });
    } catch (_) {
      return false;
    }
  };

  // Silent check — does not log. Vim never spams the console.
  const logIfAllPermissionsGranted = async () => {
    return await hasAllRequiredPermissions();
  };

  /**
   * Heuristic check for Google Docs Braille support (Tools → Accessibility
   * → Screen reader support + Braille support).
   *
   * Docs exposes no public API for this setting. The primary signal is the
   * accessibility mirror inside `.docs-texteventtarget-iframe` (the same DOM
   * Vim-For-Docs drives): paginated page nodes, a populated textbox, or a
   * working `Selection.modify` probe. Canvas svg annotations and the legacy
   * paragraph renderer are kept as secondary signals — they only appear for
   * whitelisted extensions / legacy rendering, so their absence alone must
   * NOT be treated as braille-off (that caused false `no-annotated-dom`
   * warnings for users with braille correctly enabled).
   *
   * Pure DOM read with save/restore selection probe — safe to call anywhere.
   * NOTE: Docs builds the mirror lazily, so this can false-negative if called
   * before the surface loads (`mirror-not-ready`). Callers should re-check.
   *
   * @param {Document} [rootDoc] - Document to inspect. Defaults to global document.
   * @returns {{supported: boolean, reason: string, details: Object}}
   */
  const checkDocsBrailleSupport = (rootDoc) => {
    const details = {
      hasTextEventIframe: false,
      iframeAccessible: false,
      hasIframeTextbox: false,
      hasIframePages: false,
      iframeTextLength: 0,
      selectionProbeOk: false,
      hasMainEditor: false,
      hasAnnotatedCanvas: false,
      hasAriaLabelRects: false,
      hasParagraphRenderer: false
    };
    try {
      const doc = rootDoc || (typeof document !== 'undefined' ? document : null);
      if (!doc || typeof doc.querySelector !== 'function') {
        return { supported: false, reason: 'no-document', details };
      }
      try {
        details.hasMainEditor = !!doc.querySelector('.kix-appview-editor, .kix-appview');
      } catch (_) {}
      const iframe = doc.querySelector('.docs-texteventtarget-iframe');
      details.hasTextEventIframe = !!iframe;
      try {
        details.hasAnnotatedCanvas = !!doc.querySelector(
          '.kix-canvas-tile-content svg g, .kix-canvas-tile-selection svg'
        );
        details.hasAriaLabelRects = !!doc.querySelector(
          '.kix-canvas-tile-content svg rect[aria-label], ' +
          '.kix-canvas-tile-content svg g[aria-label], ' +
          'svg g[role="paragraph"]'
        );
        details.hasParagraphRenderer = !!doc.querySelector('.kix-paragraphrenderer');
      } catch (_) {}
      try {
        const idoc = iframe && iframe.contentDocument;
        const win = iframe && iframe.contentWindow;
        if (idoc) {
          details.iframeAccessible = true;
          let root = null;
          try {
            root = idoc.querySelector('.kix-page-paginated, .kix-paginateddocumentplugin, .kix-page') ||
              idoc.querySelector('[role="textbox"]') ||
              idoc.querySelector('[contenteditable="true"]');
          } catch (_) { root = null; }
          details.hasIframeTextbox = !!root;
          try {
            details.hasIframePages = !!idoc.querySelector(
              '.kix-page-paginated, .kix-paginateddocumentplugin, .kix-page'
            );
          } catch (_) {}
          try {
            const t = (root && root.textContent && root.textContent.length) ||
              (idoc.body && idoc.body.textContent && idoc.body.textContent.length) || 0;
            details.iframeTextLength = t;
          } catch (_) {}
          try {
            const sel = win && typeof win.getSelection === 'function' ? win.getSelection() : null;
            if (sel && sel.rangeCount > 0 && typeof sel.modify === 'function') {
              const range = sel.getRangeAt(0).cloneRange();
              const before = sel.toString();
              try { sel.modify('extend', 'forward', 'character'); } catch (_) {}
              const afterF = sel.toString();
              try { sel.removeAllRanges(); sel.addRange(range); } catch (_) {}
              try { sel.modify('extend', 'backward', 'character'); } catch (_) {}
              const afterB = sel.toString();
              try { sel.removeAllRanges(); sel.addRange(range); } catch (_) {}
              details.selectionProbeOk = (afterF !== before) || (afterB !== before);
            }
          } catch (_) {}
        }
      } catch (_) {}
      if (details.selectionProbeOk) {
        return { supported: true, reason: 'selection-probe-ok', details };
      }
      if (details.hasIframePages) {
        return { supported: true, reason: 'mirror-pages-found', details };
      }
      if (details.hasAnnotatedCanvas || details.hasAriaLabelRects || details.hasParagraphRenderer) {
        return { supported: true, reason: 'annotated-dom-found', details };
      }
      if (details.hasIframeTextbox && details.iframeTextLength >= 20) {
        return { supported: true, reason: 'mirror-text-found', details };
      }
      if (details.hasTextEventIframe && details.iframeAccessible && !details.hasIframeTextbox) {
        return { supported: false, reason: 'mirror-not-ready', details };
      }
      return { supported: false, reason: 'no-mirror-content', details };
    } catch (_) {
      return { supported: false, reason: 'check-failed', details };
    }
  };

  /**
   * Wraps Chrome's callback-based API to return a Promise
   * @param {Object} obj - The Chrome API object (e.g., chrome.storage.sync)
   * @param {string} method - The method name to wrap (e.g., 'get')
   * @param {...any} args - Arguments to pass to the method
   * @returns {Promise} A promise that resolves with the result
   */
  const chromeAPIAsPromise = (obj, method, ...args) => {
    return new Promise((resolve, reject) => {
      obj[method](...args, (result) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(result);
        }
      });
    });
  };

  const storageSync = {
    /**
     * Get data from sync storage
     * @param {string|Array|Object} keys - Keys to get from storage
     * @returns {Promise} Promise resolving with storage data
     */
    get: (keys) => {
      if (isFirefox) {
        return api.storage.sync.get(keys);
      } else {
        return chromeAPIAsPromise(api.storage.sync, 'get', keys);
      }
    },

    /**
     * Save data to sync storage
     * @param {Object} data - Data to store
     * @returns {Promise} Promise resolving when data is stored
     */
    set: (data) => {
      if (isFirefox) {
        return api.storage.sync.set(data);
      } else {
        return chromeAPIAsPromise(api.storage.sync, 'set', data);
      }
    },
    remove: (keys) => {
      if (isFirefox) {
        return api.storage.sync.remove(keys);
      } else {
        return chromeAPIAsPromise(api.storage.sync, 'remove', keys);
      }
    }
  };

  const storageLocal = {
    /**
     * Get data from local storage
     * @param {string|Array|Object} keys - Keys to get from storage
     * @returns {Promise} Promise resolving with storage data
     */
    get: (keys) => {
      if (isFirefox) {
        return api.storage.local.get(keys);
      } else {
        return chromeAPIAsPromise(api.storage.local, 'get', keys);
      }
    },

    /**
     * Save data to local storage
     * @param {Object} data - Data to store
     * @returns {Promise} Promise resolving when data is stored
     */
    set: (data) => {
      if (isFirefox) {
        return api.storage.local.set(data);
      } else {
        return chromeAPIAsPromise(api.storage.local, 'set', data);
      }
    },
    remove: (keys) => {
      if (isFirefox) {
        return api.storage.local.remove(keys);
      } else {
        return chromeAPIAsPromise(api.storage.local, 'remove', keys);
      }
    }
  };

  return {
    // Required permissions helpers
    requiredPermissions: REQUIRED_PERMISSIONS.slice(),
    hasAllRequiredPermissions,
    logIfAllPermissionsGranted,
    checkDocsBrailleSupport,

    // Storage API (sync)
    storage: storageSync,

    // Local storage API (non-sync, larger quota)
    storageLocal: storageLocal,

    // Runtime API
    runtime: {
      /**
       * Get URL for resource within extension
       * @param {string} path - Path to resource
       * @returns {string} Full URL to the resource
       */
      getURL: (path) => {
        return api.runtime.getURL(path);
      },

      /**
       * Add a message listener
       * @param {Function} callback - Listener function
       */
      onMessage: {
        addListener: (callback) => {
          api.runtime.onMessage.addListener(callback);
        },
        removeListener: (callback) => {
          api.runtime.onMessage.removeListener(callback);
        }
      },

      /**
       * Send a message
       * @param {Object} message - Message to send
       * @returns {Promise} Promise resolving with the response
       */
      sendMessage: (message) => {
        if (isFirefox) {
          return api.runtime.sendMessage(message);
        } else {
          return chromeAPIAsPromise(api.runtime, 'sendMessage', message);
        }
      }
    },

    // Tabs API
    tabs: {
      /**
       * Query for tabs
       * @param {Object} queryInfo - Query parameters
       * @returns {Promise} Promise resolving with matching tabs
       */
      query: (queryInfo) => {
        if (isFirefox) {
          return api.tabs.query(queryInfo);
        } else {
          return chromeAPIAsPromise(api.tabs, 'query', queryInfo);
        }
      },

      /**
       * Send a message to a specific tab
       * @param {number} tabId - ID of tab to send message to
       * @param {Object} message - Message to send
       * @returns {Promise} Promise resolving with the response
       */
      sendMessage: (tabId, message) => {
        if (isFirefox) {
          return api.tabs.sendMessage(tabId, message);
        } else {
          return chromeAPIAsPromise(api.tabs, 'sendMessage', tabId, message);
        }
      },
      create: (createProperties) => {
        if (isFirefox) {
          return api.tabs.create(createProperties);
        } else {
          return chromeAPIAsPromise(api.tabs, 'create', createProperties);
        }
      }
    }
  };
})();

// Expose the API globally so content scripts can use it
window.browserAPI = browserAPI; 