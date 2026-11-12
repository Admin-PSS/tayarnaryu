/* တရားနာယူ — listen to dhammadownload.com talks online.
   Audio streams directly from dhammadownload.com (linking permitted on their main page).
   Data: data/index.json (teachers + albums), data/t/<id>.json (talks of one teacher, loaded
   when opened), data/search.json (all talks, loaded on first search). */
"use strict";

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const MMD = "၀၁၂၃၄၅၆၇၈၉";
const mm = x => String(x).replace(/\d/g, d => MMD[d]);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cut = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
const fmt = s => {
  if (!isFinite(s) || s < 0) return "--:--";
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  return mm((h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(sec).padStart(2, "0"));
};
const fmtDate = d => d ? mm(d.split("-").reverse().join("-")) : "";

/* Android / iOS app (Capacitor, see mobile/): the web files are bundled in the app.
   Native = BackgroundAudio plugin (mobile/android/.../BackgroundAudioPlugin.java,
   mobile/ios/App/App/BackgroundAudioPlugin.swift); undefined on the website. */
const IN_APP = !!window.Capacitor?.isNativePlatform?.();
const IOS = IN_APP && window.Capacitor.getPlatform?.() === "ios";
const Native = IN_APP ? window.Capacitor.Plugins?.BackgroundAudio : null;
const SITE = "https://dhamma-mp3.pyisoe.com/";   // live website: share links + fresh talk lists
const CONTACT = "pyisoester@gmail.com";           // developer contact (About page, privacy policy, Play Console)

const store = {
  get(k, def) { try { const v = localStorage.getItem("tny." + k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem("tny." + k, JSON.stringify(v)); } catch { /* private mode / full */ } },
};

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}

/* ---------- state ---------- */
let CAT = null;                              // data/index.json
const teachers = new Map();                  // id -> teacher (from index)
const byId = new Map();                      // item id -> {it, s, g, gi}
let searchIndex = null;                      // [{id, key}] once search.json is loaded
let pos = store.get("pos", {});              // id -> {t, d, at, done}
let favs = store.get("favs", []);            // ids, newest first
let recent = store.get("recent", []);        // ids, newest first
let meta = store.get("meta", {});            // id -> {it, tid, gi}: talks we must show without loading their teacher
const settings = Object.assign({ rate: 1, theme: "auto", sort: "site" }, store.get("settings", {}));
let currentList = [];                        // ids of the album being shown ("play all")

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
const savePos = () => store.set("pos", pos);
const saveSettings = () => store.set("settings", settings);

const darkQuery = matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
  if (settings.theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = settings.theme;
  // app: status/navigation bar strips in the same colour as the page (iOS also follows "theme")
  const dark = settings.theme === "dark" || (settings.theme === "auto" && darkQuery.matches);
  Native?.setBars({ color: dark ? "#16120e" : "#f6f0e6", dark, theme: settings.theme }).catch(() => {});
}
applyTheme();
darkQuery.addEventListener?.("change", applyTheme);

/* Myanmar search normalisation: ignore spaces/punctuation, common spelling variants */
const norm = s => String(s).toLowerCase().normalize("NFC")
  .replace(/[\s​-‍\-_.,()[\]"'၊။:]/g, "")
  .replace(/သြ/g, "ဩ").replace(/၀/g, "ဝ").replace(/၇/g, "ရ");

/* ---------- data ---------- */
async function fetchJSON(url, opts = {}) {
  const r = await fetch(url, { cache: "no-cache", ...opts });
  if (!r.ok) throw new Error(url + " " + r.status);
  return r.json();
}
async function getJSON(url) {
  // In the app, the bundled lists only change with a new APK; the website is re-scraped every
  // week, so try it first and fall back to the bundled copy when offline or slow.
  if (IN_APP) {
    try { return await fetchJSON(SITE + url, AbortSignal.timeout ? { signal: AbortSignal.timeout(8000) } : {}); }
    catch { /* offline → bundled copy */ }
  }
  return fetchJSON(url);
}

function register(it, tid, gi) {
  const s = teachers.get(tid); if (!s) return;
  byId.set(it.id, { it, s, g: s.groups[gi], gi });
}

async function loadCatalog() {
  CAT = await getJSON("data/index.json");
  for (const t of CAT.teachers) teachers.set(t.id, t);
  for (const n of CAT.new || []) register(n, n.tid, n.gi);
  for (const [id, m] of Object.entries(meta)) if (!byId.has(id)) register(m.it, m.tid, m.gi);
  favs = favs.filter(id => byId.has(id));
  recent = recent.filter(id => byId.has(id));
}

const loading = new Map();
function loadTeacher(tid) {
  const t = teachers.get(tid);
  if (!t) return Promise.reject(new Error("unknown teacher"));
  if (t.loaded) return Promise.resolve(t);
  if (!loading.has(tid)) {
    loading.set(tid, getJSON(`data/t/${tid}.json`).then(d => {
      d.groups.forEach((items, gi) => {
        if (t.groups[gi]) t.groups[gi].items = items.map(it => it.id);
        items.forEach(it => register(it, tid, gi));
      });
      t.loaded = true;
      return t;
    }).finally(() => loading.delete(tid)));
  }
  return loading.get(tid);
}

let searchLoading = null;
function loadSearch() {
  if (searchIndex) return Promise.resolve();
  searchLoading ??= getJSON("data/search.json").then(all => {
    const idx = [];
    for (const [tid, groups] of Object.entries(all)) {
      const t = teachers.get(tid); if (!t) continue;
      groups.forEach((items, gi) => {
        const g = t.groups[gi];
        if (g && !g.items) g.items = items.map(it => it.id);
        for (const it of items) {
          if (!byId.has(it.id)) register(it, tid, gi);
          idx.push({ id: it.id, key: norm([it.t, it.n, g?.t, t.name, it.date].join(" ")) });
        }
      });
      t.loaded = true;
    }
    searchIndex = idx;
  }).catch(e => { searchLoading = null; throw e; });
  return searchLoading;
}

/* remember enough about talks in history/favourites/queue to show them without loading their teacher */
function saveMeta() {
  const keep = new Set([...recent, ...favs, ...player.queue]);
  const m = {};
  for (const id of keep) {
    const e = byId.get(id);
    if (e) m[id] = { it: e.it, tid: e.s.id, gi: e.gi };
    else if (meta[id]) m[id] = meta[id];
  }
  meta = m; store.set("meta", meta);
}

function audioUrl(it) {
  const u = /^https?:/.test(it.u) ? it.u : CAT.base + it.u;
  return encodeURI(u).replace(/#/g, "%23").replace(/\?/g, "%3F");
}

/* ---------- rendering helpers ---------- */
function progressOf(id) {
  const p = pos[id];
  if (!p) return null;
  if (p.done) return { pct: 100, done: true };
  return p.d ? { pct: Math.min(100, p.t / p.d * 100) } : null;
}

function talkRow(id, showSayadaw = false) {
  const e = byId.get(id); if (!e) return "";
  const { it, s, g } = e;
  const p = progressOf(id);
  const info = [];
  if (it.n) info.push(esc(cut(it.n, 120)));
  if (showSayadaw) info.push(esc(cut(s.name, 40)) + " · " + esc(cut(g?.t || "", 40)));
  else if (it.date && !it.t.includes(mm(it.date.slice(0, 4)))) info.push(fmtDate(it.date));
  const pp = pos[id];
  if (pp && !pp.done && pp.t > 5) info.push("▶ " + fmt(pp.t) + (pp.d ? " / " + fmt(pp.d) : ""));
  const playing = player.currentId() === id;
  const fav = favs.includes(id);
  return `<li class="row${playing ? " playing" : ""}${p?.done ? " done" : ""}" data-row="${id}"${showSayadaw ? ' data-wide="1"' : ""}>
    <button class="row-main" data-act="play" data-id="${id}">
      <span class="row-title">${playing ? "🔊 " : ""}${esc(it.t)}</span>
      ${info.length ? `<span class="row-meta">${info.join(" · ")}</span>` : ""}
      ${p && !p.done ? `<span class="bar"><i style="width:${p.pct.toFixed(1)}%"></i></span>` : ""}
    </button>
    <button class="icon-btn fav${fav ? " on" : ""}" data-act="fav" data-id="${id}" aria-label="နှစ်သက်ရာ">${fav ? "★" : "☆"}</button>
  </li>`;
}

function talkList(ids, showSayadaw = false) {
  if (!ids.length) return `<div class="card empty">မရှိသေးပါ</div>`;
  return `<div class="card"><ul class="list">${ids.map(id => talkRow(id, showSayadaw)).join("")}</ul></div>`;
}

function setHeader(title, back) {
  $("#viewTitle").textContent = title;
  $("#backBtn").hidden = !back;
  $("#backBtn").dataset.to = back || "";
  document.title = title === "တရားနာယူ" ? title : title + " · တရားနာယူ";
}

function setTab(tab) {
  document.querySelectorAll(".tabs a").forEach(a => a.classList.toggle("on", a.dataset.tab === tab));
}

const spinner = msg => `<p class="loading" style="margin-top:20vh">${msg || "ဖွင့်နေသည်…"}</p>`;
const errorBox = () => `<div class="card empty">ဖွင့်၍မရပါ။ အင်တာနက် စစ်ပြီး ပြန်ကြိုးစားကြည့်ပါ။
  <p><button class="btn ghost" data-act="retry">ပြန်ကြိုးစားရန်</button></p></div>`;

/* ---------- views ---------- */
function sectionCounts() {
  const c = {};
  for (const t of CAT.teachers) c[t.section] = (c[t.section] || 0) + 1;
  return c;
}

function viewHome() {
  setHeader("တရားနာယူ"); setTab("home");
  const cont = recent.find(id => pos[id] && !pos[id].done && pos[id].t > 5 && byId.has(id));
  let h = "";
  if (cont) {
    const { it, s } = byId.get(cont);
    const p = pos[cont];
    h += `<div class="section"><h2>▶ ဆက်နာရန်</h2></div>
      <div class="card"><button class="continue" data-act="resume" data-id="${cont}">
        <span class="play-btn">▶︎</span>
        <span class="txt"><span class="row-title">${esc(it.t)}</span>
        <span class="row-meta">${esc(cut(s.name, 40))} · ${fmt(p.t)}${p.d ? " / " + fmt(p.d) : ""}</span>
        ${p.d ? `<span class="bar"><i style="width:${(p.t / p.d * 100).toFixed(1)}%"></i></span>` : ""}</span>
      </button></div>`;
  }
  const newIds = (CAT.new || []).map(n => n.id).filter(id => byId.has(id)).slice(0, 5);
  if (newIds.length) h += `<div class="section"><h2>🆕 အသစ်ထည့်ထားသော တရားများ</h2><a href="#/new">အားလုံး ›</a></div>` + talkList(newIds, true);
  if (recent.length) h += `<div class="section"><h2>🕘 မကြာမီက နာခဲ့သော</h2><a href="#/library/recent">အားလုံး ›</a></div>` + talkList(recent.slice(0, 5), true);
  if (favs.length) h += `<div class="section"><h2>⭐ နှစ်သက်ရာ</h2><a href="#/library/favs">အားလုံး ›</a></div>` + talkList(favs.slice(0, 5), true);
  const cnt = sectionCounts();
  const icons = { sayadaw: "🙏", lay: "📖", chanting: "🪷", class: "🎓" };
  h += `<div class="section"><h2>📚 တရားတော်များ</h2><span class="small muted">${mm(CAT.total)} ပုဒ်</span></div>
    <div class="card"><ul class="list">${CAT.sections.filter(s => cnt[s.id]).map(s => `
      <li><a class="sayadaw-card" href="#/sayadaws/${s.id}"><span class="av">${icons[s.id] || "☸"}</span>
        <span style="flex:1"><b>${esc(s.name)}</b><span class="row-meta">${mm(cnt[s.id])} ${s.id === "sayadaw" ? "ပါး" : "ခု"}</span></span>
        <span class="chev">›</span></a></li>`).join("")}</ul></div>`;
  h += credit();
  return h;
}

function credit() {
  return `<p class="credit">အသံဖိုင်များကို <a href="${esc(CAT.source)}" target="_blank" rel="noopener">dhammadownload.com</a> မှ
    ခွင့်ပြုချက်ဖြင့် တိုက်ရိုက်ဖွင့်ပါသည်။<br>တရားစာရင်း ${fmtDate(CAT.generated)} ထိ · <a href="#/about">ⓘ App အကြောင်း</a></p>`;
}

function viewAbout() {
  setHeader("App အကြောင်း", "#/"); setTab("library");
  const cnt = sectionCounts();
  const teachersN = (cnt.sayadaw || 0) + (cnt.lay || 0);
  const site = "https://www.dhammadownload.com/";
  return `<div class="about">
    <div class="about-hero">
      <img src="icons/icon-192.png" alt="" width="84" height="84">
      <h2>တရားနာယူ</h2>
      <p class="muted">ဓမ္မဒေါင်းလုပ်မှ တရားတော်များကို အွန်လိုင်းမှ တိုက်ရိုက် နာယူနိုင်ရန်</p>
    </div>

    <div class="card about-card">
      <h3>🙏 ကျေးဇူးတင်လွှာ</h3>
      <p>ဤ App ရှိ တရားတော် အသံဖိုင်အားလုံးကို
        <a href="${site}" target="_blank" rel="noopener">ဓမ္မဒေါင်းလုပ် (dhammadownload.com)</a> မှ
        စေတနာဖြင့် အခမဲ့ မျှဝေထားခြင်း ဖြစ်ပါသည်။</p>
      <p>တရားဒါန ပြုတော်မူကြသော ဆရာတော်ဘုရားများ၊ ဆရာကြီးများနှင့်
        ဓမ္မဒေါင်းလုပ် အဖွဲ့ဝင်များ အားလုံးကို ကျေးဇူးအထူး တင်ရှိပါသည်။</p>
    </div>

    <div class="card about-card">
      <h3>📜 ခွင့်ပြုချက်</h3>
      <p class="small muted">ဓမ္မဒေါင်းလုပ် ပင်မစာမျက်နှာတွင် ဖော်ပြထားသော “ကြိုတင်ခွင့်ပြုချက်” –</p>
      <blockquote>ဓမ္မဒေါင်းလုပ် website ကို InternetTraffic နိုင်အောင် 1Gbps Internet Bandwidth, Dedicated Server with SSD
        Hardisk array များဖြင့်, စီစဉ်ထားပါသည်။ ယ္ခု ဓမ္မဒေါင်းလုပ် website မှ တရားတော်များ၏ URL Link များကို
        မိမိတို့၏ ကိုယ်ပိုင် website မှ တိုက်ရိုက် ပြန်လည် Link လုပ်၍ အသုံးပြုလိုပါက ခွင့်ပြူပါကြောင်း အသိပေးအပ်ပါသည်။</blockquote>
      <p class="small"><a href="${site}index.htm" target="_blank" rel="noopener">ပင်မစာမျက်နှာတွင် ကြည့်ရန် ›</a></p>
    </div>

    <div class="card about-card">
      <h3>ℹ App အလုပ်လုပ်ပုံ</h3>
      <ul>
        <li>တရားတော်များကို ဓမ္မဒေါင်းလုပ် ဆာဗာမှ <b>တိုက်ရိုက်</b> ဖွင့်ပါသည်။ အသံဖိုင်များကို ကူးယူ သိမ်းဆည်းထားခြင်း မရှိပါ။</li>
        <li>တရားစာရင်းကို ဓမ္မဒေါင်းလုပ်မှ <b>အပတ်စဉ်</b> အလိုအလျောက် ပြန်လည်စစ်ဆေးပါသည်။</li>
        <li>ကြော်ငြာ မရှိပါ။ အကောင့်ဖွင့်ရန် မလိုပါ။ အခမဲ့ ဖြစ်ပါသည်။</li>
        <li>နာခဲ့သော မှတ်တမ်း၊ နှစ်သက်ရာ နှင့် ဆက်နာရန် နေရာများကို <b>သင့်ဖုန်းထဲတွင်သာ</b> သိမ်းပါသည်။
          ကိုယ်ရေးအချက်အလက် မည်သည့်အရာကိုမျှ စုဆောင်းခြင်း မရှိပါ။</li>
      </ul>
    </div>

    <div class="card about-card about-stats">
      <div><b>${mm(teachersN)}</b><span>ဆရာတော်/ဆရာကြီး</span></div>
      <div><b>${mm(CAT.total)}</b><span>တရားတော်</span></div>
      <div><b>${fmtDate(CAT.generated)}</b><span>စာရင်း နောက်ဆုံးစစ်</span></div>
    </div>

    <div class="card about-card">
      <h3>🤝 ဓမ္မဒေါင်းလုပ်ကို ထောက်ပံ့ရန်</h3>
      <p>ဓမ္မဒေါင်းလုပ်သည် ဆာဗာ၊ အင်တာနက် စရိတ်များကို အလှူရှင်များ၏ စေတနာဖြင့် ရပ်တည်နေပါသည်။</p>
      <p><a class="btn" href="${site}Contribute-to-dhammadownload.htm" target="_blank" rel="noopener">ကူညီလှူဒါန်းရန် ›</a></p>
      <p class="small muted">ဓမ္မဒေါင်းလုပ်၏ ကိုယ်ပိုင် App –
        <a href="https://play.google.com/store/apps/details?id=com.dhammadownload.dhammadownloadandroid" target="_blank" rel="noopener">Android</a> ·
        <a href="https://itunes.apple.com/us/app/dhamma-download/id1148319071" target="_blank" rel="noopener">iPhone</a></p>
    </div>

    <div class="card about-card">
      <h3>✉ ဆက်သွယ်ရန် / အကြံပြုရန်</h3>
      <p>App နှင့် ပတ်သက်၍ အမှားတွေ့ရှိပါက သို့မဟုတ် အကြံပြုလိုပါက အီးမေးလ်ဖြင့် ဆက်သွယ်နိုင်ပါသည်။</p>
      <p><a class="btn" href="mailto:${CONTACT}?subject=${encodeURIComponent("တရားနာယူ App")}">${CONTACT}</a></p>
      <p class="small"><a href="${IN_APP ? SITE : ""}privacy.html" target="_blank" rel="noopener">🔒 ကိုယ်ရေးအချက်အလက် မူဝါဒ (Privacy Policy) ›</a></p>
    </div>

    <p class="credit">ဤ App သည် ဓမ္မဒေါင်းလုပ်၏ တရားဝင် App မဟုတ်ပါ။ ဓမ္မဒေါင်းလုပ်၏ ခွင့်ပြုချက်ဖြင့်
      တရားနာယူသူများ အဆင်ပြေစေရန် စေတနာဖြင့် ပြုလုပ်ထားခြင်း ဖြစ်ပါသည်။<br><br>
      သာဓု သာဓု သာဓု 🙏</p>
  </div>`;
}

const collator = (() => { try { return new Intl.Collator("my"); } catch { return new Intl.Collator(); } })();
let teacherFilter = "", filterSection = "";

function viewSayadaws(section = "sayadaw") {
  const sec = CAT.sections.find(s => s.id === section) || CAT.sections[0];
  if (filterSection !== sec.id) { teacherFilter = ""; filterSection = sec.id; }
  setHeader(sec.name); setTab("sayadaws");
  const cnt = sectionCounts();
  return `<div class="seg">${CAT.sections.filter(s => cnt[s.id]).map(s =>
      `<button data-act="section" data-sec="${s.id}" class="${s.id === sec.id ? "on" : ""}">${esc(s.name.split(" ")[0])}</button>`).join("")}</div>
    ${cnt[sec.id] > 8 ? `<div class="row" style="gap:8px;margin-bottom:10px">
      <input id="tq" class="search-box" type="search" placeholder="အမည်ဖြင့် စစ်ရန်…" value="${esc(teacherFilter)}" autocomplete="off" style="flex:1">
      <button class="chip" data-act="sort">${settings.sort === "abc" ? "က-အ" : "စာရင်းအစဉ်"}</button></div>` : ""}
    <div id="tlist" data-sec="${sec.id}">${teacherCards(sec.id)}</div>`;
}

function teacherCards(section) {
  let list = CAT.teachers.filter(t => t.section === section);
  const q = norm(teacherFilter);
  if (q) list = list.filter(t => norm(t.name).includes(q) || t.id.includes(teacherFilter.toLowerCase()));
  if (settings.sort === "abc") list = [...list].sort((a, b) => collator.compare(a.name, b.name));
  if (!list.length) return `<div class="card empty">ရှာမတွေ့ပါ</div>`;
  return `<div class="card"><ul class="list">${list.map(t => `
    <li><a class="sayadaw-card" href="#/s/${t.id}"><span class="av">☸</span>
      <span style="flex:1;min-width:0"><b>${esc(t.name)}</b><span class="row-meta">တရား ${mm(t.count)} ပုဒ် · အုပ်စု ${mm(t.groups.length)} ခု</span></span>
      <span class="chev">›</span></a></li>`).join("")}</ul></div>`;
}

function viewSayadaw(tid) {
  const t = teachers.get(tid);
  if (!t) return viewNotFound();
  setHeader(t.name, "#/sayadaws/" + t.section); setTab("sayadaws");
  loadTeacher(tid).catch(() => {});   // start fetching talks while the album list is read
  return `<div class="group-head"><h2>${esc(t.name)}</h2>
      <p class="muted">တရား ${mm(t.count)} ပုဒ် · <a href="${esc(t.source)}" target="_blank" rel="noopener">dhammadownload.com တွင်ကြည့်ရန်</a></p></div>
    <div class="card"><ul class="list">${t.groups.map((g, gi) => {
    const done = g.items ? g.items.filter(id => pos[id]?.done).length : 0;
    return `<li><a class="row" href="#/g/${t.id}/${gi}" style="text-decoration:none;color:inherit">
      <span class="row-main"><span class="row-title">📁 ${esc(g.t)}</span>
      ${g.d ? `<span class="row-meta">${esc(cut(g.d, 90))}</span>` : ""}</span>
      <span class="count">${done ? mm(done) + "/" : ""}${mm(g.c || 0)} ပုဒ်</span></a></li>`;
  }).join("")}</ul></div>`;
}

async function viewGroup(tid, gi) {
  const t = teachers.get(tid);
  if (!t || !t.groups[+gi]) return viewNotFound();
  setHeader(t.name, "#/s/" + tid); setTab("sayadaws");
  await loadTeacher(tid);
  const g = t.groups[+gi];
  const ids = g.items || [];
  currentList = ids;
  return `<div class="group-head"><h2>${esc(g.t)}</h2>${g.d ? `<p class="muted">${esc(g.d)}</p>` : ""}
    <button class="btn" data-act="playall">▶ အားလုံးဖွင့်ရန် (${mm(ids.length)} ပုဒ်)</button></div>` + talkList(ids);
}

/* a single talk, opened from a shared link: #/t/<teacher>/<talk> */
async function viewTalk(tid, id) {
  const t = teachers.get(tid);
  if (!t) return viewNotFound();
  setHeader(t.name, "#/s/" + tid); setTab("sayadaws");
  await loadTeacher(tid);
  const e = byId.get(id);
  if (!e || e.s.id !== tid) return viewNotFound();
  const { it, g, gi } = e;
  const ids = g?.items || [id];
  currentList = ids;
  const p = pos[id];
  const resume = p && !p.done && p.t > 5;
  return `<div class="card talk-hero">
      <h2>${esc(it.t)}</h2>
      <p class="muted">${esc(t.name)}</p>
      ${g ? `<p class="muted small"><a href="#/g/${esc(tid)}/${gi}">📁 ${esc(g.t)}</a></p>` : ""}
      ${it.n ? `<p class="small">${esc(it.n)}</p>` : ""}
      ${it.date ? `<p class="muted small">${fmtDate(it.date)}</p>` : ""}
      <div class="talk-actions">
        <button class="btn" data-act="resume" data-id="${id}">▶ ${resume ? "ဆက်နာရန် (" + fmt(p.t) + ")" : "နာယူရန်"}</button>
        <button class="btn ghost" data-act="share" data-id="${id}">🔗 မျှဝေရန်</button>
      </div>
    </div>
    ${ids.length > 1 ? `<div class="section"><h2>ဤ အစုထဲမှ တရားများ (${mm(ids.length)} ပုဒ်)</h2></div>` + talkList(ids) : ""}`;
}

/* share a talk: phone share menu (Viber, Messenger, Telegram…) or copy the link */
function talkLink(id) {
  const e = byId.get(id);
  const base = IN_APP ? SITE : location.origin + location.pathname;   // in the app: https://localhost/…
  return base + "#/t/" + encodeURIComponent(e.s.id) + "/" + id;
}
async function shareTalk(id) {
  const e = byId.get(id); if (!e) return;
  const url = talkLink(id);
  const text = `${e.it.t} — ${e.s.name}`;
  if (Native) {
    try { await Native.share({ title: e.it.t, text: text + "\n" + url }); return; }
    catch { /* fall through to copy */ }
  }
  if (navigator.share) {
    try { await navigator.share({ title: e.it.t, text, url }); return; }
    catch (err) { if (err.name === "AbortError") return; }
  }
  try { await navigator.clipboard.writeText(text + "\n" + url); toast("🔗 လင့်ခ် ကူးယူပြီးပါပြီ။ Viber/Messenger တွင် ကူးထည့်နိုင်ပါသည်"); }
  catch { prompt("ဤလင့်ခ်ကို ကူးယူပါ", url); }
}

function viewNew() {
  setHeader("အသစ်ထည့်ထားသော တရားများ", "#/"); setTab("home");
  return talkList((CAT.new || []).map(n => n.id).filter(id => byId.has(id)), true);
}

let lastQuery = "";
function viewSearch() {
  setHeader("ရှာဖွေရန်"); setTab("search");
  setTimeout(() => {
    const i = $("#q"); if (!i) return;
    i.focus();
    loadSearch().then(() => runSearch(i.value)).catch(() => {
      const r = $("#results"); if (r) r.innerHTML = errorBox();
    });
  }, 0);
  return `<input id="q" class="search-box" type="search" placeholder="တရားအမည်၊ ဆရာတော်အမည် ဖြင့် ရှာရန်…" value="${esc(lastQuery)}" autocomplete="off">
    <div id="results" style="margin-top:12px">${searchIndex ? "" : spinner("ရှာဖွေရန် စာရင်း ဖွင့်နေသည်… (ပထမအကြိမ်သာ)")}</div>`;
}

const HINT = `<p class="empty">ဥပမာ – မေတ္တာ၊ သတိပဋ္ဌာန်၊ ဓမ္မစကြာ၊ မိုးကုတ်</p>`;
function runSearch(q) {
  lastQuery = q;
  const out = $("#results"); if (!out || !searchIndex) return;
  const terms = q.trim().split(/\s+/).map(norm).filter(Boolean);
  if (!terms.length) { out.innerHTML = HINT; return; }
  const hits = [];
  let more = false;
  for (const e of searchIndex) {
    if (terms.every(t => e.key.includes(t))) { if (hits.length >= 200) { more = true; break; } hits.push(e.id); }
  }
  const tHits = CAT.teachers.filter(t => terms.every(x => norm(t.name).includes(x)));
  const gHits = [];
  for (const t of CAT.teachers) t.groups.forEach((g, gi) => {
    if (gHits.length < 30 && terms.every(x => norm(g.t + " " + (g.d || "")).includes(x))) gHits.push({ t, g, gi });
  });
  let h = "";
  if (tHits.length) h += `<div class="section"><h2>🙏 ဆရာတော်/ဆရာကြီး (${mm(tHits.length)})</h2></div><div class="card"><ul class="list">` +
    tHits.slice(0, 10).map(t => `<li><a class="sayadaw-card" href="#/s/${t.id}"><span class="av">☸</span>
      <span style="flex:1;min-width:0"><b>${esc(t.name)}</b><span class="row-meta">တရား ${mm(t.count)} ပုဒ်</span></span><span class="chev">›</span></a></li>`).join("") + `</ul></div>`;
  if (gHits.length) h += `<div class="section"><h2>📁 အုပ်စုများ (${mm(gHits.length)}${gHits.length >= 30 ? "+" : ""})</h2></div><div class="card"><ul class="list">` +
    gHits.slice(0, 15).map(({ t, g, gi }) => `<li><a class="row" href="#/g/${t.id}/${gi}" style="text-decoration:none;color:inherit">
      <span class="row-main"><span class="row-title">📁 ${esc(g.t)}</span><span class="row-meta">${esc(cut(t.name, 50))}</span></span>
      <span class="count">${mm(g.c || 0)} ပုဒ်</span></a></li>`).join("") + `</ul></div>`;
  h += `<div class="section"><h2>🎧 တရားများ (${mm(hits.length)}${more ? "+" : ""})</h2></div>`;
  h += hits.length ? talkList(hits, true) : `<div class="card empty">ရှာမတွေ့ပါ</div>`;
  if (more) h += `<p class="empty small">ရလဒ် များလွန်းပါသည်။ စကားလုံး ထပ်ထည့်၍ ရှာကြည့်ပါ။</p>`;
  out.innerHTML = h;
}

function viewLibrary(tab = "favs") {
  setHeader("ကိုယ်ပိုင်"); setTab("library");
  const tabs = [["favs", "⭐ နှစ်သက်ရာ"], ["recent", "🕘 နာခဲ့သော"], ["settings", "⚙ ဆက်တင်"], ["about", "ⓘ အကြောင်း"]];
  let h = `<div class="seg">${tabs.map(([k, l]) => `<button data-act="libtab" data-tab="${k}" class="${k === tab ? "on" : ""}">${l}</button>`).join("")}</div>`;
  if (tab === "favs") h += talkList(favs, true);
  else if (tab === "recent") h += talkList(recent, true) + (recent.length ? `<p style="text-align:center"><button class="btn ghost" data-act="clearrecent">မှတ်တမ်း ရှင်းရန်</button></p>` : "");
  else {
    const th = [["auto", "ဖုန်းအတိုင်း"], ["light", "☀ အလင်း"], ["dark", "🌙 အမှောင်"]];
    h += `<div class="card" style="padding:14px">
      <p style="margin:0 0 6px"><b>အရောင်</b></p>
      <div class="seg">${th.map(([k, l]) => `<button data-act="theme" data-theme="${k}" class="${settings.theme === k ? "on" : ""}">${l}</button>`).join("")}</div>
      ${IN_APP ? "" : `<p style="margin:12px 0 6px"><b>Home Screen သို့ ထည့်ရန်</b></p>
      <p class="small muted" style="margin:0">Android Chrome – ⋮ menu › “Add to Home screen”<br>iPhone Safari – Share › “Add to Home Screen”</p>`}
      <p style="margin:12px 0 6px"><b>ဒေါင်းလုဒ်</b></p>
      <p class="small muted" style="margin:0">Player ထဲရှိ ⬇ ကိုနှိပ်ပါက MP3 ဖိုင်ကို ဖုန်းထဲသို့ သိမ်းနိုင်ပါသည်။ (အင်တာနက်မရှိချိန် ဖုန်း၏ Music app ဖြင့် နာနိုင်ပါသည်)</p>
    </div>` + credit();
  }
  return h;
}

function viewNotFound() { setHeader("တရားနာယူ", "#/"); return `<div class="card empty">စာမျက်နှာ မတွေ့ပါ</div>`; }

/* ---------- router ---------- */
let routeSeq = 0;
async function route() {
  if (!CAT) return;
  const seq = ++routeSeq;
  const parts = (location.hash.slice(1) || "/").split("/").filter(Boolean).map(decodeURIComponent);
  const [a, b, c] = parts;
  let html;
  try {
    if (!a) html = viewHome();
    else if (a === "sayadaws") html = viewSayadaws(b);
    else if (a === "s") html = viewSayadaw(b);
    else if (a === "g") {
      $("#view").innerHTML = spinner();
      html = await viewGroup(b, c);
    }
    else if (a === "search") html = viewSearch();
    else if (a === "library") html = viewLibrary(b);
    else if (a === "new") html = viewNew();
    else if (a === "t") {
      $("#view").innerHTML = spinner();
      html = await viewTalk(b, c);
    }
    else if (a === "about") html = viewAbout();
    else html = viewNotFound();
  } catch {
    html = errorBox();
  }
  if (seq !== routeSeq) return;        // user already moved on
  $("#view").innerHTML = html;
  window.scrollTo(0, scrollMemo.get(location.hash) || 0);
}
const scrollMemo = new Map();
let lastHash = location.hash;
window.addEventListener("hashchange", () => {
  scrollMemo.set(lastHash, window.scrollY);
  lastHash = location.hash;
  closePlayer(true);
  route();
});

/* re-render the list rows in place (keeps scroll position) */
function refreshRows() {
  document.querySelectorAll("[data-row]").forEach(li => {
    li.outerHTML = talkRow(li.dataset.row, !!li.dataset.wide);
  });
}

/* ---------- player ---------- */
const audio = new Audio();
audio.preload = "metadata";

const player = (() => {
  let queue = [], qi = -1, pendingSeek = 0, lastSave = 0;

  const currentId = () => queue[qi];
  const cur = () => byId.get(currentId());

  function saveQueue() { store.set("queue", { queue, qi }); saveMeta(); }

  function load(i, autoplay = true) {
    if (i < 0 || i >= queue.length) return;
    qi = i;
    const e = cur(); if (!e) return;
    audio.src = audioUrl(e.it);
    audio.defaultPlaybackRate = audio.playbackRate = settings.rate;
    const p = pos[e.it.id];
    pendingSeek = p && !p.done && p.t > 5 ? Math.max(0, p.t - 3) : 0;
    recent = [e.it.id, ...recent.filter(x => x !== e.it.id)].slice(0, 100);
    store.set("recent", recent);
    saveQueue();
    setStatus("");
    renderPlayerInfo();
    setMediaMeta(e);
    refreshRows();
    if (autoplay) play();
  }

  async function play() {
    if (qi < 0) return;
    try {
      $("#pPlay").classList.add("busy");
      await audio.play();
    } catch (err) {
      if (err.name !== "AbortError") setStatus("ဖွင့်၍မရပါ – " + err.message, true);
    } finally { $("#pPlay").classList.remove("busy"); }
  }

  function start(ids, i) { queue = ids.filter(id => byId.has(id)); load(queue.indexOf(ids[i]), true); }

  function savePosition(force) {
    const id = currentId(); if (!id || !audio.duration) return;
    const now = Date.now();
    if (!force && now - lastSave < 5000) return;
    lastSave = now;
    const d = audio.duration, t = audio.currentTime;
    const prev = pos[id] || {};
    pos[id] = { t, d, at: now, done: prev.done || (d > 60 && t > d - 30) };
    savePos();
  }

  function next(auto = false) {
    if (qi + 1 < queue.length) load(qi + 1, true);
    else if (!auto) toast("နောက်ထပ်တရား မရှိတော့ပါ");
  }
  function prev() {
    if (audio.currentTime > 5 || qi === 0) audio.currentTime = 0;
    else load(qi - 1, true);
  }

  audio.addEventListener("loadedmetadata", () => {
    if (pendingSeek && pendingSeek < audio.duration - 5) audio.currentTime = pendingSeek;
    pendingSeek = 0;
    audio.playbackRate = settings.rate;
    renderTime(); updatePositionState();
  });
  audio.addEventListener("timeupdate", () => { renderTime(); savePosition(false); });
  audio.addEventListener("play", () => { renderPlayState(); setStatus(""); });
  audio.addEventListener("pause", () => { renderPlayState(); savePosition(true); });
  audio.addEventListener("waiting", () => setStatus("ခဏစောင့်ပါ… (Buffering)"));
  audio.addEventListener("playing", () => setStatus(""));
  audio.addEventListener("seeked", updatePositionState);
  audio.addEventListener("ratechange", updatePositionState);
  audio.addEventListener("ended", () => {
    const id = currentId();
    if (id) { pos[id] = { t: 0, d: audio.duration, at: Date.now(), done: true }; savePos(); }
    refreshRows();
    if (sleep.mode === "end") { setSleep("off"); toast("😴 အိပ်ချိန်မှတ် – ရပ်လိုက်ပါပြီ"); renderPlayState(); return; }
    next(true);
  });
  audio.addEventListener("error", () => {
    if (!audio.src || qi < 0) return;
    const codes = { 1: "ရပ်တန့်သွားသည်", 2: "အင်တာနက် ပြဿနာ", 3: "ဖိုင်ဖတ်၍မရပါ", 4: "ဖိုင်ကို ရှာမတွေ့ပါ / ဖွင့်၍မရပါ" };
    setStatus("⚠ " + (codes[audio.error?.code] || "အမှား") + " – ခဏနေ ပြန်စမ်းကြည့်ပါ", true);
    renderPlayState();
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) savePosition(true); });
  window.addEventListener("pagehide", () => savePosition(true));

  // restore last session (paused)
  function restore() {
    const saved = store.get("queue", null);
    if (saved && Array.isArray(saved.queue)) {
      const curId = saved.queue[saved.qi];
      queue = saved.queue.filter(id => byId.has(id));
      const i = queue.indexOf(curId);
      if (i >= 0) load(i, false);
    }
  }

  return { load, play, start, next, prev, restore, currentId, cur, get queue() { return queue; }, get qi() { return qi; } };
})();

function setStatus(msg, err = false) {
  const s = $("#pStatus"); s.textContent = msg; s.classList.toggle("err", err);
  if (err) toast(msg, 4000);
}

function renderPlayerInfo() {
  const e = player.cur();
  $("#mini").hidden = !e;
  document.body.classList.toggle("has-mini", !!e);
  if (!e) return;
  const { it, s, g } = e;
  $("#miniTitle").textContent = it.t;
  $("#miniSub").textContent = s.name;
  $("#pTitle").textContent = it.t;
  $("#pSub").textContent = s.name;
  $("#pGroup").textContent = [g?.t, it.n].filter(Boolean).join(" · ");
  $("#dlLink").href = audioUrl(it);
  $("#pFav").textContent = favs.includes(it.id) ? "★" : "☆";
  $("#pFav").classList.toggle("on", favs.includes(it.id));
  $("#pRate").textContent = mm(settings.rate) + "×";
  renderPlayState(); renderTime(); renderQueue();
}

function renderPlayState() {
  const playing = !audio.paused;
  $("#pPlay").textContent = $("#miniPlay").textContent = playing ? "⏸︎" : "▶︎";   // U+FE0E after the symbol: plain text glyph, not the iOS emoji
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = playing ? "playing" : "paused";
}

let seeking = false;
function renderTime() {
  const d = audio.duration, t = audio.currentTime;
  const known = isFinite(d) && d > 0;
  const fallbackD = pos[player.currentId()]?.d;
  $("#pCur").textContent = fmt(t);
  $("#pDur").textContent = fmt(known ? d : fallbackD);
  if (!seeking) $("#pSeek").value = known ? Math.round(t / d * 1000) : 0;
  $("#miniProg").style.width = known ? (t / d * 100) + "%" : "0";
  if (sleep.mode && sleep.mode !== "end") $("#pSleepTxt").textContent = fmt((sleep.until - Date.now()) / 1000);
}

function renderQueue() {
  const box = $("#pQueue");
  if (box.hidden) return;
  const ids = player.queue;
  const start = Math.max(0, player.qi - 2);
  const shown = ids.slice(start, start + 60);
  box.innerHTML = `<div class="section"><h2>☰ နောက်ထပ် (${mm(player.qi + 1)}/${mm(ids.length)})</h2></div>
    <div class="card"><ul class="list">${shown.map(id => talkRow(id)).join("")}</ul></div>`;
  box.querySelectorAll("[data-act=play]").forEach(b => (b.dataset.act = "qplay"));
}

let playerPushed = false;
function openPlayer() {
  if (!player.cur()) return;
  $("#player").hidden = false;
  renderPlayerInfo();
  history.pushState({ player: true }, "", location.hash || "#/");
  playerPushed = true;
}
function closePlayer(fromNav) {
  if ($("#player").hidden) return;
  $("#player").hidden = true;
  if (!fromNav && playerPushed) { playerPushed = false; history.back(); }
  playerPushed = false;
}
window.addEventListener("popstate", () => { if (!$("#player").hidden) { playerPushed = false; $("#player").hidden = true; } });

/* ---------- sleep timer ---------- */
const sleep = { mode: null, until: 0, timer: null };
function setSleep(v) {
  clearTimeout(sleep.timer);
  sleep.mode = null;
  $("#pSleep").classList.remove("on");
  $("#pSleepTxt").textContent = "အိပ်ချိန်";
  if (v === "off") return;
  sleep.mode = v;
  $("#pSleep").classList.add("on");
  if (v === "end") { $("#pSleepTxt").textContent = "တရားဆုံးလျှင်"; toast("😴 ဤတရား ဆုံးလျှင် ရပ်ပါမည်"); return; }
  const ms = +v * 60000;
  sleep.until = Date.now() + ms;
  sleep.timer = setTimeout(fadeOutAndStop, ms);
  toast("😴 " + mm(v) + " မိနစ်အကြာတွင် ရပ်ပါမည်");
  renderTime();
}
function fadeOutAndStop() {
  const v0 = audio.volume; let k = 0;
  const iv = setInterval(() => {
    k++; audio.volume = Math.max(0, v0 * (1 - k / 20));
    if (k >= 20) { clearInterval(iv); audio.pause(); audio.volume = v0; setSleep("off"); }
  }, 500);
}

/* ---------- media session (lock screen / notification controls) ---------- */
function setMediaMeta(e) {
  if (!("mediaSession" in navigator)) return;
  const base = new URL("icons/", location.href).href;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: e.it.t, artist: e.s.name, album: e.g?.t || "",
    artwork: [{ src: base + "icon-192.png", sizes: "192x192", type: "image/png" },
              { src: base + "icon-512.png", sizes: "512x512", type: "image/png" }],
  });
}
function updatePositionState() {
  if (!("mediaSession" in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!isFinite(audio.duration)) return;
  try { navigator.mediaSession.setPositionState({ duration: audio.duration, playbackRate: audio.playbackRate, position: Math.min(audio.currentTime, audio.duration) }); } catch { /* ignore */ }
}
if ("mediaSession" in navigator) {
  const ms = navigator.mediaSession;
  const set = (a, f) => { try { ms.setActionHandler(a, f); } catch { /* unsupported */ } };
  set("play", () => player.play());
  set("pause", () => audio.pause());
  set("previoustrack", () => player.prev());
  set("nexttrack", () => player.next());
  set("seekbackward", d => (audio.currentTime = Math.max(0, audio.currentTime - (d.seekOffset || 15))));
  set("seekforward", d => (audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (d.seekOffset || 15))));
  set("seekto", d => { audio.currentTime = d.seekTime; });
}

/* ---------- Android app: background playback + notification, Back button ----------
   The audio plays in the WebView; the native PlaybackService keeps the app alive with the
   screen off and shows the lock-screen / notification controls. */
let bgStopped = false;
function bgUpdate(playing) {
  const e = player.cur();
  if (!Native || !e) return;
  if (playing) bgStopped = false;
  else if (bgStopped) return;            // closed with ✕ — don't bring the notification back on "pause"
  Native.update({ title: e.it.t, artist: e.s.name, playing, artUrl: SITE + "icons/icon-512.png" }).catch(() => {});
}
if (Native) {
  audio.addEventListener("playing", () => bgUpdate(true));
  audio.addEventListener("pause", () => bgUpdate(false));
  Native.addListener("control", ({ action }) => {
    if (action === "play") player.play();
    if (action === "pause") audio.pause();
    if (action === "next") player.next();
    if (action === "prev") player.prev();
    if (action === "stop") { bgStopped = true; audio.pause(); Native.stop(); }
  });
}
const CapApp = IN_APP ? window.Capacitor.Plugins?.App : null;
if (CapApp) {
  document.body.classList.add("in-app");
  // Back: close sheet/player, else previous page; on the home page go to the background
  // (instead of closing the app) so a talk keeps playing.
  CapApp.addListener("backButton", () => {
    if (!$("#sleepSheet").hidden) { $("#sleepSheet").hidden = true; return; }
    if (!$("#player").hidden) { closePlayer(false); return; }
    const h = location.hash;
    if (!h || h === "#/" || h === "#") CapApp.minimizeApp();
    else if (history.length > 1) history.back();
    else location.hash = "#/";
  });
}

/* ---------- events ---------- */
function toggleFav(id) {
  favs = favs.includes(id) ? favs.filter(x => x !== id) : [id, ...favs];
  store.set("favs", favs);
  saveMeta();
  toast(favs.includes(id) ? "⭐ နှစ်သက်ရာသို့ ထည့်ပြီး" : "နှစ်သက်ရာမှ ဖယ်ပြီး");
}

document.addEventListener("click", ev => {
  const el = ev.target.closest("[data-act], [data-sleep]");
  if (!el) return;
  if (el.dataset.sleep) { setSleep(el.dataset.sleep); $("#sleepSheet").hidden = true; return; }
  const id = el.dataset.id;
  switch (el.dataset.act) {
    case "play": {
      if (player.currentId() === id) { audio.paused ? player.play() : audio.pause(); openPlayer(); break; }
      // queue = the list the tapped row belongs to
      const ul = el.closest("ul.list");
      const list = ul ? [...ul.querySelectorAll("[data-row]")].map(li => li.dataset.row) : [id];
      player.start(list, list.indexOf(id));
      break;
    }
    case "qplay": player.load(player.queue.indexOf(id), true); renderQueue(); break;
    case "resume": {
      const e = byId.get(id); if (!e) break;
      if (player.currentId() === id) { player.play(); openPlayer(); break; }
      loadTeacher(e.s.id).then(t => {
        const ids = t.groups[e.gi]?.items || [id];
        player.start(ids, Math.max(0, ids.indexOf(id)));
      }).catch(() => player.start([id], 0)).finally(openPlayer);
      break;
    }
    case "playall": {
      const firstOpen = currentList.find(x => !pos[x]?.done) || currentList[0];
      player.start(currentList, currentList.indexOf(firstOpen));
      openPlayer();
      break;
    }
    case "fav": toggleFav(id); refreshRows(); renderPlayerInfo(); break;
    case "share": shareTalk(id); break;
    case "libtab": location.hash = el.dataset.tab === "about" ? "#/about" : "#/library/" + el.dataset.tab; break;
    case "section": teacherFilter = ""; location.hash = "#/sayadaws/" + el.dataset.sec; break;
    case "sort":
      settings.sort = settings.sort === "abc" ? "site" : "abc"; saveSettings();
      el.textContent = settings.sort === "abc" ? "က-အ" : "စာရင်းအစဉ်";
      $("#tlist").innerHTML = teacherCards($("#tlist").dataset.sec);
      break;
    case "theme": settings.theme = el.dataset.theme; saveSettings(); applyTheme(); route(); break;
    case "retry": location.reload(); break;
    case "clearrecent":
      if (confirm("နာခဲ့သော မှတ်တမ်းကို ရှင်းမလား?")) { recent = []; store.set("recent", recent); saveMeta(); route(); }
      break;
  }
});

$("#view").addEventListener("input", ev => {
  if (ev.target.id === "q") {
    clearTimeout(runSearch.t);
    runSearch.t = setTimeout(() => runSearch(ev.target.value), 200);
  } else if (ev.target.id === "tq") {
    teacherFilter = ev.target.value;
    $("#tlist").innerHTML = teacherCards($("#tlist").dataset.sec);
  }
});

$("#backBtn").onclick = () => { location.hash = $("#backBtn").dataset.to || "#/"; };
$("#miniOpen").onclick = openPlayer;
$("#miniPlay").onclick = () => (audio.paused ? player.play() : audio.pause());
$("#miniNext").onclick = () => player.next();
$("#playerClose").onclick = () => closePlayer(false);
$("#pPlay").onclick = () => (audio.paused ? player.play() : audio.pause());
$("#pPrev").onclick = () => player.prev();
$("#pNext").onclick = () => player.next();
$("#pBack").onclick = () => (audio.currentTime = Math.max(0, audio.currentTime - 15));
$("#pFwd").onclick = () => (audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 15));
$("#pRate").onclick = () => {
  settings.rate = RATES[(RATES.indexOf(settings.rate) + 1) % RATES.length] || 1;
  audio.playbackRate = audio.defaultPlaybackRate = settings.rate;
  saveSettings(); $("#pRate").textContent = mm(settings.rate) + "×";
};
$("#pSleep").onclick = () => ($("#sleepSheet").hidden = false);
$("#sleepSheet").onclick = ev => { if (ev.target.id === "sleepSheet") ev.target.hidden = true; };
$("#pFav").onclick = () => { const id = player.currentId(); if (id) { toggleFav(id); renderPlayerInfo(); refreshRows(); } };
$("#pShare").onclick = () => { const id = player.currentId(); if (id) shareTalk(id); };
// ⬇ in the app: a WebView can't follow <a download>, so Android's download manager saves it;
// on iOS the plugin downloads it, then the share sheet offers "Save to Files"
let dlBusy = false;
$("#dlLink").addEventListener("click", ev => {
  const e = player.cur();
  if (!Native || !e) return;
  ev.preventDefault();
  if (dlBusy) { toast("⬇ ဒေါင်းလုဒ် လုပ်နေဆဲ ဖြစ်ပါသည်…"); return; }
  const url = audioUrl(e.it);
  const filename = decodeURIComponent(url.split("/").pop());
  if (IOS) {
    dlBusy = true;
    toast("⬇ ဒေါင်းလုဒ် လုပ်နေပါသည်… ပြီးလျှင် “Save to Files” ဖြင့် သိမ်းပါ", 6000);
    Native.download({ url, title: e.it.t, filename })
      .catch(() => toast("⚠ ဒေါင်းလုဒ် မအောင်မြင်ပါ။ အင်တာနက်ကို စစ်ပြီး ထပ်ကြိုးစားပါ", 4000))
      .finally(() => (dlBusy = false));
    return;
  }
  Native.download({ url, title: e.it.t, filename })
    .then(() => toast("⬇ ဒေါင်းလုဒ် စတင်ပါပြီ – Download/Dhamma ဖိုဒါတွင် သိမ်းပါမည်", 3500))
    .catch(() => window.open(url, "_system"));
});
$("#pQueueBtn").onclick = () => { const q = $("#pQueue"); q.hidden = !q.hidden; renderQueue(); };
const seekEl = $("#pSeek");
seekEl.addEventListener("input", () => {
  seeking = true;
  if (isFinite(audio.duration)) $("#pCur").textContent = fmt(seekEl.value / 1000 * audio.duration);
});
seekEl.addEventListener("change", () => {
  if (isFinite(audio.duration)) audio.currentTime = seekEl.value / 1000 * audio.duration;
  seeking = false;
});

document.addEventListener("keydown", e => {
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || !player.cur()) return;
  if (e.code === "Space") { e.preventDefault(); audio.paused ? player.play() : audio.pause(); }
  else if (e.code === "ArrowLeft") audio.currentTime = Math.max(0, audio.currentTime - 15);
  else if (e.code === "ArrowRight") audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 15);
  else if (e.code === "Escape") { closePlayer(false); $("#sleepSheet").hidden = true; }
});

/* ---------- start ---------- */
(async () => {
  try {
    await loadCatalog();
  } catch (err) {
    $("#view").innerHTML = errorBox();
    return;
  }
  // carry over history from the first version (single catalog.json)
  migrateV1();
  player.restore();
  route();
  // no service worker in the app: files are already on the phone, and it could serve stale ones
  if (!IN_APP && "serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();

/* v1 kept no "meta"; load the 3 original teachers once so old history/favourites still show */
function migrateV1() {
  if (store.get("v", 1) >= 2) return;
  const ids = new Set([...store.get("recent", []), ...store.get("favs", []), ...(store.get("queue", {})?.queue || [])]);
  store.set("v", 2);
  if (![...ids].some(id => !byId.has(id))) return;
  Promise.all(["nandamala", "mahasi", "saddhammaramsi"].map(t => loadTeacher(t).catch(() => {})))
    .then(() => {
      favs = store.get("favs", []).filter(id => byId.has(id));
      recent = store.get("recent", []).filter(id => byId.has(id));
      saveMeta(); player.restore(); route();
    });
}
