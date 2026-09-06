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
import { Sparkles, X } from "lucide-react";

import type { AppSnapshot, AssistantAction, Citation } from "./actions";
import { useAssistant, type ScreenStatePayload } from "./useAssistant";
import "../styles/assistant.css";

const EXAMPLES = [
  "Add the chlorophyll layer and hide temperature",
  "What is the sea surface temperature at 15°N 88°E?",
  "Which floats are reporting right now?",
  "Take me to the Bay of Bengal",
];

interface Props {
  open: boolean;
  onClose: () => void;
  onActions: (actions: AssistantAction[]) => AppSnapshot | undefined;
  onUndo: (snapshot: AppSnapshot) => void;
  getState: () => ScreenStatePayload;
}

function CitationLine({ citations }: { citations: Citation[] }) {
  const first = citations[0];
  if (!first) return null;
  const summary = [first.label ?? first.dataset, first.provider, first.time]
    .filter(Boolean)
    .join(" · ");
  return (
    <details className="assistant-cite">
      <summary className="assistant-cite__summary">
        {citations.length === 1 ? summary : `${summary} + ${citations.length - 1} more`}
      </summary>
      <ul className="assistant-cite__list">
        {citations.map((c, i) => (
          <li key={i} className="assistant-cite__row">
            {[
              c.label ?? c.dataset,
              c.provider,
              c.time,
              c.depth_m != null ? `${c.depth_m} m` : null,
              c.units,
            ]
              .filter(Boolean)
              .join(" · ")}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function AssistantPanel({ open, onClose, onActions, onUndo, getState }: Props) {
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { messages, send, streaming, statusText, available, unavailableReason } = useAssistant({
    onActions,
    getState,
  });

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [messages, statusText]);

  if (!open) return null;

  const submit = (text: string) => {
    setDraft("");
    void send(text);
  };

  return (
    <aside
      className="assistant-panel"
      role="complementary"
      aria-label="Ocean assistant"
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <header className="assistant-panel__head">
        <span className="assistant-panel__title">
          <Sparkles style={{ width: 15, height: 15, color: "#22d3ee" }} aria-hidden />
          Ocean assistant
        </span>
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
                  Every measurement I give you is fetched from the data on screen and cited.
                  I will say so when something is general knowledge instead.
                </p>
                <ul className="assistant-panel__examples">
                  {EXAMPLES.map((ex) => (
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

                {m.role === "assistant" && !m.failed ? (
                  m.citations && m.citations.length > 0 ? (
                    <CitationLine citations={m.citations} />
                  ) : (
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

            {statusText ? (
              <p className="assistant-panel__status" role="status">
                {statusText}
              </p>
            ) : null}
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
              className="assistant-panel__send"
              disabled={streaming || draft.trim().length === 0}
            >
              {streaming ? "Working…" : "Send"}
            </button>
          </form>
        </>
      )}
    </aside>
  );
}
