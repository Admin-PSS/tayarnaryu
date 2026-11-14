# တရားနာယူ

A free web app (PWA) for listening online to Dhamma talks from
[dhammadownload.com](https://www.dhammadownload.com/). Audio streams directly from
dhammadownload.com, which publicly permits linking to its MP3 files
("ကြိုတင်ခွင့်ပြုချက်" notice on its main page). Nothing is re-hosted.

- Website: https://dhamma-mp3.pyisoe.com/
- Android: [Google Play](https://play.google.com/store/apps/details?id=com.adminpss.tayarnaryu)
- iPhone / iPad: [App Store](https://apps.apple.com/app/id6833746953)

## Layout

| Path | What |
|---|---|
| `app/` | The app (static files, deployed as-is): `index.html`, `style.css`, `app.js`, `sw.js`, `manifest.webmanifest`, `icons/` |
| `app/data/index.json` | Teachers, sections, album titles, newly added talks (loaded at start) |
| `app/data/t/<id>.json` | All talks of one teacher (loaded when that teacher is opened) |
| `app/data/search.json` | Every talk (loaded on first search) |
| `tools/build_catalog.py` | Reads `AudioInMyanmar.htm` and every teacher page/sub-page, writes `app/data/` |
| `tools/check_catalog.py` | Quality report: flags teachers whose page layout confused the parser |
| `tools/first_seen.json` | When each talk first appeared (feeds "အသစ်ထည့်ထားသော တရားများ") |
| `tools/make_icons.py` | Regenerates the app icons |
| `.github/workflows/update-and-deploy.yml` | Weekly catalog update + GitHub Pages deploy |

## Run locally

```sh
python tools/build_catalog.py          # refresh the talk list
cd app && python -m http.server 8765   # open http://127.0.0.1:8765
```

## Teachers

New teachers listed on dhammadownload.com's *Audio in Myanmar* page are picked up
automatically by the weekly run. Exceptions (fixed ids/names, sections, merged pages,
pages to skip) live in `OVERRIDES`, `SKIP_PAGES` and `LAY_PAGES` in
`tools/build_catalog.py`. After changing the parser, run
`python tools/check_catalog.py` (and `python tools/check_catalog.py <teacher-id>` for samples).

WMA files are skipped (browsers cannot play them); videos are not included.
