#!/usr/bin/env python3
"""Log cthulhu's print status once a second, as JSON lines with a wallclock
timestamp, for burning an overlay into the recording later. Stops once the
print is over (two checks in a row), like record-print.sh."""
import json, sys, time, urllib.request

out = open(sys.argv[1], "a", buffering=1)
over = 0
while True:
    t = time.time()
    try:
        with urllib.request.urlopen("http://127.0.0.1:9120/api/status", timeout=2) as r:
            d = json.load(r)
        p = d.get("print") or {}
        out.write(json.dumps({"t": round(t, 3), "print": p}) + "\n")
        over = over + 1 if p.get("statusLabel") in ("Idle", "Complete", "Stopped", "Cancelled") else 0
        if over >= 60:
            break
    except Exception as e:  # keep going through blips
        out.write(json.dumps({"t": round(t, 3), "error": str(e)}) + "\n")
    time.sleep(max(0, 1 - (time.time() - t)))
