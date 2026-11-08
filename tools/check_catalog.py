"""Quality report for app/data: flags teachers whose page layout confused the parser.

Usage: python tools/check_catalog.py [teacher_id ...]   (ids: show sample groups/titles)
"""
import json
import re
import sys
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "app" / "data"
MY = re.compile(r"[က-႟]")
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_catalog import DATE_ONLY  # noqa: E402  (same rule as the builder)

idx = json.loads((DATA / "index.json").read_text(encoding="utf-8"))
show = set(sys.argv[1:])
rows = []
for t in idx["teachers"]:
    groups = json.loads((DATA / "t" / f"{t['id']}.json").read_text(encoding="utf-8"))["groups"]
    items = [it for g in groups for it in g]
    n = len(items)
    no_my = sum(not MY.search(it["t"]) for it in items)            # title without Myanmar text
    date_only = sum(bool(DATE_ONLY.match(it["t"])) for it in items)  # title is just a date
    longt = sum(len(it["t"]) > 120 for it in items)
    single = sum(g.get("c", 0) == 1 for g in t["groups"])
    folder_t = sum(not MY.search(g["t"]) for g in t["groups"])
    dup_t = n - len({it["t"] for it in items})
    flags = []
    if no_my / n > .3: flags.append(f"latin-titles {no_my}")
    if date_only: flags.append(f"date-only {date_only}")
    if longt: flags.append(f"long {longt}")
    if len(t["groups"]) > 3 and single / len(t["groups"]) > .5: flags.append(f"1-item-groups {single}/{len(t['groups'])}")
    if folder_t / len(t["groups"]) > .5 and len(t["groups"]) > 1: flags.append(f"latin-groups {folder_t}")
    if dup_t / n > .3: flags.append(f"dup-titles {dup_t}")
    rows.append((t["id"], n, len(t["groups"]), flags))
    if t["id"] in show:
        print(f"===== {t['id']}  {t['name']}")
        for g, gi in zip(t["groups"], groups):
            print(f"  [G] {g['t'][:80]} | {g.get('d', '')[:50]} ({len(gi)})")
            for it in gi[:3]:
                print(f"       - {it['t'][:70]} | {it.get('n', '')[:40]} | {it['u'][-40:]}")

if not show:
    bad = [r for r in rows if r[3]]
    for tid, n, ng, flags in bad:
        print(f"{tid[:55]:55} {n:5} talks {ng:4} groups  {', '.join(flags)}")
    print(f"\n{len(bad)} of {len(rows)} teachers flagged")
