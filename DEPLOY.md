# Putting the classroom and the notice board online

One Worker, one deploy, three pages. Fifteen minutes the first time.

Everything in `kinspire-classroom.zip`.

***

## What you get

| Page | Who it is for | What it does |
|---|---|---|
| `/board` | everybody | The notice board. Teachers post classes, players take seats. |
| `/` | everybody | The classroom. Teachers drive slides, students watch. |
| `/classes` | anybody deciding | The catalog listing: levels, lengths, age ratings. |

***

## Before you start

- **Node 18 or newer.** `node --version` in a terminal. If that fails, install it from nodejs.org.
- **A Cloudflare account.** Free. The Workers free plan covers this comfortably at the scale of a few classes a week, and SQLite-backed Durable Objects, which this needs, are on it. Current limits are at `developers.cloudflare.com/durable-objects/platform/pricing` and the SQLite storage billing changed in late 2025, so read it rather than trusting a number from anywhere else.

***

## Deploying it

Unzip it somewhere you will remember, open a terminal in that folder, and run these in order.

    npm install

    npx wrangler login

The second one opens a browser and asks you to authorize. Say yes, come back to the terminal.

    npx wrangler deploy

**That prints your URL.** It will look like:

    https://kinspire-classroom.YOURNAME.workers.dev

where `YOURNAME` is your Cloudflare workers.dev subdomain. **Write it down. It is the only thing you need from this step.**

If it says workers.dev is not enabled, open the Cloudflare dashboard, go to Workers and Pages, and pick a subdomain. Then run `deploy` again.

***

## Set a real admin code, before anybody else sees it

The board ships with a built-in admin code so it runs out of the box. **Replace it immediately.** It is the only thing standing between a stranger and the ability to issue teacher codes.

    npx wrangler secret put ADMIN_CODE

It asks for a value. Type something long that you will not lose, press enter. It takes effect at once; no redeploy.

**Check it worked:** open `/board`, click *Teaching?*, and sign in with your new code. The red line about `wrangler secret put` should be gone.

***

## First ten minutes on the board

1. Go to **`https://your-url/board`** and click **Teaching?**
2. Sign in with your admin code.
3. In **Teacher codes**, type `Tony`, click **Issue a code**. Write the six characters down.
4. Do the same for `Shawn`.
5. Send each of them their code **directly**, not in a channel. A code is their whole sign in.
6. Post something yourself to check it: pick a class, a date, a cap of 8, fee 0, a couple of sentences. It appears on the public board at once.
7. Open the board in a private window as if you were a player, click attend, and take a seat. Then go back to your teacher desk and confirm you can see the name.
8. Cancel the test listing.

***

## What a teacher does, every time

1. **Days ahead: post it.** `/board`, *Teaching?*, sign in, pick category, level, class. Date, length, cap, fee, and a blurb. The catalog blurb in section 3 of the curriculum is written for exactly this.
2. **On the day: press Start the classroom** on your own listing. A new tab opens with a room already built and the right deck loaded.
3. **Press Add the room code** and paste the five characters back onto the listing. Everybody holding a confirmed seat can now see it on their ticket.
4. **Teach.** Arrow keys, number keys to jump, `b` to black the screen out. The cue under each slide is the line from your brief.
5. **Release the handout** at the end, with the button.
6. **End the class**, then **Log this run** and answer the three questions.

The teacher card for each class, in `kinspire-class-print-pack.zip`, has the running clock and the cut list on one page. Print it or keep it open.

***

## What a player does

Nothing, until they want a seat.

1. Open the board.
2. Find a class, click **Attend**.
3. Give a name, and a Discord handle if they want to be reachable.
4. **Free class:** the seat is theirs at once. **Paid class:** the seat is held for thirty minutes, they follow the payment link, and the teacher confirms it.
5. On the day, open the ticket and press **Open the classroom**.

No account at any point. The ticket is kept in their browser, with the code as the fallback on another device.

***

## A custom domain, if you want one

Not required. If Kinspire already has a domain on Cloudflare, add this to `wrangler.jsonc` above the closing brace:

    "routes": [
      { "pattern": "classes.kinspire.net", "custom_domain": true }
    ]

Then `npx wrangler deploy` again. It will issue the certificate itself.

***

## Changing it later

**New or edited class in the catalog:** edit `Kinspire_Class_Catalog.md`, then

    cd build && python3 extract_catalog.py
    cd .. && npx wrangler deploy

The board's three dropdowns come from that file. Never edit `src/catalog.js` by hand.

**New or edited deck:**

    cd build && python3 build_decks.py
    cd .. && npx wrangler deploy

**Checking nothing broke:**

    npx wrangler dev --port 8788 &
    node e2e.mjs        # the classroom, 91 assertions
    node e2e_board.mjs  # the notice board, 61 assertions
    node e2e_flow.mjs   # the whole chain end to end, 44 assertions

All three are safe to run repeatedly.

***

## What to post, once it is up

Plain, because this is an announcement rather than a pitch. Swap the URL in.

**For the Discord announcements channel:**

> **Classes are live.**
>
> The notice board is at **https://your-url/board** . Everything being taught is listed there with the date, how long it runs, how many seats are left, and what it costs if anything.
>
> You do not need an account. Click a class, click attend, give a name. That is the whole thing.
>
> On the day, open your ticket and press Open the classroom.
>
> First up: **A1 "What's a D20?"** for anybody who has never played, and **C1 "Know your Limits"** for anybody who has thought about running a game and not started.

**For the teachers, sent directly with their code:**

> Your teacher code for the Kinspire board is **XXXXXX**. Keep it to yourself; it is your whole sign in.
>
> Go to https://your-url/board , click Teaching?, and put it in. Post a class with the dropdowns, then on the day press Start the classroom on your own listing and read the room code out.
>
> Your teacher card for the class is attached. It has the clock and the cut list on one page.

**Pin the board link** rather than reposting it. The listings change; the link does not.

***

## If something goes wrong

**The deploy fails with a Durable Object migration error.** You have deployed before with a different config. Run `npx wrangler deployments list` to see what is there, and if it is a test deploy you do not care about, `npx wrangler delete` and start again.

**A teacher cannot sign in.** Their code was disabled, or it was mistyped. Codes have no I, O, S, 0, 1 or 5 in them on purpose, so a character that looks like one of those is a different character.

**A class shows the wrong time.** It will not. Times are stored as an instant and displayed in whoever is reading's own zone, with the zone named next to it. If somebody sees a different hour than you do, they are in a different timezone and you are both correct.

**Somebody paid and the board still says they are holding.** The board cannot see payments. Mark them paid on your desk.

**A hold expired and the seat went back.** That is the design. The seat is on the board again and they can take it again.

***

## Two things this deliberately does not do

**It does not verify payments.** A paid class holds the seat, hands over your payment link, and waits for you to confirm. Nothing here talks to a payment processor, and building it to look like it did would be worse than saying so.

**It messages nobody.** A player who takes a seat sees a ticket on screen and gets no email. If you cancel a class, nobody is told. Post the cancellation in Discord yourself. **This is the first thing worth adding** and the reason it is not here yet is that it needs a decision about what you send and from where.
