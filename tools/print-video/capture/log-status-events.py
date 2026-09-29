#!/usr/bin/env python3
"""Timestamp every status push from cthulhu's /api/ws, to the millisecond.

    curl -sN ws://127.0.0.1:9120/api/ws | log-status-events.py PREFIX-status-events.jsonl

The printer phases (Lifting ~2.2 s, Dropping ~2.1 s, Exposing ~3.1 s) are
far too short for a 1 Hz poll, which smears each boundary by up to a second;
render.py uses these exact changes when present. Reads curl's websocket
output on stdin (messages run together, so they're
split with raw_decode) and writes one JSON line per change of status label or
layer: {"t": epoch, "label", "layer"}.
"""
import json, sys, time

out = open(sys.argv[1], "a", buffering=1)
dec = json.JSONDecoder()
buf, last = "", None
stdin = sys.stdin.buffer
while True:
    chunk = stdin.read1(65536)
    if not chunk:
        break
    t = time.time()
    buf += chunk.decode()
    while True:
        buf = buf.lstrip()
        if not buf:
            break
        try:
            obj, end = dec.raw_decode(buf)
        except ValueError:
            break  # incomplete; wait for more
        buf = buf[end:]
        p = obj.get("print") or {}
        key = (p.get("statusLabel"), p.get("currentLayer"))
        if key != last:
            out.write(json.dumps({"t": round(t, 3), "label": key[0], "layer": key[1]}) + "\n")
            last = key
        if key[0] in ("Idle", "Complete", "Stopped", "Cancelled"):
            sys.exit(0)  # the print is over; closing stdin ends curl too
