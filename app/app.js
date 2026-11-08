/* တရားနာယူ — listen to dhammadownload.com talks online.
   Audio streams directly from dhammadownload.com (linking permitted on their main page). */
"use strict";

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const MMD = "၀၁၂၃၄၅၆၇၈၉";
const mm = x => String(x).replace(/\d/g, d => MMD[d]);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = s => {
  if (!isFinite(s) || s < 0) return "--:--";
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  return mm((h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(sec).padStart(2, "0"));
};
const fmtDate = d => d ? mm(d.split("-").reverse().join("-")) : "";

const store = {
  get(k, def) { try { const v = localStorage.getItem("tny." + k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem("tny." + k, JSON.stringify(v)); } catch { /* private mode etc. */ } },
};

let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), ms);
}

/* ---------- state ---------- */
let CAT = null;                              // catalog.json
const byId = new Map();                      // id -> {it, s, g, gi}
let searchIndex = [];                        // [{id, key}]
let pos = store.get("pos", {});              // id -> {t, d, at, done}
let favs = store.get("favs", []);            // ids, newest first
let recent = store.get("recent", []);        // ids, newest first
const settings = Object.assign({ rate: 1, theme: "auto" }, store.get("settings", {}));
let currentList = [];                        // ids shown in the current view (for "play from here")

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
const savePos = () => store.set("pos", pos);
const saveSettings = () => store.set("settings", settings);

function applyTheme() {
  if (settings.theme === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = settings.theme;
}
applyTheme();

/* Myanmar search normalisation: ignore spaces/punctuation, common spelling variants */
const norm = s => String(s).toLowerCase().normalize("NFC")
  .replace(/[\s​-‍\-_.,()[\]"'၊။:]/g, "")
  .replace(/သြ/g, "ဩ").replace(/၀/g, "ဝ").replace(/၇/g, "ရ");

/* ---------- catalog ---------- */
async function loadCatalog() {
  const r = await fetch("catalog.json", { cache: "no-cache" });
  if (!r.ok) throw new Error("catalog " + r.status);
  CAT = await r.json();
  for (const s of CAT.sayadaws) {
    s.count = 0;
    s.groups.forEach((g, gi) => {
      for (const it of g.items) {
        byId.set(it.id, { it, s, g, gi });
        searchIndex.push({ id: it.id, key: norm([it.t, it.n, g.t, s.name, it.date].join(" ")) });
      }
      s.count += g.items.length;
    });
  }
  // forget ids that no longer exist in the catalog
  favs = favs.filter(id => byId.has(id));
  recent = recent.filter(id => byId.has(id));
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
  const meta = [];
  if (it.n) meta.push(esc(it.n));
  if (showSayadaw) meta.push(esc(s.name) + " · " + esc(g.t.length > 40 ? g.t.slice(0, 40) + "…" : g.t));
  else if (it.date && !it.t.includes(mm(it.date.slice(0, 4)))) meta.push(fmtDate(it.date));
  const pp = pos[id];
  if (pp && !pp.done && pp.t > 5) meta.push("⏵ " + fmt(pp.t) + (pp.d ? " / " + fmt(pp.d) : ""));
  const playing = player.currentId() === id;
  return `<li class="row${playing ? " playing" : ""}${p?.done ? " done" : ""}" data-row="${id}">
    <button class="row-main" data-act="play" data-id="${id}">
      <span class="row-title">${playing ? "🔊 " : ""}${esc(it.t)}</span>
      ${meta.length ? `<span class="row-meta">${meta.join(" · ")}</span>` : ""}
      ${p && !p.done ? `<span class="bar"><i style="width:${p.pct.toFixed(1)}%"></i></span>` : ""}
    </button>
    <button class="icon-btn fav${favs.includes(id) ? " on" : ""}" data-act="fav" data-id="${id}" aria-label="နှစ်သက်ရာ">${favs.includes(id) ? "★" : "☆"}</button>
  </li>`;
}

function talkList(ids, showSayadaw = false) {
  currentList = ids.slice();
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

/* ---------- views ---------- */
function viewHome() {
  setHeader("တရားနာယူ"); setTab("home");
  const cont = recent.find(id => pos[id] && !pos[id].done && pos[id].t > 5);
  let h = "";
  if (cont) {
    const { it, s } = byId.get(cont);
    const p = pos[cont];
    h += `<div class="section"><h2>▶ ဆက်နာရန်</h2></div>
      <div class="card"><button class="continue" data-act="resume" data-id="${cont}">
        <span class="play-btn">▶</span>
        <span class="txt"><span class="row-title">${esc(it.t)}</span>
        <span class="row-meta">${esc(s.name)} · ${fmt(p.t)}${p.d ? " / " + fmt(p.d) : ""}</span>
        ${p.d ? `<span class="bar"><i style="width:${(p.t / p.d * 100).toFixed(1)}%"></i></span>` : ""}</span>
      </button></div>`;
  }
  const newIds = (CAT.new || []).map(n => n.id).filter(id => byId.has(id)).slice(0, 5);
  if (newIds.length) h += `<div class="section"><h2>🆕 အသစ်ထည့်ထားသော တရားများ</h2><a href="#/new">အားလုံး ›</a></div>` + talkList(newIds, true);
  if (recent.length) h += `<div class="section"><h2>🕘 မကြာမီက နာခဲ့သော</h2><a href="#/library/recent">အားလုံး ›</a></div>` + talkList(recent.slice(0, 5), true);
  if (favs.length) h += `<div class="section"><h2>⭐ နှစ်သက်ရာ</h2><a href="#/library/favs">အားလုံး ›</a></div>` + talkList(favs.slice(0, 5), true);
  h += `<div class="section"><h2>🙏 ဆရာတော်များ</h2></div>` + sayadawCards();
  h += credit();
  return h;
}

function sayadawCards() {
  return `<div class="card"><ul class="list">${CAT.sayadaws.map(s => `
    <li><a class="sayadaw-card" href="#/s/${s.id}"><span class="av">☸</span>
      <span style="flex:1"><b>${esc(s.name)}</b><span class="row-meta">တရား ${mm(s.count)} ပုဒ် · အုပ်စု ${mm(s.groups.length)} ခု</span></span>
      <span class="chev">›</span></a></li>`).join("")}</ul></div>`;
}

function credit() {
  return `<p class="credit">အသံဖိုင်များကို <a href="${esc(CAT.source)}" target="_blank" rel="noopener">dhammadownload.com</a> မှ
    ခွင့်ပြုချက်ဖြင့် တိုက်ရိုက်ဖွင့်ပါသည်။<br>တရားစာရင်း ${fmtDate(CAT.generated)} ထိ</p>`;
}

function viewSayadaws() {
  setHeader("ဆရာတော်များ"); setTab("sayadaws");
  return sayadawCards();
}

function viewSayadaw(sid) {
  const s = CAT.sayadaws.find(x => x.id === sid);
  if (!s) return viewNotFound();
  setHeader(s.name, "#/sayadaws"); setTab("sayadaws");
  return `<div class="card"><ul class="list">${s.groups.map((g, gi) => {
    const done = g.items.filter(it => pos[it.id]?.done).length;
    return `<li><a class="row" href="#/g/${s.id}/${gi}" style="text-decoration:none;color:inherit">
      <span class="row-main"><span class="row-title">📁 ${esc(g.t)}</span>
      ${g.d ? `<span class="row-meta">${esc(g.d.length > 90 ? g.d.slice(0, 90) + "…" : g.d)}</span>` : ""}</span>
      <span class="count">${done ? mm(done) + "/" : ""}${mm(g.items.length)} ပုဒ်</span></a></li>`;
  }).join("")}</ul></div>`;
}

function viewGroup(sid, gi) {
  const s = CAT.sayadaws.find(x => x.id === sid);
  const g = s?.groups[+gi];
  if (!g) return viewNotFound();
  setHeader(s.name, "#/s/" + sid); setTab("sayadaws");
  const ids = g.items.map(it => it.id);
  return `<div class="group-head"><h2>${esc(g.t)}</h2>${g.d ? `<p class="muted">${esc(g.d)}</p>` : ""}
    <button class="btn" data-act="playall">▶ အားလုံးဖွင့်ရန် (${mm(ids.length)} ပုဒ်)</button></div>` + talkList(ids);
}

function viewNew() {
  setHeader("အသစ်ထည့်ထားသော တရားများ", "#/"); setTab("home");
  return talkList((CAT.new || []).map(n => n.id).filter(id => byId.has(id)), true);
}

let lastQuery = "";
function viewSearch() {
  setHeader("ရှာဖွေရန်"); setTab("search");
  currentList = [];
  setTimeout(() => { const i = $("#q"); if (i) { i.focus(); if (lastQuery) runSearch(lastQuery); } }, 0);
  return `<input id="q" class="search-box" type="search" placeholder="တရားအမည်၊ ဆရာတော်အမည် ဖြင့် ရှာရန်…" value="${esc(lastQuery)}" autocomplete="off">
    <div id="results" style="margin-top:12px"><p class="empty">ဥပမာ – မေတ္တာ၊ သတိပဋ္ဌာန်၊ ဓမ္မစကြာ</p></div>`;
}

function runSearch(q) {
  lastQuery = q;
  const out = $("#results"); if (!out) return;
  const terms = q.trim().split(/\s+/).map(norm).filter(Boolean);
  if (!terms.length) { out.innerHTML = `<p class="empty">ဥပမာ – မေတ္တာ၊ သတိပဋ္ဌာန်၊ ဓမ္မစကြာ</p>`; currentList = []; return; }
  const hits = [];
  for (const e of searchIndex) {
    if (terms.every(t => e.key.includes(t))) { hits.push(e.id); if (hits.length >= 200) break; }
  }
  const groups = [];
  for (const s of CAT.sayadaws) s.groups.forEach((g, gi) => {
    const k = norm(g.t + " " + (g.d || ""));
    if (terms.every(t => k.includes(t))) groups.push({ s, g, gi });
  });
  let h = "";
  if (groups.length) h += `<div class="section"><h2>📁 အုပ်စုများ (${mm(groups.length)})</h2></div><div class="card"><ul class="list">` +
    groups.slice(0, 20).map(({ s, g, gi }) => `<li><a class="row" href="#/g/${s.id}/${gi}" style="text-decoration:none;color:inherit">
      <span class="row-main"><span class="row-title">📁 ${esc(g.t)}</span><span class="row-meta">${esc(s.name)}</span></span>
      <span class="count">${mm(g.items.length)} ပုဒ်</span></a></li>`).join("") + `</ul></div>`;
  h += `<div class="section"><h2>🎧 တရားများ (${mm(hits.length)}${hits.length >= 200 ? "+" : ""})</h2></div>`;
  h += hits.length ? talkList(hits, true) : `<div class="card empty">ရှာမတွေ့ပါ</div>`;
  out.innerHTML = h;
  if (!hits.length) currentList = [];
}

function viewLibrary(tab = "favs") {
  setHeader("ကိုယ်ပိုင်"); setTab("library");
  const tabs = [["favs", "⭐ နှစ်သက်ရာ"], ["recent", "🕘 နာခဲ့သော"], ["settings", "⚙ ဆက်တင်"]];
  let h = `<div class="seg">${tabs.map(([k, l]) => `<button data-act="libtab" data-tab="${k}" class="${k === tab ? "on" : ""}">${l}</button>`).join("")}</div>`;
  if (tab === "favs") h += talkList(favs, true);
  else if (tab === "recent") h += talkList(recent, true) + (recent.length ? `<p style="text-align:center"><button class="btn ghost" data-act="clearrecent">မှတ်တမ်း ရှင်းရန်</button></p>` : "");
  else {
    currentList = [];
    const th = [["auto", "ဖုန်းအတိုင်း"], ["light", "☀ အလင်း"], ["dark", "🌙 အမှောင်"]];
    h += `<div class="card" style="padding:14px">
      <p style="margin:0 0 6px"><b>အရောင်</b></p>
      <div class="seg">${th.map(([k, l]) => `<button data-act="theme" data-theme="${k}" class="${settings.theme === k ? "on" : ""}">${l}</button>`).join("")}</div>
      <p style="margin:12px 0 6px"><b>Home Screen သို့ ထည့်ရန်</b></p>
      <p class="small muted" style="margin:0">Android Chrome – ⋮ menu › “Add to Home screen”<br>iPhone Safari – Share › “Add to Home Screen”</p>
      <p style="margin:12px 0 6px"><b>ဒေါင်းလုဒ်</b></p>
      <p class="small muted" style="margin:0">Player ထဲရှိ ⬇ ကိုနှိပ်ပါက MP3 ဖိုင်ကို ဖုန်းထဲသို့ သိမ်းနိုင်ပါသည်။ (အင်တာနက်မရှိချိန် ဖုန်း၏ Music app ဖြင့် နာနိုင်ပါသည်)</p>
    </div>` + credit();
  }
  return h;
}

function viewNotFound() { setHeader("တရားနာယူ", "#/"); return `<div class="card empty">စာမျက်နှာ မတွေ့ပါ</div>`; }

/* ---------- router ---------- */
function route() {
  if (!CAT) return;
  const parts = (location.hash.slice(1) || "/").split("/").filter(Boolean).map(decodeURIComponent);
  const [a, b, c] = parts;
  let html;
  if (!a) html = viewHome();
  else if (a === "sayadaws") html = viewSayadaws();
  else if (a === "s") html = viewSayadaw(b);
  else if (a === "g") html = viewGroup(b, c);
  else if (a === "search") html = viewSearch();
  else if (a === "library") html = viewLibrary(b);
  else if (a === "new") html = viewNew();
  else html = viewNotFound();
  $("#view").innerHTML = html;
  const y = scrollMemo.get(location.hash);
  window.scrollTo(0, y || 0);
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
    const showS = !!li.querySelector(".row-meta")?.textContent.includes(byId.get(li.dataset.row)?.s.name);
    li.outerHTML = talkRow(li.dataset.row, showS);
  });
}

/* ---------- player ---------- */
const audio = new Audio();
audio.preload = "metadata";

const player = (() => {
  let queue = [], qi = -1, pendingSeek = 0, lastSave = 0;
  const saved = store.get("queue", null);

  const currentId = () => queue[qi];
  const cur = () => byId.get(currentId());

  function saveQueue() { store.set("queue", { queue, qi }); }

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

  function start(ids, i) {
    queue = ids.slice(); load(i, true);
  }

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
    if (saved && Array.isArray(saved.queue)) {
      queue = saved.queue.filter(id => byId.has(id));
      const i = queue.indexOf(saved.queue[saved.qi]);
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
  $("#pGroup").textContent = [g.t, it.n].filter(Boolean).join(" · ");
  $("#dlLink").href = audioUrl(it);
  $("#pFav").textContent = favs.includes(it.id) ? "★" : "☆";
  $("#pFav").classList.toggle("on", favs.includes(it.id));
  $("#pRate").textContent = mm(settings.rate) + "×";
  renderPlayState(); renderTime(); renderQueue();
}

function renderPlayState() {
  const playing = !audio.paused;
  $("#pPlay").textContent = $("#miniPlay").textContent = playing ? "⏸" : "▶";
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

function openPlayer() {
  if (!player.cur()) return;
  $("#player").hidden = false;
  renderPlayerInfo();
  if (location.hash !== "#player-open") history.pushState({ player: true }, "", location.hash || "#/");
  playerPushed = true;
}
let playerPushed = false;
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
    title: e.it.t, artist: e.s.name, album: e.g.t,
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

/* ---------- events ---------- */
function toggleFav(id) {
  favs = favs.includes(id) ? favs.filter(x => x !== id) : [id, ...favs];
  store.set("favs", favs);
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
      const e = byId.get(id);
      const ids = e.g.items.map(it => it.id);
      if (player.currentId() === id) player.play();
      else player.start(ids, ids.indexOf(id));
      openPlayer();
      break;
    }
    case "playall": {
      const firstOpen = currentList.find(x => !pos[x]?.done) || currentList[0];
      player.start(currentList, currentList.indexOf(firstOpen));
      openPlayer();
      break;
    }
    case "fav": toggleFav(id); refreshRows(); renderPlayerInfo(); break;
    case "libtab": location.hash = "#/library/" + el.dataset.tab; break;
    case "theme": settings.theme = el.dataset.theme; saveSettings(); applyTheme(); route(); break;
    case "clearrecent":
      if (confirm("နာခဲ့သော မှတ်တမ်းကို ရှင်းမလား?")) { recent = []; store.set("recent", recent); route(); }
      break;
  }
});

$("#view").addEventListener("input", ev => {
  if (ev.target.id !== "q") return;
  clearTimeout(runSearch.t);
  runSearch.t = setTimeout(() => runSearch(ev.target.value), 150);
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
    $("#view").innerHTML = `<div class="card empty">တရားစာရင်း ဖွင့်၍မရပါ။ အင်တာနက် စစ်ပြီး ပြန်ဖွင့်ကြည့်ပါ။<br><small>${esc(err.message)}</small></div>`;
    return;
  }
  player.restore();
  route();
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
