/**
 * The assistant panel.
 *
 * Two things here are not decoration and should not be simplified away.
 *
 * The **provenance line** under each answer is rendered from `citations`, which
 * the backend builds from the tool calls that actually ran — not from anything
 * the model wrote. That is what makes context.md §5.1's grounding rule
 * checkable: an answer that fetched nothing has no citations, and gets the
 * "general knowledge" marker instead of quietly reading as data.
 *
 * The **Undo** control restores the snapshot taken immediately before the
 * actions were applied. It exists because the assistant changes a forecaster's
 * workspace without asking first, which is only reasonable if putting it back
 * is one click.
 */

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, Sparkles, X } from "lucide-react";

import type { AppSnapshot, AssistantAction, Citation } from "./actions";
import { useAssistant, type ScreenStatePayload } from "./useAssistant";
import type { AssistantScopeLabel } from "./useAssistantBridge";
import "../styles/assistant.css";

/** What each view can do, said the way a reader would ask for it. */
const EXAMPLES: Record<Props["view"], string[]> = {
  map: [
    "What is the sea surface temperature at 15°N 88°E?",
    "Add the chlorophyll layer and hide temperature",
    "Show 100 m",
    "Take me to the Bay of Bengal",
  ],
  globe: [
    "Compare float 2901335 against the model",
    "Which floats are reporting?",
    "Go to 11 October 2013",
    "Open the chunk over the Bay of Bengal",
  ],
  chunk: [
    "Show salinity",
    "Switch to the isosurface",
    "What is the temperature at 100 m here?",
    "Where is the thermocline in this chunk?",
  ],
};

interface Props {
  open: boolean;
  onClose: () => void;
  onActions: (actions: AssistantAction[]) => AppSnapshot | undefined;
  onUndo: (snapshot: AppSnapshot) => void;
  getState: () => ScreenStatePayload;
  /** The view on screen: what the assistant's actions apply to. */
  view: "map" | "globe" | "chunk";
  /** Its name and the extent or date it shows, for the header's scope line. */
  scope: AssistantScopeLabel;
}

const describe = (c: Citation) =>
  c.kind === "web"
    ? c.title ?? c.url ?? "web source"
    : [c.label ?? c.dataset, c.provider, c.time, c.depth_m != null ? `${c.depth_m} m` : null, c.units]
        .filter(Boolean)
        .join(" · ");

function CitationLine({ citations }: { citations: Citation[] }) {
  const first = citations[0];
  if (!first) return null;
  // A mixed answer names the measured source first: this is a data tool, and
  // "Copernicus + 2 web sources" tells the reader more than the reverse would.
  const dataCount = citations.filter((c) => c.kind !== "web").length;
  const summary = describe(first);
  return (
    <details className="assistant-cite">
      <summary className="assistant-cite__summary">
        {citations.length === 1 ? summary : `${summary} + ${citations.length - 1} more`}
        {dataCount === 0 ? " · web" : null}
      </summary>
      <ul className="assistant-cite__list">
        {citations.map((c, i) => (
          <li
            key={i}
            className={`assistant-cite__row${c.kind === "web" ? " assistant-cite__row--web" : ""}`}
          >
            {c.kind === "web" && c.url ? (
              <a
                className="assistant-cite__link"
                href={c.url}
                target="_blank"
                rel="noreferrer noopener"
              >
                {describe(c)}
              </a>
            ) : (
              describe(c)
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function AssistantPanel({ open, onClose, onActions, onUndo, getState, view, scope }: Props) {
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { messages, send, streaming, statusText, available, unavailableReason } = useAssistant({
    onActions,
    getState,
  });

  useEffect(() => {
    if (open) {
      const timer = setTimeout(() => {
        inputRef.current?.focus();
      }, 60);
      return () => clearTimeout(timer);
    }
  }, [open]);

  useEffect(() => {
    if (open) {
      logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
    }
  }, [open, messages, statusText, streaming]);

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;
    setDraft("");
    void send(trimmed);
  };

  return (
    <aside
      id="assistant-panel"
      className={`assistant-panel ${open ? "assistant-panel--open" : "assistant-panel--closed"}`}
      role="complementary"
      aria-label="Ocean assistant"
      aria-hidden={!open}
      tabIndex={open ? 0 : -1}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <header className="assistant-panel__head">
        <div className="assistant-panel__heading">
          <span className="assistant-panel__title">
            <Sparkles
              style={{ width: 15, height: 15, color: "var(--rt-copper, #e59858)" }}
              aria-hidden
            />
            Ocean assistant
          </span>
          {/* Which view the assistant's changes land on. A label, then a
              readout — two jobs, two elements, no separator glyph (§5.2). */}
          <span className="assistant-panel__scope">
            <span className="assistant-panel__scope-view">{scope.view}</span>
            {scope.detail ? (
              <span className="assistant-panel__scope-detail">{scope.detail}</span>
            ) : null}
          </span>
        </div>
        <button
          type="button"
          className="assistant-panel__close"
          onClick={onClose}
          aria-label="Close the assistant"
        >
          <X style={{ width: 15, height: 15 }} aria-hidden />
        </button>
      </header>

      {available === false ? (
        <p className="assistant-panel__unavailable">
          {unavailableReason ?? "The assistant is unavailable."} Everything else in the app
          works without it.
        </p>
      ) : (
        <>
          <div className="assistant-panel__log" ref={logRef}>
            {messages.length === 0 ? (
              <div className="assistant-panel__empty">
                <strong>Ask about the water, or tell me what to show.</strong>
                <p style={{ margin: "6px 0 0" }}>
                  Every measurement I give you is read from the data this view draws, and
                  cited. Changes apply to the view you are on. I will say so when something
                  is general knowledge instead.
                </p>
                <ul className="assistant-panel__examples">
                  {EXAMPLES[view].map((ex) => (
                    <li key={ex}>
                      <button
                        type="button"
                        className="assistant-panel__example"
                        onClick={() => submit(ex)}
                      >
                        {ex}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            {messages.map((m) => (
              <div
                key={m.id}
                className={`assistant-msg assistant-msg--${m.role}${
                  m.failed ? " assistant-msg--failed" : ""
                }`}
              >
                <div className="assistant-msg__body">{m.text}</div>

                {/* The marker belongs on an unsourced *claim*, not on a report
                    of an action. "Added chlorophyll and hid temperature" states
                    nothing about the ocean, so labelling it general knowledge
                    would be noise — and worse, it would train the reader to
                    ignore the marker in the one place it matters. */}
                {m.role === "assistant" && !m.failed ? (
                  m.citations && m.citations.length > 0 ? (
                    <CitationLine citations={m.citations} />
                  ) : m.snapshot ? null : (
                    <span className="assistant-msg__ungrounded">
                      General knowledge — not from your data
                    </span>
                  )
                ) : null}

                {m.snapshot ? (
                  <button
                    type="button"
                    className="assistant-msg__undo"
                    onClick={() => onUndo(m.snapshot!)}
                  >
                    Undo this change
                  </button>
                ) : null}
              </div>
            ))}

            {/* Names what is actually happening (§5.3): the backend's own status line
                when it has sent one, otherwise just that the request is out. */}
            {streaming && (
              <div className="assistant-thinking" role="status" aria-live="polite">
                <div className="assistant-thinking__header">
                  <span className="assistant-thinking__pulse-dot" />
                  <span className="assistant-thinking__status">
                    {statusText || "Working…"}
                  </span>
                </div>
                <div className="assistant-thinking__wave-bar">
                  <span className="assistant-thinking__wave-track" />
                </div>
              </div>
            )}
          </div>

          <form
            className="assistant-panel__form"
            onSubmit={(e) => {
              e.preventDefault();
              submit(draft);
            }}
          >
            <textarea
              ref={inputRef}
              className="assistant-panel__input"
              value={draft}
              rows={1}
              placeholder="Ask about the water, or say what to show…"
              disabled={streaming}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; Shift+Enter is a newline. A forecaster types one
                // line and expects it to go.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit(draft);
                }
              }}
              aria-label="Message the ocean assistant"
            />
            <button
              type="submit"
              className={`assistant-panel__send ${streaming ? "assistant-panel__send--streaming" : ""}`}
              disabled={streaming || draft.trim().length === 0}
              title={streaming ? "Working…" : "Send message"}
              aria-label={streaming ? "Working" : "Send message"}
            >
              {streaming ? (
                <Loader2 className="assistant-panel__send-spinner" size={16} strokeWidth={2.4} />
              ) : (
                <ArrowUp className="assistant-panel__send-icon" size={16} strokeWidth={2.4} />
              )}
            </button>
          </form>
        </>
      )}
    </aside>
  );
}
