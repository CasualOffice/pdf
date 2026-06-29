#!/usr/bin/env python3
# Extract the shown text of a PDF (UX-S5 redaction check). Decodes literal and
# hex show-strings from content streams (inflating FlateDecode where present).
# Usage: extract-text.py <pdf>
import re, sys, zlib, binascii

data = open(sys.argv[1], "rb").read()
parts = []
for m in re.finditer(rb"stream\r?\n(.*?)\r?\nendstream", data, re.S):
    s = m.group(1)
    try:
        s = zlib.decompress(s)
    except Exception:
        pass
    parts.append(s)
blob = b"\n".join(parts) if parts else data

out = []
for m in re.finditer(rb"<([0-9A-Fa-f]+)>|\(((?:[^()\\]|\\.)*)\)", blob):
    if m.group(1):
        try:
            out.append(binascii.unhexlify(m.group(1)).decode("latin1"))
        except Exception:
            pass
    else:
        out.append(m.group(2).decode("latin1"))
print(" ".join(out))
