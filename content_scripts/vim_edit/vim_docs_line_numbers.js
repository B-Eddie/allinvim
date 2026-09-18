(function() {
    'use strict';
    
    // Configuration for line markers
    const config = {
        zIndex: 1000,
        fontSize: '15px',
        // Resolves to the palette used by the rest of Everything Vim's UI. See lib/theme.js.
        lineColor: 'var(--color-fog-text, #6c6c6c)',
        fontWeight: 'normal',
        minTopPosition: 120,
        markerClass: 'relative-line-marker',
        caretSelector: '.kix-cursor-caret',
        titleSelector: '.docs-title-outer',
        canvasTileSelector: '.kix-canvas-tile-content',
        editorContainerSelector: '#kix-appview > div.kix-appview-editor-container > div',
        linesToDisplay: 50,
        defaultZoom: 1
    };
    
    // State variables
    let lastCaretRect = null;
    let enabled = false; // current active state (markers shown)
    let globalEnabled = true; // respects Vim enabled toggle
    let lineNumbersPref = true; // respects Line Numbers toggle
    let initialized = false;
    let eventListenersAdded = false;
    let observers = [];
    // Perf: coalesce rapid updates (keydown/scroll/mutations) into one rAF,
    // skip work when caret hasn't moved, and track created markers so clear
    // doesn't need a document-wide querySelectorAll each time.
    let pendingRaf = 0;
    let pendingTimer = 0;
    let lastRun = 0;
    let lastCaretTop = -1;
    let lastCaretLeft = -1;
    let activeMarkers = [];
    const UPDATE_MIN_INTERVAL = 80;
    
    // Pool for reusing marker elements
    const markersPool = [];
    
    // Detect browser environment
    const isBrowser = typeof browser !== 'undefined';
    const api = isBrowser ? browser : chrome;
    
    // Create styles for the markers
    function createStyles() {
        // Only create styles once
        if (document.getElementById('relative-line-numbers-style')) return;
        
        const styleEl = document.createElement('style');
        styleEl.id = 'relative-line-numbers-style';
        styleEl.textContent = `
            .${config.markerClass} {
                position: absolute;
                color: ${config.lineColor};
                font-family: monospace;
                font-weight: ${config.fontWeight};
                z-index: ${config.zIndex};
                font-size: ${config.fontSize};
                pointer-events: none;
                text-align: right;
                width: 30px;
                opacity: 0.8;
                user-select: none;
                will-change: transform;
                transition: top 50ms linear;
            }
        `;
        document.head.appendChild(styleEl);
    }
    
    // Remove all existing markers (tracked list first, DOM query as fallback)
    function clearMarkers() {
        if (activeMarkers.length) {
            for (let i = 0; i < activeMarkers.length; i++) {
                const marker = activeMarkers[i];
                try { marker.remove(); } catch (_) {}
                if (markersPool.length < 100) {
                    markersPool.push(marker);
                }
            }
            activeMarkers = [];
            return;
        }
        const markers = document.querySelectorAll(`.${config.markerClass}`);
        markers.forEach(marker => {
            marker.remove();
            if (markersPool.length < 100) {
                markersPool.push(marker);
            }
        });
    }
    
    // Get current zoom level
    function getZoomLevel() {
        const titleElement = document.querySelector(config.titleSelector);
        return titleElement && titleElement.style.zoom 
               ? parseFloat(titleElement.style.zoom) 
               : config.defaultZoom;
    }
    
    // Create a single marker element
    function createMarker(left, top, text) {
        if (top < config.minTopPosition) return null;
        
        let marker = markersPool.pop();
        if (!marker) {
            marker = document.createElement('div');
            marker.className = config.markerClass;
        } else {
            marker.className = config.markerClass;
        }
        
        marker.textContent = text;
        marker.style.left = `${left}px`;
        marker.style.top = `${top}px`;
        return marker;
    }
    
    // Add markers to the document
    function addMarkers(markers) {
        if (!enabled) return; // Extra check before adding markers

        const fragment = document.createDocumentFragment();
        for (let i = 0; i < markers.length; i++) {
            const marker = markers[i];
            if (marker) { fragment.appendChild(marker); activeMarkers.push(marker); }
        }
        document.body.appendChild(fragment);
    }

    // Coalesced scheduler: rapid key/scroll/mutation events become one update.
    function scheduleLineUpdate() {
        if (!enabled) { clearMarkers(); return; }
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (now - lastRun < UPDATE_MIN_INTERVAL) {
            if (pendingTimer) return;
            const wait = UPDATE_MIN_INTERVAL - (now - lastRun);
            pendingTimer = setTimeout(function () {
                pendingTimer = 0;
                lastRun = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                try { updateLineMarkers(); } catch (_) {}
            }, wait);
            return;
        }
        try {
            if (typeof requestAnimationFrame === 'function') {
                if (pendingRaf) return;
                pendingRaf = requestAnimationFrame(function () {
                    pendingRaf = 0;
                    lastRun = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                    try { updateLineMarkers(); } catch (_) {}
                });
            } else {
                lastRun = now;
                updateLineMarkers();
            }
        } catch (_) { updateLineMarkers(); }
    }

    // Update relative line number markers (throttled via scheduleLineUpdate)
    function updateLineMarkers() {
        if (!enabled) { clearMarkers(); return; }
        try {
            const caret = document.querySelector(config.caretSelector);
            if (!caret) return;
            const caretRect = caret.getBoundingClientRect();
            if (caretRect.width === 0 && caretRect.height === 0) return;

            const caretTopDoc = caretRect.top + window.scrollY;
            // Skip rebuild when caret hasn't moved (e.g. repeated mutations).
            if (Math.abs(caretTopDoc - lastCaretTop) < 2 && Math.abs(caretRect.left - lastCaretLeft) < 2 && activeMarkers.length) {
                return;
            }
            lastCaretTop = caretTopDoc;
            lastCaretLeft = caretRect.left;
            lastCaretRect = { ...caretRect };

            // Clear existing markers
            clearMarkers();

            // Determine left position from canvas tiles if possible
            let lineNumberLeft;
            const tiles = Array.from(document.querySelectorAll(config.canvasTileSelector));
            if (tiles.length) {
                const minLeft = tiles.reduce((min, el) => Math.min(min, el.getBoundingClientRect().left + window.scrollX), Infinity);
                lineNumberLeft = isFinite(minLeft) ? minLeft : 0;
            } else {
                lineNumberLeft = 0;
            }

            // Build a list of candidate line tops near the caret
            const lineTops = getLineTopsNear(caretTopDoc);
            const markers = [];

            if (lineTops.length) {
                // Find nearest index to caretTopDoc
                let idx = 0; let best = Infinity;
                for (let i = 0; i < lineTops.length; i++) {
                    const d = Math.abs(lineTops[i] - caretTopDoc);
                    if (d < best) { best = d; idx = i; }
                }
                for (let off = -config.linesToDisplay; off <= config.linesToDisplay; off++) {
                    if (off === 0) continue;
                    const j = idx + off;
                    if (j < 0 || j >= lineTops.length) continue;
                    const y = lineTops[j];
                    const rel = Math.abs(off);
                    markers.push(createMarker(lineNumberLeft, y, String(rel)));
                }
            } else {
                // Fallback: approximate using caret height and skip gaps between tiles
                const zoomLevel = getZoomLevel();
                const lineHeight = caretRect.height * zoomLevel; // best-effort
                const intervals = getTileVerticalIntervals();
                for (let off = -config.linesToDisplay; off <= config.linesToDisplay; off++) {
                    if (off === 0) continue;
                    let y = caretTopDoc + off * lineHeight;
                    if (!isInAnyInterval(y, intervals)) continue; // skip page gaps
                    const rel = Math.abs(off);
                    markers.push(createMarker(lineNumberLeft, y, String(rel)));
                }
            }

            addMarkers(markers);
        } catch (_) {}
    }

    function getLineTopsNear(centerYDoc) {
        // Perf: try cheapest selector first; only fall through if empty.
        // Cap scanned nodes so huge docs don't force hundreds of layouts.
        const selectorPriority = [
            '.kix-lineview-content',
            '.kix-lineview',
            '.kix-paragraphrenderer'
        ];
        const seen = new Set();
        const tops = [];
        const viewMin = window.scrollY - window.innerHeight * 0.5;
        const viewMax = window.scrollY + window.innerHeight * 1.5;
        const MAX_NODES = 400;
        for (let s = 0; s < selectorPriority.length; s++) {
            const els = document.querySelectorAll(selectorPriority[s]);
            if (!els || !els.length) continue;
            const n = Math.min(els.length, MAX_NODES);
            for (let i = 0; i < n; i++) {
                const el = els[i];
                let r;
                try { r = el.getBoundingClientRect(); } catch (_) { continue; }
                if (!r || (r.height === 0 && r.width === 0)) continue;
                const top = Math.round(r.top + window.scrollY);
                if (top < viewMin || top > viewMax) continue;
                const key = String(top);
                if (!seen.has(key)) { seen.add(key); tops.push(top); }
            }
            if (tops.length >= 10) break; // enough to anchor relative numbers
        }
        tops.sort((a,b)=>a-b);
        return tops;
    }

    function getTileVerticalIntervals() {
        const tiles = Array.from(document.querySelectorAll(config.canvasTileSelector));
        return tiles.map(el => {
            const r = el.getBoundingClientRect();
            return [r.top + window.scrollY, r.bottom + window.scrollY];
        }).sort((a,b)=>a[0]-b[0]);
    }

    function isInAnyInterval(y, intervals) {
        for (let i=0;i<intervals.length;i++) {
            const [a,b] = intervals[i];
            if (y >= a && y <= b) return true;
        }
        return false;
    }
    
    // Handle scroll events (coalesced)
    function handleScroll() {
        if (!enabled) return;
        scheduleLineUpdate();
    }

    // Set up mutation observer to watch for caret changes
    function observeCaretChanges() {
        const caret = document.querySelector(config.caretSelector);
        if (!caret) {
            if (enabled) {
                setTimeout(observeCaretChanges, 1000);
            }
            return null;
        }

        const observer = new MutationObserver(() => {
            if (enabled) scheduleLineUpdate();
        });
        
        observer.observe(caret, { 
            attributes: true, 
            characterData: true, 
            subtree: true 
        });
        
        return observer;
    }
    
    // Observe editor position changes
    function observeEditorChanges() {
        const docContainer = document.querySelector('.kix-appview-editor');
        if (!docContainer) {
            if (enabled) {
                setTimeout(observeEditorChanges, 1000);
            }
            return null;
        }
        
        const observer = new MutationObserver(() => {
            if (enabled) {
                scheduleLineUpdate();
            }
        });
        
        observer.observe(docContainer, { 
            attributes: true,
            attributeFilter: ['style', 'class'],
            childList: true, 
            subtree: true
        });
        
        return observer;
    }
    
    // Add event listeners for user interaction
    function addEventListeners() {
        if (eventListenersAdded) return;
        
        document.addEventListener("keyup", () => {
            if (enabled) scheduleLineUpdate();
        }, { passive: true });

        document.addEventListener("keydown", () => {
            if (enabled) scheduleLineUpdate();
        }, { passive: true });

        document.addEventListener("mouseup", () => {
            if (enabled) scheduleLineUpdate();
        }, { passive: true });

        // Add scroll listeners
        document.addEventListener("scroll", handleScroll, { passive: true, capture: true });
        window.addEventListener("resize", () => {
            if (enabled) { lastCaretTop = -1; scheduleLineUpdate(); }
        }, { passive: true });
        
        // Add scroll listener to the editor container
        const editorContainer = document.querySelector(config.editorContainerSelector);
        if (editorContainer) {
            editorContainer.addEventListener("scroll", handleScroll, { passive: true });
        }
        
        // Also monitor more DOM elements for scroll events
        const possibleScrollContainers = document.querySelectorAll('.kix-appview-editor, .docs-scrollable');
        possibleScrollContainers.forEach(container => {
            container.addEventListener("scroll", handleScroll, { passive: true });
        });
        
        eventListenersAdded = true;
    }
    
    // Set up observers for document changes
    function setupObservers() {
        if (observers.length === 0) {
            const caretObserver = observeCaretChanges();
            const editorObserver = observeEditorChanges();
            
            if (caretObserver) observers.push(caretObserver);
            if (editorObserver) observers.push(editorObserver);
        }
    }
    
    // Clean up observers if needed
    function cleanupObservers() {
        observers.forEach(observer => observer.disconnect());
        observers = [];
    }
    
    // Toggle line numbers on/off
    function toggleLineNumbers(showLineNumbers) {
        const wasEnabled = enabled;
        enabled = showLineNumbers;
        lastCaretTop = -1;
        lastCaretLeft = -1;

        // If turning off, make sure markers are cleared
        if (!enabled) {
            try { if (pendingRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(pendingRaf); } catch (_) {}
            try { if (pendingTimer) clearTimeout(pendingTimer); } catch (_) {}
            pendingRaf = 0; pendingTimer = 0;
            clearMarkers();
        }

        // If turning on from off
        if (enabled && !wasEnabled) {
            if (!initialized) {
                init();
            } else {
                addEventListeners();
                setupObservers();
                scheduleLineUpdate();
            }
        }

        return enabled;
    }

    function applyEffectiveEnabled() {
        const effective = !!(globalEnabled && lineNumbersPref);
        toggleLineNumbers(effective);
    }
    
    // Initialize the script when needed
    function init() {
        if (initialized) return;
        
        try {
            createStyles();
            addEventListeners();
            
            if (enabled) {
                setupObservers();
                updateLineMarkers(true);
            }
            
            initialized = true;
        } catch (error) {
            // Silent error handling
        }
    }
    
    // Check storage for initial state
    function checkInitialState() {
        try {
            api.storage.sync.get(["enabled", "lineNumbersEnabled"], (data) => {
                try { globalEnabled = (typeof data.enabled !== 'undefined') ? !!data.enabled : true; } catch (_) { globalEnabled = true; }
                try { lineNumbersPref = (typeof data.lineNumbersEnabled !== 'undefined') ? !!data.lineNumbersEnabled : true; } catch (_) { lineNumbersPref = true; }

                if (globalEnabled && lineNumbersPref) {
                    enabled = true;
                    init();
                }

                // Listen for runtime messages (optional path).
                //
                // This listener never calls sendResponse, so it must return false
                // for every message. Returning true means "I will respond
                // asynchronously", which keeps the sender's channel open forever:
                // chrome.tabs.sendMessage() then never settles for ANY handler this
                // script does not answer. Because this content script is injected on
                // every URL (<all_urls>), doing so hung the toolbar popup's
                // isVimiumInstalledInTab() probe, so ActionPage.init() never finished
                // and none of the popup's elements were clickable.
                try {
                    api.runtime.onMessage.addListener((message) => {
                        if (message && message.action === "updateSettings" && message.settings) {
                            if (Object.prototype.hasOwnProperty.call(message.settings, 'enabled')) {
                                globalEnabled = !!message.settings.enabled;
                            }
                            if (Object.prototype.hasOwnProperty.call(message.settings, 'lineNumbersEnabled')) {
                                lineNumbersPref = !!message.settings.lineNumbersEnabled;
                            }
                            applyEffectiveEnabled();
                        }
                        return false; // Not handled: never claim the message.
                    });
                } catch (e) {
                    // ignore
                }

                // Listen to storage changes for instant apply (no tabs permission needed)
                try {
                    api.storage.onChanged.addListener((changes, area) => {
                        if (area !== 'sync') return;
                        if (changes.enabled) globalEnabled = !!changes.enabled.newValue;
                        if (changes.lineNumbersEnabled) lineNumbersPref = !!changes.lineNumbersEnabled.newValue;
                        applyEffectiveEnabled();
                    });
                } catch (e) {
                    // ignore
                }
            });
        } catch (e) {
            // If Browser API is not available, start in enabled mode
            // silent fallback
            enabled = true;
            init();
        }
    }
    
    // Expose API to window (update is throttled; updateNow forces sync)
    window.relativeLineNumbers = {
        update: scheduleLineUpdate,
        updateNow: updateLineMarkers,
        toggle: toggleLineNumbers,
        clear: clearMarkers
    };
    
    // Start the initialization process
    checkInitialState();
})();