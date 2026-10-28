"""Sample the Subspace Reloaded online player count and keep a small history.
pop/recent.json : {"u": last sample unix, "s": [[unix, players], ...]}  last 8 days, ~5-minute samples
pop/hourly.json : {"h": [[hourStartUnix, avg, max, min, samples], ...]}   every hour since collection began
"""
import json, os, sys, time, urllib.request
URL = "https://auth.subspacereloaded.com/playercount"
N = int(os.environ.get("SAMPLES", "11"))      # samples in this run
GAP = int(os.environ.get("GAP", "300"))        # seconds between samples
def get():
    try:
        req = urllib.request.Request(URL, headers={"User-Agent": "premier-playbook-pop/1.0"})
        with urllib.request.urlopen(req, timeout=20) as r:
            v = json.loads(r.read().decode()).get("playercount")
            return int(v) if v is not None else None
    except Exception as e:
        print("sample failed:", e, file=sys.stderr); return None
def load(p, d):
    try:
        with open(p) as f: return json.load(f)
    except Exception: return d
new = []
for i in range(N):
    v = get(); t = int(time.time())
    if v is not None: new.append([t, v]); print(time.strftime("%H:%M:%S"), v)
    if i < N - 1: time.sleep(GAP)
if not new: sys.exit(0)
R = load("pop/recent.json", {"s": []}); H = load("pop/hourly.json", {"h": []})
s = R.get("s", []) + new; cut = int(time.time()) - 8 * 86400
s = sorted({x[0]: x for x in s if x[0] >= cut}.values())
R = {"u": s[-1][0], "s": s}
# rebuild hourly rows for every hour touched by recent samples; keep older rows as they are
by = {}
for t, v in s: by.setdefault(t - t % 3600, []).append(v)
h = {x[0]: x for x in H.get("h", [])}
for k, L in by.items(): h[k] = [k, round(sum(L) / len(L), 1), max(L), min(L), len(L)]
H = {"h": sorted(h.values())}
os.makedirs("pop", exist_ok=True)
json.dump(R, open("pop/recent.json", "w"), separators=(",", ":"))
json.dump(H, open("pop/hourly.json", "w"), separators=(",", ":"))
print("stored", len(new), "samples; recent", len(s), "hourly", len(H["h"]))
