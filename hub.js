/* The teacher hub, online.
 *
 * Two views of the same thirty-one classes. Anybody gets the blurb, the floor,
 * the header facts, the subject names and the handout. A teacher signed in with
 * their notice board code also gets the timings, the cut list, the room notes,
 * the day-of steps, the teacher-only answers, and the sheets that stay on the
 * teacher's side of the screen.
 *
 * The split is enforced here, where the response is built. A page that fetched
 * everything and hid half of it with CSS would be a page that hands A13's
 * answers to anybody who opens the network tab, and two of the practicums in
 * this program stop working the moment that happens.
 *
 * Sign-in is the notice board's, unchanged: the same codes, the same tokens,
 * the same thirty day expiry, resolved by asking the Board durable object who
 * a token belongs to. There is no second password list to keep in step.
 *
 * Files live in R2. Uploads are keyed up/<class>/<id>-<name>; the printed pack
 * is keyed pack/<name>. R2 holds the metadata on the object itself rather than
 * in a table somewhere else, so a file and what is known about it cannot drift
 * apart.
 */
import { HUB } from "./hubdata.js";

const MAX_UPLOAD = 25 * 1024 * 1024;     // per file
const MAX_NAME = 120;

/* ------------------------------------------------------------ helpers */

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// A filename we are willing to put in a URL and hand back later.
function safeName(v) {
  const s = String(v || "").replace(/[\\/]+/g, " ").replace(/\s+/g, " ").trim();
  return s.replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, MAX_NAME) || "file";
}

function fileId() {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
}

/* Who is asking. The token comes from the same place the board puts it. */
async function whoAmI(request, url, env) {
  const tok = url.searchParams.get("token")
    || (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "")
    || "";
  if (!tok) return null;
  try {
    const who = await env.BOARD.getByName("board").who(tok);
    return who && (who.role === "teacher" || who.role === "admin") ? who : null;
  } catch {
    return null;
  }
}

/* Which of the printed pack a student may have.
 *
 * A teacher card carries the cut list, the room notes and, for A13, the answers
 * to its own practicum, so every card is gated whatever else is true. Handouts
 * are what attendees leave with and spoil nothing. The rest is decided by the
 * same build-time classification the hub data uses.
 */
const TEACHER_SHEETS = new Set(
  Object.values(HUB).flatMap(c => c.tea.sheets));

function packIsTeacherOnly(name) {
  if (/_Teacher_Card\.pdf$/i.test(name)) return true;
  if (/_Handout\.pdf$/i.test(name)) return false;
  return TEACHER_SHEETS.has(name);
}

/* ------------------------------------------------------------ the data */

function publicList() {
  return Object.values(HUB).map(c => c.pub);
}

function oneClass(id, teacher) {
  const c = HUB[id];
  if (!c) return null;
  return teacher ? { ...c.pub, tea: c.tea } : { ...c.pub };
}

/* ------------------------------------------------------------ files */

async function listFiles(env, classId, teacher) {
  if (!env.FILES) return [];
  const out = [];
  // R2 list() omits customMetadata unless it is asked for. Without this the
  // metadata reads back empty, every upload looks like it has no visibility
  // set, and the share-with-everybody option silently does nothing.
  const seen = await env.FILES.list({
    prefix: `up/${classId}/`, limit: 200, include: ["customMetadata"],
  });
  for (const o of seen.objects) {
    const m = o.customMetadata || {};
    const forTeachers = m.visibility !== "all";
    if (forTeachers && !teacher) continue;
    out.push({
      key: o.key,
      name: m.name || o.key.split("/").pop(),
      size: o.size,
      at: m.at ? Number(m.at) : null,
      by: m.byName || "",
      mine: !!(teacher && m.byCode && teacher.code === m.byCode),
      visibility: forTeachers ? "teachers" : "all",
      note: m.note || "",
    });
  }
  out.sort((a, b) => (b.at || 0) - (a.at || 0));
  return out;
}

async function putUpload(request, url, env, who) {
  const classId = String(url.searchParams.get("class") || "").trim();
  if (!HUB[classId]) return json({ ok: false, error: "Unknown class." }, 400);
  if (!env.FILES) {
    return json({ ok: false, error:
      "File storage is not connected yet. The R2 bucket binding named FILES is "
      + "missing from wrangler.jsonc, or the bucket does not exist." }, 503);
  }

  const form = await request.formData().catch(() => null);
  if (!form) return json({ ok: false, error: "Send the file as form data." }, 400);
  const visibility = form.get("visibility") === "all" ? "all" : "teachers";
  const note = String(form.get("note") || "").replace(/\s+/g, " ").trim().slice(0, 300);

  const files = form.getAll("file").filter(f => f && typeof f === "object" && f.size != null);
  if (!files.length) return json({ ok: false, error: "No file." }, 400);

  const saved = [];
  for (const f of files) {
    if (f.size > MAX_UPLOAD) {
      return json({ ok: false, error:
        `${safeName(f.name)} is ${(f.size / 1048576).toFixed(1)}MB. The limit is 25MB.` }, 413);
    }
    const name = safeName(f.name);
    const key = `up/${classId}/${fileId()}-${name}`;
    await env.FILES.put(key, f.stream(), {
      httpMetadata: { contentType: f.type || "application/octet-stream" },
      customMetadata: {
        name, note, visibility,
        byCode: who.code || "", byName: who.name || "",
        at: String(Date.now()), classId,
      },
    });
    saved.push({ key, name });
  }
  return json({ ok: true, saved });
}

async function putPack(request, url, env) {
  if (!env.FILES) return json({ ok: false, error: "No bucket bound." }, 503);
  const form = await request.formData().catch(() => null);
  if (!form) return json({ ok: false, error: "Send the files as form data." }, 400);
  const files = form.getAll("file").filter(f => f && typeof f === "object" && f.size != null);
  let n = 0;
  for (const f of files) {
    const name = safeName(f.name);
    if (!/\.pdf$/i.test(name)) continue;
    await env.FILES.put(`pack/${name}`, f.stream(), {
      httpMetadata: { contentType: "application/pdf" },
      customMetadata: { name, at: String(Date.now()) },
    });
    n++;
  }
  return json({ ok: true, stored: n });
}

async function serveFile(url, env, teacher) {
  const key = decodeURIComponent(url.pathname.slice("/files/".length));
  if (!key || key.includes("..")) return new Response("No.", { status: 400 });
  if (!env.FILES) return new Response("File storage is not connected yet.", { status: 503 });

  if (key.startsWith("pack/")) {
    if (packIsTeacherOnly(key.slice(5)) && !teacher) {
      return new Response("Teachers only.", { status: 403 });
    }
  } else if (key.startsWith("up/")) {
    const head = await env.FILES.head(key);
    if (!head) return new Response("Not here.", { status: 404 });
    if ((head.customMetadata || {}).visibility !== "all" && !teacher) {
      return new Response("Teachers only.", { status: 403 });
    }
  } else {
    return new Response("No.", { status: 400 });
  }

  const obj = await env.FILES.get(key);
  if (!obj) return new Response("Not here.", { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set("cache-control", "private, max-age=300");
  h.set("content-disposition",
    `inline; filename="${(obj.customMetadata || {}).name || "file"}"`);
  return new Response(obj.body, { headers: h });
}

/* ------------------------------------------------------------ routes */

export async function hubRoutes(request, url, env) {
  const p = url.pathname;

  if (p === "/hub") {
    return new Response(HUB_HTML, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  if (p === "/api/hub" && request.method === "GET") {
    const who = await whoAmI(request, url, env);
    return json({
      role: who ? who.role : "public",
      name: who ? who.name : "",
      classes: publicList(),
      packOnline: !!env.FILES,
    });
  }

  if (p.startsWith("/api/hub/class/") && request.method === "GET") {
    const who = await whoAmI(request, url, env);
    const id = decodeURIComponent(p.slice("/api/hub/class/".length));
    const c = oneClass(id, !!who);
    if (!c) return json({ ok: false, error: "Unknown class." }, 404);
    return json({ ok: true, role: who ? who.role : "public", klass: c,
                  files: await listFiles(env, id, who) });
  }

  if (p === "/api/hub/upload" && request.method === "POST") {
    const who = await whoAmI(request, url, env);
    if (!who) return json({ ok: false, error: "Teachers only." }, 403);
    return putUpload(request, url, env, who);
  }

  if (p === "/api/hub/pack" && request.method === "POST") {
    const who = await whoAmI(request, url, env);
    if (!who || who.role !== "admin") {
      return json({ ok: false, error: "Admins only." }, 403);
    }
    return putPack(request, url, env);
  }

  if (p === "/api/hub/delete" && request.method === "POST") {
    const who = await whoAmI(request, url, env);
    if (!who) return json({ ok: false, error: "Teachers only." }, 403);
    const body = await request.json().catch(() => ({}));
    const key = String(body.key || "");
    if (!key.startsWith("up/") || key.includes("..")) {
      return json({ ok: false, error: "Not a file you can remove." }, 400);
    }
    if (!env.FILES) return json({ ok: false, error: "No bucket bound." }, 503);
    const head = await env.FILES.head(key);
    if (!head) return json({ ok: false, error: "Not here." }, 404);
    const m = head.customMetadata || {};
    if (who.role !== "admin" && m.byCode !== who.code) {
      return json({ ok: false, error: "That is somebody else's file." }, 403);
    }
    await env.FILES.delete(key);
    return json({ ok: true });
  }

  if (p.startsWith("/files/")) {
    const who = await whoAmI(request, url, env);
    return serveFile(url, env, who);
  }

  return null;
}

/* ------------------------------------------------------------ the page */

export const HUB_HTML = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kinspire Teacher Hub</title>
<style>
:root{--ink:#16140f;--soft:#4a453a;--faint:#b8b1a2;--paper:#f7f4ec;--line:#ddd6c6}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
  font:17px/1.6 Georgia,'Times New Roman',serif;padding:0 20px 90px}
.wrap{max-width:1060px;margin:0 auto}
header{padding:48px 0 6px}
h1{font-weight:400;font-size:38px;line-height:1.1;margin:0 0 .3em}
.sub{color:var(--soft);max-width:66ch;margin:0 0 14px}
.who{font-size:15px;color:var(--soft)}
.who b{font-weight:400;color:var(--ink)}
button,.btn{font:inherit;font-size:15px;border:1px solid var(--ink);background:none;
  color:var(--ink);border-radius:4px;padding:6px 13px;cursor:pointer;text-decoration:none;
  display:inline-block}
button:hover,.btn:hover{background:var(--ink);color:var(--paper)}
button.soft,.btn.soft{border-color:var(--faint);color:var(--soft)}
button.soft:hover,.btn.soft:hover{background:var(--soft);color:var(--paper);border-color:var(--soft)}
input,select,textarea{font:inherit;font-size:15px;background:var(--paper);color:var(--ink);
  border:1px solid var(--line);border-radius:4px;padding:7px 9px}
nav{position:sticky;top:0;background:var(--paper);border-bottom:1px solid var(--line);
  padding:12px 0;margin:22px 0 0;z-index:5;display:flex;gap:14px;align-items:center;
  flex-wrap:wrap}
nav a{color:var(--soft);text-decoration:none;font-size:15px;border-bottom:1px solid transparent}
nav a:hover{color:var(--ink);border-bottom-color:var(--faint)}
h2.track{font-weight:400;font-size:13px;letter-spacing:.24em;text-transform:uppercase;
  color:var(--soft);margin:46px 0 6px;border-bottom:1px solid var(--line);padding-bottom:8px}
.card{border:1px solid var(--line);border-radius:6px;padding:20px 22px;margin:16px 0;
  background:#fbf9f3}
.card h3{font-weight:400;font-size:24px;margin:0 0 4px}
.card h3 .id{color:var(--faint);margin-right:10px}
.meta{color:var(--soft);font-size:14.5px;margin:0 0 12px}
.meta span+span::before{content:" \\00b7 ";color:var(--faint)}
.floor{margin:0 0 12px;padding-left:13px;border-left:2px solid var(--faint);font-size:16px}
.floor b{font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:var(--soft);
  display:block;margin-bottom:3px;font-weight:400}
.blurb{color:var(--soft);margin:0 0 12px}
details{margin:0 0 10px}
summary{cursor:pointer;color:var(--soft);font-size:15px}
ol.subj,ul.plain{margin:8px 0 0;padding-left:22px;color:var(--soft);font-size:15.5px}
ol.subj b{color:var(--ink);font-weight:400}
ol.subj .m{color:var(--faint)}
.tea{border:1px solid var(--ink);border-radius:6px;padding:16px 18px;margin:14px 0 0;
  background:#f2ece0}
.tea h4{font-weight:400;font-size:12px;letter-spacing:.22em;text-transform:uppercase;
  color:var(--soft);margin:0 0 8px}
.tea h4+h4{margin-top:16px}
.tea pre{white-space:pre-wrap;font:inherit;font-size:15px;margin:0}
.tea p,.tea ul.md,.tea ol.md{margin:0 0 .7em}
.tea > :last-child{margin-bottom:0}
table.md{border-collapse:collapse;margin:0 0 .8em;font-size:15px;width:100%}
table.md th,table.md td{border-bottom:1px solid var(--line);padding:4px 10px 4px 0;
  text-align:left;vertical-align:top}
table.md th{font-weight:400;color:var(--soft);font-size:13px;letter-spacing:.06em}
blockquote{margin:0 0 .8em;padding-left:13px;border-left:2px solid var(--faint);color:var(--soft)}
ul.md,ol.md{padding-left:20px}
code{font-family:inherit;color:var(--soft)}
.files a{margin:0 7px 7px 0}
.lock{color:var(--faint);font-size:14px;font-style:italic}
.up{border-top:1px solid var(--line);margin-top:14px;padding-top:12px;font-size:15px}
.up label{color:var(--soft);margin-right:10px}
.row{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-top:8px}
.msg{font-size:15px;color:var(--soft);margin-top:8px}
.msg.bad{color:#8c2f22}
dialog{border:1px solid var(--ink);border-radius:6px;background:var(--paper);color:var(--ink);
  padding:22px 24px;max-width:420px;font:inherit}
dialog::backdrop{background:rgba(22,20,15,.45)}
footer{margin-top:64px;padding-top:18px;border-top:1px solid var(--line);
  color:var(--faint);font-size:14.5px}
@media print{nav,.up,button{display:none}}
</style></head><body><div class="wrap">
<header>
<h1>Teacher hub</h1>
<p class="sub">Everything for a class in one place. Signed out this shows what a class is and
what people leave with. Signed in with your notice board code it also shows the timings, the
cut list, the room notes and the sheets that stay on your side of the screen.</p>
<p class="who" id="who">Checking...</p>
</header>
<nav id="nav"></nav>
<div id="list"></div>
<footer>Generated from the curricula. The teacher half of every class is withheld by the
server rather than hidden by the page, so signing out genuinely removes it.</footer>
</div>

<dialog id="signin">
<p style="margin:0 0 10px">Your notice board code. The same one you use to post a class.</p>
<div class="row"><input id="code" size="14" autocomplete="off" placeholder="code">
<button id="go">Sign in</button><button class="soft" id="cancel">Cancel</button></div>
<p class="msg" id="sierr"></p>
</dialog>

<script>
var TOK = null, ROLE = "public", NAME = "", DATA = [], OPEN = {};
function $(id){ return document.getElementById(id); }
function esc(s){ var d = document.createElement("div"); d.textContent = s == null ? "" : s; return d.innerHTML; }

/* The handout and the answer blocks are markdown. Rendering them as text left
   asterisks and table pipes on screen, which is unreadable and looks broken.
   This is deliberately small: bold, tables, lists, quotes and paragraphs are
   everything the corpus uses. Everything is escaped before any tag is added. */
function md(src){
  var lines = esc(src == null ? "" : src).split("\\n");
  var out = [], i = 0;
  function inline(t){
    return t.replace(/\\*\\*(.+?)\\*\\*/g, "<b>$1</b>")
            .replace(/(^|[^*])\\*([^*\\n]+)\\*/g, "$1<i>$2</i>")
            .replace(/\`([^\`]+)\`/g, "<code>$1</code>");
  }
  while (i < lines.length) {
    var l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (/^\\s*\\|/.test(l)) {
      var rows = [];
      while (i < lines.length && /^\\s*\\|/.test(lines[i])) {
        var cells = lines[i].trim().replace(/^\\||\\|$/g, "").split("|");
        if (!/^[\\s:|-]+$/.test(lines[i])) rows.push(cells);
        i++;
      }
      if (rows.length) {
        out.push("<table class='md'>" + rows.map(function(r, n){
          var tag = n === 0 ? "th" : "td";
          return "<tr>" + r.map(function(c){
            return "<" + tag + ">" + inline(c.trim()) + "</" + tag + ">"; }).join("") + "</tr>";
        }).join("") + "</table>");
      }
      continue;
    }
    // The text is escaped before this runs, so a blockquote marker arrives as
    // &gt; rather than >. Matching the raw character found nothing and every
    // quoted line in the corpus rendered as a paragraph beginning "&gt;".
    if (/^\\s*&gt;/.test(l)) {
      var q = [];
      while (i < lines.length && /^\\s*&gt;/.test(lines[i])) { q.push(lines[i].replace(/^\\s*&gt;\\s?/, "")); i++; }
      out.push("<blockquote>" + inline(q.join(" ")) + "</blockquote>");
      continue;
    }
    if (/^\\s*[-*]\\s+/.test(l)) {
      var ul = [];
      while (i < lines.length && /^\\s*[-*]\\s+/.test(lines[i])) {
        ul.push("<li>" + inline(lines[i].replace(/^\\s*[-*]\\s+/, "")) + "</li>"); i++; }
      out.push("<ul class='md'>" + ul.join("") + "</ul>");
      continue;
    }
    if (/^\\s*\\d+\\.\\s+/.test(l)) {
      var ol = [];
      while (i < lines.length && /^\\s*\\d+\\.\\s+/.test(lines[i])) {
        ol.push("<li>" + inline(lines[i].replace(/^\\s*\\d+\\.\\s+/, "")) + "</li>"); i++; }
      out.push("<ol class='md'>" + ol.join("") + "</ol>");
      continue;
    }
    // Everything else is a paragraph. The guard has to match the branches
    // above exactly, or a line those branches reject and this one also rejects
    // consumes nothing and the loop spins: "**Bold.**" starts with a star,
    // which is not a bullet because no space follows, and an earlier version
    // excluded it from paragraphs too and hung the whole page.
    var para = [lines[i]]; i++;
    while (i < lines.length && lines[i].trim()
           && !/^\\s*\\|/.test(lines[i]) && !/^\\s*&gt;/.test(lines[i])
           && !/^\\s*[-*]\\s+/.test(lines[i]) && !/^\\s*\\d+\\.\\s+/.test(lines[i])) {
      para.push(lines[i]); i++; }
    out.push("<p>" + inline(para.join(" ")) + "</p>");
  }
  return out.join("");
}
function tok(){ try { return localStorage.getItem("kinspire_board_token") || ""; } catch(e){ return ""; } }
function setTok(t){ try { t ? localStorage.setItem("kinspire_board_token", t) : localStorage.removeItem("kinspire_board_token"); } catch(e){} TOK = t || null; }
function q(u){ return u + (u.indexOf("?") < 0 ? "?" : "&") + (TOK ? "token=" + encodeURIComponent(TOK) : ""); }

function head(){
  var el = $("who");
  if (ROLE === "public") {
    el.innerHTML = 'Signed out. <button id="si">Teacher sign in</button>';
    $("si").onclick = function(){ $("sierr").textContent = ""; $("signin").showModal(); };
  } else {
    el.innerHTML = 'Signed in as <b>' + esc(NAME) + '</b> (' + esc(ROLE) +
      '). <button class="soft" id="so">Sign out</button>';
    $("so").onclick = function(){ setTok(""); load(); };
  }
}

function card(c){
  var meta = ["level","length","ages","system"].filter(function(k){ return c[k]; })
    .map(function(k){ return "<span>" + esc(c[k]) + "</span>"; }).join("");
  var subs = (c.subjects || []).map(function(n){ return "<li>" + esc(n) + "</li>"; }).join("");
  return '<div class="card" id="c-' + esc(c.id) + '">'
    + '<h3><span class="id">' + esc(c.id) + '</span>' + esc(c.title) + '</h3>'
    + '<p class="meta">' + meta + '</p>'
    + (c.floor ? '<p class="floor"><b>They leave able to</b>' + esc(c.floor) + '</p>' : "")
    + (c.blurb ? '<p class="blurb">' + esc(c.blurb) + '</p>' : "")
    + '<details' + (OPEN[c.id] ? " open" : "") + '><summary>'
    + (c.subjects || []).length + ' subjects, and the rest of it</summary>'
    + '<ol class="subj">' + subs + '</ol>'
    + '<div class="more" data-id="' + esc(c.id) + '"><p class="msg">Loading...</p></div>'
    + '</details></div>';
}

function render(){
  var tracks = [];
  DATA.forEach(function(c){ var t = (c.track || "Other").split(",")[0].trim();
    if (tracks.indexOf(t) < 0) tracks.push(t); });
  $("nav").innerHTML = tracks.map(function(t){
    return '<a href="#t-' + t.replace(/\\s+/g, "-") + '">' + esc(t) + "</a>"; }).join("");
  $("list").innerHTML = tracks.map(function(t){
    var cs = DATA.filter(function(c){ return (c.track || "Other").split(",")[0].trim() === t; });
    return '<h2 class="track" id="t-' + t.replace(/\\s+/g, "-") + '">' + esc(t) + "</h2>"
      + cs.map(card).join("");
  }).join("");
  Array.prototype.forEach.call(document.querySelectorAll("details"), function(d){
    d.addEventListener("toggle", function(){
      var box = d.querySelector(".more"); if (!box) return;
      var id = box.getAttribute("data-id");
      OPEN[id] = d.open;
      if (d.open && !box.getAttribute("data-done")) detail(id, box);
    });
    if (d.open) { var b = d.querySelector(".more");
      if (b && !b.getAttribute("data-done")) detail(b.getAttribute("data-id"), b); }
  });
}

function fileLinks(files){
  if (!files.length) return "";
  return '<p class="files">' + files.map(function(f){
    return '<a class="btn soft" href="' + q("/files/" + f.key) + '" target="_blank">'
      + esc(f.name) + (f.visibility === "teachers" ? " (teachers)" : "")
      + '</a>' + (f.mine || ROLE === "admin"
        ? ' <button class="soft" data-del="' + esc(f.key) + '">remove</button>' : "");
  }).join(" ") + "</p>";
}

function detail(id, box){
  fetch(q("/api/hub/class/" + encodeURIComponent(id))).then(function(r){ return r.json(); })
  .then(function(d){
    if (!d.ok) { box.innerHTML = '<p class="msg bad">' + esc(d.error || "Not found") + "</p>"; return; }
    var c = d.klass, h = "";
    if (c.handout) h += '<h4 style="margin-top:14px">The handout</h4><div class="tea">'
      + md(c.handout) + "</div>";
    if (c.sheets && c.sheets.length) h += '<p class="files">' + c.sheets.map(function(n){
      return '<a class="btn soft" href="' + q("/files/pack/" + encodeURIComponent(n))
        + '" target="_blank">' + esc(n) + "</a>"; }).join(" ") + "</p>";

    if (c.tea) {
      var t = c.tea, s = '<div class="tea"><h4>The clock</h4><ol class="subj">'
        + t.timings.map(function(x){ return "<li><b>" + esc(x.n) + "</b> <span class='m'>"
          + x.m + " min</span></li>"; }).join("") + "</ol>";
      if (t.cuts.length) s += "<h4>Cut list, in order</h4><ol class='subj'>"
        + t.cuts.map(function(x){ return "<li>" + esc(x) + "</li>"; }).join("") + "</ol>";
      if (t.notes.length) s += "<h4>Room notes</h4><ul class='plain'>"
        + t.notes.map(function(x){ return "<li>" + esc(x) + "</li>"; }).join("") + "</ul>";
      if (t.day.length) s += "<h4>Running it on the day</h4><ol class='subj'>"
        + t.day.map(function(x){ return "<li>" + esc(x) + "</li>"; }).join("") + "</ol>";
      if (t.answers) s += "<h4>Answers, for you</h4>" + md(t.answers);
      s += "</div>";
      h += s;
      h += '<p class="files"><a class="btn" href="' + q("/files/pack/" + c.id + "_Teacher_Card.pdf")
        + '" target="_blank">Teacher card</a> <a class="btn soft" href="'
        + q("/files/pack/" + c.id + "_Handout.pdf") + '" target="_blank">Handout</a>'
        + (t.sheets || []).map(function(n){
          return ' <a class="btn" href="' + q("/files/pack/" + encodeURIComponent(n))
            + '" target="_blank">' + esc(n) + " (teachers)</a>"; }).join("") + "</p>";
    } else {
      h += '<p class="lock">The timings, cut list, room notes and teacher sheets are '
        + "withheld until you sign in.</p>";
    }

    h += '<div class="shared"></div>';
    if (c.tea) {
      h += '<div class="up"><label>Add your own material</label>'
        + '<div class="row"><input type="file" multiple class="f">'
        + '<select class="v"><option value="teachers">Teachers only</option>'
        + '<option value="all">Everybody</option></select>'
        + '<input class="n" size="26" placeholder="a note, optional">'
        + '<button class="u">Upload</button></div>'
        + '<p class="msg m2"></p></div>';
    }
    box.innerHTML = h;
    box.setAttribute("data-done", "1");

    var shared = box.querySelector(".shared");
    if (shared) shared.innerHTML = (d.files && d.files.length)
      ? "<h4 style='margin:14px 0 6px;font-weight:400;font-size:12px;letter-spacing:.22em;"
        + "text-transform:uppercase;color:var(--soft)'>Uploaded for this class</h4>"
        + fileLinks(d.files)
      : "";

    Array.prototype.forEach.call(box.querySelectorAll("[data-del]"), function(b){
      b.onclick = function(){
        fetch(q("/api/hub/delete"), { method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: b.getAttribute("data-del") }) })
        .then(function(r){ return r.json(); })
        .then(function(x){ if (x.ok) { box.removeAttribute("data-done"); detail(id, box); } });
      };
    });

    var up = box.querySelector(".u");
    if (up) up.onclick = function(){
      var f = box.querySelector(".f"), m = box.querySelector(".m2");
      if (!f.files.length) { m.textContent = "Pick a file first."; return; }
      var fd = new FormData();
      for (var i = 0; i < f.files.length; i++) fd.append("file", f.files[i]);
      fd.append("visibility", box.querySelector(".v").value);
      fd.append("note", box.querySelector(".n").value);
      m.className = "msg m2"; m.textContent = "Uploading...";
      fetch(q("/api/hub/upload?class=" + encodeURIComponent(id)),
            { method: "POST", body: fd })
      .then(function(r){ return r.json(); })
      .then(function(x){
        if (!x.ok) { m.className = "msg m2 bad"; m.textContent = x.error || "That did not work."; return; }
        m.textContent = "";
        box.removeAttribute("data-done"); detail(id, box);
      })
      .catch(function(){ m.className = "msg m2 bad"; m.textContent = "That did not work."; });
    };
  });
}

function load(){
  fetch(q("/api/hub")).then(function(r){ return r.json(); }).then(function(d){
    ROLE = d.role; NAME = d.name; DATA = d.classes || [];
    head(); render();
  }).catch(function(){ $("who").textContent = "Could not load the hub. Reload."; });
}

$("go").onclick = function(){
  var c = $("code").value.trim();
  if (!c) return;
  fetch("/api/board/signin", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ code: c }) })
  .then(function(r){ return r.json(); }).then(function(d){
    if (!d.ok) { $("sierr").className = "msg bad"; $("sierr").textContent = d.error || "No."; return; }
    setTok(d.token); $("signin").close(); load();
  });
};
$("cancel").onclick = function(){ $("signin").close(); };

TOK = tok() || null;
load();
</script></body></html>`;
