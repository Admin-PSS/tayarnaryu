# တရားနာယူ

A free web app (PWA) for listening online to Dhamma talks from
[dhammadownload.com](https://www.dhammadownload.com/). Audio streams directly from
dhammadownload.com, which publicly permits linking to its MP3 files
("ကြိုတင်ခွင့်ပြုချက်" notice on its main page). Nothing is re-hosted.

## Layout

| Path | What |
|---|---|
| `app/` | The app (static files, deployed as-is): `index.html`, `style.css`, `app.js`, `sw.js`, `manifest.webmanifest`, `icons/`, `catalog.json` |
| `tools/build_catalog.py` | Reads the Sayadaw pages and writes `app/catalog.json` |
| `tools/first_seen.json` | When each talk first appeared (feeds "အသစ်ထည့်ထားသော တရားများ") |
| `tools/make_icons.py` | Regenerates the app icons |
| `.github/workflows/update-and-deploy.yml` | Weekly catalog update + GitHub Pages deploy |

## Run locally

```sh
python tools/build_catalog.py          # refresh the talk list
cd app && python -m http.server 8765   # open http://127.0.0.1:8765
```

## Add a Sayadaw

Add an entry to `SAYADAWS` in `tools/build_catalog.py` (id, Myanmar name, page file
names from dhammadownload.com), run the script, and check the groups and titles.
Set `"subtitles": True` if the page's links show only a date and the real title is
on the next line (as on the Saddhammaramsi page).
