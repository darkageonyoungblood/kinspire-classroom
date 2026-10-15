# Kinspire Classroom

Two rooms in one Worker, one deploy.

**`/board`** is the notice board. Teachers sign in with a code and post a class
from the catalog with a date, a cap, a fee and a blurb. Players do not sign in
at all: they look, they click attend, they give a name, the count moves.

**`/`** is the classroom. Pick a class, get a code, drive the slides. Everyone
else watches whatever is on screen right now, and nothing else.

**`/classes`** is the catalog listing, with levels, lengths and age ratings.

The classroom is the same shape as the dice table: one room, two roles, state
held on the server.

***

## Why this needs a server

A deck in a browser is a file every viewer has a complete copy of. That is
fine for a deck you email and wrong for a class you are running, for three
reasons.

**Reading ahead.** A student socket is sent the markup of one slide. Not the
deck, not the slide list, not the next slide. Hiding later slides with CSS is
not hiding them; not sending them is. If students can scroll ahead, a teaching
aid becomes a document they read instead of listening, and the teacher has
lost the room.

**Position.** The slide the class is on lives in the Durable Object. Somebody
whose connection drops, or who joins eleven minutes late, lands where the
class actually is rather than at slide one.

**Control.** Advancing requires the teacher token. A student socket can send
exactly one message, which is whether they are following.

A blackout is enforced the same way. When the teacher blacks out the screen,
the student payload contains no slide at all, so there is nothing on the page
to inspect. The teacher keeps seeing their own slide.

***

## Running it

    npm install
    npx wrangler dev        # local, at http://127.0.0.1:8787
    npx wrangler deploy     # live, at kinspire-classroom.<your-subdomain>.workers.dev

A Worker, not a static drop, because it needs Durable Objects. SQLite-backed
Durable Objects are on the Workers free plan and a class of twelve for an hour
sits far inside the limits.

`public/` holds images only. The client page is embedded in the Worker, so
every path that is not an image falls through to it.

***

## How a class runs

1. The teacher opens the site and picks a class from the list.
2. They get a five-character code and a student link.
3. They read the code out, or paste the link in chat or Discord.
4. Students enter the code and a name. No account, no install.
5. The teacher drives. Students follow.

The teacher link is held in that browser's localStorage and in the address
bar. **There is no recovery if that browser data is cleared mid-class**, so
for a class that matters, keep the tab open. Opening a new room takes about
four seconds, which is the fallback.

### Teacher controls

| Key | Does |
|---|---|
| right arrow, space, page down | next slide |
| left arrow, page up | previous slide |
| a number, then a pause | jump to that slide, two digits included |
| Home, End | first slide, last slide |
| `b` or `.` | blackout |

The same keys as the standalone decks, on purpose.

The teacher panel also shows the cue for the current slide, taken from the
written curriculum so the brief and the deck cannot disagree, the name of the
next slide, the slide list, and who is in the room.

### What students can do

One button: **I am not following.** It shows on the teacher's bar as a count
and in the roster next to the name. The teacher clears them all at once.

This exists because a virtual class gives a teacher none of the signals a
table does. It is the cheapest substitute for looking up and seeing a face.

### Co-teaching

The teacher link works for more than one person at once. Both get the full
controls and the panel says how many of you are driving, which is the thing
that stops two people reaching for the clicker at the same moment.

### Ending a class

**End the class** replaces the student's slide with a line saying it is over
and withdraws the hand-raise. **Reopen** puts it back. A student who leaves
the tab open is told rather than left on a dead slide.

### The run log

After a class, **Log this run** captures the three bug-log questions and the
attendance, with the peak count filled in for you. It lives in the room and
exports as markdown from **Download the run log**. The classes are also the
playtest, and this is the only part of that which was being thrown away.

### High contrast

Both views have it, per viewer, remembered in that browser. It repaints the
diagrams as well as the text: pure black on pure white. The warm paper and
the serif were chosen to sit beside a hand-drawn sheet, and this gives back
what that choice costs somebody.

### Handouts

Off until the teacher releases them. The handout text lives with the deck, so
releasing it is one button and nobody has to find a file. Switching decks
hides it again.

***

## The decks

| ID | Class | Slides | Ages | Teacher |
|---|---|---|---|---|
| A1 | "What's a D20?" Intro to TTRPG Play | 17 | all ages | unassigned |
| C1 | "Know your Limits" Intro to DMing | 19 | all ages | T |
| C2 | Prep and Atmosphere | 20 | all ages | T prep, D atmosphere |

`/classes` is the listing, built from the same catalog, so a deck and its
listing cannot disagree.

Black ink on warm paper, no colour, no webfonts. The deck renders identically
with the network gone, which is the point of having it offline.

**Every diagram is inline SVG, constructed from shapes and type.** Nothing in
this tool is generated. The one photographic image is a hand-drawn reference
sheet, scanned.

### Editing a deck

Slides are built by `build/build_decks.py` into `src/decks.js`. Edit the
builder and run it; do not edit `decks.js` by hand.

    cd build && python3 build_decks.py

A1's twelve slides are extracted from `deck/a1-deck.html` rather than retyped,
so the standalone file you can email and the deck served here cannot drift
apart.

***

## Tests

    npx wrangler dev --port 8788 &
    node e2e.mjs        # the classroom, 91 assertions
    node e2e_board.mjs  # the notice board, 61 assertions
    node e2e_flow.mjs   # the whole chain, 44 assertions

Real browsers throughout. `e2e_flow.mjs` is the one that fails if the pieces
stop joining up: four browsers, one class, from Darkageon issuing Shawn a code
to a paying attendee looking at slide two. All three are safe to run
repeatedly against the same dev state. The ones worth
reading are the negative ones:

- a student on slide 1 does not hold slide 6, slide 10, the slide list, or the
  teacher's cue anywhere in their page
- a blackout removes the slide from the student page entirely
- the teacher keeps their slide during a blackout
- a bad teacher token does not open the teacher view
- no slide in any deck overflows its stage, checked element by element

That last one is there because a layout bug on slide 8 of the A1 deck passed
every DOM assertion and was only visible in a screenshot.

***

## The notice board

### How a class gets taught, start to finish

1. Darkageon issues a teacher a code from the admin panel on `/board`.
2. The teacher signs in with it and posts a class: category, then level, then
   the class itself, from the catalog. Then a date and time, a cap, a fee, and
   a few sentences about what it is.
3. Players open `/board`, find it, and click attend. They give a name and get
   a ticket. No account.
4. On the day the teacher presses **Start the classroom** on their own listing,
   which opens a room with the right deck already loaded, then pastes the
   five-character code back onto the listing with **Add the room code**.
5. Everybody holding a confirmed seat sees that code on their ticket and can
   press **Open the classroom** to walk straight in.

**The room code is never on the public board.** A code admits anybody, so a
paid class would be free to whoever read the page. It goes to seat holders and
to the teacher, and nowhere else. A seat that is still holding payment is not
given it either.

### The three dropdowns

Category, then level, then class, generated from `Kinspire_Class_Catalog.md` by
`build/extract_catalog.py`. All 181 classes across six categories. Edit the
catalog and rerun the builder; never edit `src/catalog.js` by hand. A board
that offers a class the catalog does not have is worse than no board.

Categories with one level (art, system creation, artists and vendors) collapse
the middle select rather than asking a question with one answer.

### Payment, said plainly

**This cannot verify a payment.** Nothing here talks to a processor.

A paid class holds the seat for 30 minutes, hands the player the teacher's own
payment link, and waits. The teacher sees who is holding and marks them paid.
A hold that runs out releases the seat back to the board automatically, so a
cap is never locked up by somebody who wandered off.

Any other design would be claiming a check the code does not perform.

### What a player is and is not sent

A listing's public shape carries counts and nothing else. No attendee names, no
contact details, no tickets, no teacher codes. The teacher's roster is the
teacher's. This is the same rule the classroom uses for slides, and the board
test suite asserts it against the live API rather than against the page.

### Codes

The admin code comes from the `ADMIN_CODE` secret, and falls back to
`KINSPIRE-ADMIN` so the thing runs out of the box. **Set a real one before this
is on the open internet:**

    npx wrangler secret put ADMIN_CODE

The admin panel says so in red until you do.

Teacher codes are six characters, issued from that panel, one per teacher. A
code is the whole sign in, so send it directly rather than posting it.

### Times

Stored as an instant, displayed in whoever is reading's own zone with the zone
named. Nobody types a timezone and nobody has to work out whether a date in
October is EST or EDT.

***

## Still open

- Does this share a Worker with the dice table, or stay separate. Separate for
  now, which is one more thing to maintain and keeps a failure in one from
  taking out the other mid-class.
- Are sessions recorded. If the deck plus a transcript becomes the artifact,
  the slides have to work without the teacher present, which is a higher bar
  than they clear now.
- Does the teacher view need the full subject brief alongside the cue. One
  line per slide is what is there; the whole brief would mean no second
  window, and also more scope.
- Should the board email or message anyone. It does not. A player who takes a
  seat gets a ticket on screen and nothing else, and a teacher who cancels
  reaches nobody. Whether that matters depends on how far ahead classes get
  posted.
- Should a listing create its room automatically at the start time, rather than
  the teacher pressing a button and pasting a code back. The chain works; it is
  two clicks that could be none.
