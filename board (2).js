/**
 * The notice board. One Durable Object, shared by everybody.
 *
 * Teachers sign in with a code and post a class from the catalog. Players do
 * not sign in at all: they look, they click attend, they give a name, and the
 * count moves.
 *
 * Three things are worth saying plainly about the design.
 *
 *   1. A player gives a name and gets a ticket, which is not an account. The
 *      teacher needs a roster or the cap is a number with nothing behind it,
 *      and the player needs a way to give a seat back.
 *
 *   2. **This cannot verify a payment.** Nothing here talks to a payment
 *      processor. A paid class holds the seat, sends the player to the
 *      teacher's own payment link, and waits for the teacher to confirm.
 *      Holds expire so a cap is never locked up by somebody who wandered off.
 *      Any other design would be pretending to a check it does not perform.
 *
 *   3. A player is never sent another attendee's name. The public view of a
 *      listing carries counts and nothing else, the same rule the classroom
 *      uses for slides.
 */
import { DurableObject } from "cloudflare:workers";
import { CATEGORIES, CLASS_INDEX } from "./catalog.js";

/* ------------------------------------------------------------ ids */

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

function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ------------------------------------------------------------ limits */

const HOLD_MINUTES = 30;          // how long a paid seat waits for payment
const MAX_LISTINGS = 400;
const MAX_CAP = 200;
const MAX_FEE_CENTS = 100000;     // a thousand of whatever currency
const KEEP_PAST_DAYS = 45;        // a finished class stays visible this long

function clean(v, len) {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, len) : "";
}

function cleanBlurb(v) {
  return typeof v === "string" ? v.replace(/[ \t]+/g, " ").trim().slice(0, 700) : "";
}

function num(v, lo, hi, dflt) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

// Only http(s), and never a javascript: or data: URL dressed up as a link.
function cleanUrl(v) {
  const s = clean(v, 500);
  if (!s) return "";
  let u;
  try { u = new URL(s); } catch { return ""; }
  return (u.protocol === "https:" || u.protocol === "http:") ? u.toString() : "";
}

/* ------------------------------------------------------------ durable object */

export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.db = null;
    ctx.blockConcurrencyWhile(async () => {
      this.db = (await ctx.storage.get("board")) || {
        teachers: {},
        tokens: {},
        listings: [],
        nextId: 1,
        created: Date.now(),
      };
      this.db.teachers ||= {};
      this.db.tokens ||= {};
      this.db.listings ||= [];
      this.db.nextId ||= 1;
    });
  }

  save() { return this.ctx.storage.put("board", this.db); }

  // The built-in code, used only when no ADMIN_CODE secret is set. It lives in
  // this file, which means it lives in the repository and in the build log, so
  // it is weaker than a secret and the admin panel says so. A secret set in the
  // Cloudflare dashboard overrides it with no code change.
  static BUILT_IN = "LEAKY-DRUID-ROD";

  adminCode() {
    return (this.env && this.env.ADMIN_CODE) || Board.BUILT_IN;
  }

  usingBuiltIn() {
    return !(this.env && this.env.ADMIN_CODE);
  }

  /* ---------------------------------------------------------- housekeeping */

  // Lazy rather than on a timer: a hold is only ever wrong when somebody is
  // looking, and somebody looking is exactly when this runs.
  sweep() {
    const now = Date.now();
    let changed = false;
    for (const l of this.db.listings) {
      const before = l.seats.length;
      l.seats = l.seats.filter(s => !(s.state === "holding" && s.expires && s.expires < now));
      if (l.seats.length !== before) changed = true;
    }
    const cutoff = now - KEEP_PAST_DAYS * 86400000;
    const keep = this.db.listings.filter(l => l.startsAt > cutoff);
    if (keep.length !== this.db.listings.length) { this.db.listings = keep; changed = true; }

    for (const [t, v] of Object.entries(this.db.tokens)) {
      if (now - v.at > 30 * 86400000) { delete this.db.tokens[t]; changed = true; }
    }
    return changed;
  }

  /* ---------------------------------------------------------- auth */

  async signIn(given) {
    const c = clean(given, 64).toUpperCase();
    if (!c) return { ok: false, error: "Enter your code." };

    if (sameSecret(c, this.adminCode().toUpperCase())) {
      const t = token();
      this.db.tokens[t] = { role: "admin", name: "Admin", code: "", at: Date.now() };
      await this.save();
      return { ok: true, token: t, role: "admin", name: "Admin" };
    }

    const rec = this.db.teachers[c];
    if (!rec || rec.disabled) return { ok: false, error: "That code is not on the board." };
    const t = token();
    this.db.tokens[t] = { role: "teacher", name: rec.name, code: c, at: Date.now() };
    await this.save();
    return { ok: true, token: t, role: "teacher", name: rec.name };
  }

  who(t) {
    const v = this.db.tokens[clean(t, 80)];
    return v || null;
  }

  async addTeacher(tok, name) {
    const me = this.who(tok);
    if (!me || me.role !== "admin") return { ok: false, error: "Admins only." };
    const n = clean(name, 40);
    if (!n) return { ok: false, error: "Give the teacher a name." };
    let c;
    do { c = code(6); } while (this.db.teachers[c]);
    this.db.teachers[c] = { name: n, created: Date.now(), disabled: false };
    await this.save();
    return { ok: true, code: c, name: n };
  }

  async setTeacher(tok, teacherCode, disabled) {
    const me = this.who(tok);
    if (!me || me.role !== "admin") return { ok: false, error: "Admins only." };
    const rec = this.db.teachers[clean(teacherCode, 16).toUpperCase()];
    if (!rec) return { ok: false, error: "No such code." };
    rec.disabled = !!disabled;
    await this.save();
    return { ok: true };
  }

  async teacherList(tok) {
    const me = this.who(tok);
    if (!me || me.role !== "admin") return { ok: false, error: "Admins only." };
    const rows = Object.entries(this.db.teachers).map(([c, v]) => ({
      code: c, name: v.name, disabled: !!v.disabled,
      listings: this.db.listings.filter(l => l.teacherCode === c && l.status === "open").length,
    }));
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, teachers: rows, adminHint: this.usingBuiltIn() };
  }

  /* ---------------------------------------------------------- listings */

  seatCounts(l) {
    const confirmed = l.seats.filter(s => s.state === "confirmed").length;
    const holding = l.seats.filter(s => s.state === "holding").length;
    return { confirmed, holding, taken: confirmed + holding,
             available: Math.max(0, l.cap - confirmed - holding) };
  }

  // Everything a player is allowed to see. No names, no tickets, no code.
  publicListing(l) {
    const c = this.seatCounts(l);
    return {
      id: l.id, classId: l.classId, title: l.title,
      category: l.category, tier: l.tier, track: l.track,
      teacherName: l.teacherName,
      startsAt: l.startsAt, minutes: l.minutes,
      cap: l.cap, taken: c.taken, available: c.available, holding: c.holding,
      feeCents: l.feeCents, paid: l.feeCents > 0, payUrl: l.feeCents > 0 ? l.payUrl : "",
      blurb: l.blurb, status: l.status,
      hasRoom: !!l.roomCode,
    };
  }

  async listings() {
    if (this.sweep()) await this.save();
    const now = Date.now();
    const rows = this.db.listings
      .filter(l => l.status === "open" && l.startsAt > now - 4 * 3600000)
      .sort((a, b) => a.startsAt - b.startsAt)
      .map(l => this.publicListing(l));
    return { ok: true, listings: rows, categories: CATEGORIES, holdMinutes: HOLD_MINUTES };
  }

  async mine(tok) {
    const me = this.who(tok);
    if (!me) return { ok: false, error: "Sign in again." };
    if (this.sweep()) await this.save();
    const all = me.role === "admin"
      ? this.db.listings
      : this.db.listings.filter(l => l.teacherCode === me.code);
    const rows = all
      .slice()
      .sort((a, b) => b.startsAt - a.startsAt)
      .slice(0, 80)
      .map(l => ({
        ...this.publicListing(l),
        status: l.status,
        roomCode: l.roomCode || "",
        // the roster is the teacher's and nobody else's
        seats: l.seats.map(s => ({
          id: s.id, name: s.name, contact: s.contact,
          state: s.state, at: s.at, expires: s.expires || 0,
        })),
      }));
    return { ok: true, role: me.role, name: me.name, listings: rows };
  }

  async post(tok, body) {
    const me = this.who(tok);
    if (!me) return { ok: false, error: "Sign in again." };
    if (this.db.listings.length >= MAX_LISTINGS) {
      return { ok: false, error: "The board is full. Cancel something old first." };
    }

    const k = CLASS_INDEX[clean(body.classId, 12)];
    if (!k) return { ok: false, error: "Pick a class from the list." };

    const startsAt = Math.trunc(Number(body.startsAt));
    if (!Number.isFinite(startsAt) || startsAt <= 0) {
      return { ok: false, error: "Give the class a date and time." };
    }
    if (startsAt < Date.now() - 3600000) {
      return { ok: false, error: "That date and time is in the past." };
    }

    const feeCents = num(body.feeCents, 0, MAX_FEE_CENTS, 0);
    const payUrl = cleanUrl(body.payUrl);
    if (feeCents > 0 && !payUrl) {
      return { ok: false, error: "A paid class needs a payment link, starting http or https." };
    }

    const l = {
      id: this.db.nextId++,
      classId: k.id, title: k.title,
      category: k.category, tier: k.tier, track: k.track,
      teacherCode: me.code, teacherName: clean(body.teacherName, 40) || me.name,
      startsAt,
      minutes: num(body.minutes, 15, 480, 60),
      cap: num(body.cap, 1, MAX_CAP, 8),
      feeCents, payUrl,
      blurb: cleanBlurb(body.blurb),
      status: "open",
      roomCode: "",
      seats: [],
      created: Date.now(),
    };
    this.db.listings.push(l);
    await this.save();
    return { ok: true, listing: this.publicListing(l) };
  }

  find(id) {
    return this.db.listings.find(l => l.id === Math.trunc(Number(id)));
  }

  mayEdit(me, l) {
    return me && l && (me.role === "admin" || l.teacherCode === me.code);
  }

  async update(tok, body) {
    const me = this.who(tok);
    const l = this.find(body.id);
    if (!this.mayEdit(me, l)) return { ok: false, error: "Not yours to change." };

    if (body.cap !== undefined) {
      const cap = num(body.cap, 1, MAX_CAP, l.cap);
      const c = this.seatCounts(l);
      if (cap < c.taken) {
        return { ok: false, error: `${c.taken} people are already signed up. The cap cannot go below that.` };
      }
      l.cap = cap;
    }
    if (body.blurb !== undefined) l.blurb = cleanBlurb(body.blurb);
    if (body.roomCode !== undefined) {
      const rc = clean(body.roomCode, 5).toUpperCase();
      if (rc && !/^[A-Z2-9]{5}$/.test(rc)) {
        return { ok: false, error: "A room code is five characters." };
      }
      l.roomCode = rc;
    }
    if (body.status === "cancelled" || body.status === "open") l.status = body.status;
    await this.save();
    return { ok: true, listing: this.publicListing(l) };
  }

  async markSeat(tok, body) {
    const me = this.who(tok);
    const l = this.find(body.id);
    if (!this.mayEdit(me, l)) return { ok: false, error: "Not yours to change." };
    const s = l.seats.find(x => x.id === clean(body.seat, 24));
    if (!s) return { ok: false, error: "No such seat." };
    if (body.remove) {
      l.seats = l.seats.filter(x => x.id !== s.id);
    } else {
      s.state = body.paid ? "confirmed" : "holding";
      s.expires = body.paid ? 0 : Date.now() + HOLD_MINUTES * 60000;
    }
    await this.save();
    return { ok: true };
  }

  /* ---------------------------------------------------------- attending */

  async attend(body) {
    if (this.sweep()) await this.save();
    const l = this.find(body.id);
    if (!l || l.status !== "open") return { ok: false, error: "That class is no longer on the board." };
    if (l.startsAt < Date.now()) return { ok: false, error: "That class has already started." };

    const name = clean(body.name, 40);
    if (!name) return { ok: false, error: "Give a name the teacher can call you." };

    const c = this.seatCounts(l);
    if (c.available <= 0) return { ok: false, error: "That class is full." };

    const seat = {
      id: code(8),
      name,
      contact: clean(body.contact, 80),
      state: l.feeCents > 0 ? "holding" : "confirmed",
      at: Date.now(),
      expires: l.feeCents > 0 ? Date.now() + HOLD_MINUTES * 60000 : 0,
    };
    l.seats.push(seat);
    await this.save();
    return {
      ok: true,
      ticket: seat.id,
      state: seat.state,
      roomCode: seat.state === "confirmed" ? (l.roomCode || "") : "",
      payUrl: l.feeCents > 0 ? l.payUrl : "",
      holdMinutes: HOLD_MINUTES,
      listing: this.publicListing(l),
    };
  }

  async ticket(body) {
    if (this.sweep()) await this.save();
    const t = clean(body.ticket, 16).toUpperCase();
    for (const l of this.db.listings) {
      const s = l.seats.find(x => x.id === t);
      if (s) {
        return {
          ok: true, state: s.state, name: s.name,
          expires: s.expires || 0,
          listing: this.publicListing(l),
          // only a seat holder is told where the room is
          roomCode: s.state === "confirmed" ? (l.roomCode || "") : "",
        };
      }
    }
    return { ok: false, error: "No seat with that ticket. It may have expired." };
  }

  async release(body) {
    const t = clean(body.ticket, 16).toUpperCase();
    for (const l of this.db.listings) {
      const before = l.seats.length;
      l.seats = l.seats.filter(x => x.id !== t);
      if (l.seats.length !== before) {
        await this.save();
        return { ok: true, listing: this.publicListing(l) };
      }
    }
    return { ok: false, error: "No seat with that ticket." };
  }
}

/* ===================================================== the page */

export const BOARD_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kinspire Notice Board</title>
<style>
:root{
  --paper:#f7f4ec; --ink:#16140f; --soft:#4a453a; --faint:#b8b1a2;
  --line:#e2dccd; --warm:#efe9da;
  --serif: Georgia, "Iowan Old Style", "Palatino Linotype", Palatino, serif;
}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0}
body{background:var(--paper);color:var(--ink);font-family:var(--serif);line-height:1.5}
.wrap{max-width:940px;margin:0 auto;padding:40px 20px 90px}
.kicker{font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:var(--soft);margin:0 0 16px}
h1{font-size:clamp(30px,5vw,46px);font-weight:400;line-height:1.08;margin:0 0 .3em}
h2{font-size:22px;font-weight:400;margin:34px 0 12px}
.lede{font-size:17px;color:var(--soft);max-width:62ch;margin:0 0 6px}
.topbar{display:flex;justify-content:space-between;align-items:baseline;gap:16px;flex-wrap:wrap}
a{color:var(--ink)}
button{
  font:inherit;font-size:15px;color:var(--ink);background:transparent;
  border:1.6px solid var(--ink);border-radius:999px;padding:7px 18px;cursor:pointer;
}
button:hover{background:var(--warm)}
button.solid{background:var(--ink);color:var(--paper)}
button.solid:hover{background:#2d2920}
button.quiet{border-color:var(--faint);color:var(--soft);font-size:14px;padding:5px 13px}
button:disabled{opacity:.42;cursor:default}
button:disabled:hover{background:transparent}
input,select,textarea{
  font:inherit;font-size:16px;color:var(--ink);background:#fffdf7;
  border:1.6px solid var(--faint);border-radius:7px;padding:8px 10px;width:100%;
}
textarea{min-height:76px;resize:vertical;line-height:1.45}
label{display:block;font-size:11px;letter-spacing:.17em;text-transform:uppercase;color:var(--soft);margin:0 0 5px}
.field{margin:0 0 13px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:0 14px}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:0 14px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.err{color:#8c3d1f;font-size:14.5px;margin:9px 0 0;min-height:1.2em}
.ok{color:#2f5d3a}

/* a listing */
.card{border-top:2px solid var(--ink);padding:22px 0 20px}
.card .head{display:flex;justify-content:space-between;gap:18px;align-items:baseline;flex-wrap:wrap}
.card h3{font-size:24px;font-weight:400;margin:0}
.card h3 .id{color:var(--faint);margin-right:.45em}
.card .meta{font-size:12.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--soft);margin:5px 0 0}
.card .blurb{margin:12px 0 0;color:var(--soft);max-width:62ch}
.when{font-size:18px;margin:10px 0 0}
.when b{font-weight:400}
.seats{text-align:right;white-space:nowrap}
.seats .big{font-size:30px;line-height:1}
.seats .lab{font-size:11px;letter-spacing:.17em;text-transform:uppercase;color:var(--soft);display:block;margin-top:3px}
.bar{height:7px;background:var(--line);border-radius:4px;margin:9px 0 0;overflow:hidden;min-width:130px}
.bar i{display:block;height:100%;background:var(--ink)}
.bar i.hold{background:var(--faint)}
.tagline{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0 0}
.tag{font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--soft);
  border:1px solid var(--faint);border-radius:999px;padding:2px 11px}
.tag.fee{border-color:var(--ink);color:var(--ink)}
.tag.full{background:var(--ink);color:var(--paper);border-color:var(--ink)}
.acts{margin:16px 0 0;display:flex;gap:10px;flex-wrap:wrap;align-items:center}

/* panels */
.panel{border:2px solid var(--ink);border-radius:10px;padding:20px 22px;margin:0 0 18px;background:#fffdf7}
.panel h3{margin:0 0 4px;font-size:20px;font-weight:400}
.panel .note{font-size:14px;color:var(--soft);margin:0 0 16px}
.ticket{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:21px;letter-spacing:.18em}
.roster{list-style:none;margin:10px 0 0;padding:0;font-size:15px}
.roster li{display:flex;gap:10px;align-items:baseline;padding:6px 0;border-top:1px solid var(--line)}
.roster li .nm{flex:1}
.roster li .st{font-size:11.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--soft)}
.roster li.holding .st{color:#8c3d1f}
.empty{color:var(--soft);padding:26px 0;font-size:16px}
.foot{margin-top:48px;padding-top:16px;border-top:2px solid var(--ink);font-size:14px;color:var(--soft);max-width:62ch}
.codebox{background:var(--warm);border-radius:7px;padding:12px 14px;margin:12px 0 0;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:18px;letter-spacing:.14em}
@media (max-width:620px){
  .grid2,.grid3{grid-template-columns:1fr}
  .card .head{flex-direction:column}
  .seats{text-align:left}
}
@media (prefers-color-scheme: dark){
  :root{--paper:#16140f;--ink:#f1ece0;--soft:#a79f8e;--faint:#5c5648;--line:#2e2b24;--warm:#262219}
  input,select,textarea,.panel{background:#1c1a14}
  button.solid{color:#16140f}
}
</style>
</head>
<body>
<div class="wrap">

  <div class="topbar">
    <div>
      <p class="kicker">Kinspire</p>
      <h1>Notice board</h1>
    </div>
    <div class="row" id="navrow">
      <button class="quiet" id="navsee">See classes</button>
      <button class="quiet" id="navticket">Find my seat</button>
      <button class="quiet" id="navteach">Teaching?</button>
    </div>
  </div>

  <!-- ============================================ public -->
  <div id="see">
    <p class="lede">Everything being taught, soonest first. No account, no sign up: pick one and click attend.</p>
    <div class="row" style="margin:18px 0 6px">
      <div class="field" style="flex:1 1 200px;margin:0">
        <label for="filtcat">Show</label>
        <select id="filtcat"><option value="">everything</option></select>
      </div>
      <div class="field" style="flex:1 1 160px;margin:0">
        <label for="filtfee">Cost</label>
        <select id="filtfee">
          <option value="">any</option>
          <option value="free">free only</option>
          <option value="paid">paid only</option>
        </select>
      </div>
      <div class="field" style="flex:0 0 auto;margin:0">
        <label>&nbsp;</label>
        <button class="quiet" id="refresh">Refresh</button>
      </div>
    </div>
    <div id="list"></div>
  </div>

  <!-- ============================================ attend -->
  <div id="attend" hidden>
    <h2 id="attendtitle">Attend</h2>
    <div class="panel">
      <h3 id="attendclass"></h3>
      <p class="note" id="attendwhen"></p>
      <div class="field">
        <label for="atname">Your name</label>
        <input id="atname" maxlength="40" autocomplete="name" placeholder="what the teacher should call you">
      </div>
      <div class="field">
        <label for="atcontact">Discord handle or email, optional</label>
        <input id="atcontact" maxlength="80" autocomplete="off" placeholder="so the teacher can reach you if it moves">
      </div>
      <p class="note" id="atfee"></p>
      <div class="row">
        <button class="solid" id="atgo">Take a seat</button>
        <button class="quiet" id="atback">Back</button>
      </div>
      <p class="err" id="aterr"></p>
    </div>
  </div>

  <!-- ============================================ ticket -->
  <div id="ticket" hidden>
    <h2>Your seat</h2>
    <div class="panel" id="ticketpanel"></div>
    <div class="panel">
      <h3>Find a seat you already took</h3>
      <p class="note">Tickets are kept in this browser. If you are on another device, type the code.</p>
      <div class="row" style="align-items:flex-end">
        <div class="field" style="flex:1 1 200px;margin:0">
          <label for="tkcode">Ticket code</label>
          <input id="tkcode" maxlength="8" autocapitalize="characters" placeholder="ABCD2345">
        </div>
        <button id="tklook">Look it up</button>
      </div>
      <p class="err" id="tkerr"></p>
    </div>
  </div>

  <!-- ============================================ teacher -->
  <div id="teach" hidden>
    <div id="signin">
      <h2>Teaching</h2>
      <div class="panel">
        <h3>Sign in with your code</h3>
        <p class="note">No password and no account. If you do not have a code, ask Darkageon for one.</p>
        <div class="row" style="align-items:flex-end">
          <div class="field" style="flex:1 1 200px;margin:0">
            <label for="sicode">Code</label>
            <input id="sicode" maxlength="32" autocapitalize="characters" autocomplete="off">
          </div>
          <button class="solid" id="sigo">Sign in</button>
        </div>
        <p class="err" id="sierr"></p>
      </div>
    </div>

    <div id="desk" hidden>
      <div class="topbar">
        <h2 style="margin-top:0" id="deskwho"></h2>
        <button class="quiet" id="signout">Sign out</button>
      </div>

      <div class="panel">
        <h3>Post a class</h3>
        <p class="note">Pick it from the catalog, then say when and how many.</p>
        <div class="grid3">
          <div class="field"><label for="pcat">Category</label><select id="pcat"></select></div>
          <div class="field"><label for="ptier">Level</label><select id="ptier"></select></div>
          <div class="field"><label for="pclass">Class</label><select id="pclass"></select></div>
        </div>
        <div class="grid3">
          <div class="field"><label for="pwhen">Date and time</label><input id="pwhen" type="datetime-local"></div>
          <div class="field"><label for="plen">Minutes</label><input id="plen" inputmode="numeric" value="60"></div>
          <div class="field"><label for="pcap">Attendee cap</label><input id="pcap" inputmode="numeric" value="8"></div>
        </div>
        <div class="grid2">
          <div class="field"><label for="pfee">Fee per person, 0 for free</label><input id="pfee" inputmode="decimal" value="0"></div>
          <div class="field"><label for="ppay">Payment link, only if there is a fee</label><input id="ppay" placeholder="https://"></div>
        </div>
        <div class="field">
          <label for="pblurb">What the class is about</label>
          <textarea id="pblurb" maxlength="700" placeholder="A few sentences. This is what somebody reads before deciding to come."></textarea>
        </div>
        <div class="row">
          <button class="solid" id="ppost">Put it on the board</button>
          <span id="ptz" style="font-size:13px;color:var(--soft)"></span>
        </div>
        <p class="err" id="perr"></p>
      </div>

      <div id="adminpanel" hidden class="panel">
        <h3>Teacher codes</h3>
        <p class="note">Each teacher gets one code. It is their whole sign in, so send it to them directly.</p>
        <div class="row" style="align-items:flex-end;margin-bottom:12px">
          <div class="field" style="flex:1 1 200px;margin:0">
            <label for="tname">New teacher's name</label>
            <input id="tname" maxlength="40">
          </div>
          <button id="tadd">Issue a code</button>
        </div>
        <div id="newcode" hidden class="codebox"></div>
        <ul class="roster" id="tlist"></ul>
        <p class="err" id="terr"></p>
      </div>

      <h2>What you have posted</h2>
      <div id="mine"></div>
    </div>
  </div>

  <p class="foot" id="footnote"></p>
</div>

<script>
(function(){
  "use strict";
  var $ = function(id){ return document.getElementById(id); };
  var panes = ["see","attend","ticket","teach"];
  var CATS = [], HOLD = 30, listings = [], mine = [], tok = null, role = null, who = "";
  var poll = null, current = null;

  function show(name){
    panes.forEach(function(p){ $(p).hidden = p !== name; });
    window.scrollTo(0, 0);
  }

  function esc(s){
    return String(s == null ? "" : s)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  function money(c){
    if (!c) return "free";
    return "$" + (c / 100).toFixed(2).replace(/\.00$/, "");
  }

  // Shown in whoever is reading's own zone, with the zone named, because
  // this project has already been bitten once by EST against EDT.
  function when(ms, minutes){
    var d = new Date(ms);
    var day = d.toLocaleDateString(undefined, { weekday:"long", month:"long", day:"numeric" });
    var t = d.toLocaleTimeString(undefined, { hour:"numeric", minute:"2-digit" });
    var zone = "";
    try {
      zone = new Intl.DateTimeFormat(undefined, { timeZoneName:"short" })
        .formatToParts(d).find(function(p){ return p.type === "timeZoneName"; }).value;
    } catch (e) {}
    return day + ", " + t + " " + zone + (minutes ? "  ·  " + minutes + " min" : "");
  }

  function api(path, body){
    return fetch("/api/board/" + path, {
      method: "POST",
      headers: { "content-type":"application/json" },
      body: JSON.stringify(body || {}),
    }).then(function(r){ return r.json(); });
  }

  /* ---------------------------------------------- tickets, per browser */

  function myTickets(){
    try { return JSON.parse(localStorage.getItem("kinspire.board.tickets") || "[]"); }
    catch (e) { return []; }
  }
  function keepTicket(t){
    try {
      var all = myTickets().filter(function(x){ return x !== t; });
      all.unshift(t);
      localStorage.setItem("kinspire.board.tickets", JSON.stringify(all.slice(0, 20)));
    } catch (e) {}
  }
  function dropTicket(t){
    try {
      localStorage.setItem("kinspire.board.tickets",
        JSON.stringify(myTickets().filter(function(x){ return x !== t; })));
    } catch (e) {}
  }

  /* ---------------------------------------------- the public list */

  function load(){
    return api("listings").then(function(d){
      if (!d.ok) return;
      listings = d.listings; CATS = d.categories; HOLD = d.holdMinutes;
      fillFilter();
      paintList();
      $("footnote").textContent =
        "Paid classes hold your seat for " + HOLD + " minutes while you pay, then release it. "
        + "Nothing on this page takes a payment: the link goes to whatever the teacher uses, "
        + "and they confirm your seat once it lands.";
    });
  }

  function fillFilter(){
    var sel = $("filtcat");
    if (sel.options.length > 1) return;
    CATS.forEach(function(c){
      var o = document.createElement("option");
      o.value = c.id; o.textContent = c.name;
      sel.appendChild(o);
    });
  }

  function paintList(){
    var cat = $("filtcat").value, fee = $("filtfee").value;
    var rows = listings.filter(function(l){
      if (cat && l.category !== cat) return false;
      if (fee === "free" && l.paid) return false;
      if (fee === "paid" && !l.paid) return false;
      return true;
    });
    var box = $("list");
    box.innerHTML = "";
    if (!rows.length){
      box.innerHTML = '<p class="empty">Nothing on the board that matches. '
        + 'Classes appear here as teachers post them.</p>';
      return;
    }
    rows.forEach(function(l){ box.appendChild(cardFor(l)); });
  }

  function cardFor(l){
    var el = document.createElement("div");
    el.className = "card";
    var full = l.available <= 0;
    var pct = Math.round(100 * Math.min(1, (l.taken - l.holding) / l.cap));
    var hpct = Math.round(100 * Math.min(1, l.holding / l.cap));
    el.innerHTML =
      '<div class="head"><div style="flex:1 1 360px">'
      + '<h3><span class="id">' + esc(l.classId) + '</span>' + esc(l.title) + '</h3>'
      + '<p class="meta">' + esc(l.track) + '  &middot;  with ' + esc(l.teacherName) + '</p>'
      + '<p class="when"><b>' + esc(when(l.startsAt, l.minutes)) + '</b></p>'
      + '</div><div class="seats">'
      + '<span class="big">' + l.taken + ' / ' + l.cap + '</span>'
      + '<span class="lab">' + (full ? "full" : l.available + " free") + '</span>'
      + '<div class="bar"><i style="width:' + pct + '%"></i>'
      + (hpct ? '<i class="hold" style="width:' + hpct + '%;margin-top:-7px;margin-left:' + pct + '%"></i>' : '')
      + '</div></div></div>'
      + (l.blurb ? '<p class="blurb">' + esc(l.blurb) + '</p>' : '')
      + '<div class="tagline">'
      + '<span class="tag' + (l.paid ? ' fee' : '') + '">' + esc(money(l.feeCents)) + '</span>'
      + (full ? '<span class="tag full">full</span>' : '')
      + (l.holding ? '<span class="tag">' + l.holding + ' paying now</span>' : '')
      + '</div><div class="acts"></div>';
    var b = document.createElement("button");
    b.className = "solid";
    b.textContent = full ? "Full" : "Attend";
    b.disabled = full;
    b.onclick = function(){ openAttend(l); };
    el.querySelector(".acts").appendChild(b);
    return el;
  }

  /* ---------------------------------------------- attending */

  function openAttend(l){
    current = l;
    show("attend");
    $("attendclass").textContent = l.classId + ". " + l.title;
    $("attendwhen").textContent = when(l.startsAt, l.minutes) + "  ·  with " + l.teacherName
      + "  ·  " + l.available + " of " + l.cap + " left";
    $("atfee").textContent = l.paid
      ? "This class is " + money(l.feeCents) + " a person. Your seat is held for " + HOLD
        + " minutes while you pay, and the teacher confirms it once the payment lands."
      : "This class is free. Your seat is yours as soon as you click.";
    $("aterr").textContent = "";
    try { $("atname").value = localStorage.getItem("kinspire.name") || ""; } catch (e) {}
    setTimeout(function(){ $("atname").focus(); }, 50);
  }

  $("atback").onclick = function(){ show("see"); };
  $("atgo").onclick = function(){
    if (!current) return;
    var name = $("atname").value.trim();
    if (!name){ $("aterr").textContent = "Give a name the teacher can call you."; return; }
    try { localStorage.setItem("kinspire.name", name); } catch (e) {}
    $("atgo").disabled = true;
    api("attend", { id: current.id, name: name, contact: $("atcontact").value })
      .then(function(d){
        $("atgo").disabled = false;
        if (!d.ok){ $("aterr").textContent = d.error || "Could not take that seat."; load(); return; }
        keepTicket(d.ticket);
        showTicket(d.ticket, d.state, d.payUrl, d.listing, d.holdMinutes, d.roomCode);
        load();
      })
      .catch(function(){ $("atgo").disabled = false; $("aterr").textContent = "Could not reach the board."; });
  };

  function showTicket(code, state, payUrl, l, hold, roomCode){
    show("ticket");
    var p = $("ticketpanel");
    p.innerHTML =
      '<h3>' + esc(l.classId + ". " + l.title) + '</h3>'
      + '<p class="note">' + esc(when(l.startsAt, l.minutes)) + '  &middot;  with ' + esc(l.teacherName) + '</p>'
      + '<p style="margin:0 0 4px">Your ticket</p>'
      + '<p class="ticket">' + esc(code) + '</p>'
      + (roomCode
          ? '<p class="note" style="margin-top:14px">On the day, open the classroom and '
            + 'put in this room code.</p><p class="ticket">' + esc(roomCode) + '</p>'
          : '')
      + (state === "holding"
          ? '<p class="note" style="margin-top:14px"><strong>Your seat is held for '
            + (hold || HOLD) + ' minutes.</strong> Pay through the link, then the teacher '
            + 'confirms it. If the hold runs out the seat goes back on the board and you can take it again.</p>'
          : '<p class="note ok" style="margin-top:14px">Your seat is confirmed. Nothing else to do.</p>')
      + '<div class="acts" id="tkacts"></div>';
    var acts = $("tkacts");
    if (roomCode){
      var j = document.createElement("button");
      j.className = "solid";
      j.textContent = "Open the classroom";
      j.onclick = function(){ window.open("/#s/" + roomCode, "_blank", "noopener"); };
      acts.appendChild(j);
    }
    if (state === "holding" && payUrl){
      var a = document.createElement("button");
      a.className = "solid";
      a.textContent = "Go and pay";
      a.onclick = function(){ window.open(payUrl, "_blank", "noopener"); };
      acts.appendChild(a);
    }
    var g = document.createElement("button");
    g.textContent = "Give the seat back";
    g.onclick = function(){
      api("release", { ticket: code }).then(function(d){
        dropTicket(code);
        if (d.ok){ load(); show("see"); }
      });
    };
    acts.appendChild(g);
    var s = document.createElement("button");
    s.className = "quiet";
    s.textContent = "Back to the board";
    s.onclick = function(){ show("see"); };
    acts.appendChild(s);
  }

  $("tklook").onclick = function(){
    var t = $("tkcode").value.trim().toUpperCase();
    $("tkerr").textContent = "";
    if (!t){ $("tkerr").textContent = "Type the ticket code."; return; }
    api("ticket", { ticket: t }).then(function(d){
      if (!d.ok){ $("tkerr").textContent = d.error; return; }
      keepTicket(t);
      showTicket(t, d.state, d.listing.payUrl, d.listing, HOLD, d.roomCode);
    });
  };

  $("navticket").onclick = function(){
    var mine = myTickets();
    if (mine.length){
      api("ticket", { ticket: mine[0] }).then(function(d){
        show("ticket");
        if (d.ok) showTicket(mine[0], d.state, d.listing.payUrl, d.listing, HOLD, d.roomCode);
        else { dropTicket(mine[0]); $("ticketpanel").innerHTML =
          '<h3>Nothing held in this browser</h3><p class="note">Type a ticket code below.</p>'; }
      });
    } else {
      show("ticket");
      $("ticketpanel").innerHTML =
        '<h3>Nothing held in this browser</h3><p class="note">Type a ticket code below.</p>';
    }
  };
  $("navsee").onclick = function(){ show("see"); load(); };
  $("navteach").onclick = function(){
    show("teach");
    // switching to this pane should show what is true now, not what was
    // true when the twenty-five second poll last fired
    if (tok) loadMine();
  };
  $("refresh").onclick = load;
  $("filtcat").onchange = paintList;
  $("filtfee").onchange = paintList;

  /* ---------------------------------------------- teacher side */

  $("sigo").onclick = function(){
    var c = $("sicode").value.trim();
    $("sierr").textContent = "";
    api("signin", { code: c }).then(function(d){
      if (!d.ok){ $("sierr").textContent = d.error || "Could not sign in."; return; }
      tok = d.token; role = d.role; who = d.name;
      try {
        localStorage.setItem("kinspire.board.tok", tok);
        localStorage.setItem("kinspire.board.who", who || "you");
      } catch (e) {}
      enterDesk();
    });
  };
  $("sicode").addEventListener("keydown", function(e){ if (e.key === "Enter") $("sigo").click(); });

  $("signout").onclick = function(){
    tok = null; role = null;
    try {
      localStorage.removeItem("kinspire.board.tok");
      localStorage.removeItem("kinspire.board.who");
    } catch (e) {}
    $("desk").hidden = true; $("signin").hidden = false;
  };

  function enterDesk(){
    $("signin").hidden = true;
    $("desk").hidden = false;
    $("deskwho").textContent = who + (role === "admin" ? ", admin" : "");
    $("adminpanel").hidden = role !== "admin";
    buildSelects();
    try {
      $("ptz").textContent = "Times are in " + Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (e) {}
    if (role === "admin") loadTeachers();
    loadMine();
  }

  function buildSelects(){
    var cat = $("pcat");
    if (cat.options.length) return;
    CATS.forEach(function(c, i){
      var o = document.createElement("option");
      o.value = String(i); o.textContent = c.name;
      cat.appendChild(o);
    });
    cat.onchange = fillTiers;
    $("ptier").onchange = fillClasses;
    fillTiers();
  }

  function fillTiers(){
    var c = CATS[Number($("pcat").value) || 0];
    var t = $("ptier");
    t.innerHTML = "";
    c.tiers.forEach(function(x, i){
      var o = document.createElement("option");
      o.value = String(i); o.textContent = x.name;
      t.appendChild(o);
    });
    // a category with one level does not need a question asked about it
    t.disabled = c.tiers.length < 2;
    fillClasses();
  }

  function fillClasses(){
    var c = CATS[Number($("pcat").value) || 0];
    var t = c.tiers[Number($("ptier").value) || 0];
    var s = $("pclass");
    s.innerHTML = "";
    t.classes.forEach(function(k){
      var o = document.createElement("option");
      o.value = k.id; o.textContent = k.id + ". " + k.title;
      s.appendChild(o);
    });
  }

  $("ppost").onclick = function(){
    $("perr").textContent = "";
    var when = $("pwhen").value;
    if (!when){ $("perr").textContent = "Give the class a date and time."; return; }
    var fee = Math.round(parseFloat($("pfee").value || "0") * 100);
    if (!Number.isFinite(fee) || fee < 0) fee = 0;
    $("ppost").disabled = true;
    api("post", {
      token: tok,
      classId: $("pclass").value,
      startsAt: new Date(when).getTime(),
      minutes: $("plen").value,
      cap: $("pcap").value,
      feeCents: fee,
      payUrl: $("ppay").value,
      blurb: $("pblurb").value,
    }).then(function(d){
      $("ppost").disabled = false;
      if (!d.ok){ $("perr").textContent = d.error || "Could not post it."; return; }
      $("pblurb").value = ""; $("pwhen").value = "";
      loadMine(); load();
    }).catch(function(){ $("ppost").disabled = false; $("perr").textContent = "Could not reach the board."; });
  };

  function loadMine(){
    api("mine", { token: tok }).then(function(d){
      if (!d.ok){ $("signout").click(); return; }
      mine = d.listings;
      var box = $("mine");
      box.innerHTML = "";
      if (!mine.length){
        box.innerHTML = '<p class="empty">Nothing posted yet.</p>';
        return;
      }
      mine.forEach(function(l){ box.appendChild(mineCard(l)); });
    });
  }

  function mineCard(l){
    var el = document.createElement("div");
    el.className = "card";
    var past = l.startsAt < Date.now();
    el.innerHTML =
      '<div class="head"><div style="flex:1 1 340px">'
      + '<h3><span class="id">' + esc(l.classId) + '</span>' + esc(l.title) + '</h3>'
      + '<p class="meta">' + esc(when(l.startsAt, l.minutes))
      + (l.status === "cancelled" ? "  &middot;  cancelled" : past ? "  &middot;  finished" : "")
      + (l.roomCode ? "  &middot;  room " + esc(l.roomCode) : "")
      + '</p></div><div class="seats"><span class="big">' + l.taken + ' / ' + l.cap + '</span>'
      + '<span class="lab">' + esc(money(l.feeCents)) + '</span></div></div>'
      + (l.blurb ? '<p class="blurb">' + esc(l.blurb) + '</p>' : '')
      + '<ul class="roster"></ul><div class="acts"></div>';

    var ul = el.querySelector(".roster");
    if (!l.seats.length){
      var li0 = document.createElement("li");
      li0.innerHTML = '<span class="nm" style="color:var(--soft)">nobody yet</span>';
      ul.appendChild(li0);
    }
    l.seats.forEach(function(s){
      var li = document.createElement("li");
      if (s.state === "holding") li.className = "holding";
      li.innerHTML = '<span class="nm">' + esc(s.name)
        + (s.contact ? ' <span style="color:var(--soft)">' + esc(s.contact) + '</span>' : '')
        + '</span><span class="st">' + (s.state === "holding" ? "paying" : "confirmed") + '</span>';
      if (l.feeCents > 0 && s.state === "holding"){
        var ok = document.createElement("button");
        ok.className = "quiet"; ok.textContent = "Mark paid";
        ok.onclick = function(){
          api("mark", { token: tok, id: l.id, seat: s.id, paid: true }).then(loadMine);
        };
        li.appendChild(ok);
      }
      var rm = document.createElement("button");
      rm.className = "quiet"; rm.textContent = "Remove";
      rm.onclick = function(){
        api("mark", { token: tok, id: l.id, seat: s.id, remove: true }).then(function(){
          loadMine(); load();
        });
      };
      li.appendChild(rm);
      ul.appendChild(li);
    });

    var acts = el.querySelector(".acts");
    if (l.status === "open" && !past){
      // the day-of chain: start the room, then put its code on the listing so
      // everybody holding a ticket can see where to go
      var go = document.createElement("button");
      go.className = "solid";
      go.textContent = "Start the classroom";
      go.onclick = function(){ window.open("/#new/" + l.classId, "_blank", "noopener"); };
      acts.appendChild(go);

      var rc = document.createElement("button");
      rc.textContent = l.roomCode ? "Room code " + l.roomCode : "Add the room code";
      rc.onclick = function(){
        var v = prompt("The five-character code the classroom gave you", l.roomCode || "");
        if (v === null) return;
        api("update", { token: tok, id: l.id, roomCode: v.trim().toUpperCase() })
          .then(function(d){ if (!d.ok) alert(d.error); loadMine(); });
      };
      acts.appendChild(rc);

      var cap = document.createElement("button");
      cap.className = "quiet"; cap.textContent = "Change the cap";
      cap.onclick = function(){
        var v = prompt("New attendee cap", String(l.cap));
        if (v === null) return;
        api("update", { token: tok, id: l.id, cap: v }).then(function(d){
          if (!d.ok) alert(d.error);
          loadMine(); load();
        });
      };
      acts.appendChild(cap);

      var can = document.createElement("button");
      can.className = "quiet"; can.textContent = "Cancel the class";
      can.onclick = function(){
        if (!confirm("Take " + l.classId + " off the board? Anyone signed up keeps their ticket but the listing goes.")) return;
        api("update", { token: tok, id: l.id, status: "cancelled" }).then(function(){
          loadMine(); load();
        });
      };
      acts.appendChild(can);
    }
    return el;
  }

  /* ---------------------------------------------- admin */

  function loadTeachers(){
    api("teachers", { token: tok }).then(function(d){
      if (!d.ok) return;
      var ul = $("tlist");
      ul.innerHTML = "";
      if (!d.teachers.length){
        ul.innerHTML = '<li><span class="nm" style="color:var(--soft)">no codes issued yet</span></li>';
      }
      d.teachers.forEach(function(t){
        var li = document.createElement("li");
        li.innerHTML = '<span class="nm">' + esc(t.name)
          + ' <span style="color:var(--soft)">' + esc(t.code) + '</span></span>'
          + '<span class="st">' + t.listings + ' posted' + (t.disabled ? ", off" : "") + '</span>';
        var b = document.createElement("button");
        b.className = "quiet";
        b.textContent = t.disabled ? "Turn on" : "Turn off";
        b.onclick = function(){
          api("setteacher", { token: tok, code: t.code, disabled: !t.disabled }).then(loadTeachers);
        };
        li.appendChild(b);
        ul.appendChild(li);
      });
      if (d.adminHint){
        $("terr").textContent = "The admin code is the one built into the code, "
          + "so it is in the repository rather than hidden. To replace it: Cloudflare "
          + "dashboard, this Worker, Settings, Variables and Secrets, Add, type Secret, "
          + "name ADMIN_CODE, then Deploy. A secret overrides this with no code change.";
      }
    });
  }

  $("tadd").onclick = function(){
    $("terr").textContent = "";
    api("addteacher", { token: tok, name: $("tname").value }).then(function(d){
      if (!d.ok){ $("terr").textContent = d.error; return; }
      $("tname").value = "";
      $("newcode").hidden = false;
      $("newcode").textContent = d.name + "  " + d.code;
      loadTeachers();
    });
  };

  /* ---------------------------------------------- boot */

  load().then(function(){
    try {
      var saved = localStorage.getItem("kinspire.board.tok");
      if (saved){
        tok = saved;
        api("mine", { token: tok }).then(function(d){
          if (d.ok){ role = d.role; who = d.name; show("teach"); enterDesk(); }
          else { tok = null; try { localStorage.removeItem("kinspire.board.tok"); } catch (e) {} }
        });
      }
    } catch (e) {}
  });

  // The board moves when other people act on it, so it refreshes itself.
  poll = setInterval(function(){
    if (!$("see").hidden) load();
    else if (!$("teach").hidden && tok) loadMine();
  }, 25000);

  window.__board = {
    state: function(){ return { listings: listings, role: role, tickets: myTickets() }; },
    reload: load,
  };
})();
</script>
</body>
</html>`;
