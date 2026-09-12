/**
 * The live scene spec, editable. The view has no other scene state, so this is
 * exactly what's on screen, and editing it does what the controls do. Unknown
 * layer types get a message instead of failing silently.
 */

interface Props {
  text: string;
  message: string;
  ok: boolean;
  onEdit: (text: string) => void;
  onApply: () => void;
  onReset: () => void;
}

export function SpecInspector({ text, message, ok, onEdit, onApply, onReset }: Props) {
  return (
    <div className="chunk-spec">
      <div className="chunk-spec__head">
        <div className="chunk-spec__title">Scene spec · live</div>
        <button type="button" className="chunk-spec__action" onClick={onApply}>
          Apply
        </button>
        <button
          type="button"
          className="chunk-spec__action chunk-spec__action--muted"
          onClick={onReset}
        >
          Reset
        </button>
      </div>
      <textarea
        className="chunk-spec__editor"
        spellCheck={false}
        value={text}
        onChange={(e) => onEdit(e.target.value)}
        aria-label="Scene spec JSON"
      />
      <div className={`chunk-spec__status${ok ? "" : " chunk-spec__status--error"}`} role="status">
        {message}
      </div>
    </div>
  );
}
