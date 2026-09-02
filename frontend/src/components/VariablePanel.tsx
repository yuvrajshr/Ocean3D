/**
 * Variable selector. In Explore mode the hazard group is hidden and a one-line
 * caption is shown for the current variable — same visual system, less control
 * density (context.md §5.1, Principle 4).
 */

import type { VariableInfo } from "../api/client";

interface VariablePanelProps {
  variables: VariableInfo[];
  selected: string;
  mode: "ops" | "explore";
  onSelect: (key: string) => void;
}

export function VariablePanel({ variables, selected, mode, onSelect }: VariablePanelProps) {
  const primary = variables.filter((v) => v.group === "primary");
  const hazard = variables.filter((v) => v.group === "hazard");
  const current = variables.find((v) => v.key === selected);

  const renderOption = (variable: VariableInfo) => (
    <li key={variable.key}>
      <button
        type="button"
        className="variable-option"
        aria-pressed={variable.key === selected}
        disabled={!variable.available}
        onClick={() => onSelect(variable.key)}
        title={variable.unavailable_reason ?? variable.caption}
      >
        <span className="variable-option__swatch" aria-hidden="true" />
        <span>{variable.label}</span>
        <span className="variable-option__units readout">{variable.units}</span>
      </button>
    </li>
  );

  return (
    <>
      <div className="panel__section">
        <h2 className="panel__heading">Variable</h2>
        <ul className="variable-list">{primary.map(renderOption)}</ul>
        {mode === "explore" && current ? (
          <p className="variable-caption">{current.caption}</p>
        ) : null}
      </div>

      {mode === "ops" && hazard.length > 0 ? (
        <div className="panel__section">
          <h2 className="panel__heading">Cyclone fields</h2>
          <ul className="variable-list">{hazard.map(renderOption)}</ul>
        </div>
      ) : null}
    </>
  );
}
