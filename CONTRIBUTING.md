# Contributing to Ocean3D (INCOIS Ocean Data Visualization)

**SIH 2026 · Problem Statement 26067 · Ministry of Earth Sciences (MoES) / INCOIS**

Thank you for contributing to the INCOIS 3D Ocean Data Visualization Platform. This document defines our team's engineering standards, git workflow, and mandatory documentation requirements before committing and pushing code.

---

## 1. Core Documentation Requirements (Mandatory Before Pushing)

Our project uses persistent context documents to keep team members and AI coding assistants fully aligned. **Before pushing any branch or opening a pull request, ensure the following are updated:**

1. **`context.md` Section 10 (Decision Log):**
   - Every architectural choice, interaction pattern, data pipeline change, or design reversal **must** be recorded with the date, rationale, and consequences.
   - If a new UI pattern or layout rule was introduced, add its corresponding principle to **`context.md` Section 5.1 (UI/UX Design Direction)**.

2. **`next_session.md` (Session Handoff):**
   - Summarize the current state of the branch, what features were added or changed, and how to verify them.
   - List any new environment requirements, dataset dependencies, or gotchas/traps encountered.

3. **`CLAUDE.md` (Frontend Rules):**
   - Verify that your changes adhere to `CLAUDE.md`'s hard rules:
     - No colors outside `tokens.css` / `context.md` §5.1.
     - Real INCOIS sample data only (never `placehold.co` or fake numbers).
     - No generic AI-design tells (no flat card grids, no decorative gradients, no unnecessary animations).
     - Viewport is the primary hero; chrome remains restrained and functional.

---

## 2. Git & Branching Workflow

- **`main`:** The stable, deployable demo branch. Direct pushes to `main` are restricted.
- **Feature Branches:** Create descriptive branch names from `main`:
  - Features: `feature/layer-manager`, `feature/depth-slider`, `sidePannel`
  - Fixes: `fix/webgl-fallback`, `fix/timeline-sync`
  - Experiments: `exp/particle-streamlines`

### Pre-Commit / Pre-Push Checklist

Before pushing your branch:
```bash
# 1. Typecheck the frontend
cd frontend
npx tsc --noEmit

# 2. Run backend integration tests
cd ../backend
.venv/Scripts/pytest

# 3. Verify dev servers run cleanly without console errors
# Frontend: http://localhost:5173
# Backend:  http://127.0.0.1:8000
```

### Commit Message Conventions
Write clear, imperative commit messages:
```
feat(layers): implement uppermost active layer stack hierarchy
fix(depth): calibrate vertical depth slider to INCOIS 24-level grid
docs(context): record side-by-side right HUD architecture in decision log
```

---

## 3. Frontend Guidelines

- **Architecture:** React 19 + TypeScript + Three.js built with Vite.
- **Strict TypeScript:** `noUnusedLocals: true` and `noUnusedParameters: true` are enabled in `tsconfig.json`. Ensure all imports and variables are used or cleanly commented.
- **Styling:** Vanilla CSS in modular stylesheets (`src/styles/`). All color values must trace to design tokens in `tokens.css` (`abyss`, `thermocline`, `current`, `bioluminescence`, `advisory`, `foam`).
- **HUD Layout & Z-Index:**
  - `Viewport (3D Canvas)`: Base level
  - `VariablePanel (Left)`: `z-index: 20`
  - `DepthSlider (Right, 84px)`: `z-index: 24`
  - `ToolDock (Right, 16px)`: `z-index: 25`
  - `Flyout Drawers (Points Inspector)`: `z-index: 30`, offset at `right: calc(100% + 78px)` to prevent overlapping the DepthSlider.
  - `ProfilePanel (Graph Comparison)`: Floating modal overlay, `z-index: 50`.

---

## 4. Backend Guidelines

- **Architecture:** FastAPI + xarray + netCDF4 + pandas.
- **Data Ingestion:** All new upstreams (CTD casts, glider tracks, satellite altimetry) must implement the `DataSource` interface in `backend/app/ingestion/base.py`.
- **Normalization:** Endpoints must normalize responses to the Pydantic schemas in `backend/app/models/schemas.py`.
- **Provenance:** Include dataset source status (`live` or `cached` with timestamp) in responses.

---

## 5. Respecting Project Invariants

- **The Water Column is Ground Truth:** The 3D scene, depth slider, and profile comparison chart must agree on physical depths. Never interpolate or alter data values for aesthetics.
- **Attribution:** Any external dataset used (e.g. NOAA CoastWatch ETOPO relief, NASA Blue Marble basemaps, Copernicus Marine) must carry proper credit in the UI as specified in `context.md` §5.5.
