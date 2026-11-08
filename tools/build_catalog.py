"""Build the talk catalog for တရားနာယူ from dhammadownload.com.

Reads the Myanmar audio index (AudioInMyanmar.htm), every teacher page it links to
(plus their sub-pages), and writes:
  app/data/index.json      teachers, their album (group) titles, newly added talks
  app/data/t/<id>.json     one file per teacher with all talks
  app/data/search.json     every talk, loaded by the app only when searching

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
import time
import urllib.parse
import urllib.request
from pathlib import Path

SITE = "https://dhammadownload.com/"
MP3_BASE = "https://dhammadownload.com/MP3Library/"
INDEX_PAGE = "AudioInMyanmar.htm"

SECTIONS = [
    {"id": "sayadaw", "name": "ဆရာတော်များ"},
    {"id": "lay", "name": "ဆရာကြီးများ"},
    {"id": "chanting", "name": "ပရိတ်တော်နှင့် ဘုရားရှိခိုး"},
    {"id": "class", "name": "စာချတန်း / ဓမ္မာစရိယ သင်တန်းများ"},
]

# Site navigation and pages that are not a teacher's talk list.
SKIP_PAGES = {
    "index.htm", "AbhidhammaInEnglish.htm", "AbhidhammaInMyanmar.htm", "AudioInEnglish.htm",
    "AudioInMyanmar.htm", "VideoInEnglish.htm", "VideoInMyanmar.htm", "eBook-English.htm",
    "eBook-Myanmar.htm", "dhammadownload-news.htm", "Contribute-to-dhammadownload.htm",
    "Suggestion-cbox.htm", "contact.htm", "usefullinks.htm", "live.htm",
    "Dr-Nandamalabhivamsa-University-Of-Wisdom-Land-2.htm",   # test page
    "YaHanDarGyiMyar-List.htm", "YaHanDarGyiMyar-Other-List.htm",  # lists of biographies
}
# Sub-pages are followed automatically unless their name contains one of these.
SKIP_SUBPAGE = re.compile(r"wma|video|news|picture|cbox|contact|index", re.I)

# Per-page exceptions (key = the page linked from the index).
OVERRIDES = {
    "Dr-Nandamalabhivamsa-mp3-myanmar.htm": {
        "id": "nandamala", "name": "ဒေါက်တာနန္ဒမာလာဘိဝံသ",
        "extra": ["Dr-Nandamalabhivamsa-University-Of-Wisdom-Land.htm"]},
    "Dr-Nandamalabhivamsa-University-Of-Wisdom-Land.htm": {"merge_into": "nandamala"},
    "Mahasi-Sayadaw-U-Sobhana-Mahathera-mp3.htm": {"id": "mahasi", "name": "မဟာစည်ဆရာတော် ဦးသောဘဏ"},
    "Saddhammaramsi-SayaDaw-mp3-myanmar.htm": {"id": "saddhammaramsi", "name": "သဒ္ဓမ္မရံသီဆရာတော်",
                                               "subtitles": True},
    "MaSoeYeinSayadaw-Bhaddanta-Raja-Dhamma-Bhivamsa-video.htm": {"merge_into": "masoeyein"},
    "MaSoeYeinSayadaw-Bhaddanta-Raja-Dhamma-Bhivamsa-mp3Inmyanmar.htm": {
        "id": "masoeyein", "name": "မစိုးရိမ်ဆရာတော် ဘဒ္ဒန္တ ရာဇဓမ္မာဘိဝံသ",
        "extra": ["MaSoeYeinSayadaw-Bhaddanta-Raja-Dhamma-Bhivamsa-video.htm"]},
    "Chanting-mp3.htm": {"name": "ပရိတ်တော်နှင့် ဘုရားရှိခိုး", "section": "chanting"},
    "Bhaddanta-Thuseiktha-Vivamsa-DhammacriyaClass-mp3.htm": {"section": "class"},
    "AudioInMyanmar-for-Dhammarcariya-Students.htm": {"section": "class"},
    "MyaSatKyarSayadaw-BhaddantaIndakabhivamsa-SarwarAudioInMyanmar.htm": {"section": "class"},
    "HlaYadanarSayadaw-mp3.htm": {"name": "လှရတနာ ဆရာတော်"},
    "SayaDaw-U-ThuMinGaLA-mp3.htm": {"name": "ဦးသုမင်္ဂလ (မင်္ဂလတိုက်သစ် - ဒယ်အိုးဆရာတော်)"},
}
LAY_PAGES = re.compile(r"^(SayaGyi-|Dr-MehmTinMon|DawKyiKyiWein|SN-Goenka|Writer-|DhammaByuhar|"
                       r"Dhammarcariya-UHtayHlaing|Sayalay-)")

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "app" / "data"
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
    r"^[\s၀-၉0-9\-/.,]*(ညနေ|နံနက်|နံက်|မနက်|နေ့လယ်|နေ့လည်|ည|ညပိုင်း|မွန်းလွဲ)?[\s၀-၉0-9:]*(နာရီ)?\s*(\([A-Za-z]+\))?\s*$")


def fetch(page, cache):
    if cache and (cache / page).exists():
        return (cache / page).read_text(encoding="utf-8", errors="replace")
    req = urllib.request.Request(SITE + urllib.parse.quote(page),
                                 headers={"User-Agent": "TayarNarYu-catalog/1.0"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                text = r.read().decode("utf-8", errors="replace")
            break
        except Exception:
            if attempt == 2:
                raise
            time.sleep(5)
    time.sleep(0.3)  # be gentle with the site
    if cache:
        cache.mkdir(parents=True, exist_ok=True)
        (cache / page).write_text(text, encoding="utf-8")
    return text


def clean(s):
    s = html.unescape(s).replace(" ", " ").replace("​", "")
    return re.sub(r"\s+", " ", s).strip()


def html_text(fragment):
    """HTML fragment -> text where '\n' = line break and '\n\n' = paragraph break."""
    s = re.sub(r"<!--.*?-->", "", fragment, flags=re.S)
    s = re.sub(r"<(script|style)\b.*?</\1>", "", s, flags=re.S | re.I)
    s = NAV_LINK.sub("", s)
    s = re.sub(r"\s+", " ", s)  # source newlines are plain spaces in HTML
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = BLOCK.sub("\n\n", s)
    s = re.sub(r"<[^>]+>", " ", s)
    return re.sub(r"<[^\n]*", "", s)  # broken / unclosed tags in the source


def html_to_lines(fragment, after_link=True):
    """Text lines of an HTML fragment; '' marks a blank line / paragraph break.
    With after_link, returns (text on the link's own line, following lines)."""
    segs = html_text(fragment).split("\n")
    first = DECOR.sub("", clean(segs[0])) if after_link else ""
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
    return (first, lines) if after_link else lines


def split_row(frag):
    """If the link sits in a table row, return (rest of that row as text, fragment after the row)."""
    low = frag.lower()
    j = low.find("</tr")
    if j < 0 or "<tr" in low[:j] or "<a " in low[:j]:
        return "", frag
    return DECOR.sub("", clean(re.sub(r"<[^>]+>", " ", re.sub(r"<!--.*?-->", "", frag[:j], flags=re.S)))), frag[j:]


MY = re.compile(r"[က-႟]")


def placeholder(t):
    """Link text that is not a real title: a date/time, a URL, a file name, a bare number."""
    t = t.strip()
    return (not t or bool(DATE_ONLY.match(t)) or bool(re.fullmatch(r"[(]?[၀-၉0-9]+[)]?", t))
            or urlish(t))


def urlish(t):
    return not MY.search(t) and (t.lower().startswith(("http", "www.")) or ".mp3" in t.lower()
                                 or (" " not in t.strip() and re.search(r"\d", t) is not None))


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
            english_note = len(block) > 40 and not re.search(r"[က-႟]", block)
            if len(block) >= 2 and not NOT_HEADER.match(block) and not english_note:
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
    groups, current, last_item, last_text = [], None, None, ""
    links = list(MP3_LINK.finditer(text))
    for k, m in enumerate(links + [None]):
        start = links[k - 1].end() if k else 0
        end = m.start() if m else min(len(text), start + 3000)
        frag = text[start:end]
        tail, sub, header = "", "", []
        if k == 0:
            header = blocks_of(html_to_lines(frag, after_link=False))[-3:]
        else:
            tail, frag = split_row(frag)
            first, lines = html_to_lines(frag)
            tail = tail or first
            sub, header = split_between(lines, subtitles or placeholder(last_text))
        if last_item is not None:
            if tail:
                last_item["tail"] = tail
            if sub:
                last_item["s"] = sub
        if m is None:
            break
        url = norm_url(m.group(1))
        raw_text = clean(re.sub(r"<[^>]+>", " ", m.group(2)))
        num = NUM_PREFIX.match(raw_text)
        link_text = NUM_PREFIX.sub("", raw_text)
        last_text = link_text
        before = ""
        if urlish(link_text) and header:  # real title is written before a URL-like link
            before, header = " · ".join(header), []
        folder = url.rsplit("/", 1)[0]
        # a new group starts at a heading; folder changes alone only matter for unrelated paths
        if current is None or header or folder.split("/")[4:5] != current["_folder"].split("/")[4:5]:
            current = {**group_title(header, folder), "items": [], "_folder": folder}
            groups.append(current)
        last_item = None
        if url in seen_urls:
            continue
        seen_urls.add(url)
        last_item = {"id": item_id(url), "t": link_text, "_url": url,
                     "u": url[len(MP3_BASE):] if url.startswith(MP3_BASE) else url}
        if before:
            last_item["before"] = before
        if num:
            last_item["_num"] = num.group(0).strip()
        d = DATE_IN_URL.search(url.rsplit("/", 1)[-1])
        if d:
            last_item["date"] = d.group(0)
        current["items"].append(last_item)
    for g in groups:
        g.pop("_folder")
        if not g["d"]:
            del g["d"]
    return [g for g in groups if g["items"]]


def group_title(header, folder):
    """Album title = the heading nearest the talks; long prose goes to the description."""
    if not header:
        return {"t": folder.rsplit("/", 1)[-1], "d": ""}
    short = [h for h in header if len(h) <= 100]
    title = short[-1] if short else header[-1][:90].rsplit(" ", 1)[0] + "…"
    rest = [h for h in header if h != title]
    if not short:
        rest = [header[-1]] + rest[:-1]
    rest = [h for h in rest if MY.search(h)]  # English captions ("CD cover design ...") are noise
    return {"t": title, "d": " · ".join(rest[-2:])}


def file_title(url):
    name = urllib.parse.unquote(url.rsplit("/", 1)[-1])[:-4]
    return re.sub(r"[-_]+", " ", name).strip()


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
            link, url = it["t"], it.pop("_url")
            extra = " ".join(x for x in (it.pop("tail", ""), it.pop("s", "")) if x)
            before = it.pop("before", "")
            if len(extra) > 200:
                extra = ""
            if placeholder(link):
                title = before or extra or (link if link and not urlish(link) else file_title(url))
                note = link if link and not urlish(link) and title != link else ""
                if before and extra:
                    note = (note + " · " + extra).strip(" ·")
            else:
                title, note = link, extra
            it["t"] = title
            if note:
                it["n"] = note
        # titles repeated inside one album: put the site's running number back in front
        counts = {}
        for it in g["items"]:
            counts[it["t"]] = counts.get(it["t"], 0) + 1
        for k, it in enumerate(g["items"], 1):
            num = it.pop("_num", "")
            if counts[it["t"]] > 1:
                it["t"] = (num or str(k).translate(MM_DIGITS) + "။") + " " + it["t"]


def teacher_id(page):
    """'Mogok-Sayadaw-mp3.htm' -> 'mogok-sayadaw' (stable: used in links and saved history)."""
    s = re.sub(r"\.html?$", "", page, flags=re.I).lower()
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    s = re.sub(r"(-?(mp3|wma|audio|myanmar|myanmer|inmyanmar|mp3inmyanmar|audioinmyanmar|"
               r"audioinmyanmer|mp3audio))+$", "", s)
    return s.strip("-")


def discover(cache):
    """Teacher pages in the order the index lists them, with their names."""
    text = fetch(INDEX_PAGE, cache)
    teachers, seen = [], set()
    for href, label in re.findall(r"""<a\b[^>]*href\s*=\s*["']([^"']+?\.htm)["'][^>]*>(.*?)</a\s*>""",
                                  text, re.I | re.S):
        if "/" in href or href in SKIP_PAGES or href in seen:
            continue
        seen.add(href)
        ov = OVERRIDES.get(href, {})
        if "merge_into" in ov:
            continue
        name = ov.get("name") or DECOR.sub("", clean(re.sub(r"<[^>]+>", " ", label)))
        section = ov.get("section") or ("lay" if LAY_PAGES.match(href) else "sayadaw")
        teachers.append({"id": ov.get("id") or teacher_id(href), "name": name or href,
                         "section": section, "pages": [href] + ov.get("extra", []),
                         "subtitles": ov.get("subtitles", False)})
    return teachers


def sub_pages(text, known):
    out = []
    for h in re.findall(r"""href\s*=\s*["']([^"'#?]+?\.htm)["']""", text, re.I):
        if "/" in h or h in known or h in out or SKIP_SUBPAGE.search(h):
            continue
        out.append(h)
    return out


def load_seen():
    """first_seen.json: {"teachers": [...], "items": {id: date | "initial"}}"""
    if not SEEN.exists():
        return {"teachers": [], "items": {}}
    data = json.loads(SEEN.read_text(encoding="utf-8"))
    if "items" not in data:  # old flat format (first 3 Sayadaws)
        data = {"teachers": ["nandamala", "mahasi", "saddhammaramsi"], "items": data}
    return data


def write_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", type=Path)
    ap.add_argument("--only", help="comma-separated teacher ids (for testing)")
    args = ap.parse_args()

    seen = load_seen()
    known_teachers = set(seen["teachers"])
    today = dt.date.today().isoformat()

    teachers = discover(args.cache)
    index_pages = {p for t in teachers for p in t["pages"]} | SKIP_PAGES | set(OVERRIDES)
    if args.only:
        keep = set(args.only.split(","))
        teachers = [t for t in teachers if t["id"] in keep]

    out_teachers, search, total = [], {}, 0
    for t in teachers:
        seen_urls, groups, pages, i = set(), [], list(t["pages"]), 0
        while i < len(pages):
            try:
                text = fetch(pages[i], args.cache)
            except Exception as e:  # a missing sub-page must not stop the weekly update
                print(f"  ! {pages[i]}: {e}", file=sys.stderr)
                i += 1
                continue
            groups += parse_page(text, seen_urls, t["subtitles"])
            for sp in sub_pages(text, index_pages | set(pages)):
                pages.append(sp)
            i += 1
        finalize_items(groups)
        n = sum(len(g["items"]) for g in groups)
        if not n:
            print(f"{t['id']}: no MP3 talks, skipped", file=sys.stderr)
            continue
        total += n
        print(f"{t['id']}: {len(groups)} groups, {n} talks ({len(pages)} pages)", file=sys.stderr)
        first_time = t["id"] not in known_teachers
        for g in groups:
            for it in g["items"]:
                seen["items"].setdefault(it["id"], "initial" if first_time else today)
        known_teachers.add(t["id"])
        items_by_group = [g["items"] for g in groups]
        write_json(DATA / "t" / f"{t['id']}.json", {"id": t["id"], "groups": items_by_group})
        search[t["id"]] = items_by_group
        out_teachers.append({
            "id": t["id"], "name": t["name"], "section": t["section"], "count": n,
            "source": SITE + t["pages"][0],
            "groups": [{k: v for k, v in (("t", g["t"]), ("d", g.get("d")), ("c", len(g["items"]))) if v}
                       for g in groups]})

    # "Newly added" = first seen after a teacher's initial import, newest first (max 100)
    where = {it["id"]: (t["id"], gi, it) for t in out_teachers
             for gi, items in enumerate(search[t["id"]]) for it in items}
    new_ids = sorted((k for k, v in seen["items"].items() if v != "initial" and k in where),
                     key=lambda k: seen["items"][k], reverse=True)[:100]
    new = [dict(where[k][2], tid=where[k][0], gi=where[k][1], a=seen["items"][k]) for k in new_ids]

    write_json(DATA / "index.json", {
        "generated": today, "base": MP3_BASE, "source": "https://www.dhammadownload.com/",
        "total": total, "sections": SECTIONS, "teachers": out_teachers, "new": new})
    write_json(DATA / "search.json", search)
    if not args.only:
        live = {t["id"] for t in out_teachers}
        for f in (DATA / "t").glob("*.json"):  # teachers removed from the site
            if f.stem not in live:
                f.unlink()
        seen["teachers"] = sorted(known_teachers)
        SEEN.write_text(json.dumps(seen, indent=0, sort_keys=True), encoding="utf-8")
    kb = lambda f: (DATA / f).stat().st_size // 1024
    print(f"total {total} talks, {len(out_teachers)} teachers -> index {kb('index.json')} KB, "
          f"search {kb('search.json')} KB", file=sys.stderr)


if __name__ == "__main__":
    main()
