/**
 * The assistant's client: one POST, an SSE stream back.
 *
 * `EventSource` cannot POST, and the request carries a state snapshot far too
 * large for a query string, so this reads the response body as a stream and
 * parses the SSE framing by hand. That is a small amount of code for a real
 * gain: status lines arrive while the tool phase runs, so the panel can say
 * "Reading the analysis at 15°, 88°…" instead of showing a spinner for eight
 * seconds (§5.3 — name what is loading).
 *
 * Actions arrive only in the final `done` event, never mid-stream, so the
 * viewport changes after the prose has landed rather than during it.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { AppSnapshot, AssistantAction, Citation } from "./actions";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  citations?: Citation[];
  /** Set on an assistant message that changed the app, so it can offer Undo. */
  snapshot?: AppSnapshot;
  failed?: boolean;
}

export interface ScreenStatePayload {
  view: string;
  layers: { key: string; visible: boolean; opacity: number }[];
  time: string;
  depth_index: number;
  depth_m: number;
}

interface Options {
  /** Applied after the answer lands. Returns the snapshot taken before applying. */
  onActions: (actions: AssistantAction[]) => AppSnapshot | undefined;
  getState: () => ScreenStatePayload;
}

let localId = 0;
const nextId = () => `local-${(localId += 1)}`;

export function useAssistant({ onActions, getState }: Options) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [statusText, setStatusText] = useState<string | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(null);
  const conversationRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/assistant/status")
      .then((r) => r.json())
      .then((s) => {
        if (cancelled) return;
        setAvailable(Boolean(s.available));
        setUnavailableReason(s.reason ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setAvailable(false);
        setUnavailableReason("The backend is not responding.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      // Single-flight. Free-tier quota is per project and per day, so a second
      // in-flight request is spend with nothing to show for it.
      if (!trimmed || streaming) return;

      setMessages((m) => [...m, { id: nextId(), role: "user", text: trimmed }]);
      setStreaming(true);
      setStatusText(null);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch("/api/assistant/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            message: trimmed,
            conversation_id: conversationRef.current,
            state: getState(),
          }),
        });

        if (!response.ok || !response.body) {
          const detail = await response.json().catch(() => null);
          throw new Error(detail?.detail ?? "The assistant is not reachable.");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let answer = "";
        let citations: Citation[] = [];
        let actions: AssistantAction[] = [];
        let failure: string | null = null;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line; a partial frame stays in
          // the buffer until the rest of it arrives.
          let split: number;
          while ((split = buffer.indexOf("\n\n")) !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);

            const eventLine = frame.split("\n").find((l) => l.startsWith("event:"));
            const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
            if (!eventLine || !dataLine) continue;
            const event = eventLine.slice(6).trim();
            const data = JSON.parse(dataLine.slice(5).trim());

            if (event === "status") setStatusText(data.text);
            else if (event === "answer") answer = data.text;
            else if (event === "error") failure = data.text;
            else if (event === "done") {
              citations = data.citations ?? [];
              actions = data.actions ?? [];
              conversationRef.current = data.conversation_id ?? conversationRef.current;
            }
          }
        }

        setStatusText(null);

        if (failure) {
          setMessages((m) => [
            ...m,
            { id: nextId(), role: "assistant", text: failure, failed: true },
          ]);
          return;
        }

        const snapshot = actions.length ? onActions(actions) : undefined;
        setMessages((m) => [
          ...m,
          { id: nextId(), role: "assistant", text: answer, citations, snapshot },
        ]);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setStatusText(null);
        setMessages((m) => [
          ...m,
          {
            id: nextId(),
            role: "assistant",
            text: (err as Error).message,
            failed: true,
          },
        ]);
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [getState, onActions, streaming],
  );

  return { messages, send, streaming, statusText, available, unavailableReason };
}
