/**
 * The whole chain, once, the way a real class runs.
 *
 * Darkageon issues Shawn a code. Shawn posts A5 with a cap and a fee. Two
 * players find it and take seats, one paying. Shawn starts the classroom from
 * the listing, puts the room code back on it, and the player with a confirmed
 * seat walks from their ticket into the room and sees slide one.
 *
 * Everything else is tested in pieces elsewhere. This is the one that fails
 * if the pieces do not join up.
 */
import pw from "/opt/npm-tools/node_modules/playwright/index.js";
const { chromium } = pw;

const BASE = process.env.BASE || "http://127.0.0.1:8788";
const SHOTS = process.env.SHOTS || "/home/claude/classroom/shots";
const ADMIN = "KINSPIRE-ADMIN";
const TAG = "flow" + Math.random().toString(36).slice(2, 7);

let pass = 0, fail = 0, step = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
}
function stage(t) { console.log(`\n${++step}. ${t}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function settle(page, test, tries = 80, arg) {
  for (let i = 0; i < tries; i++) {
    if (await page.evaluate(test, arg).catch(() => false)) return true;
    await sleep(100);
  }
  return false;
}

const api = (op, body) =>
  fetch(`${BASE}/api/board/${op}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then(r => r.json());

function localStamp(ms) {
  const d = new Date(Date.now() + ms), p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const main = async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const admin = await (await browser.newContext({ viewport: { width: 1280, height: 950 } })).newPage();
  const shawnCtx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const shawn = await shawnCtx.newPage();
  const mara = await (await browser.newContext({ viewport: { width: 1180, height: 900 } })).newPage();
  const olm = await (await browser.newContext({ viewport: { width: 1180, height: 900 } })).newPage();

  const errs = [];
  for (const [who, pg] of [["admin", admin], ["shawn", shawn], ["mara", mara], ["olm", olm]]) {
    pg.on("pageerror", e => errs.push(`${who}: ${e.message}`));
    pg.on("console", m => { if (m.type() === "error") errs.push(`${who} console: ${m.text()}`); });
  }

  /* ---------------------------------------------------------------- */
  stage("Darkageon issues Shawn a teacher code");

  await admin.goto(`${BASE}/board`, { waitUntil: "domcontentloaded" });
  await admin.click("#navteach");
  await admin.fill("#sicode", ADMIN);
  await admin.click("#sigo");
  ok("admin signs in", await settle(admin, () => !document.getElementById("desk").hidden));
  await admin.fill("#tname", "Shawn " + TAG);
  await admin.click("#tadd");
  ok("a code is issued", await settle(admin, () => !document.getElementById("newcode").hidden));
  const shawnCode = (await admin.textContent("#newcode")).trim().split(/\s+/).pop();
  ok("it is six characters", /^[A-Z2-9]{6}$/.test(shawnCode), shawnCode);

  /* ---------------------------------------------------------------- */
  stage("Shawn posts A5 with a cap of 2 and a fee");

  await shawn.goto(`${BASE}/board`, { waitUntil: "domcontentloaded" });
  await shawn.click("#navteach");
  await shawn.fill("#sicode", shawnCode);
  await shawn.click("#sigo");
  ok("Shawn signs in", await settle(shawn, () => !document.getElementById("desk").hidden));
  ok("Shawn is not an admin", await shawn.isHidden("#adminpanel"));

  await shawn.selectOption("#pcat", { label: "Players" });
  await sleep(150);
  await shawn.selectOption("#ptier", { label: "101" });
  await sleep(150);
  await shawn.selectOption("#pclass", "A5");
  await shawn.fill("#pwhen", localStamp(2 * 86400000));
  await shawn.fill("#plen", "90");
  await shawn.fill("#pcap", "2");
  await shawn.fill("#pfee", "15");
  await shawn.fill("#ppay", "https://example.com/pay");
  await shawn.fill("#pblurb", `Ninety minutes and you leave with a character you can play. [${TAG}]`);
  await shawn.click("#ppost");
  ok("the listing appears on Shawn's desk", await settle(shawn,
    () => /Character Creation/.test(document.getElementById("mine").textContent)));

  const listing = (await api("listings")).listings.find(l => l.blurb.includes(TAG));
  ok("it reaches the public board", !!listing);
  ok("with the right cap", listing && listing.cap === 2, String(listing && listing.cap));
  ok("and the right fee", listing && listing.feeCents === 1500, String(listing && listing.feeCents));
  ok("the board does not publish a room code yet", listing && listing.hasRoom === false);

  /* ---------------------------------------------------------------- */
  stage("Mara takes a seat and pays");

  await mara.goto(`${BASE}/board`, { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 30; i++) {
    if (await mara.locator(".card", { hasText: TAG }).count()) break;
    await mara.click("#refresh"); await sleep(250);
  }
  ok("Mara finds it without signing in",
     (await mara.locator(".card", { hasText: TAG }).count()) === 1);
  await mara.locator(".card", { hasText: TAG }).locator(".acts button").click();
  ok("the attend pane says it is paid", (await mara.textContent("#atfee")).includes("$15"));
  await mara.fill("#atname", "Mara");
  await mara.fill("#atcontact", "mara#1234");
  await mara.click("#atgo");
  ok("Mara gets a ticket", await settle(mara, () => !document.getElementById("ticket").hidden));
  const maraTicket = (await mara.textContent("#ticketpanel .ticket")).trim();
  const maraPanel = await mara.textContent("#ticketpanel");
  ok("her seat is held, not confirmed", /held for 30 minutes/.test(maraPanel));
  ok("she is offered the payment link",
     await mara.locator("#tkacts button", { hasText: "Go and pay" }).count() === 1);
  ok("a held seat is given no room code", !/Open the classroom/.test(maraPanel));

  await shawn.click("#navteach");
  ok("Shawn sees her as paying", await settle(shawn,
    () => /paying/.test(document.getElementById("mine").textContent)));
  await shawn.locator("#mine .card", { hasText: TAG })
    .getByRole("button", { name: "Mark paid" }).click();
  ok("Shawn can confirm the payment", await settle(shawn,
    () => !/paying/.test(document.getElementById("mine").textContent)));

  /* ---------------------------------------------------------------- */
  stage("Olm takes the last seat, and a third person cannot");

  const olmSeat = await api("attend", { id: listing.id, name: "Olm", contact: "" });
  ok("Olm gets the second seat", olmSeat.ok);
  ok("and his is held too, because the class is paid", olmSeat.state === "holding");
  ok("a held seat gets no room code either", !olmSeat.roomCode);

  await shawn.click("#navteach");
  await settle(shawn, () => /Olm/.test(document.getElementById("mine").textContent));
  await shawn.locator("#mine .card", { hasText: TAG })
    .getByRole("button", { name: "Mark paid" }).first().click();
  ok("Shawn confirms Olm too", await settle(shawn,
    () => !/paying/.test(document.getElementById("mine").textContent)));
  const third = await api("attend", { id: listing.id, name: "Grell", contact: "" });
  ok("the cap holds against a third", !third.ok && /full/i.test(third.error));

  await mara.click("#navsee");
  await mara.click("#refresh");
  await sleep(600);
  ok("the board shows it full", await settle(mara, () => {
    const c = [...document.querySelectorAll(".card")].find(x => x.textContent.includes("flow"));
    return c && /2 \/ 2/.test(c.textContent);
  }));

  /* ---------------------------------------------------------------- */
  stage("Shawn starts the classroom from the listing");

  const roomPagePromise = shawnCtx.waitForEvent("page");
  await shawn.locator("#mine .card", { hasText: TAG })
    .getByRole("button", { name: "Start the classroom" }).click();
  const room = await roomPagePromise;
  await room.waitForLoadState("domcontentloaded");
  ok("a classroom opens", await settle(room, () => !document.getElementById("teach").hidden));
  const roomCode = (await room.textContent("#tcode")).trim();
  ok("with a five character code", /^[A-Z2-9]{5}$/.test(roomCode), roomCode);
  const deckName = await room.textContent("#tstage .tag");
  ok("and the right deck loaded", /A5/.test(deckName), deckName);
  ok("the deck has nineteen slides", (await room.$$("#tlist li")).length === 19);

  shawn.on("dialog", d => d.accept(roomCode));
  await shawn.locator("#mine .card", { hasText: TAG })
    .getByRole("button", { name: /room code/i }).click();
  await sleep(900);
  const savedRoom = await api("mine", {
    token: await shawn.evaluate(() => localStorage.getItem("kinspire.board.tok")) });
  const savedListing = savedRoom.listings.find(l => l.blurb.includes(TAG));
  ok("the code goes onto the listing", savedListing && savedListing.roomCode === roomCode,
     String(savedListing && savedListing.roomCode));
  ok("and Shawn can see it on the card", await settle(shawn,
    () => /room /i.test(document.getElementById("mine").textContent)));

  const pub = (await api("listings")).listings.find(l => l.blurb.includes(TAG));
  ok("the public board says a room exists", pub.hasRoom === true);
  ok("but never publishes the code",
     !JSON.stringify(pub).includes(roomCode),
     "the room code leaked onto the public board");

  /* ---------------------------------------------------------------- */
  stage("Olm walks from his ticket into the room");

  await olm.goto(`${BASE}/board`, { waitUntil: "domcontentloaded" });
  await olm.click("#navticket");
  await olm.fill("#tkcode", olmSeat.ticket);
  await olm.click("#tklook");
  // the "nothing held in this browser" panel also contains the word ticket,
  // so wait for his actual code rather than for the word
  ok("his ticket looks up", await settle(olm,
    t => document.getElementById("ticketpanel").textContent.includes(t), 80, olmSeat.ticket));
  const olmPanel = await olm.textContent("#ticketpanel");
  ok("a confirmed seat is given the room code", olmPanel.includes(roomCode), olmPanel.slice(0, 160));

  const classPromise = olm.context().waitForEvent("page");
  await olm.locator("#tkacts button", { hasText: "Open the classroom" }).click();
  const student = await classPromise;
  await student.waitForLoadState("domcontentloaded");
  ok("the code is prefilled for him", (await student.inputValue("#jcode")) === roomCode);
  await student.fill("#jname", "Olm");
  await student.click("#jgo");
  ok("he is in the room", await settle(student, () => !document.getElementById("watch").hidden));
  ok("looking at slide one of A5", (await student.textContent("#wpos")).trim() === "1 of 19");
  ok("and the title is right", (await student.textContent("#wtitle")).includes("Character Creation"));

  await room.keyboard.press("ArrowRight");
  ok("Shawn drives and he follows", await settle(student,
    () => document.getElementById("wpos").textContent.trim() === "2 of 19"));

  await student.screenshot({ path: `${SHOTS}/flow-student.png` });
  await room.screenshot({ path: `${SHOTS}/flow-teacher.png` });

  /* ---------------------------------------------------------------- */
  stage("Shawn ends it and logs the run");

  await room.click("#tend");
  ok("the student is told it is over", await settle(student,
    () => /finished/.test(document.getElementById("wpos").textContent)));
  await room.click("#tlogopen");
  await room.fill("#lgbroke", "nothing");
  await room.fill("#lgconf", "the modifier rule needed saying twice");
  await room.fill("#lgtried", "somebody put their 15 in Strength on a Wizard");
  await room.click("#lgsave");
  ok("the run is logged", await settle(room,
    () => /attended/.test(document.getElementById("truns").textContent)));
  const tokRoom = await room.evaluate(() => location.hash.split("/")[2]);
  const md = await (await fetch(`${BASE}/api/log?code=${roomCode}&token=${tokRoom}`)).text();
  ok("and exports with the answers", md.includes("put their 15 in Strength"));

  /* ---------------------------------------------------------------- */
  stage("Tidy up after ourselves");

  const shawnTok = await shawn.evaluate(() => localStorage.getItem("kinspire.board.tok"));
  for (const l of (await api("listings")).listings.filter(x => x.blurb.includes(TAG))) {
    await api("update", { token: shawnTok, id: l.id, status: "cancelled" });
  }
  const left = (await api("listings")).listings.filter(x => x.blurb.includes(TAG)).length;
  ok("the board is as we found it", left === 0, String(left));

  ok("no page errors anywhere in the chain", errs.length === 0, errs.slice(0, 3).join(" | "));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

main().catch(e => { console.error(e); process.exit(1); });
