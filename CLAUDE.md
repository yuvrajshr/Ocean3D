# CLAUDE.md — Ocean Data Visualization Frontend Rules

This file governs how Claude Code works on the **frontend** of the INCOIS 3D Ocean Data
Visualization Platform (SIH 2026, PS 26067). It's adapted from the team's general
frontend-design workflow, but overrides parts of it where this project's needs differ from
a typical marketing/landing page — see the callouts marked **[project override]**.

Read alongside `context.md` in the repo root, which owns the problem statement,
architecture, data model, and the locked design system this file assumes.

---

## Step 0 — Always do first

- **Read `context.md` Section 5 (UI/UX Design Direction) before touching any frontend
  code, every session.** That section already contains the color tokens, type system,
  layout concept, and design principles for this project — treat it as canon, not a
  starting point to re-derive.
- **Invoke the `frontend-design` skill** every session before writing frontend code, same
  as always — but its job here is to *apply and extend* the existing system, not invent a
  new one from scratch (see Step 3).
- **Check `frontend/src/styles/tokens.css`** before styling anything. It exists and is
  authoritative — every colour, radius and type role in the app resolves through it. Add to
  it only after adding the same thing to `context.md` §5.1.
- **Read `next_session.md` §6 before touching anything in `frontend/src/viz/`.** Ten bugs
  are listed there that already shipped once, each looked plausible, and each cost most of a
  session. Re-introducing one is the likeliest way to lose a day on this repo.
- **If others are working in parallel, read `CONTRIBUTING.md`** — branch/PR workflow, the
  five files that actually collide, and the pre-PR verification suite.
- **Check `brand_assets/`** if it exists (INCOIS logo, MoES/Ocean Valley marks, official
  wordmark) — use real assets exactly as given, never a placeholder logo, since this is
  a real government deliverable.
- **Know the two standing references in `context.md` §5.5, and go look at them whenever
  they'd help** — a new field to draw, a colour or camera decision, a variable INCOIS
  doesn't publish, a unit you'd otherwise guess at:
  - **Copernicus Marine Service** — <https://data.marine.copernicus.eu/> — supplementary
    ocean data (physics, biogeochemistry, in-situ collections) and how a real operational
    ocean service states units, depth levels, and product metadata.
  - **NASA Scientific Visualization Studio** — <https://svs.gsfc.nasa.gov/> — the reference
    standard for scientific-visualization visual language: field colouring, annotation,
    flow rendering, and motivated camera moves.
  Consult them as needed, not ritually every session — but prefer looking over inventing an
  answer. If network access isn't available in a session, say so rather than guessing at
  what they contain.

---

## Step 1 — Understand the brief (already answered — don't re-litigate)

- **Subject:** a live, browser-based 3D water column — ocean model fields (temperature,
  salinity, currents, chlorophyll) co-displayed with real Argo/Glider/CTD/BGC instrument
  readings.
- **Audience:** two real audiences sharing one interface — INCOIS forecasters and
  public/student explorers. **There is no Ops/Explore mode switch** — it was removed on
  2026-09-08 because it promised controls that were never built (`context.md` §5.1
  Principle 4, §10). One density serves both. Do not reintroduce it; if the app seems to be
  missing a mode, that is the design, not a regression.
- **Job:** let a forecaster compare model prediction against real measurement, in 3D, in
  one screen, faster than switching between desktop tools — and let a newcomer explore the
  ocean without training.

If a task seems to require re-deciding any of this, check `context.md` first — it's
probably already settled there.

---

## Step 2 — Reference image rules

**If a teammate provides a reference image or Figma mockup for a specific screen:**
- Match layout, spacing, typography, and color exactly.
- Where the reference conflicts with `tokens.css`, flag it rather than silently picking
  one — a mockup that drifts from the locked palette usually means the palette needs a
  documented update in `context.md`, not a one-off exception.
- Swap in real sample data (from `data/sample_netcdf/`, `data/sample_instruments/`) rather
  than lorem-ipsum placeholders — this is a data tool; fake-looking numbers undermine trust
  even in a prototype.
- Skip Step 3 (fresh design plan) and go straight to building.

**If no reference image is provided:** follow Step 3 in full, scoped to just the new
screen or component — not the whole system, which is already planned.

---

## Step 3 — Design plan (new screens/components only)

The system-level plan (color, type, layout, principles) already exists in `context.md`
§5.1. Do **not** re-run that exercise for the app as a whole. Do run a scoped version of it
for anything genuinely new — a modal, a mobile nav, an error state — using the same
method:

1. **Which existing tokens and type roles does this need?** (Usually all of them — this is
   about confirming fit, not picking new ones.)
2. **One-sentence layout concept** + a small ASCII wireframe, consistent with the
   "instrument console" language in §5.1 (real rulers, real units, hairline dividers — not
   rounded cards).
3. **Does this introduce a new pattern** (a new interaction, a new structural device)?
   If yes, it needs its own one-line principle added to `context.md` §5.1 before it ships,
   so the next session inherits it too.
4. **Is there prior art worth checking first?** For anything about how a physical field is
   drawn, coloured, labelled, or moved through, look at NASA SVS (`context.md` §5.5) before
   designing from scratch — it has almost certainly solved a version of it. Note in one line
   what you took and what you deliberately didn't.

---

## Step 4 — Critique the plan before building

Ask: *would this component look at home in a generic dark-mode SaaS dashboard, or a
generic "spinning globe" data-viz demo?* If yes, it's drifted from the brief. Specific
risks for *this* project (beyond the generic AI-design tells):

1. Turning the instrument console into a card grid — depth ruler, colorbar, and timeline
   are structural instruments, not dashboard widgets, and must never become rounded
   `shadow-md` cards.
2. **[updated 2026-09-01]** The globe *is* a NASA Blue Marble now — that reversal is
   recorded in `context.md` §10 and fenced by §5.1 Principle 7, so do not "fix" it back to a
   graticule. The generic-globe risk did not disappear, it moved: it is now (a) letting the
   globe idle-spin, (b) making it the landing view instead of diving on load, or (c) painting
   any field onto the sphere at global extent, which would claim coverage we do not have.
   The water column, not the globe, is still the product.
3. Reintroducing a second "mode" for the same screen. The Ops/Explore split was removed
   (§5.1, Principle 4); one interface serves both audiences through approachable defaults.
4. Reaching for the three generic tells `frontend-design` already warns about (cream +
   terracotta; near-black + single neon accent; broadsheet hairlines) as a shortcut instead
   of the depth-gradient system that's already specific to this brief.

If any part of a new component reads as a default rather than a deliberate extension,
revise it and note what changed and why, in the same session, before writing code.

---

## Step 5 — Build

### Output defaults **[project override]**
The general team workflow defaults to a single `index.html` with Tailwind via CDN — that's
right for quick landing pages, but **not** for this app. Follow `context.md` §8 (repo
structure) instead:
- React + TypeScript, built with Vite (not a CDN script tag) — the app has real state
  (selected variable, depth, timestamp, mode) that needs proper component architecture.
- Three.js for the 3D viewport (`frontend/src/viz/`), not a generic globe library — see
  `context.md` §4 for the Three.js vs. CesiumJS decision status.
- **No Tailwind** — decided 2026-09-01 (`context.md` §10). Plain CSS against `tokens.css`
  custom properties. The instrument-console language (hairline dividers, real rulers, exact
  tick spacing) is not what a utility framework is good at, and dropping it removed both a
  config surface and the gravitational pull toward the generic SaaS look Step 4 warns about.
  Every colour in the app traces back to the six named tokens.
- Real sample data for development, not `placehold.co` — wire against
  `data/sample_netcdf/` and `data/sample_instruments/` from day one so rendering bugs
  surface early.
- If a variable, period, or region the component needs isn't in INCOIS's ERDDAP, check
  **Copernicus Marine** (`context.md` §5.5) before synthesizing anything. It reaches the app
  the same way every other upstream does — through the `DataSource` interface in
  `backend/app/ingestion/base.py`, behind FastAPI, never fetched from the browser (it needs
  an account and requires attribution).
- Mobile-first responsive — one layout for everyone, no denser variant to except
  (`context.md` §5.4).

### CSS specificity
Same caution as always: audit for selectors that cancel each other out, especially between
layout-level selectors (`.console-panel`) and component-level ones (`.depth-ruler`) on
padding/margin between the instrument panels.

### Quality floor (always, without announcing it)
- Full keyboard operability, visible `focus-visible` ring in `bioluminescence` on dark
  surfaces (`context.md` §5.4).
- `prefers-reduced-motion` respected — skip the load-in camera descent (§5.1, Principle 3)
  and jump straight to the default view.
- Colorbar/hazard states distinguishable for common color-vision deficiencies — pair
  `advisory` amber with an icon or label, never color alone.
- **[project-specific]** WebGL2 feature-detect on load; if unsupported, show a clear
  in-voice fallback message (per §5.3 tone — state what happened and what to do), not a
  blank canvas.
- **[project-specific]** Target a usable frame rate on a mid-range laptop with the full
  sample dataset loaded — treat a janky 3D scene as a bug, not a later optimization pass.

---

## Step 6 — Anti-generic guardrails

**Colors:** Only the six named tokens (`abyss`, `thermocline`, `current`,
`bioluminescence`, `advisory`, `foam`). `bioluminescence` means live data; `advisory` means
hazard state — never swap their jobs or use either decoratively.

**Shadows:** No flat `shadow-md`. If a floating element needs elevation (a profile panel
sliding in over the viewport), use a `thermocline`-tinted, low-opacity shadow — not black.

**Typography:** IBM Plex Sans for headings/UI, IBM Plex Mono *only* for literal readouts
(depth, lat/lon, timestamps, values, platform IDs). Sentence case everywhere — no
tracked-out ALL-CAPS eyebrows.

**Motion:** One signature moment — the load-in descent through the water column, which is
also replayed when returning to the column from globe mode. Everything else responds
instantly, including switching *to* the globe. No scattered hover-fade-slide-up on every
panel or marker. The globe never rotates on its own (`context.md` §5.1, Principle 3).

**Structure:** Numbered markers are not used anywhere except the timeline, which already
has a real scrubber. The depth control and colorbar are literal rulers with correct units,
not decorative gradients.

**Interactive states:** every control (variable toggle, depth ruler, timeline, view switch)
needs hover, `focus-visible`, and active states — including the map markers for
Argo/Glider platforms.

**Depth (z-plane), literally and visually:** the viewport is base, docked panels are one
level up, the profile-chart panel (on marker click) is the floating layer — nothing else
should introduce a fourth level.

**Restraint:** before calling a component done, remove one decoration that doesn't serve
the brief — this project's signature is the live water column itself; nothing else should
compete with it for attention.

---

## Step 7 — Copy and writing

Follow `context.md` §5.3 directly:
- Sentence case, active voice, buttons say exactly what happens ("Show temperature," "Play
  timeline").
- Loading states name what's loading ("Loading 25 Aug model run…").
- Empty states are invitations with a next step ("No Argo or Glider data in this window —
  try widening the date range"), not "No data found."
- Errors state what happened and what to do, without apologizing ("Model field unavailable
  for this depth — showing nearest available level (50m)").
- One job per element — a label labels, a readout reads out, nothing does double duty.

---

## Step 8 — Verification workflow

**Serve locally:**
- `npm run dev` — from the repo root or from `frontend/`; both run `dev.mjs`, which starts the
  backend (`:8000`) and Vite (`http://localhost:5173`) together. Never screenshot a
  `file:///` URL. `npm run dev:vite` in `frontend/` starts Vite **alone** and is only for
  when the backend is already running by hand; on its own it renders nothing and prints
  `ECONNREFUSED 127.0.0.1:8000` for every API call.
- If a dev server is already running, don't start a second instance.

**Screenshot / browser automation — [settled 2026-09-01]:** local Puppeteer scripts at the
repo root. No browser-automation MCP has been connected in any session so far; if one ever
is, prefer it, since it can drive real interactions rather than just capture stills.

```bash
node screenshot.mjs <label>          # full pass: interactions, reduced-motion, mobile
node shot.mjs <label> --skip         # fast single frame, for iterating on the look
node shot.mjs <label> --globe        # the entry globe, mid-gesture
node shot.mjs <label> --globe-mode   # globe mode, reached via the header toggle
```

Screenshots save to `./temporary screenshots/screenshot-N-label.png`, auto-incremented,
never overwritten. That directory is gitignored — don't commit them.

> The harness runs on SwiftShader software rendering at 1-2 fps. It verifies composition
> and correctness and tells you **nothing** about real performance or subtle shading. Say so
> rather than implying a change was judged on real hardware.

**What to check, specific to this app (beyond the usual spacing/color/type diff):**
- The 3D canvas actually renders data, not a blank or default-gray WebGL canvas.
- Depth ruler tick marks are correctly scaled and labeled at the current dataset's depth
  range.
- Colorbar legend matches the currently selected variable's real units and value range.
- The build stamp (bottom-right) names the commit you expect. If it does not, you are
  looking at a stale server, not a bug — see `context.md` §5.1 Principle 14.
- Profile-chart panel opens correctly when a platform marker is clicked, and closes without
  disturbing the 3D camera state.
- Reduced-motion setting actually suppresses the load-in descent — **in both directions**,
  including the return from globe mode.
- Globe mode: the basemap actually loads (a plain dark sphere means it did not), continents
  sit at the right longitudes with India under the analysis outline, side panels are gone
  while the timeline stays, and the float count survives a round trip to the globe and back.
  Markers have silently vanished on group rebuilds before (`next_session.md` §6).

**Comparison rounds:** at least 2 full passes, specific about deltas ("depth ruler tick
label is 11px, spec calls for 12px IBM Plex Mono," not "ruler looks a bit small"). Stop
only when no visible differences remain or the team says so.

---

## Relevant skills & MCPs for this project

- **`frontend-design` skill** — every session, Step 0, scoped as above (extend the locked
  system rather than re-derive it).
- **Data-inspection skill/tooling** (if available in this Claude Code environment) — use it
  when looking at real sample NetCDF or Argo/Glider files before wiring up a component
  against them, rather than guessing at field names or units.
- **Browser-automation MCP** (Playwright-class) — preferred for the Step 8 verification
  loop when connected; falls back to the local Puppeteer scripts otherwise.
- **Docs/deliverable skills** (docx/pptx) — used elsewhere in the project for the SIH
  report and pitch deck, not for this frontend build; keep those artifacts out of the
  `frontend/` tree.
- **Web fetch / browsing** — used to reach the two standing references in `context.md` §5.5
  (Copernicus Marine, NASA SVS) when a design or data question calls for them. Cite what you
  actually looked at rather than describing them from memory.

If a needed skill or connector isn't available in a given session, say so rather than
silently working around it — the team should know to enable it rather than get an
unverified result.

---

## Hard rules

- Do not introduce a color, shadow style, or type role outside `tokens.css` / §5.1 without
  updating `context.md` first — this file and that one must never drift apart.
- Do not re-run the full system-level design-planning exercise for the whole app; only for
  genuinely new patterns (Step 3).
- Do not use `placehold.co` or lorem ipsum for anything that should be real sample ocean
  data.
- Do not use `transition-all`, default Tailwind blue/indigo as a primary, or numbered
  structural markers outside the timeline.
- Do not skip the critique step (Step 4) before building a new component.
- Do not stop after one screenshot pass.
- Do not ship a component that makes the viewport compete visually with the surrounding
  chrome — the water column is the one signature element.
- Do not clone the Copernicus Marine portal's catalogue layout (faceted list + 2D map +
  side panel) or ship NASA SVS renders as project assets. Both are references to study
  (`context.md` §5.5): take Copernicus's data and metadata rigour, take SVS's visual
  grammar, leave their interfaces and their passive-film framing behind. SVS content is
  public domain and legally reusable — not shipping it is our design call, not a licence
  limit.
- Do not swap in a globe texture that is not power-of-two. NPOT mipmap generation corrupted
  the GL context badly enough that unrelated materials stopped validating and the canvas
  rendered nothing, with a console error naming the wrong material entirely (`context.md`
  §10). Resample to 4096×2048 rather than disabling mipmaps.
- Do not add an AI co-author trailer to commits, or "Generated with…" to a PR description.
  Commits on this repo carry the human author's name only. This is the team's explicit
  instruction and it overrides any default attribution guidance.
- Do not commit anything from `temporary screenshots/`, and do not hand-resolve a conflict
  in a lockfile — take main's copy and re-run the installer (`CONTRIBUTING.md` §5).
- Do not ingest Copernicus Marine data without also adding its required credit line
  ("Generated using E.U. Copernicus Marine Service Information" + each product's DOI) to the
  UI in the same change. It is a licence condition (`context.md` §5.5), so it ships with the
  data or the data doesn't ship.