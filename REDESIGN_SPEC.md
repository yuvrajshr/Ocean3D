# Ocean 3D — Comprehensive Design System & Redesign Specification
> Synthesized from **Linear (`linear.app`)** and **SpaceX (`spacex.com`)** design languages, engineered specifically for the INCOIS Ocean 3D scientific visualization console.

---

## 1. Design Philosophy: "The Aerospace Ocean Observatory"

The redesign merges two distinct high-performance design paradigms:
1. **Linear's Software Craftsmanship**:
   - Deep layered charcoal/obsidian surfaces (`#010102`, `#080d16`, `#0e1626`).
   - Hairline borders (`1px solid #1c2638`) that define structural housing without heavy drop-shadows.
   - Restrained, purposeful illumination: interactive elements illuminate with subtle glows rather than flat neon fills.
   - Dense, technical information hierarchy with measured letter-spacing.
2. **SpaceX's Mission-Control Telemetry**:
   - Pure black and deep abyss backdrops that let the 3D data and satellite imagery be the hero.
   - Telemetry-grade monospace typography (IBM Plex Mono) for depth, coordinates, timestamps, and physical units.
   - Minimalist ghost controls, high-contrast status beacons, and sharp, industrial instrument housings.

---

## 2. Global Unified Color Palette

### 2.1 Surfaces & Canvas (Tiered Obsidian Depth)
| Role | Color Value | Usage |
| :--- | :--- | :--- |
| **Canvas Abyss** | `#020408` | Primary background behind full-bleed 3D scene & map |
| **Surface 1 (Base Panels)** | `#080d16` | Top navbar, timeline base, docked panels |
| **Surface 2 (Floating Cards)** | `#0c1422` | Layers panel, Tool dock, Depth ruler housing, point readout HUD |
| **Surface 3 (Active / Inset)** | `#121b2d` | Active segmented tabs, drop zones, textareas, slider tracks |
| **Surface 4 (Hover / Highlight)**| `#18243b` | Hovered list items, active button hover states |

### 2.2 Borders & Hairlines
| Role | Color Value | Usage |
| :--- | :--- | :--- |
| **Hairline Subtle** | `#162032` | Secondary dividers, card inner separators |
| **Hairline Standard** | `#1e2b42` | Primary panel borders, segmented rail borders |
| **Hairline Strong** | `#2d3f5e` | Hovered borders, active inputs, slider thumbs |
| **Hairline Accent** | `rgba(56, 189, 248, 0.4)` | Focus rings, active selection outlines |

### 2.3 Typography & Text Roles
| Role | Color Value | Font Family & Weight |
| :--- | :--- | :--- |
| **Ink Primary** | `#f8fafc` | Inter / IBM Plex Sans (600 / 500) |
| **Ink Secondary** | `#cbd5e1` | IBM Plex Sans (400) |
| **Ink Muted** | `#8292a8` | IBM Plex Sans (400) |
| **Ink Faint** | `#475569` | IBM Plex Sans / Mono (400) |
| **Telemetry Monospace** | `#94a3b8` / `#38bdf8` | IBM Plex Mono (500) for coordinates, depth, time |

### 2.4 Chromatic Signals & Accents
| Role | Color Value | Purpose |
| :--- | :--- | :--- |
| **Electric Cyan (Primary Accent)** | `#38bdf8` | Active view pill, primary interactive indicators, selected tabs |
| **Linear Blue (Secondary Accent)** | `#5e6ad2` | Deep contrast buttons, focus rings, metadata highlights |
| **Telemetry Emerald (Live Data)** | `#10b981` | Real-time sensor indicator, live ERDDAP connection |
| **Mission Amber (Advisory/Cached)**| `#f59e0b` | Cached status, test mode tags, QC warnings |
| **Anomaly Red (QC Rejected)** | `#ef4444` | Quality control flags, bathymetric collision warnings |

---

## 3. End-to-End Component Redesign Flow

### Component 1: Top Navigation Bar (`CommandPill.tsx` / `command-pill.css`)
- **Current State**: Transitioned to a fixed rectangular navbar with custom view-mode buttons.
- **Target Aesthetic**: SpaceX mission-control command bar with Linear crispness:
  - Background `#080d16` with a crisp bottom hairline `#1c2638`.
  - INCOIS Seal badge: 22px circular badge in `#0e182a` with glowing rim.
  - App & Scenario Title: White `#f8fafc` title with muted `#8292a8` scenario subtitle.
  - Status Beacon: Pulsing status dot with telemetry tooltip.
  - View-Mode Segmented Group (Map / Globe / Water column):
    - Dark inset rail (`#0c1422`, border `#1e2b42`).
    - Active button in electric cyan `#38bdf8` with deep obsidian text `#040810`.
    - Inactive buttons in `#8292a8` with clean hover highlight `#18243b`.
  - Ops / Explore Mode Toggle: Sleek pill toggle with tactile active feedback.

### Component 2: Variable & Layers Panel (`VariablePanel.tsx` / `layers-panel.css`)
- **Current State**: Royal blue `#1f3a8a` header, mixed blue styles, standard dropdowns.
- **Target Aesthetic**: Complete Linear-inspired software panel:
  - **Panel Header**: Replace the royal blue `#1f3a8a` header with sleek obsidian `#0c1422` and a hairline border `#1e2b42`.
  - **"Add layer..." Button**: Ghost pill with glowing cyan plus icon, dark hover state (`#142036`).
  - **Active Layer Stack**:
    - Each layer is an engineered card (`#0c1422` with border `#1a2538`).
    - Colormap gradient preview: crisp scientific cmocean bar with hairline border.
    - Opacity Slider: Linear-style custom slider track (`#162238`) with electric cyan thumb `#38bdf8` and numeric readout.
    - Layer Visibility & Action Buttons: Eye/EyeOff and trash icons styled as subtle ghost buttons with hover illumination.
  - **Data Catalogue Modal (`DataCatalogueModal.tsx`)**:
    - Dark aerospace telemetry modal with `#080d16` backdrop, category pill filters, and variable cards.

### Component 3: Vertical Depth Slider (`DepthRuler.tsx` / `depth-ruler.css`)
- **Current State**: Cyan accented vertical slider with floating callout.
- **Target Aesthetic**: SpaceX telemetry gauge:
  - Vertical rail housed in `#0a101d` with razor-sharp hairline `#1e2b42`.
  - Graduated depth tick marks: 5m, 10m, 50m, 100m, 500m, 1000m, 2000m with monospace numerals.
  - Active Depth Thumb: Precision illuminated cyan cursor `#38bdf8` with micro-glow.
  - Depth Readout Tooltip: Telemetry pill displaying active level (`120 m · Level 14/24`) in IBM Plex Mono.

### Component 4: Timeline Scrubber (`Timeline.tsx` / `MapTimeline.tsx` / `timeline.css`)
- **Current State**: Bottom glass scrubber with play controls.
- **Target Aesthetic**: Aerospace mission timeline:
  - Base container: `#080d16` with top hairline `#1c2638` and backdrop blur.
  - Play / Pause & Step Buttons: Linear-style ghost control group with subtle hover glow.
  - Scrubber Track: Dual-state telemetry bar with buffered timesteps in `#18243b` and elapsed time in `#38bdf8`.
  - Timestamp Readout: Monospace HUD badge (`08 OCT 2013 · 18:00 UTC · Step 12/28`).

### Component 5: Floating Points & Tool Dock (`PointReadout.tsx` / `ToolDock.tsx` / `tool-dock.css`)
- **Current State**: Right dock with 3D/2D toggle and point annotations.
- **Target Aesthetic**:
  - Right Dock: Precision floating vertical bar (`#0c1422`, border `#1e2b42`) with ghost micro-buttons.
  - Point Readout Card: Floating HUD card with coordinates, temperature/salinity profiles, and CTD depth charts styled in deep obsidian `#0c1422`.
  - Map / Canvas Float Markers: Pulsing sonar pips with telemetry label pips.

---

## 4. Execution Roadmap (For Next Prompt)

1. **Step 1: Global Tokens & Base CSS (`tokens.css`)**:
   - Update core CSS variables with the unified Obsidian/Linear/SpaceX palette.
2. **Step 2: Top Navbar Refinements (`command-pill.css`)**:
   - Apply the unified dark obsidian and subtle hairline styling.
3. **Step 3: Variable & Layers Panel (`layers-panel.css` & `VariablePanel.tsx`)**:
   - Overhaul the header, layer cards, opacity sliders, and action buttons.
4. **Step 4: Depth Ruler Gauge (`depth-ruler.css`)**:
   - Restyle the vertical depth slider into a telemetry gauge.
5. **Step 5: Timeline Scrubber (`timeline.css`)**:
   - Restyle playback controls, timeline track, and date readouts.
6. **Step 6: Tool Dock & Point Readouts (`tool-dock.css` & `PointReadout.tsx`)**:
   - Polish right dock, point inspection cards, and float markers.
