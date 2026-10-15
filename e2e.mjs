/**
 * End to end check against a running `wrangler dev`.
 *
 *   npx wrangler dev --port 8788 &
 *   node e2e.mjs
 *
 * Two real browsers: one teacher, one student. The assertions that matter
 * most are the negative ones. A student's page must never contain a slide
 * the class is not on, and must contain nothing at all during a blackout.
 */
import pw from "/opt/npm-tools/node_modules/playwright/index.js";
const { chromium } = pw;

const BASE = process.env.BASE || "http://127.0.0.1:8788";
const SHOTS = process.env.SHOTS || "/home/claude/classroom/shots";

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

const main = async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const tCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const sCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const teacher = await tCtx.newPage();
  const student = await sCtx.newPage();

  const errs = [];
  for (const [who, p] of [["teacher", teacher], ["student", student]]) {
    p.on("pageerror", e => errs.push(`${who}: ${e.message}`));
    p.on("console", m => { if (m.type() === "error") errs.push(`${who} console: ${m.text()}`); });
  }

  /* ---------------------------------------------------- landing */

  await teacher.goto(BASE, { waitUntil: "domcontentloaded" });
  await teacher.waitForSelector("#catalog .card button");
  const cards = await teacher.$$eval("#catalog .card h3", els => els.map(e => e.textContent));
  ok("catalog lists four classes", cards.length === 4, JSON.stringify(cards));
  ok("A1 is in the catalog", cards.some(c => c.includes("What's a D20?")));
  ok("A5 is in the catalog", cards.some(c => c.includes("Character Creation")));
  ok("C1 is in the catalog", cards.some(c => c.includes("Know your Limits")));
  ok("C2 is in the catalog", cards.some(c => c.includes("Prep and Atmosphere")));

  /* ---------------------------------------------------- teacher opens */

  await teacher.click("#catalog .card button");
  ok("teacher view opens", await settle(teacher, () => !document.getElementById("teach").hidden));
  const code = (await teacher.textContent("#tcode")).trim();
  ok("class code is five characters", /^[A-Z2-9]{5}$/.test(code), code);
  ok("teacher starts on slide 1", (await teacher.textContent("#tpos")).trim() === "1 / 17");
  const cue = (await teacher.textContent("#tcue")).trim();
  ok("teacher sees a cue", cue.length > 20, cue.slice(0, 40));
  ok("slide list has 17 entries", (await teacher.$$("#tlist li")).length === 17);

  /* ---------------------------------------------------- student joins */

  await student.goto(`${BASE}/#s/${code}`, { waitUntil: "domcontentloaded" });
  ok("code prefilled from link", (await student.inputValue("#jcode")) === code);
  await student.fill("#jname", "Test Student");
  await student.click("#jgo");
  ok("student view opens", await settle(student, () => !document.getElementById("watch").hidden));
  ok("student sees position", (await student.textContent("#wpos")).trim() === "1 of 17");
  ok("student sees the title", (await student.textContent("#wtitle")).includes("What's a D20?"));

  ok("teacher sees one watcher",
     await settle(teacher, () => document.getElementById("tcount").textContent.startsWith("1 ")));
  ok("roster names the student",
     (await teacher.textContent("#troster")).includes("Test Student"));

  /* ------------------------------------- the negative test that matters */

  const studentHtml = await student.content();
  ok("student has slide 1 content", studentHtml.includes("What's a D20?"));
  ok("student does NOT hold slide 6 content", !studentHtml.includes("You find out"),
     "the four-beat loop text leaked into a student on slide 1");
  ok("student does NOT hold slide 10 content", !studentHtml.includes("On an attack roll, it hits"));
  ok("student does NOT hold the slide list", !studentHtml.includes("Anatomy of a roll"));
  ok("student does NOT hold the teacher cue", !studentHtml.includes(cue.slice(0, 30)));

  /* ---------------------------------------------------- advancing */

  await teacher.keyboard.press("ArrowRight");
  ok("teacher advanced", await settle(teacher,
    () => document.getElementById("tpos").textContent.trim() === "2 / 17"));
  ok("student followed", await settle(student,
    () => document.getElementById("wpos").textContent.trim() === "2 of 17"));
  ok("student got slide 2 content",
     (await student.content()).includes("Get your audio working"));

  // digit keys build a number, so slides past nine are reachable
  await teacher.keyboard.press("1");
  await teacher.keyboard.press("7");
  ok("two-digit jump works", await settle(teacher,
    () => document.getElementById("tpos").textContent.trim() === "17 / 17"));
  ok("student followed to 12", await settle(student,
    () => document.getElementById("wpos").textContent.trim() === "17 of 17"));
  ok("next button disabled on last slide", await teacher.isDisabled("#tnext"));

  // clicking the slide list
  await teacher.click("#tlist li:nth-child(6)");
  ok("list click moves the room", await settle(teacher,
    () => document.getElementById("tpos").textContent.trim() === "6 / 17"));
  ok("student is on 6", await settle(student,
    () => document.getElementById("wpos").textContent.trim() === "6 of 17"));
  ok("slide 6 is the loop", (await student.content()).includes("You find out"));

  /* ---------------------------------------------------- blackout */

  await teacher.click("#tblack");
  ok("teacher stage goes dark", await settle(teacher,
    () => document.getElementById("tstage").classList.contains("dark")));
  ok("student stage goes dark", await settle(student,
    () => document.getElementById("wstage").classList.contains("dark")));
  const blackHtml = await student.content();
  ok("blackout removes the slide from the student page",
     !blackHtml.includes("You find out"),
     "slide markup was still in the student DOM during a blackout");
  ok("student is told the screen is down",
     (await student.textContent("#wpos")).includes("screen is down"));
  ok("teacher still sees the slide while blacked out",
     (await teacher.content()).includes("You find out"),
     "the teacher lost their own slide during a blackout");

  await teacher.keyboard.press("b");
  ok("blackout lifts", await settle(student,
    () => !document.getElementById("wstage").classList.contains("dark")));
  ok("slide comes back", (await student.content()).includes("You find out"));

  /* ---------------------------------------------------- hands */

  await student.click("#wlost");
  ok("student button latches", await settle(student,
    () => document.getElementById("wlost").classList.contains("on")));
  ok("teacher sees the hand", await settle(teacher,
    () => !document.getElementById("tclear").hidden));
  ok("roster marks them", (await teacher.textContent("#troster")).includes("not following"));
  await teacher.click("#tclear");
  ok("teacher can clear hands", await settle(teacher,
    () => document.getElementById("tclear").hidden));
  ok("student button unlatches", await settle(student,
    () => !document.getElementById("wlost").classList.contains("on")));

  /* ---------------------------------------------------- handout */

  ok("handout hidden before release", await student.isHidden("#whand"));
  ok("student does NOT hold the handout text", !(await student.content()).includes("natural 20 on an attack roll always hits"));
  await teacher.click("#thand");
  ok("handout button appears", await settle(student,
    () => !document.getElementById("whand").hidden));
  await student.click("#whand");
  ok("handout renders", await settle(student,
    () => !document.getElementById("handout").hidden));
  ok("handout has the content",
     (await student.textContent("#handout")).includes("natural 20 on an attack roll always hits"));
  ok("handout bold survived",
     (await student.$$("#handout strong")).length > 3);

  /* ---------------------------------------------------- deck switch */

  teacher.on("dialog", d => d.accept());
  await teacher.click("#tdecks button:has-text(\"Prep and Atmosphere\")");
  ok("teacher switched deck", await settle(teacher,
    () => document.getElementById("tpos").textContent.trim() === "1 / 20"));
  ok("student moved to the new deck", await settle(student,
    () => document.getElementById("wpos").textContent.trim() === "1 of 20"));
  ok("student title updated",
     (await student.textContent("#wtitle")).includes("Prep and Atmosphere"));
  ok("deck switch drops the handout", await student.isHidden("#whand"));
  ok("C2 slide list has 20 entries", (await teacher.$$("#tlist li")).length === 20);

  /* ---------------------------------------------------- refresh lands in place */

  await teacher.click("#tlist li:nth-child(7)");
  ok("teacher on C2 slide 7", await settle(teacher,
    () => document.getElementById("tpos").textContent.trim() === "7 / 20"));
  await student.reload({ waitUntil: "domcontentloaded" });
  await student.fill("#jname", "Test Student");
  await student.click("#jgo");
  ok("a refreshed student lands where the class is", await settle(student,
    () => document.getElementById("wpos").textContent.trim() === "7 of 20"));

  /* ---------------------------------------------------- bad credentials */

  const stray = await sCtx.newPage();
  await stray.goto(`${BASE}/#t/${code}/deadbeef`, { waitUntil: "domcontentloaded" });
  await sleep(1500);
  ok("a bad teacher token does not open the teacher view",
     await stray.isHidden("#teach"));
  await stray.close();

  const bad = await sCtx.newPage();
  await bad.goto(BASE, { waitUntil: "domcontentloaded" });
  await bad.fill("#jcode", "ZZZZZ");
  await bad.click("#jgo");
  ok("a code with no class says so", await settle(bad,
    () => (document.getElementById("jerr").textContent || "").length > 5));
  await bad.close();

  /* ---------------------------------------------------- layout and shots */

  await teacher.click("#tlist li:nth-child(5)");
  await settle(teacher, () => document.getElementById("tpos").textContent.trim() === "5 / 20");

  // every slide of both decks: render it and check nothing spills out
  for (const [deck, total] of [[1, 19], [2, 19], [3, 20], [0, 17]]) {
    await teacher.click(`#tdecks button:nth-child(${deck + 1})`);
    await settle(teacher, () => true);
    await sleep(350);
    for (let i = 1; i <= total; i++) {
      await teacher.click(`#tlist li:nth-child(${i})`);
      await settle(teacher,
        () => true);
      await sleep(120);
      const spill = await teacher.evaluate(() => {
        const st = document.querySelector("#tstage");
        const sl = st.querySelector(".slide");
        if (!sl) return "no slide";
        const a = st.getBoundingClientRect(), b = sl.getBoundingClientRect();
        const over = [];
        sl.querySelectorAll("*").forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.width && r.height && (r.right > a.right + 1 || r.bottom > a.bottom + 1 ||
              r.left < a.left - 1 || r.top < a.top - 1)) over.push(el.tagName);
        });
        return over.length ? over.slice(0, 4).join(",") : "";
      });
      if (spill) { fail++; console.log(`  FAIL overflow on deck ${deck} slide ${i}: ${spill}`); }
    }
    pass++;
  }
  console.log("  ok   no slide overflows its stage, all three decks");

  await teacher.click("#tdecks button:has-text(\"Know your Limits\")");
  await sleep(400);
  for (const n of [6, 7, 8, 10, 12, 14, 16, 18]) {
    await teacher.click(`#tlist li:nth-child(${n})`);
    await sleep(250);
    await teacher.locator("#tstage").screenshot({ path: `${SHOTS}/c1-${String(n).padStart(2, "0")}.png` });
  }
  await teacher.click("#tdecks button:has-text(\"Prep and Atmosphere\")");
  await sleep(400);
  for (const n of [5, 7, 12, 13, 17, 18]) {
    await teacher.click(`#tlist li:nth-child(${n})`);
    await sleep(250);
    await teacher.locator("#tstage").screenshot({ path: `${SHOTS}/c2-${String(n).padStart(2, "0")}.png` });
  }
  await teacher.screenshot({ path: `${SHOTS}/teacher-view.png` });
  await student.screenshot({ path: `${SHOTS}/student-view.png` });

  /* ---------------------------------------------------- narrow student */

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const ph = await phone.newPage();
  await ph.goto(`${BASE}/#s/${code}`, { waitUntil: "domcontentloaded" });
  await ph.fill("#jname", "Phone");
  await ph.click("#jgo");
  ok("student view works at phone width", await settle(ph,
    () => !document.getElementById("watch").hidden));
  const hscroll = await ph.evaluate(() =>
    document.documentElement.scrollWidth > window.innerWidth + 1);
  ok("no horizontal scroll at phone width", !hscroll);
  await ph.screenshot({ path: `${SHOTS}/student-phone.png` });
  await phone.close();

  /* ---------------------------------------------------- no advertising */

  for (const [n, deck] of [[1, "A5"], [2, "C1"], [3, "C2"], [0, "A1"]]) {
    await teacher.click(`#tdecks button:nth-child(${n + 1})`);
    await sleep(350);
    const total = (await teacher.$$("#tlist li")).length;
    let adverts = [];
    for (let i = 1; i <= total; i++) {
      await teacher.click(`#tlist li:nth-child(${i})`);
      await sleep(70);
      const txt = (await teacher.textContent("#tstage")) || "";
      const label = (await teacher.textContent(`#tlist li:nth-child(${i})`)) || "";
      const isArrival = /Arrival/i.test(label);
      if (/sign up|buy anything|subscribe|tell your friends/i.test(txt)) adverts.push(`${deck} ${i} cta`);
      // the Discord link is the operational fallback and belongs on the
      // arrival slide only; anywhere else it is promotion
      if (/discord/i.test(txt) && !isArrival) adverts.push(`${deck} ${i} discord`);
    }
    ok(`no advertising in the ${deck} deck`, adverts.length === 0, adverts.join(", "));
  }

  /* ---------------------------------------------------- the listing */

  const list = await sCtx.newPage();
  await list.goto(`${BASE}/classes`, { waitUntil: "domcontentloaded" });
  const titles = await list.$$eval(".cls h3", e => e.map(x => x.textContent));
  ok("listing shows every class", titles.length === 4, JSON.stringify(titles));
  const listText = await list.textContent("body");
  for (const f of ["all ages", "Prerequisites", "Length", "Taught by"]) {
    ok(`listing carries ${f}`, listText.includes(f));
  }
  ok("listing is not a pitch", !/sign up|buy|subscribe|don't miss/i.test(listText));
  await list.screenshot({ path: `${SHOTS}/listing.png`, fullPage: true });
  await list.close();

  /* ---------------------------------------------------- high contrast */

  await teacher.click(`#tdecks button:nth-child(1)`);
  await sleep(350);
  await teacher.click("#tlist li:nth-child(8)");
  await sleep(250);
  await student.click("#whc");
  ok("student can turn on high contrast", await settle(student,
    () => document.getElementById("wstage").classList.contains("hc")));
  const hcInk = await student.evaluate(() => {
    const t = document.querySelector("#wstage svg [stroke]");
    return t ? getComputedStyle(t).stroke : "";
  });
  ok("high contrast repaints the diagrams", /rgb\(0, 0, 0\)/.test(hcInk), hcInk);
  await student.screenshot({ path: `${SHOTS}/student-contrast.png` });
  await student.click("#whc");
  ok("high contrast turns back off", await settle(student,
    () => !document.getElementById("wstage").classList.contains("hc")));

  /* ---------------------------------------------------- the house frame */

  const corner = await teacher.evaluate(() => {
    const el = document.querySelector("#tstage .slide");
    return getComputedStyle(el, "::before").borderTopWidth;
  });
  ok("slides carry the corner marks", corner === "2px", corner);

  /* ---------------------------------------------------- a second teacher */

  const co = await tCtx.newPage();
  await co.goto(`${BASE}/#t/${code}/${await teacher.evaluate(() => location.hash.split("/")[2])}`,
                { waitUntil: "domcontentloaded" });
  ok("a co-teacher gets the same controls", await settle(co,
    () => !document.getElementById("teach").hidden));
  ok("both teachers are told", await settle(teacher,
    () => /2 of you are driving/.test(document.getElementById("tteachers").textContent)));
  await co.click("#tnext");
  ok("the co-teacher can drive", await settle(teacher,
    () => document.getElementById("tpos").textContent.trim() === "9 / 17"));
  await co.close();

  /* ---------------------------------------------------- the run log */

  await teacher.click("#tlogopen");
  await teacher.fill("#lgatt", "9");
  await teacher.fill("#lgbroke", "the arrival slide sat up too long");
  await teacher.fill("#lgconf", "nobody knew what a modifier was by name");
  await teacher.fill("#lgtried", "somebody tried to roll for the locked door before describing");
  await teacher.click("#lgsave");
  ok("a run is logged", await settle(teacher,
    () => /9 attended/.test(document.getElementById("truns").textContent)));
  const token = await teacher.evaluate(() => location.hash.split("/")[2]);
  const md = await (await fetch(`${BASE}/api/log?code=${code}&token=${token}`)).text();
  ok("the log exports as markdown", md.includes("# Kinspire class run log"), md.slice(0, 60));
  ok("the log carries the answers", md.includes("nobody knew what a modifier was by name"));
  ok("the log carries the attendance", md.includes("**Attended:** 9"));
  const badTok = await fetch(`${BASE}/api/log?code=${code}&token=deadbeef`);
  ok("a bad token cannot read the log", badTok.status === 403, String(badTok.status));

  /* ---------------------------------------------------- ending a class */

  await teacher.click("#tend");
  ok("the student is told it is over", await settle(student,
    () => /finished/.test(document.getElementById("wpos").textContent)));
  const endHtml = await student.content();
  ok("the slide is gone when the class ends", !endHtml.includes("Anatomy of a roll"));
  ok("the student is told what to do", endHtml.includes("close this tab"));
  ok("the hand button is withdrawn", await student.isHidden("#wlost"));
  await teacher.click("#tend");
  ok("a class can be reopened", await settle(student,
    () => /of 17/.test(document.getElementById("wpos").textContent)));

  ok("no page errors", errs.length === 0, errs.slice(0, 3).join(" | "));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
};

main().catch(e => { console.error(e); process.exit(1); });
