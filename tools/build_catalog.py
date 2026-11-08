"""Build app/catalog.json for တရားနာယူ from dhammadownload.com Sayadaw pages.

dhammadownload.com publicly permits linking directly to its MP3 URLs
("ကြိုတင်ခွင့်ပြုချက်" notice on https://www.dhammadownload.com/index.htm).

Usage:  python tools/build_catalog.py             (fetch live pages)
        python tools/build_catalog.py --cache DIR (reuse/save HTML in DIR)
"""
import argparse
import datetime as dt
import hashlib
import html
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

SITE = "https://dhammadownload.com/"
MP3_BASE = "https://dhammadownload.com/MP3Library/"

# Add a Sayadaw here to include them in the app.
SAYADAWS = [
    {
        "id": "nandamala",
        "name": "ဒေါက်တာနန္ဒမာလာဘိဝံသ",
        "pages": [
            "Dr-Nandamalabhivamsa-mp3-myanmar.htm",
            "Dr-Nandamalabhivamsa-mp3-myanmar-Meditation.htm",
            "Dr-Nandamalabhivamsa-mp3-myanmar-category.htm",
        ],
    },
    {
        "id": "mahasi",
        "name": "မဟာစည်ဆရာတော် ဦးသောဘဏ",
        "pages": ["Mahasi-Sayadaw-U-Sobhana-Mahathera-mp3.htm"],
    },
    {
        "id": "saddhammaramsi",
        "name": "သဒ္ဓမ္မရံသီဆရာတော်",
        "pages": ["Saddhammaramsi-SayaDaw-mp3-myanmar.htm"],
        "subtitles": True,  # the talk title is on the line after the (date) link
    },
]

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "app" / "catalog.json"
SEEN = ROOT / "tools" / "first_seen.json"

MP3_LINK = re.compile(
    r"""<a\b[^>]*?href\s*=\s*["']([^"']+?\.mp3)["'][^>]*>(.*?)</a\s*>""", re.I | re.S)
NAV_LINK = re.compile(
    r"""<a\b[^>]*href\s*=\s*["'][^"']*\.html?[^"']*["'][^>]*>.*?</a\s*>""", re.I | re.S)
BLOCK = re.compile(r"</?(p|div|tr|table|h[1-6]|li|ul|ol|center|blockquote)\b[^>]*>", re.I)
NUM_PREFIX = re.compile(r"^\s*[(]?[၀-၉0-9]{1,4}\s*[။.)]\s*")
DATE_IN_URL = re.compile(r"(19|20)\d\d-[01]\d-[0-3]\d")
DECOR = re.compile(r"^[\s*~=_\-#.·•]+|[\s*~=_\-#.·•]+$")
# link text that is only a date/time, e.g. "၂၉-၁၂-၂၀၀၂ ညနေ ၇နာရီ (BBT)"
DATE_ONLY = re.compile(
    r"^[\s၀-၉0-9\-/.,]*(ညနေ|နံနက်|မနက်|နေ့လယ်|ည)?[\s၀-၉0-9:]*(နာရီ)?\s*(\([A-Za-z]+\))?\s*$")


def fetch(page, cache):
    if cache and (cache / page).exists():
        return (cache / page).read_text(encoding="utf-8", errors="replace")
    req = urllib.request.Request(SITE + page, headers={"User-Agent": "TayarNarYu-catalog/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        text = r.read().decode("utf-8", errors="replace")
    if cache:
        cache.mkdir(parents=True, exist_ok=True)
        (cache / page).write_text(text, encoding="utf-8")
    return text


def clean(s):
    s = html.unescape(s).replace(" ", " ").replace("​", "")
    return re.sub(r"\s+", " ", s).strip()


def html_to_lines(fragment, after_link=True):
    """Text lines of an HTML fragment; '' marks a blank line / paragraph break.
    With after_link, text before the first line break is the link's own line and is dropped."""
    s = re.sub(r"<!--.*?-->", "", fragment, flags=re.S)
    s = re.sub(r"<(script|style)\b.*?</\1>", "", s, flags=re.S | re.I)
    s = NAV_LINK.sub("", s)
    s = re.sub(r"\s+", " ", s)  # source newlines are plain spaces in HTML
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = BLOCK.sub("\n\n", s)
    s = re.sub(r"<[^>]+>", "", s)
    s = re.sub(r"<[^\n]*", "", s)  # broken / unclosed tags in the source
    segs = s.split("\n")
    if after_link:
        segs = segs[1:]
    lines = []
    for raw in segs:
        line = DECOR.sub("", clean(raw))
        if line:
            lines.append(line)
        elif not lines or lines[-1] != "":
            lines.append("")
    while lines and lines[-1] == "":
        lines.pop()
    return lines


NOT_HEADER = re.compile(
    r"^([၀-၉0-9]{1,4}\s*။|[၀-၉0-9]{1,2}[-.][၀-၉0-9]{1,2}[-.][၀-၉0-9]{4}|https?://|[(]?[၀-၉0-9]+[)]?$)")


def blocks_of(lines):
    """Join consecutive lines into blocks; drop blocks that are not real headings
    (unlinked talk lines such as "၂၆-၀၁-၂၀၂၁ ..." or "၂၅၃။ ...", URLs, stray numbers)."""
    out, cur = [], []
    for line in lines + [""]:
        if line:
            cur.append(line)
        elif cur:
            block = " ".join(cur)
            if len(block) >= 2 and not NOT_HEADER.match(block):
                out.append(block)
            cur = []
    return out


def split_between(lines, subtitles):
    """Lines between two links -> (subtitle of previous talk, header blocks of next group)."""
    sub = []
    if subtitles:
        while lines and lines[0]:
            sub.append(lines.pop(0))
    return " ".join(sub), blocks_of(lines)


def norm_url(u):
    u = urllib.parse.unquote(urllib.parse.urljoin(SITE, html.unescape(u).strip()))
    for old in ("http://www.dhammadownload.com/", "http://dhammadownload.com/",
                "https://www.dhammadownload.com/"):
        u = u.replace(old, SITE)
    return re.sub(r"/\s+", "/", u)


def item_id(url):
    return hashlib.sha1(url.encode("utf-8")).hexdigest()[:10]


def parse_page(text, seen_urls, subtitles=False):
    groups, current, prev_end, last_item = [], None, 0, None
    for k, m in enumerate(MP3_LINK.finditer(text)):
        if k == 0:
            sub, header = "", blocks_of(html_to_lines(text[:m.start()], after_link=False))[-3:]
        else:
            sub, header = split_between(html_to_lines(text[prev_end:m.start()]), subtitles)
        if sub and last_item:
            last_item["s"] = sub
        prev_end, last_item = m.end(), None
        url = norm_url(m.group(1))
        folder = url.rsplit("/", 1)[0]
        # a new group starts at a heading; folder changes alone only matter for unrelated paths
        if current is None or header or folder.split("/")[4:5] != current["_folder"].split("/")[4:5]:
            current = {"t": header[-1] if header else folder.rsplit("/", 1)[-1],
                       "d": " · ".join(header[-3:-1]), "items": [], "_folder": folder}
            groups.append(current)
        if url in seen_urls:
            continue
        seen_urls.add(url)
        link_text = NUM_PREFIX.sub("", clean(re.sub(r"<[^>]+>", " ", m.group(2))))
        last_item = {"id": item_id(url), "t": link_text or url.rsplit("/", 1)[-1][:-4],
                     "u": url[len(MP3_BASE):] if url.startswith(MP3_BASE) else url}
        d = DATE_IN_URL.search(url.rsplit("/", 1)[-1])
        if d:
            last_item["date"] = d.group(0)
        current["items"].append(last_item)
    if subtitles and last_item:
        sub, _ = split_between(html_to_lines(text[prev_end:prev_end + 3000]), True)
        if sub:
            last_item["s"] = sub
    for g in groups:
        g.pop("_folder")
        if not g["d"]:
            del g["d"]
    return [g for g in groups if g["items"]]


MONTHS = {"january": "ဇန်နဝါရီ", "february": "ဖေဖော်ဝါရီ", "march": "မတ်", "april": "ဧပြီ",
          "may": "မေ", "june": "ဇွန်", "july": "ဇူလိုင်", "august": "ဩဂုတ်",
          "september": "စက်တင်ဘာ", "october": "အောက်တိုဘာ", "november": "နိုဝင်ဘာ",
          "december": "ဒီဇင်ဘာ"}
MM_DIGITS = str.maketrans("0123456789", "၀၁၂၃၄၅၆၇၈၉")


def tidy_group_title(g):
    """'July' -> '၂၀၂၄ ဇူလိုင်', 'July &June' -> '၂၀၁၉ ဇူလိုင် / ဇွန်'; a '(note)' title
    gives way to the heading before it."""
    words = re.findall(r"[A-Za-z]+", g["t"])
    if words and all(w.lower() in MONTHS for w in words):
        years = sorted({it["date"][:4] for it in g["items"] if "date" in it})
        year = years[-1].translate(MM_DIGITS) + " " if years else ""
        g["t"] = year + " / ".join(MONTHS[w.lower()] for w in words)
        return not year  # True = month heading still missing its year
    if g["t"].startswith("(") and g.get("d"):
        parts = g["d"].split(" · ")
        g["t"], g["d"] = parts[-1], " · ".join(parts[:-1] + [g["t"]])
    return False


def finalize_items(groups):
    last_year = ""
    for g in groups:
        if tidy_group_title(g):
            if last_year:  # month heading without dated talks: same year as the one before
                g["t"] = last_year + " " + g["t"]
        else:
            m = re.match(r"^([၀-၉]{4}) ", g["t"])
            last_year = m.group(1) if m else ""
        for it in g["items"]:
            s = it.pop("s", "")
            if not s or len(s) > 200:
                continue
            if DATE_ONLY.match(it["t"]):
                it["n"], it["t"] = it["t"], s  # date line becomes the note
            else:
                it["n"] = s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", type=Path)
    args = ap.parse_args()

    first_seen = json.loads(SEEN.read_text(encoding="utf-8")) if SEEN.exists() else {}
    initial_run = not first_seen
    today = dt.date.today().isoformat()

    sayadaws, total = [], 0
    for sd in SAYADAWS:
        seen_urls, groups = set(), []
        for page in sd["pages"]:
            groups += parse_page(fetch(page, args.cache), seen_urls, sd.get("subtitles", False))
        finalize_items(groups)
        n = sum(len(g["items"]) for g in groups)
        total += n
        print(f"{sd['id']}: {len(groups)} groups, {n} talks", file=sys.stderr)
        sayadaws.append({"id": sd["id"], "name": sd["name"], "groups": groups})
        for g in groups:
            for it in g["items"]:
                first_seen.setdefault(it["id"], "initial" if initial_run else today)

    # "Newly added" = first seen after the initial build, newest first (max 100)
    new_ids = sorted((k for k, v in first_seen.items() if v != "initial"),
                     key=lambda k: first_seen[k], reverse=True)[:100]

    catalog = {
        "generated": today,
        "base": MP3_BASE,
        "source": "https://www.dhammadownload.com/",
        "sayadaws": sayadaws,
        "new": [{"id": k, "a": first_seen[k]} for k in new_ids],
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    SEEN.write_text(json.dumps(first_seen, indent=0, sort_keys=True), encoding="utf-8")
    print(f"total {total} talks -> {OUT} ({OUT.stat().st_size // 1024} KB)", file=sys.stderr)


if __name__ == "__main__":
    main()
