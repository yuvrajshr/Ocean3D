/**
 * BuildStatus — which build is on screen, and a warning when it is out of date.
 *
 * context.md §5.1 Principle 14. Two elements with one job each:
 *
 *   - the stamp: a faint readout in the viewport's bottom-right corner, the
 *     mirror of the map's bottom-left pan/zoom readout. It names the commit the
 *     page was built from, and splits into "ui" and "api" only when those differ
 *     — at that point the split is the diagnosis.
 *
 *   - the alert: a status line that appears only when the running code is older
 *     than the code on disk. It gives both commits and the action. There is no
 *     "Refresh" button, because reloading cannot fix a stale server; the fix is
 *     restarting a process, so the line says exactly that. It does not hide on a
 *     timer, because staleness does not resolve itself.
 */

import { useState } from "react";

import { sameCommit, short } from "./classify";
import { useBuildStatus } from "./useBuildStatus";
import "../styles/build-status.css";

const DISMISS_KEY = "ocean3d:build-alert-dismissed";

function readDismissed(): string | null {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(value: string): void {
  try {
    window.sessionStorage.setItem(DISMISS_KEY, value);
  } catch {
    /* storage blocked: the dismissal lasts until the next re-render instead */
  }
}

/** "pull: Fast-forward" → "pull". Only verbs a reader would recognise. */
function gitVerb(reason: string | undefined): string | null {
  const verb = /^([a-z-]+)/.exec(reason ?? "")?.[1];
  return verb && ["pull", "merge", "checkout", "rebase", "reset", "cherry-pick", "revert"].includes(verb)
    ? verb
    : null;
}

function Sha({ value }: { value: string }) {
  return <span className="build-sha">{short(value)}</span>;
}

export function BuildStatus() {
  const { ui, api, disk } = useBuildStatus();
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);

  if (!ui.sha) return null;

  const uiStale = disk?.ui.status === "stale";
  const apiStale = disk?.api.status === "stale";
  const head = disk?.head ?? null;
  const apiSplit = Boolean(api?.sha && !sameCommit(api.sha, ui.sha));

  // One dismissal per exact situation: a newer pull brings the line back.
  const situation = `${ui.sha}>${head}|${api?.sha ?? "-"}>${head}`;
  const showAlert = (uiStale || apiStale) && head !== null && dismissed !== situation;

  const verb = gitVerb(disk?.ui.reason);
  const title = [
    `Page built from ${ui.sha}${ui.branch ? ` on ${ui.branch}` : ""}`,
    api?.sha ? `API started from ${api.sha}${api.branch ? ` on ${api.branch}` : ""}` : "API build unknown",
    head ? `Disk is at ${head}${disk?.branch ? ` on ${disk.branch}` : ""}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <>
      {showAlert && head ? (
        <div className="build-alert" role="status">
          <p className="build-alert__text">
            {uiStale && disk?.mode === "preview" ? (
              <>
                This bundle was built from <Sha value={ui.sha} />, but the frontend on disk is now{" "}
                <Sha value={head} />. Rebuild with <kbd>npm run build</kbd>, then reload.
              </>
            ) : uiStale ? (
              <>
                This page is running <Sha value={ui.sha} />, but the code on disk is{" "}
                <Sha value={head} />
                {verb ? ` after a git ${verb}` : ""}. Stop the dev server, run{" "}
                <kbd>npm run dev</kbd> from the repo root, then reload
                {apiStale ? " — that restarts the API too" : ""}.
              </>
            ) : (
              <>
                The API is running <Sha value={api?.sha ?? ""} />, but the backend on disk is{" "}
                <Sha value={head} />. Restart it — <kbd>npm run dev</kbd> from the repo root starts
                both halves.
              </>
            )}
          </p>
          <button
            type="button"
            className="build-alert__dismiss"
            onClick={() => {
              writeDismissed(situation);
              setDismissed(situation);
            }}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      <p className="build-stamp" title={title}>
        {apiSplit && api?.sha ? (
          <>
            <span className="build-stamp__part">
              ui <Sha value={ui.sha} />
              {uiStale ? <span className="build-stamp__stale"> stale</span> : null}
            </span>
            <span className="build-stamp__part">
              api <Sha value={api.sha} />
              {apiStale ? <span className="build-stamp__stale"> stale</span> : null}
            </span>
          </>
        ) : (
          <span className="build-stamp__part">
            build <Sha value={ui.sha} />
            {uiStale || apiStale ? <span className="build-stamp__stale"> stale</span> : null}
          </span>
        )}
      </p>
    </>
  );
}
