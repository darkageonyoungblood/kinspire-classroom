/**
 * Kinspire classroom. Worker + Durable Object.
 *
 * A teacher drives one deck. Students watch. The room is on the server.
 *
 * This tool contains no AI. Nothing is generated, predicted or suggested.
 * Every slide in it was constructed from shapes and type by hand.
 *
 * The server exists for enforcement, the same reason the dice table has one.
 *
 *   1. Position. The current slide lives in the Durable Object, not in
 *      anyone's browser. A student who refreshes lands where the class is.
 *
 *   2. Reading ahead. A student socket is sent one slide's markup and never
 *      the deck. Hiding later slides with CSS is not hiding them; not
 *      sending them is.
 *
 *   3. Control. Advancing requires the teacher token. A student socket's
 *      messages cannot move the room.
 */
import { DurableObject } from "cloudflare:workers";
import { DECKS, CATALOG } from "./decks.js";
import { Board, BOARD_HTML } from "./board.js";
import { CATEGORIES, CLASS_INDEX } from "./catalog.js";

// A Durable Object class has to be exported from the entry module.
export { Board };

/* ------------------------------------------------------------ ids */

// No I, O, S, 0, 1, 5: a code gets read aloud over voice chat.
const ALPHABET = "ABCDEFGHJKLMNPQRTUVWXYZ2346789";

function code(n) {
  const buf = new Uint32Array(n);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < n; i++) s += ALPHABET[buf[i] % ALPHABET.length];
  return s;
}

function token() {
  const buf = new Uint8Array(24);
  crypto.getRandomValues(buf);
  return Array.from(buf, b => b.toString(16).padStart(2, "0")).join("");
}

// Length-independent compare, so a wrong token leaks nothing by timing.
function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------ limits */

const MAX_STUDENTS = 200;
const NAME_LEN = 24;

function cleanName(v) {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, NAME_LEN) : "";
  return s || "Someone";
}

function deckOf(id) {
  return Object.prototype.hasOwnProperty.call(DECKS, id) ? DECKS[id] : null;
}

/**
 * A class in the catalog with no deck built yet still gets a working room: a
 * code, a roster, the hand-raise, the blackout and the run log. What it does
 * not get is somebody else's slides, which is what the old fallback did. A
 * teacher picking C9 and being shown A1's deck is worse than no deck at all.
 */
function esc(v) {
  return String(v).replace(/[&<>]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m]));
}

function shellDeck(id) {
  const c = CLASS_INDEX[id];
  if (!c) return null;
  const where = c.track || c.category || "Kinspire";
  return {
    id,
    title: c.title,
    track: where,
    shell: true,
    handout: null,
    slides: [{
      label: "Title",
      cls: "center",
      note: "No deck is built for this class yet, so this is the only slide. "
          + "Everything else in the room works: the roster, the hand-raise, "
          + "the blackout, full screen and the run log.",
      html: '<p class="kicker">Kinspire &middot; ' + esc(where) + " &middot; " + esc(id)
          + '</p>\n    <h1>' + esc(c.title) + "</h1>\n"
          + '    <div class="rule" style="margin-top:1.4em"></div>',
    }],
  };
}

function anyDeck(id) { return deckOf(id) || shellDeck(id); }

/* ------------------------------------------------------------ durable object */

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get("room")) || null;
      if (this.room) this.migrate();
    });
  }

  // An old room keeps working when the shape grows.
  migrate() {
    const r = this.room;
    r.slide ??= 0;
    r.blackout ??= false;
    r.handoutOut ??= false;
    r.ended ??= false;
    r.peak ??= 0;
    r.runs ??= [];
    if (!deckOf(r.deckId)) r.deckId = CATALOG[0].id;
    r.slide = this.clamp(r.slide);
  }

  save() {
    return this.ctx.storage.put("room", this.room);
  }

  deck() {
    return anyDeck(this.room.deckId) || DECKS[CATALOG[0].id];
  }

  clamp(n) {
    const total = this.deck().slides.length;
    n = Math.trunc(Number(n));
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(total - 1, n));
  }

  /* ---------------------------------------------------------- lifecycle */

  async open(roomCode, deckId) {
    const d = anyDeck(deckId);
    if (!d) return { error: "No class in the catalog has that id." };
    this.room = {
      code: roomCode,
      teacherToken: token(),
      deckId: d.id,
      slide: 0,
      blackout: false,
      handoutOut: false,
      ended: false,
      peak: 0,
      runs: [],
      created: Date.now(),
    };
    await this.save();
    return { code: roomCode, token: this.room.teacherToken, deck: d.id,
             title: d.title, shell: !!d.shell };
  }

  async exists() { return !!this.room; }

  async checkTeacher(tok) {
    return !!this.room && sameSecret(tok, this.room.teacherToken);
  }

  async describe() {
    if (!this.room) return { ok: false, error: "No class is running under that code." };
    const d = this.deck();
    return { ok: true, title: d.title, id: d.id, track: d.track };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (!this.room) return new Response("No such class", { status: 404 });

    let who;
    if (url.searchParams.get("role") === "teacher") {
      if (!sameSecret(url.searchParams.get("token") || "", this.room.teacherToken)) {
        return new Response("Bad teacher token", { status: 403 });
      }
      who = { role: "teacher" };
    } else {
      if (this.countStudents() >= MAX_STUDENTS) {
        return new Response("This class is full", { status: 409 });
      }
      who = { role: "student", name: cleanName(url.searchParams.get("name")), lost: false };
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [who.role]);
    server.serializeAttachment(who);
    this.push(server, who);
    if (who.role === "student") {
      const n = this.countStudents();
      if (n > this.room.peak) { this.room.peak = n; this.save(); }
      this.pushTeacher();
    } else {
      this.pushTeacher();
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---------------------------------------------------------- roster */

  sockets(role) {
    return this.ctx.getWebSockets(role);
  }

  countStudents() {
    return this.sockets("student").length;
  }

  roster() {
    const out = [];
    for (const ws of this.sockets("student")) {
      const a = ws.deserializeAttachment();
      if (a) out.push({ name: a.name, lost: !!a.lost });
    }
    out.sort((x, y) => x.name.localeCompare(y.name));
    return out;
  }

  /* ---------------------------------------------------------- projections */

  // The slide the room is on, as markup. Blackout is enforced here rather
  // than in CSS: when the screen is black there is nothing to inspect.
  current(hidden) {
    const d = this.deck();
    const s = d.slides[this.room.slide];
    if (hidden) return { cls: "center", html: "" };
    return { cls: s.cls || "", html: s.html };
  }

  teacherView() {
    const d = this.deck();
    const i = this.room.slide;
    const s = d.slides[i];
    const next = d.slides[i + 1] || null;
    const roster = this.roster();
    return {
      t: "teacher",
      code: this.room.code,
      deck: {
        id: d.id, title: d.title, track: d.track, level: d.level,
        teacher: d.teacher, length: d.length, total: d.slides.length,
        labels: d.slides.map(x => x.label),
      },
      slide: i,
      note: s.note || "",
      show: this.current(false),
      nextLabel: next ? next.label : null,
      blackout: this.room.blackout,
      handoutOut: this.room.handoutOut,
      handout: d.handout || "",
      catalog: CATALOG,
      students: roster,
      lost: roster.filter(x => x.lost).length,
      ended: this.room.ended,
      teachers: this.sockets("teacher").length,
      peak: this.room.peak,
      runs: this.room.runs.slice(-5),
      opened: this.room.created,
    };
  }

  // Everything a student is allowed to have: the slide they are looking at,
  // and where that sits in the hour. No deck, no labels, no later slides.
  studentView(me) {
    const d = this.deck();
    return {
      t: "student",
      code: this.room.code,
      title: d.title,
      track: d.track,
      slide: this.room.slide,
      total: d.slides.length,
      show: this.current(this.room.blackout),
      blackout: this.room.blackout,
      handoutOut: this.room.handoutOut,
      handout: this.room.handoutOut ? (d.handout || "") : "",
      lost: !!(me && me.lost),
      name: me ? me.name : "",
      ended: this.room.ended,
    };
  }

  push(ws, who) {
    try {
      ws.send(JSON.stringify(who.role === "teacher" ? this.teacherView() : this.studentView(who)));
    } catch { /* socket gone */ }
  }

  pushTeacher() {
    const v = JSON.stringify(this.teacherView());
    for (const ws of this.sockets("teacher")) {
      try { ws.send(v); } catch { /* ignore */ }
    }
  }

  pushStudents() {
    // Each student's payload carries their own lost flag, so these are
    // serialized per socket rather than broadcast as one string.
    for (const ws of this.sockets("student")) {
      const a = ws.deserializeAttachment();
      try { ws.send(JSON.stringify(this.studentView(a))); } catch { /* ignore */ }
    }
  }

  pushAll() {
    this.pushTeacher();
    this.pushStudents();
  }

  /* ---------------------------------------------------------- messages */

  async webSocketMessage(ws, raw) {
    const who = ws.deserializeAttachment();
    if (!who || !this.room) return;

    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== "string") return;

    if (who.role === "student") return this.fromStudent(ws, who, m);
    return this.fromTeacher(m);
  }

  async fromStudent(ws, who, m) {
    // A student can say one thing: whether they are following.
    if (m.t !== "lost") return;
    who.lost = !!m.on;
    ws.serializeAttachment(who);
    this.push(ws, who);
    this.pushTeacher();
  }

  async fromTeacher(m) {
    const r = this.room;

    switch (m.t) {
      case "go":    r.slide = this.clamp(m.n); break;
      case "next":  r.slide = this.clamp(r.slide + 1); break;
      case "prev":  r.slide = this.clamp(r.slide - 1); break;
      case "first": r.slide = 0; break;
      case "last":  r.slide = this.deck().slides.length - 1; break;

      case "blackout": r.blackout = m.on === undefined ? !r.blackout : !!m.on; break;
      case "handout":  r.handoutOut = m.on === undefined ? !r.handoutOut : !!m.on; break;

      case "deck": {
        const d = deckOf(m.id);
        if (!d) return;
        r.deckId = d.id;
        r.slide = 0;
        r.blackout = false;
        r.handoutOut = false;
        break;
      }

      case "end":    r.ended = true;  break;
      case "reopen": r.ended = false; break;

      case "logRun": {
        // The bug log, captured where the class happened rather than in a
        // document somebody has to remember to open afterwards.
        const t = v => (typeof v === "string" ? v.slice(0, 600).trim() : "");
        r.runs.push({
          at: Date.now(),
          deck: r.deckId,
          attended: Math.max(0, Math.trunc(Number(m.attended)) || this.room.peak),
          broke: t(m.broke),
          confused: t(m.confused),
          tried: t(m.tried),
          notes: t(m.notes),
        });
        r.runs.splice(0, Math.max(0, r.runs.length - 40));
        break;
      }

      case "clearLost": {
        for (const ws of this.sockets("student")) {
          const a = ws.deserializeAttachment();
          if (a && a.lost) { a.lost = false; ws.serializeAttachment(a); }
        }
        break;
      }

      default: return;
    }

    await this.save();
    this.pushAll();
  }

  async exportLog() {
    if (!this.room) return "";
    const pad = n => String(n).padStart(2, "0");
    const day = ms => {
      const d = new Date(ms);
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    };
    const out = [
      "# Kinspire class run log",
      "",
      `Room ${this.room.code}. Exported ${day(Date.now())}. Times are UTC.`,
      "",
    ];
    if (!this.room.runs.length) out.push("No runs logged in this room yet.");
    for (const r of this.room.runs) {
      const d = DECKS[r.deck];
      out.push("***", "");
      out.push(`## ${r.deck} ${d ? d.title : ""}, ${day(r.at)}`);
      out.push("");
      out.push(`**Attended:** ${r.attended}`);
      out.push("");
      out.push(`**What broke?** ${r.broke || "nothing recorded"}`);
      out.push("");
      out.push(`**What confused people that should not have?** ${r.confused || "nothing recorded"}`);
      out.push("");
      out.push(`**What did somebody try that did not work?** ${r.tried || "nothing recorded"}`);
      if (r.notes) { out.push(""); out.push(`**Notes.** ${r.notes}`); }
      out.push("");
    }
    return out.join("\n");
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch { /* ignore */ }
    this.pushTeacher();
  }

  async log() { return this.exportLog(); }

  async webSocketError() {
    this.pushTeacher();
  }
}

/* ------------------------------------------------------------ worker */

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

const CODE_RE = /^[A-Z2-9]{5}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/catalog") {
      return json({
        catalog: CATALOG,                       // the four built decks
        categories: CATEGORIES,                 // all 181, for the dropdowns
        built: CATALOG.map(c => c.id),          // which of them have slides
      });
    }

    if (url.pathname === "/board") {
      return new Response(BOARD_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }

    if (url.pathname.startsWith("/api/board/") && request.method === "POST") {
      const op = url.pathname.slice("/api/board/".length);
      const body = await request.json().catch(() => ({}));
      const b = env.BOARD.getByName("board");
      switch (op) {
        case "listings":    return json(await b.listings());
        case "signin":      return json(await b.signIn(body.code));
        case "mine":        return json(await b.mine(body.token));
        case "post":        return json(await b.post(body.token, body));
        case "update":      return json(await b.update(body.token, body));
        case "mark":        return json(await b.markSeat(body.token, body));
        case "attend":      return json(await b.attend(body));
        case "ticket":      return json(await b.ticket(body));
        case "release":     return json(await b.release(body));
        case "teachers":    return json(await b.teacherList(body.token));
        case "addteacher":  return json(await b.addTeacher(body.token, body.name));
        case "setteacher":  return json(await b.setTeacher(body.token, body.code, body.disabled));
        default:            return json({ ok: false, error: "No such action." }, 404);
      }
    }

    if (url.pathname === "/classes") {
      return new Response(LISTING_HTML, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/api/log") {
      const roomCode = (url.searchParams.get("code") || "").toUpperCase();
      if (!CODE_RE.test(roomCode)) return new Response("Bad class code", { status: 400 });
      const stub = env.ROOM.getByName(roomCode);
      if (!(await stub.exists())) return new Response("No such class", { status: 404 });
      if (!(await stub.checkTeacher(url.searchParams.get("token") || ""))) {
        return new Response("Bad teacher token", { status: 403 });
      }
      return new Response(await stub.log(), {
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": `attachment; filename="run-log-${roomCode}.md"`,
        },
      });
    }

    if (url.pathname === "/api/open" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      // Opening a room is a teacher action. The notice board already knows who
      // the teachers are, so this asks it rather than keeping a second list of
      // people in a second place that can disagree with the first.
      const me = await env.BOARD.getByName("board").who(String(body.token || ""));
      if (!me) {
        return json({ ok: false, error: "Teachers only. Sign in with your teacher code." }, 403);
      }
      const roomCode = code(5);
      const out = await env.ROOM.getByName(roomCode).open(roomCode, body.deck);
      return json(out.error ? { ok: false, error: out.error } : { ...out, who: me.name });
    }

    if (url.pathname === "/api/join" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const roomCode = String(body.code || "").toUpperCase();
      if (!CODE_RE.test(roomCode)) {
        return json({ ok: false, error: "That class code does not look right." }, 400);
      }
      const stub = env.ROOM.getByName(roomCode);
      if (!(await stub.exists())) {
        return json({ ok: false, error: "No class is running under that code." }, 404);
      }
      return json(await stub.describe());
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const roomCode = (url.searchParams.get("code") || "").toUpperCase();
      if (!CODE_RE.test(roomCode)) return new Response("Bad class code", { status: 400 });
      return env.ROOM.getByName(roomCode).fetch(request);
    }

    return new Response(CLIENT_HTML, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  },
};

/* ===================================================== listing page */

// Built from the catalog at request time, so a deck and its listing cannot
// disagree. Factual rather than persuasive: what it is, who it is for, how
// long, what age, and what you leave with.
const LISTING_HTML = (() => {
  const esc = t => String(t == null ? "" : t)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const rows = CATALOG.map(c => `
    <article class="cls">
      <h3><span class="id">${esc(c.id)}</span> ${esc(c.title)}</h3>
      <p class="blurb">${esc(c.blurb)}</p>
      <dl>
        <div><dt>Track</dt><dd>${esc(c.track)}</dd></div>
        <div><dt>Level</dt><dd>${esc(c.level)}</dd></div>
        <div><dt>Length</dt><dd>${esc(c.length)}</dd></div>
        <div><dt>Ages</dt><dd class="${c.ages === "all ages" ? "" : "flag"}">${esc(c.ages)}</dd></div>
        <div><dt>Prerequisites</dt><dd>${esc(c.prereq)}</dd></div>
        <div><dt>System</dt><dd>${esc(c.system)}</dd></div>
        <div><dt>Taught by</dt><dd>${esc(c.teacher)}</dd></div>
      </dl>
    </article>`).join("");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kinspire Classes</title>
<style>
:root{--paper:#f7f4ec;--ink:#16140f;--soft:#4a453a;--faint:#b8b1a2;
  --serif:Georgia,"Iowan Old Style","Palatino Linotype",Palatino,serif}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--paper);color:var(--ink);font-family:var(--serif);line-height:1.5}
.wrap{max-width:860px;margin:0 auto;padding:46px 22px 80px}
.kicker{font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:var(--soft);margin:0 0 20px}
h1{font-size:clamp(30px,5vw,46px);font-weight:400;line-height:1.08;margin:0 0 .4em}
.lede{font-size:17px;color:var(--soft);max-width:60ch;margin:0 0 10px}
.cls{border-top:2px solid var(--ink);padding:26px 0 6px}
.cls h3{font-size:25px;font-weight:400;margin:0 0 .35em}
.cls .id{color:var(--faint);margin-right:.5em}
.blurb{margin:0 0 16px;color:var(--soft);max-width:62ch}
dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:4px 22px;margin:0}
dl div{display:flex;gap:8px;font-size:14px;padding:3px 0;border-bottom:1px solid #e6e1d4}
dt{color:var(--soft);min-width:98px;letter-spacing:.06em;text-transform:uppercase;font-size:11px;padding-top:3px}
dd{margin:0}
dd.flag{font-weight:700}
.foot{margin-top:44px;padding-top:18px;border-top:2px solid var(--ink);font-size:15px;color:var(--soft);max-width:62ch}
a{color:var(--ink)}
@media (prefers-color-scheme: dark){
  :root{--paper:#16140f;--ink:#f1ece0;--soft:#a79f8e;--faint:#5c5648}
  dl div{border-bottom-color:#2e2b24}
}
</style></head>
<body><div class="wrap">
<p class="kicker">Kinspire</p>
<h1>Classes</h1>
<p class="lede">Taught live inside Kinspire. Every class here is standalone: you can take it without having taken anything before it, unless the prerequisites say otherwise.</p>
<p class="lede"><strong>All ages is the default.</strong> Where a class is marked otherwise, the mark is the rule rather than a suggestion.</p>
${rows}
<p class="foot"><a href="/board">The notice board</a> is where classes are posted with dates, caps and fees, and where you take a seat. To sit in on one once it starts, you need the five-character code the teacher reads out, and <a href="/">the join page</a>. There is nothing to install and no account.</p>
</div></body></html>`;
})();

/* ===================================================== embedded client */

const CLIENT_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kinspire Classroom</title>
<style>
/* -----------------------------------------------------------------
   Slide styling is lifted from the standalone A1 deck so a slide
   renders identically here and in the file you can email. Black ink
   on warm paper, no colour, no webfonts: the deck looks the same
   with the network gone, which is the point of having it offline.
   ----------------------------------------------------------------- */
:root{
  --paper:#f7f4ec;
  --ink:#16140f;
  --ink-soft:#4a453a;
  --rule:#16140f;
  --chrome:#1b1915;
  --chrome-2:#2a2722;
  --chrome-line:#4a4438;
  --chrome-ink:#ded8ca;
  --serif: Georgia, "Iowan Old Style", "Palatino Linotype", Palatino, serif;
}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0;height:100%}
body{
  background:var(--chrome-2);
  color:var(--chrome-ink);
  font-family:var(--serif);
  min-height:100vh;
}


/* Corner marks rather than a border. A box around every slide fights the
   diagrams, most of which are already boxes. Four marks say these pages
   belong together and then get out of the way. */
.slide::before,.slide::after{
  content:"";position:absolute;pointer-events:none;
  width:2.2%;height:3.9%;border:2px solid #b8b1a2;
}
.slide::before{left:2.4%;top:2.8%;border-right:0;border-bottom:0}
.slide::after{right:2.4%;bottom:2.8%;border-left:0;border-top:0}
.stage.noframe .slide::before,.stage.noframe .slide::after{display:none}

/* High contrast. The warm paper and the serif were chosen to sit beside a
   hand-drawn sheet, and that choice costs a low-vision reader something.
   This gives it back: pure black on pure white, heavier rules, and the
   diagrams repainted through their presentation attributes. */
.stage.hc{background:#fff;color:#000}
.stage.hc .kicker,.stage.hc .body,.stage.hc .note,.stage.hc .col .lab{color:#1a1a1a}
.stage.hc .tag,.stage.hc .num{color:#444}
.stage.hc .rule,.stage.hc .quote{border-color:#000;background:#000}
.stage.hc .quote{background:none;border-left-color:#000}
.stage.hc svg [stroke="#16140f"]{stroke:#000}
.stage.hc svg [stroke="#4a453a"]{stroke:#000}
.stage.hc svg [stroke="#b8b1a2"]{stroke:#555}
.stage.hc svg [fill="#16140f"]{fill:#000}
.stage.hc svg [fill="#4a453a"]{fill:#000}
.stage.hc svg [fill="#b8b1a2"]{fill:#555}
.stage.hc svg [fill="#f7f4ec"]{fill:#fff}
.stage.hc .slide::before,.stage.hc .slide::after{border-color:#777}

/* ---------------------------------------------------- the stage */
.stagewrap{display:flex;align-items:center;justify-content:center;min-height:0}
.stage{
  position:relative;
  width:100%;
  aspect-ratio:16/9;
  background:var(--paper);
  color:var(--ink);
  box-shadow:0 10px 60px rgba(0,0,0,.55);
  overflow:hidden;
}
.stage.dark{background:#0d0c0a}
.stagewrap:fullscreen{background:#0d0c0a;width:100%;height:100%;padding:0}
.stagewrap:fullscreen .stage{width:min(100vw,177.7vh);box-shadow:none}
.slide{
  position:absolute;inset:0;
  padding:5.2% 6.5%;
  display:flex;flex-direction:column;
}
.slide.center{align-items:center;justify-content:center;text-align:center}

h1{font-size:clamp(24px,4.6cqw,74px);line-height:1.02;margin:0;letter-spacing:.012em;font-weight:400}
h2{font-size:clamp(15px,2.3cqw,38px);line-height:1.12;margin:0 0 .5em;font-weight:400;letter-spacing:.01em}
.kicker{font-size:clamp(8px,.98cqw,15px);letter-spacing:.26em;text-transform:uppercase;color:var(--ink-soft);margin:0 0 1.5em}
.big{font-size:clamp(17px,2.9cqw,46px);line-height:1.22;margin:0}
.body{font-size:clamp(11px,1.42cqw,23px);line-height:1.45;color:var(--ink-soft);margin:.7em 0 0}
.note{font-size:clamp(11px,1.3cqw,20px);line-height:1.45;color:var(--ink-soft)}
.stage{container-type:inline-size}
.fill{flex:1;display:flex;align-items:center;justify-content:center;min-height:0}
.fill svg{width:100%;height:100%}
.fill img{max-width:100%;max-height:100%;object-fit:contain}
.rule{height:2px;background:var(--rule);width:9%;margin:1.1em 0 0}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:4%;flex:1;min-height:0;align-content:center}
.col{display:flex;flex-direction:column;justify-content:center}
.col .lab{font-size:clamp(8px,.98cqw,15px);letter-spacing:.2em;text-transform:uppercase;color:var(--ink-soft);margin-bottom:.9em}
.quote{font-size:clamp(12px,1.82cqw,30px);line-height:1.3;border-left:3px solid var(--ink);padding-left:.8em}
.tag{position:absolute;left:6.5%;bottom:3.4%;font-size:clamp(7px,.9cqw,13px);letter-spacing:.22em;text-transform:uppercase;color:#9a9284}
.num{position:absolute;right:6.5%;bottom:3.4%;font-size:clamp(7px,.9cqw,13px);letter-spacing:.18em;color:#9a9284}
.stage.dark .slide{visibility:hidden}
.stage.dark .blackmsg{visibility:visible}
.blackmsg{
  position:absolute;inset:0;display:none;align-items:center;justify-content:center;
  color:#4a4438;font-size:14px;letter-spacing:.3em;text-transform:uppercase;
}
.stage.dark .blackmsg{display:flex}

/* ---------------------------------------------------- shared chrome */
.wrap{max-width:1180px;margin:0 auto;padding:34px 22px 60px}
.brand{font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:#8d8575;margin:0 0 26px}
.h{font-size:34px;line-height:1.1;margin:0 0 .5em;font-weight:400}
.sub{color:#9c9484;font-size:16px;line-height:1.5;margin:0 0 30px;max-width:62ch}
.card{
  background:var(--chrome);border:1px solid var(--chrome-line);
  border-radius:12px;padding:20px 22px;margin:0 0 14px;
}
.card h3{margin:0 0 4px;font-size:21px;font-weight:400}
.card .meta{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#8d8575;margin:0 0 10px}
.card p{margin:0;color:#9c9484;font-size:15px;line-height:1.5}
.card .act{margin-top:16px}
button,.btn{
  font:inherit;font-size:15px;color:var(--chrome-ink);background:transparent;
  border:1px solid #585243;border-radius:999px;padding:7px 18px;cursor:pointer;
}
button:hover,.btn:hover{background:#3a362d}
button.on{background:var(--chrome-ink);color:var(--chrome);border-color:var(--chrome-ink)}
button:disabled{opacity:.4;cursor:default}
button:disabled:hover{background:transparent}
input{
  font:inherit;font-size:17px;color:var(--chrome-ink);background:#0f0e0b;
  border:1px solid #585243;border-radius:8px;padding:9px 12px;width:100%;
}
input::placeholder{color:#6d6758}
select{
  font:inherit;font-size:17px;color:var(--chrome-ink);background:#0f0e0b;
  border:1px solid #585243;border-radius:8px;padding:9px 12px;width:100%;
}
label{display:block;font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#8d8575;margin:0 0 7px}
.field{margin:0 0 14px}
.err{color:#d9a38c;font-size:14px;margin:10px 0 0;min-height:1.2em}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}

/* ---------------------------------------------------- teacher */
#teach{padding:14px 16px 16px;display:grid;gap:14px;grid-template-columns:minmax(0,1fr) 330px;min-height:100vh}
#teach .left{display:flex;flex-direction:column;gap:12px;min-width:0}
#teach .right{display:flex;flex-direction:column;gap:12px;min-width:0;max-height:calc(100vh - 30px);overflow:auto}
.panel{background:var(--chrome);border:1px solid var(--chrome-line);border-radius:10px;padding:13px 15px}
.panel h4{margin:0 0 9px;font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#8d8575;font-weight:400}
.cue{font-size:16px;line-height:1.5;color:#e7e1d3;margin:0}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.pos{font-size:15px;color:#9c9484;min-width:76px}
.slidelist{list-style:none;margin:0;padding:0;font-size:14px}
.slidelist li{display:flex;gap:9px;padding:5px 7px;border-radius:6px;cursor:pointer;color:#9c9484;align-items:baseline}
.slidelist li:hover{background:#2a2720}
.slidelist li.cur{background:#332f26;color:#f1ebdd}
.slidelist li .n{color:#6d6758;min-width:20px;text-align:right;font-size:12px}
.roster{list-style:none;margin:0;padding:0;font-size:14px;color:#9c9484}
.roster li{padding:3px 0;display:flex;justify-content:space-between;gap:8px}
.roster li.lost{color:#e6bda6}
.lostpill{background:#4a2f22;color:#f0cdb6;border-radius:999px;padding:1px 9px;font-size:12px}
.joinline{font-size:13px;color:#8d8575;line-height:1.6;word-break:break-all}
.joinline b{color:#ded8ca;font-weight:400;letter-spacing:.12em}
@media (max-width:1000px){
  #teach{grid-template-columns:1fr}
  #teach .right{max-height:none}
}

/* ---------------------------------------------------- student */
#watch{min-height:100vh;display:flex;flex-direction:column;padding:12px}
#watch .top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#8d8575;padding:2px 4px 10px}
#watch .stagewrap{flex:1}
#watch .foot{display:flex;justify-content:center;gap:10px;padding:12px 4px 4px;flex-wrap:wrap}
#handout{
  background:var(--paper);color:var(--ink);border-radius:10px;padding:26px 30px;
  margin:14px auto 0;max-width:72ch;font-size:16px;line-height:1.6;
}
#handout h4{margin:0 0 .6em;font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:var(--ink-soft);font-weight:400}
#handout p{margin:0 0 .85em}
#handout ol{margin:0 0 .85em;padding-left:1.4em}
#handout blockquote{margin:0 0 .85em;padding-left:.9em;border-left:3px solid var(--ink);font-style:italic}
.dead{text-align:center;color:#8d8575;padding:40px 10px;font-size:16px}
.ended{
  position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
  flex-direction:column;gap:10px;background:var(--paper);color:var(--ink);
  font-size:clamp(16px,2.2cqw,34px);text-align:center;padding:8%;
}
.ended small{font-size:.5em;color:var(--ink-soft);letter-spacing:.1em;text-transform:uppercase}
.logform{display:flex;flex-direction:column;gap:8px}
.logform textarea{
  font:inherit;font-size:14px;color:var(--chrome-ink);background:#0f0e0b;
  border:1px solid #585243;border-radius:8px;padding:8px 10px;width:100%;
  min-height:52px;resize:vertical;
}
.logform label{margin:0}
.runs{list-style:none;margin:0;padding:0;font-size:13px;color:#9c9484}
.runs li{padding:4px 0;border-top:1px solid #2e2b24}
.runs li:first-child{border-top:0}
</style>
</head>
<body>

<!-- ============================================ landing -->
<div id="home" class="wrap">
  <p class="brand">Kinspire &middot; Classroom</p>
  <h1 class="h">Join a class.</h1>
  <p class="sub">Put in the code your teacher read out. Nothing to install, no account to make. The teacher drives the slides and you see whatever is on screen right now.</p>

  <div class="card">
    <h3>Join a class</h3>
    <p class="meta">Students</p>
    <div class="row" style="align-items:flex-end;gap:12px;margin-top:12px">
      <div class="field" style="flex:0 0 160px;margin:0">
        <label for="jcode">Class code</label>
        <input id="jcode" maxlength="5" autocapitalize="characters" autocomplete="off" placeholder="ABCDE">
      </div>
      <div class="field" style="flex:1 1 200px;margin:0">
        <label for="jname">Your name</label>
        <input id="jname" maxlength="24" autocomplete="off" placeholder="what the teacher should call you">
      </div>
      <button id="jgo">Join</button>
    </div>
    <p class="err" id="jerr"></p>
  </div>

  <p class="sub" style="margin-top:-4px"><a href="/board" style="color:#bdb5a4">The notice board: what is being taught, when, and how many seats are left</a><br><a href="/classes" style="color:#bdb5a4">Every class in the catalog, with levels, lengths and age ratings</a></p>

  <div id="teachgate" style="margin-top:36px">
    <button id="tashow">Teacher access</button>
  </div>

  <div id="tasign" hidden style="margin-top:16px">
    <div class="card">
      <h3>Teacher access</h3>
      <p class="meta">Darkageon, Shawn and Tony</p>
      <p>Your teacher code is the same one you use on the notice board.</p>
      <div class="row" style="align-items:flex-end;gap:12px;margin-top:14px">
        <div class="field" style="flex:1 1 220px;margin:0">
          <label for="tacode">Teacher code</label>
          <input id="tacode" maxlength="64" autocapitalize="characters" autocomplete="off" placeholder="six characters">
        </div>
        <button id="tago">Sign in</button>
        <button id="tacancel">Not me</button>
      </div>
      <p class="err" id="taerr"></p>
    </div>
  </div>

  <div id="teachpanel" hidden>
    <h2 class="h" style="font-size:22px;margin:36px 0 6px">Start a class</h2>
    <p class="sub" id="tawho" style="margin-bottom:18px"></p>
    <div class="card">
      <div class="row" style="gap:12px;align-items:flex-start">
        <div class="field" style="flex:1 1 180px;margin:0">
          <label for="pcat">Category</label>
          <select id="pcat"></select>
        </div>
        <div class="field" style="flex:0 1 150px;margin:0" id="ptierwrap">
          <label for="ptier">Level</label>
          <select id="ptier"></select>
        </div>
        <div class="field" style="flex:2 1 300px;margin:0">
          <label for="pclass">Class</label>
          <select id="pclass"></select>
        </div>
      </div>
      <p class="meta" id="pnote" style="margin:16px 0 0;letter-spacing:0;text-transform:none;font-size:14px;color:#9c9484"></p>
      <div class="act row" style="gap:10px">
        <button id="pgo" class="on">Start this class</button>
        <button id="taout">Sign out</button>
      </div>
      <p class="err" id="perr"></p>
    </div>
  </div>
</div>

<!-- ============================================ teacher -->
<div id="teach" hidden>
  <div class="left">
    <div class="stagewrap"><div class="stage" id="tstage"></div></div>
    <div class="panel">
      <div class="bar">
        <button id="tprev">&larr;</button>
        <span class="pos" id="tpos">1 / 1</span>
        <button id="tnext">&rarr;</button>
        <button id="tblack">Blackout</button>
        <button id="tfull">Full screen</button>
        <button id="thc">High contrast</button>
        <button id="thand">Release handout</button>
        <span style="flex:1"></span>
        <span class="pos" id="tcount">0 watching</span>
        <button id="tclear" hidden>Clear hands</button>
      </div>
    </div>
    <div class="panel">
      <h4>Say this <span id="tnextlab" style="float:right;letter-spacing:.1em;text-transform:none;font-size:12px"></span></h4>
      <p class="cue" id="tcue"></p>
    </div>
  </div>

  <div class="right">
    <div class="panel">
      <h4>The room</h4>
      <p class="joinline">Class code <b id="tcode">-----</b></p>
      <p class="joinline" style="margin-top:8px">Student link<br><span id="tlink"></span></p>
      <div class="act" style="margin-top:12px"><button id="tcopy">Copy student link</button></div>
    </div>
    <div class="panel">
      <h4>Deck</h4>
      <div class="row" id="tdecks"></div>
    </div>
    <div class="panel">
      <h4>Slides</h4>
      <ul class="slidelist" id="tlist"></ul>
    </div>
    <div class="panel">
      <h4>Watching <span id="tteachers" style="float:right;letter-spacing:.1em;text-transform:none;font-size:12px"></span></h4>
      <ul class="roster" id="troster"></ul>
    </div>
    <div class="panel">
      <h4>After the run</h4>
      <div class="row" style="margin-bottom:10px">
        <button id="tend">End the class</button>
        <button id="tlogopen">Log this run</button>
      </div>
      <div id="tlogform" class="logform" hidden>
        <div><label for="lgatt">Attended</label>
          <input id="lgatt" inputmode="numeric" style="font-size:15px;padding:6px 10px"></div>
        <div><label for="lgbroke">What broke?</label>
          <textarea id="lgbroke"></textarea></div>
        <div><label for="lgconf">What confused people that should not have?</label>
          <textarea id="lgconf"></textarea></div>
        <div><label for="lgtried">What did somebody try that did not work?</label>
          <textarea id="lgtried"></textarea></div>
        <div><label for="lgnotes">Anything else</label>
          <textarea id="lgnotes"></textarea></div>
        <div class="row"><button id="lgsave">Save to the log</button>
          <button id="lgcancel">Cancel</button></div>
      </div>
      <ul class="runs" id="truns"></ul>
      <div class="act" style="margin-top:10px"><button id="tlogdl">Download the run log</button></div>
    </div>
  </div>
</div>

<!-- ============================================ student -->
<div id="watch" hidden>
  <div class="top">
    <span id="wtitle"></span>
    <span id="wpos"></span>
  </div>
  <div class="stagewrap"><div class="stage" id="wstage"></div></div>
  <div class="foot">
    <button id="wlost">I am not following</button>
    <button id="wfull">Full screen</button>
    <button id="whc">High contrast</button>
    <button id="whand" hidden>Handout</button>
  </div>
  <div id="handout" hidden></div>
</div>

<div id="dead" class="dead" hidden></div>

<script>
(function(){
  "use strict";

  var $ = function(id){ return document.getElementById(id); };
  var home = $("home"), teach = $("teach"), watch = $("watch"), dead = $("dead");

  /* ------------------------------------------------ slide rendering */

  // The markup comes from the server, which is the only source of slides.
  // It is this project's own content, built by build/build_decks.py, and it
  // carries no script: slides are shapes and type.
  function render(stage, show, pos, total, tag){
    stage.innerHTML = "";
    var sec = document.createElement("section");
    sec.className = "slide" + (show.cls ? " " + show.cls : "");
    sec.innerHTML = show.html || "";
    if (tag){
      var t = document.createElement("span");
      t.className = "tag"; t.textContent = tag;
      sec.appendChild(t);
    }
    if (total){
      var n = document.createElement("span");
      n.className = "num"; n.textContent = (pos + 1) + " / " + total;
      sec.appendChild(n);
    }
    stage.appendChild(sec);
    var b = document.createElement("div");
    b.className = "blackmsg"; b.textContent = "screen is down";
    stage.appendChild(b);
  }

  // The handout is markdown-ish and short. Only the shapes it actually
  // uses are handled: bold, blockquote, numbered list, paragraph.
  function esc(s){
    return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }
  function handoutHtml(src){
    var out = [], list = null;
    src.split(/\n{2,}/).forEach(function(block){
      var b = block.trim();
      if (!b) return;
      if (/^> /.test(b)){
        out.push("<blockquote>" + inline(b.replace(/^> /gm,"")) + "</blockquote>");
        return;
      }
      if (/^\d+\. /.test(b)){
        var items = b.split(/\n/).map(function(l){
          return "<li>" + inline(l.replace(/^\d+\.\s*/,"")) + "</li>";
        });
        out.push("<ol>" + items.join("") + "</ol>");
        return;
      }
      out.push("<p>" + inline(b) + "</p>");
    });
    return out.join("");
  }
  function inline(s){
    return esc(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  }

  /* ------------------------------------------------ socket */

  var sock = null, role = null, roomCode = null, teacherToken = null, myName = "";
  var retry = 0, closedOnPurpose = false;

  function wsUrl(){
    var p = location.protocol === "https:" ? "wss:" : "ws:";
    var q = "code=" + encodeURIComponent(roomCode);
    if (role === "teacher") q += "&role=teacher&token=" + encodeURIComponent(teacherToken);
    else q += "&role=student&name=" + encodeURIComponent(myName);
    return p + "//" + location.host + "/ws?" + q;
  }

  function connect(){
    closedOnPurpose = false;
    sock = new WebSocket(wsUrl());
    sock.onopen = function(){ retry = 0; };
    sock.onmessage = function(e){
      var v;
      try { v = JSON.parse(e.data); } catch (err) { return; }
      if (v.t === "teacher") paintTeacher(v);
      else if (v.t === "student") paintStudent(v);
    };
    sock.onclose = function(){
      if (closedOnPurpose) return;
      retry += 1;
      if (retry > 30){
        show(dead);
        dead.textContent = "Lost the connection to the class. Reload to rejoin.";
        return;
      }
      setTimeout(connect, Math.min(800 * retry, 6000));
    };
  }

  function send(msg){
    if (sock && sock.readyState === 1) sock.send(JSON.stringify(msg));
  }

  function show(el){
    [home, teach, watch, dead].forEach(function(x){ x.hidden = x !== el; });
  }

  /* ------------------------------------------------ teacher view */

  var tTotal = 1, tSlide = 0, tBlack = false, tHand = false, tDeckId = null;

  function paintTeacher(v){
    show(teach);
    tTotal = v.deck.total; tSlide = v.slide;
    tBlack = v.blackout; tHand = v.handoutOut; tDeckId = v.deck.id;

    render($("tstage"), v.show, v.slide, v.deck.total, v.deck.id + "  " + v.deck.title);
    $("tstage").classList.toggle("dark", v.blackout);

    $("tpos").textContent = (v.slide + 1) + " / " + v.deck.total;
    $("tcue").textContent = v.note || "";
    $("tnextlab").textContent = v.nextLabel ? "next: " + v.nextLabel : "last slide";
    $("tcode").textContent = v.code;

    var link = location.origin + "/#s/" + v.code;
    $("tlink").textContent = link;
    $("tcopy").dataset.link = link;

    $("tblack").classList.toggle("on", v.blackout);
    $("tblack").textContent = v.blackout ? "Screen is down" : "Blackout";
    $("thand").classList.toggle("on", v.handoutOut);
    $("thand").textContent = v.handoutOut ? "Handout is out" : "Release handout";
    $("tprev").disabled = v.slide === 0;
    $("tnext").disabled = v.slide === v.deck.total - 1;

    $("tcount").textContent = v.students.length + " watching"
      + (v.peak > v.students.length ? ", peak " + v.peak : "");
    $("tteachers").textContent = v.teachers > 1
      ? v.teachers + " of you are driving" : "";
    $("tend").textContent = v.ended ? "Reopen the class" : "End the class";
    $("tend").classList.toggle("on", v.ended);
    var runs = $("truns");
    runs.innerHTML = "";
    (v.runs || []).slice().reverse().forEach(function(r){
      var li = document.createElement("li");
      var d = new Date(r.at);
      li.textContent = r.deck + "  " + d.toISOString().slice(0, 10)
        + "  " + r.attended + " attended";
      runs.appendChild(li);
    });
    if (!(v.runs || []).length){
      var li0 = document.createElement("li");
      li0.textContent = "nothing logged in this room yet";
      runs.appendChild(li0);
    }
    $("tlogdl").dataset.url = "/api/log?code=" + encodeURIComponent(v.code)
      + "&token=" + encodeURIComponent(teacherToken || "");
    $("tclear").hidden = v.lost === 0;
    $("tclear").textContent = "Clear " + v.lost + (v.lost === 1 ? " hand" : " hands");

    var list = $("tlist");
    list.innerHTML = "";
    v.deck.labels.forEach(function(lab, i){
      var li = document.createElement("li");
      if (i === v.slide) li.className = "cur";
      var n = document.createElement("span");
      n.className = "n"; n.textContent = i + 1;
      var s = document.createElement("span");
      s.textContent = lab;
      li.appendChild(n); li.appendChild(s);
      li.onclick = function(){ send({ t:"go", n:i }); };
      list.appendChild(li);
    });

    var decks = $("tdecks");
    decks.innerHTML = "";
    v.catalog.forEach(function(d){
      var b = document.createElement("button");
      b.textContent = d.id + " " + d.title;
      if (d.id === v.deck.id) b.className = "on";
      b.onclick = function(){
        if (d.id === tDeckId) return;
        if (confirm("Switch to " + d.id + " " + d.title + "? This sends everyone back to slide 1.")) {
          send({ t:"deck", id:d.id });
        }
      };
      decks.appendChild(b);
    });

    var ros = $("troster");
    ros.innerHTML = "";
    if (!v.students.length){
      var li0 = document.createElement("li");
      li0.textContent = "nobody yet";
      ros.appendChild(li0);
    }
    v.students.forEach(function(s){
      var li = document.createElement("li");
      if (s.lost) li.className = "lost";
      var nm = document.createElement("span");
      nm.textContent = s.name;
      li.appendChild(nm);
      if (s.lost){
        var p = document.createElement("span");
        p.className = "lostpill"; p.textContent = "not following";
        li.appendChild(p);
      }
      ros.appendChild(li);
    });
  }

  $("tprev").onclick  = function(){ send({ t:"prev" }); };
  $("tnext").onclick  = function(){ send({ t:"next" }); };
  $("tblack").onclick = function(){ send({ t:"blackout" }); };
  $("thand").onclick  = function(){ send({ t:"handout" }); };
  $("tclear").onclick = function(){ send({ t:"clearLost" }); };
  $("tend").onclick   = function(){
    send({ t: $("tend").classList.contains("on") ? "reopen" : "end" });
  };
  $("thc").onclick    = function(){ contrast($("tstage"), $("thc")); };
  $("tlogopen").onclick = function(){
    var f = $("tlogform");
    f.hidden = !f.hidden;
    if (!f.hidden) $("lgbroke").focus();
  };
  $("lgcancel").onclick = function(){ $("tlogform").hidden = true; };
  $("lgsave").onclick = function(){
    send({
      t: "logRun",
      attended: parseInt($("lgatt").value, 10) || 0,
      broke: $("lgbroke").value,
      confused: $("lgconf").value,
      tried: $("lgtried").value,
      notes: $("lgnotes").value,
    });
    ["lgatt","lgbroke","lgconf","lgtried","lgnotes"].forEach(function(id){ $(id).value = ""; });
    $("tlogform").hidden = true;
  };
  $("tlogdl").onclick = function(){
    var u = $("tlogdl").dataset.url;
    if (u) window.open(u, "_blank");
  };

  // Remembered per viewer, because it is a viewer's own accessibility choice
  // and the room should not be deciding it for everyone.
  function contrast(stage, btn){
    var on = !stage.classList.contains("hc");
    stage.classList.toggle("hc", on);
    btn.classList.toggle("on", on);
    btn.textContent = on ? "Normal contrast" : "High contrast";
    try { localStorage.setItem("kinspire.hc", on ? "1" : "0"); } catch (e) {}
  }
  function restoreContrast(stage, btn){
    var on = false;
    try { on = localStorage.getItem("kinspire.hc") === "1"; } catch (e) {}
    if (on) contrast(stage, btn);
  }
  $("tcopy").onclick  = function(){
    var link = $("tcopy").dataset.link || "";
    var done = function(){ $("tcopy").textContent = "Copied"; setTimeout(function(){
      $("tcopy").textContent = "Copy student link"; }, 1400); };
    if (navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(link).then(done, function(){});
    }
  };

  // Same keys as the standalone deck, so the muscle memory carries over.
  document.addEventListener("keydown", function(e){
    if (role !== "teacher" || teach.hidden) return;
    if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    var k = e.key;
    if (k === "ArrowRight" || k === " " || k === "PageDown"){ send({t:"next"}); e.preventDefault(); }
    else if (k === "ArrowLeft" || k === "PageUp"){ send({t:"prev"}); e.preventDefault(); }
    else if (k === "Home"){ send({t:"first"}); e.preventDefault(); }
    else if (k === "End"){ send({t:"last"}); e.preventDefault(); }
    else if (k === "b" || k === "."){ send({t:"blackout"}); e.preventDefault(); }
    else if (/^[0-9]$/.test(k)){
      // digits build a slide number, so decks past nine are reachable
      pending += k;
      clearTimeout(pendTimer);
      pendTimer = setTimeout(function(){
        var n = parseInt(pending, 10); pending = "";
        if (n >= 1) send({ t:"go", n: n - 1 });
      }, 420);
      e.preventDefault();
    }
  });
  var pending = "", pendTimer = null;

  /* ------------------------------------------------ student view */

  function paintStudent(v){
    show(watch);
    if (v.ended){
      var st = $("wstage");
      st.innerHTML = "";
      st.classList.remove("dark");
      var e = document.createElement("div");
      e.className = "ended";
      e.innerHTML = "<small>" + v.title.replace(/[<>&]/g, "") + "</small>"
        + "<div>That is the end of the class.</div>"
        + "<small>You can close this tab.</small>";
      st.appendChild(e);
      $("wpos").textContent = "finished";
      $("whand").hidden = !v.handoutOut;
      $("wlost").hidden = true;
      return;
    }
    $("wlost").hidden = false;
    render($("wstage"), v.show, v.slide, v.total, v.title);
    $("wstage").classList.toggle("dark", v.blackout);
    $("wtitle").textContent = v.track + " · " + v.title;
    $("wpos").textContent = v.blackout ? "screen is down" : (v.slide + 1) + " of " + v.total;
    $("wlost").classList.toggle("on", v.lost);
    $("wlost").textContent = v.lost ? "Hand is up" : "I am not following";
    $("whand").hidden = !v.handoutOut;
    if (!v.handoutOut){
      $("handout").hidden = true;
      $("handout").innerHTML = "";
    } else if ($("handout").dataset.src !== v.handout){
      $("handout").dataset.src = v.handout;
      $("handout").innerHTML = "<h4>Handout</h4>" + handoutHtml(v.handout);
    }
  }

  $("wlost").onclick = function(){
    send({ t:"lost", on: !$("wlost").classList.contains("on") });
  };

  // Full screen on the stage rather than the document, so the chrome goes and
  // the slide grows. Wrapped because the API is refused outside a gesture and
  // is absent in a few embedded browsers.
  function fullscreen(el, btn){
    try {
      if (document.fullscreenElement){
        document.exitFullscreen();
      } else if (el.requestFullscreen){
        el.requestFullscreen().catch(function(){});
      } else if (el.webkitRequestFullscreen){
        el.webkitRequestFullscreen();
      } else {
        btn.hidden = true;
      }
    } catch (e) { btn.hidden = true; }
  }
  $("wfull").onclick = function(){ fullscreen($("wstage").parentNode, $("wfull")); };
  $("tfull").onclick = function(){ fullscreen($("tstage").parentNode, $("tfull")); };
  document.addEventListener("fullscreenchange", function(){
    var on = !!document.fullscreenElement;
    $("wfull").textContent = on ? "Exit full screen" : "Full screen";
    $("tfull").textContent = on ? "Exit full screen" : "Full screen";
  });
  $("whc").onclick = function(){ contrast($("wstage"), $("whc")); };
  $("whand").onclick = function(){
    $("handout").hidden = !$("handout").hidden;
    if (!$("handout").hidden) $("handout").scrollIntoView({ behavior:"smooth", block:"start" });
  };

  /* ------------------------------------------------ landing */

  var CATS = [], BUILT = [], boardTok = "", boardWho = "";

  function readTok(){
    try { return localStorage.getItem("kinspire.board.tok") || ""; } catch (e) { return ""; }
  }
  function readWho(){
    try { return localStorage.getItem("kinspire.board.who") || "you"; } catch (e) { return "you"; }
  }

  // The teacher panel and the notice board share one sign in. A teacher who
  // signed in on the board walks straight into this page already a teacher,
  // and there is only ever one list of who the teachers are.
  function catalog(){
    fetch("/api/catalog").then(function(r){ return r.json(); }).then(function(d){
      CATS = d.categories || [];
      BUILT = d.built || [];
      fillCats();
      boardTok = readTok();
      if (boardTok) teacherMode(readWho());
    }).catch(function(){
      $("perr").textContent = "Could not load the class list. Reload.";
    });
  }

  function opt(sel, items, label){
    sel.innerHTML = "";
    items.forEach(function(it){
      var o = document.createElement("option");
      o.value = it.value; o.textContent = it.text;
      sel.appendChild(o);
    });
    sel.disabled = items.length < 2 && label !== "class";
  }

  function fillCats(){
    opt($("pcat"), CATS.map(function(c){ return { value:c.id, text:c.name }; }), "cat");
    fillTiers();
  }

  function cat(){ return CATS.filter(function(c){ return c.id === $("pcat").value; })[0]; }

  function fillTiers(){
    var c = cat(); if (!c) return;
    // a category with one level is not a question worth asking
    $("ptierwrap").hidden = c.tiers.length < 2;
    opt($("ptier"), c.tiers.map(function(t){ return { value:t.id, text:t.name }; }), "tier");
    fillClasses();
  }

  function tier(){
    var c = cat(); if (!c) return null;
    return c.tiers.filter(function(t){ return t.id === $("ptier").value; })[0] || c.tiers[0];
  }

  function fillClasses(){
    var t = tier(); if (!t) return;
    opt($("pclass"), t.classes.map(function(k){
      return { value:k.id, text:k.id + ". " + k.title + (BUILT.indexOf(k.id) < 0 ? "" : "  (deck built)") };
    }), "class");
    noteClass();
  }

  function noteClass(){
    var id = $("pclass").value;
    $("pnote").textContent = BUILT.indexOf(id) < 0
      ? "No deck is built for this one yet. The room still works: a code, the roster, "
        + "the hand-raise, the blackout, full screen and the run log. One slide with the class name on it."
      : "This class has a full deck. The room opens on slide one with your cues in the panel.";
  }

  function teacherMode(name){
    boardWho = name || "you";
    $("teachgate").hidden = true;
    $("tasign").hidden = true;
    $("teachpanel").hidden = false;
    $("tawho").textContent = "Signed in as " + boardWho
      + ". Every class in the catalog is here, whether or not a deck is built for it.";
  }

  function signOut(){
    boardTok = "";
    try {
      localStorage.removeItem("kinspire.board.tok");
      localStorage.removeItem("kinspire.board.who");
    } catch (e) {}
    $("teachpanel").hidden = true;
    $("teachgate").hidden = false;
    $("tasign").hidden = true;
    $("tacode").value = "";
  }

  function teacherSignIn(){
    var c = ($("tacode").value || "").trim();
    if (!c){ $("taerr").textContent = "Enter your teacher code."; return; }
    $("taerr").textContent = "";
    fetch("/api/board/signin", {
      method:"POST",
      headers:{ "content-type":"application/json" },
      body: JSON.stringify({ code: c }),
    }).then(function(r){ return r.json(); }).then(function(d){
      if (!d.ok){ $("taerr").textContent = d.error || "That code is not on the board."; return; }
      boardTok = d.token;
      try {
        localStorage.setItem("kinspire.board.tok", d.token);
        localStorage.setItem("kinspire.board.who", d.name || "you");
      } catch (e) {}
      teacherMode(d.name);
    }).catch(function(){ $("taerr").textContent = "Could not reach the board."; });
  }

  function openRoom(deckId, btn){
    fetch("/api/open", {
      method:"POST",
      headers:{ "content-type":"application/json" },
      body: JSON.stringify({ deck: deckId, token: boardTok || readTok() }),
    }).then(function(r){ return r.json(); }).then(function(d){
      if (!d.code){
        if (btn) btn.disabled = false;
        if ($("perr")) $("perr").textContent = d.error || "Could not open the room.";
        if (!btn){
          show(dead);
          dead.textContent = (d.error || "Could not open the room.")
            + " Sign in with your teacher code on the classroom page first.";
        }
        return;
      }
      roomCode = d.code; teacherToken = d.token; role = "teacher";
      try { localStorage.setItem("kinspire.teach." + d.code, d.token); } catch (e) {}
      location.hash = "t/" + d.code + "/" + d.token;
      connect();
    }).catch(function(){ if (btn) btn.disabled = false; });
  }

  function joinRoom(){
    var c = ($("jcode").value || "").toUpperCase().replace(/[^A-Z2-9]/g, "");
    myName = ($("jname").value || "").trim();
    if (c.length !== 5){ $("jerr").textContent = "A class code is five characters."; return; }
    $("jerr").textContent = "";
    fetch("/api/join", {
      method:"POST",
      headers:{ "content-type":"application/json" },
      body: JSON.stringify({ code: c }),
    }).then(function(r){ return r.json(); }).then(function(d){
      if (!d.ok){ $("jerr").textContent = d.error || "Could not join."; return; }
      roomCode = c; role = "student";
      try { localStorage.setItem("kinspire.name", myName); } catch (e) {}
      location.hash = "s/" + c;
      connect();
      setTimeout(function(){ restoreContrast($("wstage"), $("whc")); }, 400);
    }).catch(function(){ $("jerr").textContent = "Could not reach the class."; });
  }

  $("jgo").onclick = joinRoom;
  $("tashow").onclick = function(){
    $("teachgate").hidden = true; $("tasign").hidden = false; $("tacode").focus();
  };
  $("tacancel").onclick = function(){ $("tasign").hidden = true; $("teachgate").hidden = false; };
  $("tago").onclick = teacherSignIn;
  $("tacode").addEventListener("keydown", function(e){ if (e.key === "Enter") teacherSignIn(); });
  $("taout").onclick = signOut;
  $("pcat").onchange = fillTiers;
  $("ptier").onchange = fillClasses;
  $("pclass").onchange = noteClass;
  $("pgo").onclick = function(){
    var b = $("pgo"); b.disabled = true; $("perr").textContent = "";
    openRoom($("pclass").value, b);
  };
  $("jcode").addEventListener("keydown", function(e){ if (e.key === "Enter") joinRoom(); });
  $("jname").addEventListener("keydown", function(e){ if (e.key === "Enter") joinRoom(); });

  /* ------------------------------------------------ boot */

  function boot(){
    try { $("jname").value = localStorage.getItem("kinspire.name") || ""; } catch (e) {}

    var h = (location.hash || "").replace(/^#/, "").split("/");

    // arrived from the notice board, which knows which class this is
    if (h[0] === "new" && /^[A-Z][0-9]+(\.[0-9]+)?$/.test(h[1] || "")){
      show(home);
      catalog();
      openRoom(h[1], null);
      return;
    }

    if (h[0] === "t" && /^[A-Z2-9]{5}$/.test(h[1] || "")){
      roomCode = h[1];
      teacherToken = h[2] || "";
      if (!teacherToken){
        try { teacherToken = localStorage.getItem("kinspire.teach." + roomCode) || ""; } catch (e) {}
      }
      if (teacherToken){
        role = "teacher"; connect();
        setTimeout(function(){ restoreContrast($("tstage"), $("thc")); }, 400);
        return;
      }
    }
    if (h[0] === "s" && /^[A-Z2-9]{5}$/.test(h[1] || "")){
      $("jcode").value = h[1];
      show(home);
      catalog();
      // a student arriving by link still gives a name, which is one field
      setTimeout(function(){ $("jname").focus(); }, 60);
      return;
    }

    show(home);
    catalog();
  }

  boot();

  // Exposed for the end-to-end test. Reading it changes nothing.
  window.__room = {
    state: function(){
      return { role: role, code: roomCode, slide: tSlide, total: tTotal,
               black: tBlack, handout: tHand, deck: tDeckId };
    },
    send: send,
  };
})();
</script>
</body>
</html>`;
