# Contributing

**INCOIS 3D Ocean Data Visualization · SIH 2026 · PS 26067**

How we work on this repo so that several people can move at once without
standing on each other. Most of it is ordinary git hygiene; the parts specific
to *this* codebase are marked.

---

## 1. Read these first

| File | What it owns |
|---|---|
| `next_session.md` | Current status, how to run it, and **the list of traps** |
| `context.md` | Problem statement, architecture, data model, locked design system, decision log |
| `CLAUDE.md` | Frontend working rules |

`context.md` and `CLAUDE.md` are canon. If your change contradicts them, the fix
is to update them in the same PR and say why — not to quietly diverge.

**Before you touch anything in `frontend/src/viz/`, read `next_session.md` §6.**
It lists ten bugs that already shipped once, looked plausible, and cost most of a
session each. Re-introducing one is the most likely way to lose a day here.

---

## 2. Getting it running

**One command, from the repo root:**

```bash
npm run dev          # both processes, prefixed output, Ctrl+C stops both
npm run dev --open   # ...and open the browser once both answer
```

It resolves the venv itself (`Scripts/` on Windows, `bin/` elsewhere), refuses to
start on a port that already answers, and **takes both down if either one dies** —
a half-running stack renders a blank page that reads as a bug in the 3D rather
than as a dead server, which is the most expensive false trail this repo has
recorded (`next_session.md` §2).

**The page names its build** in the viewport's bottom-right corner, and warns when the
code on disk has moved past what is running. If a fix you pulled "didn't take", check that
stamp before anything else — a stale server looks exactly like a bug. Either start path now
refuses to run a second server on a busy port rather than drifting to 5174.

Starting them separately still works, backend first, because the browser cannot
reach ERDDAP directly:

```bash
# Backend  → http://127.0.0.1:8000   (docs at /docs)
cd backend && .venv/Scripts/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000

# Frontend → http://localhost:5173
cd frontend && npm run dev
```

On a fresh clone, fetch the globe basemaps once (they are committed, so only if
`frontend/public/*.jpg` is missing):

```bash
cd frontend && node scripts/fetch-textures.mjs
```

---

## 3. Branches and PRs

- **Never commit directly to `main`.** Branch, open a PR, get one review.
- Name branches `area/short-description` — `viz/current-arrows`,
  `backend/wms-endpoint`, `ui/mobile-timeline`.
- **Keep branches short-lived.** Aim to merge within a day or two. A branch that
  sits for a week touching `scene.ts` is where an afternoon disappears.
- Small PRs. One concern each. A 40-line PR gets reviewed properly; a 900-line
  one gets approved without being read, which is how invariants get broken.

---

## 4. Who owns what

Conflicts are not random — they cluster. These are the collision-prone files:

| File | Lines | Why it collides |
|---|---|---|
| `frontend/src/viz/scene.ts` | ~920 | The composition hub. Nearly every 3D change lands here. |
| `frontend/src/styles/app.css` | ~810 | One stylesheet for the whole app. |
| `context.md` | ~700 | Everyone appends to the §10 decision log, at the same spot. |
| `frontend/src/App.tsx` | ~580 | All application state. |
| `package-lock.json` (×2) | — | Conflicts on any dependency change. |

**The practical rule: one person in `scene.ts` at a time.** Two people editing it
in the same week is the single most reliable way to create a painful merge. Say
in the group chat when you're going in, and get out quickly.

Areas that parallelise safely, because they barely overlap:

- **Backend** — `backend/` (Python; near-zero overlap with the frontend)
- **3D viewport** — `frontend/src/viz/`
- **UI** — `frontend/src/components/`, `frontend/src/styles/`
- **Docs and pitch** — `context.md`, `docs/`

---

## 5. Keeping merges clean

**Rebase daily. This is the highest-leverage habit here.**

```bash
git pull --rebase origin main
```

A branch three hours behind `main` almost never conflicts. One three days behind
usually does. Nothing else on this list matters as much.

**Lockfiles — never hand-resolve.** Take `main`'s copy and regenerate:

```bash
git checkout --theirs package-lock.json && npm install
```

Hand-editing a lockfile produces a tree that installs differently for different
people. That bug is very hard to trace back to its cause.

**Decision log (`context.md` §10) — append, don't reflow.** Add your entry as a
new bullet at the *end* of the list, and don't re-wrap or edit the entries around
it. If two branches both append at the end, git shows a small conflict where the
resolution is obvious: keep both entries. If you reflow a neighbouring paragraph,
the conflict becomes large and genuinely ambiguous.

Same for `next_session.md`.

**Binary files can't be merged at all.** The basemaps under `frontend/public/`
and the NetCDF fixtures in `data/` are marked binary in `.gitattributes`. If two
branches change one, git keeps both versions and someone picks. Coordinate first.

---

## 6. Before you open a PR

Run all of it. Everything here passes on `main` today, so a failure is yours:

```bash
cd backend  && .venv/Scripts/python -m pytest tests -v   # 11 integration tests, live data
cd frontend && npx tsc --noEmit && npm run build         # both must be clean
node screenshot.mjs <label>                              # full visual pass
```

`screenshot.mjs` must finish with **zero console errors**. Screenshots land in
`temporary screenshots/`, which is gitignored — don't commit them.

> The screenshot harness runs on software rendering at 1–2 fps. It verifies
> composition and correctness and tells you **nothing** about real performance.
> If your change touches the 3D, look at it on an actual GPU before you claim
> it's done.

If you changed a colour, a shadow, a type role, or added a structural pattern,
update `context.md` §5.1 **in the same PR**. `CLAUDE.md` treats drift between the
two as a hard rule violation.

---

## 7. The danger zone

These are load-bearing and easy to break with a plausible-looking edit. All are
explained in `next_session.md` §6.

- **The data column and the seafloor do not share a vertical axis.** This took
  four rebuilds to get right. Don't "simplify" `viz/geo.ts` by unifying them.
- **The volume geometry is a unit cube scaled to aspect.** The raymarch shader
  intersects `[-0.5, 0.5]` in object space; a pre-sized `BoxGeometry` silently
  clips most of the field away and still looks reasonable.
- **No tone mapping on the renderer.** It would remap the data volume's colours
  and shift what a reader believes a temperature is. The globe basemap's shadow
  lift is a *different* thing — one shader, on imagery that encodes nothing.
- **Bloom is layer-selective by construction.** Objects off `BLOOM_LAYER` are
  culled from that pass entirely and so cannot occlude — which is why the globe's
  outline and float markers are deliberately not on it.
- **Globe textures must be power-of-two.** NPOT mipmap generation corrupted the
  GL context badly enough that unrelated materials stopped validating.
- **Argo QC filtering is a correctness requirement, not polish.** Only flags 1
  and 2 are accepted. Float `2900757` looks like a dramatic cold wake and is a
  broken instrument; a test fails if it ever produces a profile again.

---

## 8. Data and attribution

- All data comes from INCOIS ERDDAP and NOAA CoastWatch through the `DataSource`
  interface in `backend/app/ingestion/base.py`. New sources implement that
  interface — don't special-case them elsewhere.
- Nothing is synthesized. If a variable you need doesn't exist upstream, say so
  rather than generating plausible numbers.
- The globe basemap is NASA Blue Marble, credited in the UI. It is a *basemap*,
  not data: no measurement is ever painted onto the sphere (`context.md` §5.1,
  Principle 7).
