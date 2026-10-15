/**
 * The notice board, end to end.
 *
 *   npx wrangler dev --port 8788 &
 *   node e2e_board.mjs
 *
 * Two browsers: a teacher posting, and a player who never signs in. The
 * assertions that matter most are the negative ones again: a player must
 * never be sent another attendee's name, and a cap must not be beatable.
 */
import pw from "/opt/npm-tools/node_modules/playwright/index.js";
const { chromium } = pw;

const BASE = process.env.BASE || "http://127.0.0.1:8788";
const SHOTS = process.env.SHOTS || "/home/claude/classroom/shots";
const ADMIN = "KINSPIRE-ADMIN";

// The durable object keeps its state between runs, so every listing this run
// posts carries a tag and every assertion is scoped to it. The alternative is
// wiping .wrangler/state before each run, which hides the fact that the board
// is supposed to survive a restart.
const TAG = "run" + Math.random().toString(36).slice(2, 8);
const tagged = t => `${t} [${TAG}]`;
const card = (page, sel) => page.locator(`${sel} .card`).filter({ hasText: TAG });

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? "  " + extra : ""}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function settle(page, test, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await page.evaluate(test).catch(() => false)) return true;
    await sleep(100);
  }
  return false;
}

const api = (op, body) =>
  fetch(`${BASE}/api/board/${op}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then(r => r.json());

// datetime-local wants local wall time, which is what a teacher types
function localStamp(msFromNow) {
  const d = new Date(Date.now() + msFromNow);
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

const main = async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const tCtx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  const pCtx = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  const teacher = await tCtx.newPage();
  const player = await pCtx.newPage();

  const errs = [];
  for (const [who, pg] of [["teacher", teacher], ["player", player]]) {
    pg.on("pageerror", e => errs.push(`${who}: ${e.message}`));
    pg.on("console", m => { if (m.type() === "error") errs.push(`${who} console: ${m.text()}`); });
  }

  /* ---------------------------------------------------- the empty board */

  await player.goto(`${BASE}/board`, { waitUntil: "domcontentloaded" });
  await player.waitForSelector("#list");
  ok("the board loads", await settle(player, () => !document.getElementById("see").hidden));
  const cats = await player.$$eval("#filtcat option", e => e.map(x => x.textContent));
  ok("the filter carries every category", cats.length === 7, JSON.stringify(cats));

  /* ---------------------------------------------------- admin issues a code */

  await teacher.goto(`${BASE}/board`, { waitUntil: "domcontentloaded" });
  await teacher.click("#navteach");
  await teacher.fill("#sicode", "NOPE");
  await teacher.click("#sigo");
  ok("a bad code is refused", await settle(teacher,
    () => (document.getElementById("sierr").textContent || "").length > 5));

  await teacher.fill("#sicode", ADMIN);
  await teacher.click("#sigo");
  ok("the admin code signs in", await settle(teacher,
    () => !document.getElementById("desk").hidden));
  ok("the admin panel appears", await teacher.isVisible("#adminpanel"));
  ok("the default admin code is called out", await settle(teacher,
    () => /wrangler secret/.test(document.getElementById("terr").textContent)));

  await teacher.fill("#tname", "Shawn");
  await teacher.click("#tadd");
  ok("a teacher code is issued", await settle(teacher,
    () => !document.getElementById("newcode").hidden));
  const issued = (await teacher.textContent("#newcode")).trim();
  const shawnCode = issued.split(/\s+/).pop();
  ok("the code looks right", /^[A-Z2-9]{6}$/.test(shawnCode), issued);
  ok("the roster lists them", (await teacher.textContent("#tlist")).includes("Shawn"));

  /* ---------------------------------------------------- the three dropdowns */

  await teacher.click("#signout");
  await teacher.fill("#sicode", shawnCode);
  await teacher.click("#sigo");
  ok("the issued code signs in", await settle(teacher,
    () => !document.getElementById("desk").hidden));
  ok("a teacher gets no admin panel", await teacher.isHidden("#adminpanel"));

  const catOpts = await teacher.$$eval("#pcat option", e => e.map(x => x.textContent));
  ok("category select has six", catOpts.length === 6, JSON.stringify(catOpts));
  let tierOpts = await teacher.$$eval("#ptier option", e => e.map(x => x.textContent));
  ok("Players has two levels", tierOpts.length === 2, JSON.stringify(tierOpts));
  let classOpts = await teacher.$$eval("#pclass option", e => e.map(x => x.textContent));
  ok("Player 101 lists fourteen classes", classOpts.length === 14, String(classOpts.length));
  ok("A5 is in the list", classOpts.some(c => c.startsWith("A5.")));

  await teacher.selectOption("#pcat", { label: "Art" });
  await sleep(120);
  tierOpts = await teacher.$$eval("#ptier option", e => e.map(x => x.textContent));
  ok("an untiered category collapses to one level", tierOpts.length === 1, JSON.stringify(tierOpts));
  ok("and its select is disabled", await teacher.isDisabled("#ptier"));
  classOpts = await teacher.$$eval("#pclass option", e => e.map(x => x.textContent));
  ok("the art track lists sixteen", classOpts.length === 16, String(classOpts.length));

  await teacher.selectOption("#pcat", { label: "DMs" });
  await sleep(120);
  await teacher.selectOption("#ptier", { label: "102" });
  await sleep(120);
  classOpts = await teacher.$$eval("#pclass option", e => e.map(x => x.textContent));
  ok("DM 102 lists twenty nine", classOpts.length === 29, String(classOpts.length));

  /* ---------------------------------------------------- posting */

  await teacher.selectOption("#pcat", { label: "Players" });
  await sleep(120);
  await teacher.selectOption("#ptier", { label: "101" });
  await sleep(120);
  await teacher.selectOption("#pclass", "A1");
  await teacher.fill("#pwhen", localStamp(3 * 86400000));
  await teacher.fill("#plen", "60");
  await teacher.fill("#pcap", "3");
  await teacher.fill("#pfee", "0");
  await teacher.fill("#pblurb", tagged("An hour on how a tabletop game actually works. No book, no dice, nothing to prepare."));
  await teacher.click("#ppost");
  ok("a free class posts", await settle(teacher,
    () => /What's a D20/.test(document.getElementById("mine").textContent)));

  // a paid one, which needs a payment link
  await teacher.selectOption("#pclass", "A5");
  await teacher.fill("#pwhen", localStamp(5 * 86400000));
  await teacher.fill("#pcap", "2");
  await teacher.fill("#pfee", "12.50");
  await teacher.fill("#pblurb", tagged("Ninety minutes and you leave with a character you can play."));
  await teacher.click("#ppost");
  ok("a paid class without a link is refused", await settle(teacher,
    () => /payment link/.test(document.getElementById("perr").textContent)));

  await teacher.fill("#ppay", "javascript:alert(1)");
  await teacher.click("#ppost");
  ok("a javascript link is refused", await settle(teacher,
    () => /payment link/.test(document.getElementById("perr").textContent)));

  await teacher.fill("#ppay", "https://example.com/pay/a5");
  await teacher.click("#ppost");
  ok("a paid class with a link posts", await settle(teacher,
    () => /Character Creation/.test(document.getElementById("mine").textContent)));

  // and one in the past
  await teacher.selectOption("#pclass", "A8");
  await teacher.fill("#pwhen", localStamp(-5 * 86400000));
  await teacher.fill("#pfee", "0");
  await teacher.fill("#ppay", "");
  await teacher.click("#ppost");
  ok("a class in the past is refused", await settle(teacher,
    () => /in the past/.test(document.getElementById("perr").textContent)));

  /* ---------------------------------------------------- the player sees them */

  await player.click("#refresh");
  await card(player, "#list").first().waitFor({ timeout: 10000 }).catch(() => {});
  for (let i = 0; i < 40 && (await card(player, "#list").count()) < 2; i++) {
    await player.click("#refresh");
    await sleep(250);
  }
  ok("both classes reach the board",
     (await card(player, "#list").count()) === 2,
     String(await card(player, "#list").count()));
  const boardText = (await card(player, "#list").allTextContents()).join(" ");
  ok("the free one says free", boardText.includes("free"));
  ok("the paid one shows its fee", boardText.includes("$12.50"));
  ok("seats show as taken out of cap", /0 \/ 3/.test(boardText), boardText.slice(0, 120));
  ok("the teacher's name is shown", boardText.includes("Shawn"));
  ok("the blurb is shown", boardText.includes("No book, no dice"));

  const pageHtml = await player.content();
  ok("a player never receives a teacher code", !pageHtml.includes(shawnCode));
  ok("a player never receives the admin code", !pageHtml.includes(ADMIN));

  await player.selectOption("#filtfee", "paid");
  await sleep(200);
  ok("the paid filter hides the free class",
     (await card(player, "#list").count()) === 1,
     String(await card(player, "#list").count()));
  await player.selectOption("#filtfee", "");
  await sleep(200);

  /* ---------------------------------------------------- attending, free */

  await card(player, "#list").filter({ hasText: "What's a D20" }).locator(".acts button").click();
  ok("the attend pane opens", await settle(player,
    () => !document.getElementById("attend").hidden));
  await player.click("#atgo");
  ok("a nameless seat is refused", await settle(player,
    () => /name/.test(document.getElementById("aterr").textContent)));

  await player.fill("#atname", "Mara");
  await player.fill("#atcontact", "mara#1234");
  await player.click("#atgo");
  ok("the ticket pane opens", await settle(player,
    () => !document.getElementById("ticket").hidden));
  const ticketText = await player.textContent("#ticketpanel");
  ok("a free seat is confirmed at once", /confirmed/.test(ticketText), ticketText.slice(0, 90));
  const freeTicket = (await player.textContent("#ticketpanel .ticket")).trim();
  ok("the ticket is eight characters", /^[A-Z2-9]{8}$/.test(freeTicket), freeTicket);

  await player.click("#navsee");
  await sleep(400);
  ok("the count moved",
     (await card(player, "#list").filter({ hasText: "What's a D20" }).textContent()).includes("1 / 3"));

  /* ---------------------------------------------------- the roster is the teacher's */

  const afterHtml = await player.content();
  ok("a player is never sent another attendee's name",
     !afterHtml.includes("mara#1234") || afterHtml.indexOf("mara#1234") === -1,
     "the contact leaked into a public listing");

  const pub = await api("listings");
  const blob = JSON.stringify(pub);
  ok("the public API carries no names", !blob.includes("Mara"), blob.slice(0, 200));
  ok("the public API carries no tickets", !blob.includes(freeTicket));
  ok("the public API carries no teacher code", !blob.includes(shawnCode));

  await teacher.reload({ waitUntil: "domcontentloaded" });
  ok("the teacher is still signed in", await settle(teacher,
    () => !document.getElementById("desk").hidden));
  ok("the teacher sees the roster", await settle(teacher,
    () => /Mara/.test(document.getElementById("mine").textContent)));
  ok("and the contact", (await teacher.textContent("#mine")).includes("mara#1234"));

  /* ---------------------------------------------------- paid holds */

  const paid = (await api("listings")).listings.find(l => l.paid && l.blurb.includes(TAG));
  const hold = await api("attend", { id: paid.id, name: "Olm", contact: "" });
  ok("a paid seat comes back holding", hold.ok && hold.state === "holding", JSON.stringify(hold).slice(0, 90));
  ok("and hands over the payment link", hold.payUrl === "https://example.com/pay/a5");
  ok("and says how long the hold lasts", hold.holdMinutes === 30, String(hold.holdMinutes));

  const look = await api("ticket", { ticket: hold.ticket });
  ok("the ticket looks up", look.ok && look.state === "holding");

  await teacher.click("#navteach");
  await sleep(400);
  ok("a holding seat reads as paying", await settle(teacher,
    () => /paying/.test(document.getElementById("mine").textContent)));

  /* ---------------------------------------------------- the cap holds */

  const second = await api("attend", { id: paid.id, name: "Yarrow", contact: "" });
  ok("the second of two seats is taken", second.ok, JSON.stringify(second).slice(0, 80));
  const third = await api("attend", { id: paid.id, name: "Grell", contact: "" });
  ok("the cap cannot be beaten", !third.ok && /full/i.test(third.error), JSON.stringify(third));

  const shrink = await api("update", { token: null, id: paid.id, cap: 1 });
  ok("a stranger cannot change the cap", !shrink.ok, JSON.stringify(shrink));

  /* ---------------------------------------------------- giving a seat back */

  const gone = await api("release", { ticket: second.ticket });
  ok("a seat can be given back", gone.ok);
  ok("and the count drops", gone.listing.taken === 1, String(gone.listing.taken));
  const again = await api("attend", { id: paid.id, name: "Grell", contact: "" });
  ok("the freed seat is takeable", again.ok);
  await api("release", { ticket: again.ticket });

  const stale = await api("ticket", { ticket: "ZZZZZZZZ" });
  ok("an unknown ticket says so", !stale.ok);

  /* ---------------------------------------------------- cancelling */

  const before = (await api("listings")).listings.filter(l => l.blurb.includes(TAG)).length;
  teacher.on("dialog", d => d.accept());
  await card(teacher, "#mine").filter({ hasText: "Character Creation" })
    .getByRole("button", { name: /Cancel the class/ }).click();
  await sleep(800);
  const after = (await api("listings")).listings.filter(l => l.blurb.includes(TAG)).length;
  ok("a cancelled class leaves the board", after === before - 1, `${before} then ${after}`);

  // leave the board as we found it, so the next run starts clean
  for (const l of (await api("listings")).listings.filter(x => x.blurb.includes(TAG))) {
    await api("update", { token: await teacher.evaluate(() =>
      localStorage.getItem("kinspire.board.tok")), id: l.id, status: "cancelled" });
  }

  /* ---------------------------------------------------- shots and layout */

  await player.click("#navsee");
  await player.click("#refresh");
  await sleep(500);
  await player.screenshot({ path: `${SHOTS}/board-public.png`, fullPage: true });
  await teacher.screenshot({ path: `${SHOTS}/board-teacher.png`, fullPage: true });

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const ph = await phone.newPage();
  await ph.goto(`${BASE}/board`, { waitUntil: "domcontentloaded" });
  await ph.waitForSelector("#list .card");
  const hscroll = await ph.evaluate(() =>
    document.documentElement.scrollWidth > window.innerWidth + 1);
  ok("no horizontal scroll at phone width", !hscroll);
  await ph.screenshot({ path: `${SHOTS}/board-phone.png`, fullPage: true });
  await phone.close();

  ok("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

main().catch(e => { console.error(e); process.exit(1); });
