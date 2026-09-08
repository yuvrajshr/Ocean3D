/**
 * AssistantDock — the assistant's entry point on the right edge.
 *
 * `designTest` moved the old ToolDock's jobs into `CommandPill` (points, the
 * view control) and stopped rendering ToolDock at all. The assistant's button
 * lived inside that file, so the merge would have compiled with no way to open
 * the panel — the feature present in the bundle and absent from the screen.
 *
 * Rather than restore the whole dock for one control, this is the slim version:
 * one button, in the lane §5.1 Principle 11 reserves for right-hand tools, clear
 * of the depth ruler's vertically-centred 240px track. Theme C, 0px radius, with
 * the 3px copper stripe designTest uses everywhere to mean "active".
 */

import { Sparkles } from "lucide-react";
import "../styles/assistant.css";

export interface AssistantDockProps {
  open: boolean;
  onToggle: () => void;
}

export function AssistantDock({ open, onToggle }: AssistantDockProps) {
  return (
    <div className="assistant-dock">
      <button
        type="button"
        id="btn-tool-assistant"
        className={`assistant-dock__btn${open ? " assistant-dock__btn--active" : ""}`}
        onClick={onToggle}
        aria-pressed={open}
        aria-controls="assistant-panel"
        title="Ask the ocean assistant"
      >
        <Sparkles aria-hidden="true" style={{ width: 18, height: 18 }} />
        <span className="assistant-dock__label">Ask</span>
      </button>
    </div>
  );
}
