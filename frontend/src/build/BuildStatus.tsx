/**
 * Shows which build is running, and warns when it's out of date.
 *
 * - The stamp: a faint readout in the bottom-right with the commit the page was
 *   built from. It splits into "ui" and "api" only when they differ.
 * - The alert: shown only when the running code is older than the code on disk.
 *   It shows both commits and what to do. No "Refresh" button, since reloading
 *   doesn't fix a stale server; you have to restart it.
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
    /* storage blocked; dismissal only lasts until the next render */
  }
}

/** "pull: Fast-forward" -> "pull". Only verbs people will recognise. */
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

  // Dismissed per exact situation, so a newer pull shows it again.
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
