/**
 * The assistant's button on the right edge. Sits in the right-hand tool lane,
 * clear of the depth ruler. Uses the copper stripe for the active state.
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
