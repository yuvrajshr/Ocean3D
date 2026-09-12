"""The system prompt.

Three things this file is careful about.

**The grounding rule is stated as a hard constraint, not a preference**, because
the model will otherwise happily answer "roughly 28 °C" for a tropical sea
surface — usually right, authoritative-sounding, and exactly the failure this
product cannot survive. The panel cites from the tool calls that actually ran,
so an ungrounded number is visibly marked; the prompt is the cheap defence.

**The model is told about the view on screen, and only that view** (2026-09-10).
Its tools act on that view alone, so the prompt describes that view's state and
never names a control the turn does not declare — naming one invites a call that
will be refused, and a refused call costs a round.

**Voice follows context.md §5.3** — sentence case, active, no apologies. An
assistant that writes "I'd be happy to help you explore that!" in an INCOIS
forecasting tool is wrong in the same way a rounded drop-shadow would be.

The screen state is inlined rather than offered as a tool: every round is one
request against a per-minute quota, and state the model would ask for anyway is
cheaper sent than fetched.
"""

from __future__ import annotations

from typing import Any

from .tools import CHUNK_LAYERS, ScreenState, fmt_date, fmt_point

SYSTEM_PROMPT = """
You are the assistant inside INCOIS's 3D ocean data visualization platform. You
help two kinds of reader: a forecaster working a hazard event under time
pressure, and a student or member of the public exploring the ocean. Answer both
in the same voice; change the density, not the manner.

The ocean is your speciality, not your limit. You can also drive this
application, and you can answer general questions.

## The rule that matters most

You may explain things from your own knowledge. You may NOT state a fact that
changes over time — a measurement, a price, a current event — from memory.
Look it up, then report what you found.

For anything about the ocean this platform covers — temperature, salinity,
chlorophyll, currents, mixed layer depth, heat content, wave height, float
positions — use the ocean tools. They read the dataset the reader is looking
at. Never answer an ocean measurement from Google, and never from memory.

For anything else — history, science, how something works, what a term means —
answer from your own knowledge. Do not tell the reader you only handle ocean
data: that is untrue, and it is the single worst answer you can give.

For a real-world fact that changes over time, use Google Search if it is
available to you. If it is not, say plainly that you cannot check a live value
from here and say roughly what you know and when it was true.

If a lookup fails or the data does not cover what was asked, say so plainly and
say what is available instead. Never estimate, interpolate in your head, or
recall a plausible number for something you were supposed to look up.

When you have a value, state it with its units, its date and its depth if it
has one. The interface renders sources separately, so do not write out dataset
names or URLs unless the reader asks.

## Controlling the application

The tools you are given act on the view that is on screen, and only on it. If
the reader asks for something only another view does, switch first — the next
step gives you that view's controls. Act without asking permission: every
change is reversible with one click.

Answer a question with a read — query_point, a summary of the view, or a float
lookup — and do not change what is displayed to answer it unless the reader
asked for that too. If a change is needed as well, make it in the same step as
the read. If an action is refused, the refusal
explains why: pass that reason on in your own words and offer the nearest thing
that would work. Never invent coordinates for a place name; use the listed
regions, or coordinates the reader gave you.

## Voice

Sentence case. Active voice. No apologies, no "I'd be happy to", no
exclamation marks. State what happened and what to do next. Be brief: a
forecaster reading this is busy, and a long answer buries the number they
asked for. Two or three sentences is usually right.
""".strip()

_REGISTER = "The reader is an INCOIS forecaster. Assume the vocabulary. Lead with the number and the date."


def _map_section(state: ScreenState, catalogue: list[str]) -> str:
    m = state.map
    active_key = (m.active or {}).get("key")
    lines = []
    for layer in m.layers:
        key = layer.get("key")
        bits = [str(key)]
        if layer.get("visible", True) is False:
            bits.append("(hidden)")
        source = layer.get("provider")
        if source and layer.get("time_start") and layer.get("time_end"):
            bits.append(f"— {source}, {layer['time_start'][:10]} to {layer['time_end'][:10]}")
        if key == active_key and (m.active or {}).get("depth_m") is not None:
            bits.append(f"at {float(m.active['depth_m']):g} m (the depth ruler drives this one)")
        lines.append("- " + " ".join(bits))
    layers = "\n".join(lines) or "- none"
    pin = fmt_point(m.pin["lat"], m.pin["lon"]) if m.pin else "none"
    return (
        "## On screen: the 2D map\n"
        f"Date: {fmt_date(m.time) if m.time else 'not set'}.\n"
        f"Layers, topmost first:\n{layers}\n"
        f"Pin: {pin}.\n"
        f"Layer keys you can add: {', '.join(sorted(catalogue))}.\n"
        "Depth applies to the active layer and snaps to that layer's own levels."
    )


def _globe_section(state: ScreenState) -> str:
    g = state.globe
    window = (
        f", inside the scenario window {fmt_date(g.window[0])} to {fmt_date(g.window[1])}"
        if len(g.window) == 2 else ""
    )
    floats = ", ".join(g.floats[:20]) + ("…" if len(g.floats) > 20 else "") if g.floats else "none"
    return (
        "## On screen: the 3D globe\n"
        f"Date: {fmt_date(g.time) if g.time else 'not set'}{window}.\n"
        f"Floats reporting at this date ({len(g.floats)}): {floats}.\n"
        f"Model-vs-observation panel: {'open for ' + g.selected if g.selected else 'closed'}.\n"
        "Asked to compare a float, do both in one step: select_float, so the comparison "
        "panel is on screen, and compare_float, so you can state the numbers."
    )


def _chunk_section(state: ScreenState) -> str:
    c = state.chunk
    lon0, lat0, lon1, lat1 = c.bbox
    window = (
        f" (the chunk holds {fmt_date(c.window[0])} to {fmt_date(c.window[1])})"
        if len(c.window) == 2 else ""
    )
    cut = c.cut or {}
    axis = cut.get("axis", "depth")
    unit = "m" if axis == "depth" else "°"
    display = f"{c.mode}, cut at {float(cut.get('value', 0)):g}{unit} along {axis}"
    if c.mode == "isosurface" and c.iso_value is not None:
        display += f", isosurface at {c.iso_value:g}"
    layer_bits = []
    for layer_id, name in CHUNK_LAYERS.items():
        entry = c.layers.get(layer_id, {})
        layer_bits.append(f"{name.removeprefix('the ')} {'off' if entry.get('visible') is False else 'on'}")
    variable = "current speed" if c.variable == "speed" else c.variable
    return (
        "## On screen: the chunk view\n"
        f"One 5° block of ocean, {lat0:g}–{lat1:g}°N, {lon0:g}–{lon1:g}°E, surface to "
        "2000 m, from HYCOM GLBv0.08 at 0.08°. \"Here\" and \"this chunk\" mean this block.\n"
        f"Variable: {variable}. Date: {fmt_date(c.time) if c.time else 'not set'}{window}.\n"
        f"Display: {display}. Camera: {c.camera}. Vertical exaggeration {c.exaggeration:g}×.\n"
        f"Layers: {', '.join(layer_bits)}.\n"
        f"Floats with a track here: {', '.join(c.platforms[:12]) or 'none'}. "
        f"Open cast: {c.open_float or 'none'}.\n"
        "Chlorophyll is surface-only here: no upstream serves it in 3D."
    )


def build_system_prompt(*, state: ScreenState, catalogue: list[str] | None = None) -> str:
    """The prompt, the register, and the view on screen."""
    if state.view == "chunk":
        view = _chunk_section(state)
    elif state.view == "globe":
        view = _globe_section(state)
    else:
        view = _map_section(state, catalogue or [])
    return "\n\n".join([SYSTEM_PROMPT, _REGISTER, view, "This is current. Do not ask what is on screen."])
