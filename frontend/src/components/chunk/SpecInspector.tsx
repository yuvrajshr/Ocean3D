/**
 * The live scene spec, editable.
 *
 * The view has no scene state outside this object, so showing it is not a debug
 * affordance — it is the honest statement of what is on screen, and editing it
 * is the same operation every control performs. It also makes the registry's
 * contract visible: name a layer type this build has no module for and the
 * message says so instead of the scene failing silently.
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
