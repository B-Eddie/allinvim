#!/usr/bin/env python3
"""Regenerate content_scripts/vim_edit/vim_motions_inline.js from
content_scripts/vim_edit/vim_motions.json.

The motions config is inlined as JS so content scripts never fetch() on web
pages: page CSP connect-src blocks chrome-extension:// fetches on strict
sites (e.g. GitHub), which previously left the edit engine dead there.

Usage: python3 build_scripts/gen_motions_inline.py
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "content_scripts" / "vim_edit" / "vim_motions.json"
DST = ROOT / "content_scripts" / "vim_edit" / "vim_motions_inline.js"

cfg = json.loads(SRC.read_text())
js = (
    "// AUTO-GENERATED from vim_motions.json — do not hand-edit. "
    "Regenerate with: python3 build_scripts/gen_motions_inline.py\n"
    "// Inlined so content scripts never fetch() on web pages (page CSP "
    "connect-src blocks chrome-extension:// fetches on strict sites like GitHub).\n"
    "window.__GENERALVIM_MOTIONS = " + json.dumps(cfg, separators=(",", ":")) + ";\n"
    "// Legacy alias (AllInVim-era readers).\n"
    "window.__ALLINVIM_MOTIONS = window.__GENERALVIM_MOTIONS;\n"
)
DST.write_text(js)
print(f"wrote {DST} ({len(js)} bytes)")
