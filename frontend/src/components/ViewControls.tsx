import React from "react";
import { Plus, Minus, RotateCcw } from "lucide-react";
import type { AppView } from "./CommandPill";
import "../styles/view-controls.css";

interface ViewControlsProps {
  view: AppView;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}

export const ViewControls: React.FC<ViewControlsProps> = ({
  view,
  onZoomIn,
  onZoomOut,
  onReset,
}) => {
  const resetLabel =
    view === "globe"
      ? "Reset globe view"
      : view === "column"
        ? "Reset 3D camera"
        : "Reset world map";

  return (
    <div
      className={`view-controls view-controls--${view}`}
      role="toolbar"
      aria-label="Viewport navigation controls"
    >
      <button
        type="button"
        className="view-controls__btn"
        onClick={onZoomIn}
        title="Zoom in (+)"
        aria-label="Zoom in"
      >
        <Plus size={15} strokeWidth={2} />
      </button>

      <div className="view-controls__divider" aria-hidden="true" />

      <button
        type="button"
        className="view-controls__btn"
        onClick={onZoomOut}
        title="Zoom out (-)"
        aria-label="Zoom out"
      >
        <Minus size={15} strokeWidth={2} />
      </button>

      <div className="view-controls__divider" aria-hidden="true" />

      <button
        type="button"
        className="view-controls__btn view-controls__btn--reset"
        onClick={onReset}
        title={resetLabel}
        aria-label={resetLabel}
      >
        <RotateCcw size={13} strokeWidth={2} />
      </button>
    </div>
  );
};
