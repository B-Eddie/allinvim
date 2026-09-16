const simulateKeyEvent = function (eventType, el, keyCode, control, alt, shift, meta) {
    if (!el) return;

    if (typeof InstallTrigger !== 'undefined') {
        try {
            let event;
            if (control && (keyCode === 37 || keyCode === 39)) {
                event = new KeyboardEvent(eventType, {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    keyCode: keyCode,
                    which: keyCode,
                    key: getKeyFromCode(keyCode),
                    code: getKeyCodeMap()[keyCode] || '',
                    location: 0,
                    ctrlKey: control,
                    altKey: alt,
                    shiftKey: shift,
                    metaKey: meta,
                    repeat: false
                });
                try {
                    Object.defineProperties(event, {
                        keyCode: { value: keyCode },
                        which: { value: keyCode },
                        ctrlKey: { value: control },
                        altKey: { value: alt },
                        shiftKey: { value: shift },
                        metaKey: { value: meta }
                    });
                } catch (_) {}
            } else {
                const options = {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    detail: 0,
                    ctrlKey: control,
                    altKey: alt,
                    shiftKey: shift,
                    metaKey: meta
                };
                event = new KeyboardEvent(eventType, options);
                try {
                    Object.defineProperties(event, {
                        keyCode: { value: keyCode },
                        which: { value: keyCode },
                        code: { value: getKeyCodeMap()[keyCode] || '' },
                        key: { value: getKeyFromCode(keyCode) || '' }
                    });
                } catch (_) {}
            }
            el.dispatchEvent(event);
            return;
        } catch (_) {
            try {
                const event = document.createEvent("KeyboardEvent");
                try {
                    if (typeof event.initKeyEvent !== 'undefined') {
                        event.initKeyEvent(eventType, true, true, window, control, alt, shift, meta, keyCode, 0);
                    } else {
                        event.initKeyboardEvent(eventType, true, true, window, getKeyFromCode(keyCode), 0, control, alt, shift, meta);
                        Object.defineProperties(event, { keyCode: { value: keyCode }, which: { value: keyCode } });
                    }
                } catch (_) {
                    event.initEvent(eventType, true, true);
                    Object.defineProperties(event, {
                        keyCode: { value: keyCode },
                        which: { value: keyCode },
                        key: { value: getKeyFromCode(keyCode) },
                        code: { value: getKeyCodeMap()[keyCode] || '' },
                        ctrlKey: { value: control },
                        altKey: { value: alt },
                        shiftKey: { value: shift },
                        metaKey: { value: meta }
                    });
                }
                el.dispatchEvent(event);
                return;
            } catch (_) {}
        }
    }

    try {
        const eventInit = {
            bubbles: true,
            cancelable: true,
            view: window,
            ctrlKey: control,
            altKey: alt,
            shiftKey: shift,
            metaKey: meta,
            keyCode: keyCode,
            which: keyCode
        };
        try {
            eventInit.key = getKeyFromCode(keyCode);
            eventInit.code = getKeyCodeMap()[keyCode] || '';
        } catch (_) {}
        const event = new KeyboardEvent(eventType, eventInit);
        const keyCodeVal = keyCode;
        try {
            Object.defineProperties(event, {
                keyCode: { get: function() { return keyCodeVal; } },
                which: { get: function() { return keyCodeVal; } }
            });
        } catch (_) {}
        el.dispatchEvent(event);
        return;
    } catch (_) {}

    try {
        const event = document.createEvent("KeyboardEvent");
        event.initEvent(eventType, true, true);
        event.keyCode = keyCode;
        event.which = keyCode;
        event.ctrlKey = control;
        event.altKey = alt;
        event.shiftKey = shift;
        event.metaKey = meta;
        el.dispatchEvent(event);
    } catch (_) {}
};

const getKeyFromCode = function(keyCode) {
    const specialKeys = {
        8: 'Backspace', 9: 'Tab', 13: 'Enter', 27: 'Escape',
        33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home',
        37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 46: 'Delete'
    };
    if (specialKeys[keyCode]) return specialKeys[keyCode];
    if (keyCode >= 32 && keyCode <= 126) return String.fromCharCode(keyCode);
    return '';
};

const getKeyCodeMap = function() {
    return {
        8: 'Backspace', 9: 'Tab', 13: 'Enter', 27: 'Escape',
        33: 'PageUp', 34: 'PageDown', 35: 'End', 36: 'Home',
        37: 'ArrowLeft', 38: 'ArrowUp', 39: 'ArrowRight', 40: 'ArrowDown', 46: 'Delete'
    };
};

const findEditorElement = function() {
    try {
        const iframe = document.querySelector(".docs-texteventtarget-iframe");
        if (iframe && iframe.contentDocument) return iframe.contentDocument.activeElement || iframe.contentDocument.body;
    } catch (_) {}
    try {
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
            try {
                if (iframe.contentDocument) {
                    const active = iframe.contentDocument.activeElement;
                    if (active && active.getAttribute('contenteditable') === 'true') return active;
                    const editables = iframe.contentDocument.querySelectorAll('[contenteditable="true"]');
                    if (editables.length > 0) return editables[0];
                    const possibleEditors = iframe.contentDocument.querySelectorAll('.kix-appview-editor, .docs-editor');
                    if (possibleEditors.length > 0) return possibleEditors[0];
                }
            } catch (_) {}
        }
    } catch (_) {}
    const editables = document.querySelectorAll('[contenteditable="true"]');
    if (editables.length > 0) return editables[0];
    return null;
};

let editorEl = findEditorElement();

window.addEventListener("message", function(event) {
    if (event.source !== window) return;
    if (!event.data || !event.data.action || !event.data.action.startsWith('vim-key-')) return;
    if (!editorEl) editorEl = findEditorElement();
    try {
        const data = event.data;
        const keyCode = data.keyCode || 0;
        const ctrl = !!data.ctrl;
        const alt = !!data.alt;
        const shift = !!data.shift;
        const meta = !!data.meta;
        if (data.action === 'vim-key-down') simulateKeyEvent("keydown", editorEl, keyCode, ctrl, alt, shift, meta);
        else if (data.action === 'vim-key-up') simulateKeyEvent("keyup", editorEl, keyCode, ctrl, alt, shift, meta);
        else if (data.action === 'vim-key-press') simulateKeyEvent("keypress", editorEl, keyCode, ctrl, alt, shift, meta);
    } catch (_) {}
});
