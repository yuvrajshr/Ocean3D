/**
 * Is what is running older than the code on disk?
 *
 * Pure, so it runs in the Vite server (see `vite.config.ts`) and in a plain
 * Node test alike. The git calls live in the config; this only decides.
 *
 * Why it exists: on 2026-09-08 a teammate kept seeing a control that had been
 * deleted from `main` two days earlier. The source was correct — the runtime on
 * their machine predated their `git pull`. Nothing in the app said which build
 * it was, so a stale server was indistinguishable from a bug, and it cost two
 * rounds of looking for a root cause in code that was already fixed.
 *
 * "HEAD moved" is not the test, for two different reasons:
 *
 *   - The frontend dev server hot-reloads. Committing your own edits moves
 *     HEAD, but Vite already applied those files, so the page is current. A
 *     warning there would fire on every commit and be ignored within a day.
 *     What makes it stale is files changing *underneath* it — a pull, merge,
 *     checkout, rebase or reset: exactly the reflog entries that are not
 *     commits.
 *
 *   - The backend does not reload at all (uvicorn runs without --reload), so
 *     for it any change under `backend/` since the process started is stale,
 *     whoever made it.
 *
 * Both are scoped by path, so a pull that only touched `context.md` warns
 * about nothing.
 */

export interface ReflogEntry {
  /** When HEAD moved, in milliseconds since the epoch. */
  at: number;
  /** The reflog subject, e.g. "pull: Fast-forward" or "commit: Fix the map". */
  subject: string;
}

export type BuildMode = "dev" | "preview";

export interface BuildVerdict {
  status: "current" | "stale" | "unknown";
  /** What made it stale, in git's own words where there are some. */
  reason?: string;
}

/** A reflog subject for work a watching dev server has already seen. */
export function isOwnCommit(subject: string): boolean {
  // "commit:", "commit (amend):", "commit (initial):", "commit (merge):".
  // A conflicted merge is committed as "commit (merge)", but its files changed
  // on disk while it was being resolved — under a watching server, not behind
  // one. The merge that brought foreign files in is logged separately, as
  // "merge …" or "pull …", and is caught below.
  return /^commit\b/.test(subject);
}

/** True when any changed path lies under one of the given top-level dirs. */
export function touches(changedPaths: string[], dirs: string[]): boolean {
  return changedPaths.some((path) => dirs.some((dir) => path === dir || path.startsWith(`${dir}/`)));
}

/** The frontend: a Vite dev server (hot-reloads) or a built bundle (does not). */
export function classifyFrontend(input: {
  /** The commit the page on screen was built from. */
  builtSha: string | null;
  /** The commit checked out on disk right now. */
  headSha: string | null;
  /** When the page's build was made. Reflog entries before this are ignored. */
  builtAt: number;
  mode: BuildMode;
  /** Repo-relative paths changed between builtSha and headSha. */
  changedPaths: string[];
  reflog: ReflogEntry[];
}): BuildVerdict {
  const { builtSha, headSha, builtAt, mode, changedPaths, reflog } = input;

  // No git (a zip download, a container without .git): say nothing rather
  // than guess. The stamp still renders; only the comparison is skipped.
  if (!builtSha || !headSha) return { status: "unknown" };
  if (sameCommit(builtSha, headSha)) return { status: "current" };
  if (!touches(changedPaths, ["frontend"])) return { status: "current" };

  // A bundle is a snapshot: nothing hot-reloads `dist/`, so any frontend
  // change since it was built makes it old — including your own commits.
  if (mode === "preview") return { status: "stale", reason: "frontend changed since this bundle was built" };

  const foreign = reflog
    .filter((entry) => entry.at >= builtAt)
    .sort((a, b) => a.at - b.at)
    .find((entry) => !isOwnCommit(entry.subject));

  return foreign ? { status: "stale", reason: foreign.subject } : { status: "current" };
}

/** The API process: it never reloads, so any backend change since start counts. */
export function classifyBackend(input: {
  /** The commit the API process started from (GET /api/build). */
  startedSha: string | null;
  headSha: string | null;
  /** Repo-relative paths changed between startedSha and headSha. */
  changedPaths: string[];
}): BuildVerdict {
  const { startedSha, headSha, changedPaths } = input;
  if (!startedSha || !headSha) return { status: "unknown" };
  if (sameCommit(startedSha, headSha)) return { status: "current" };
  return touches(changedPaths, ["backend"])
    ? { status: "stale", reason: "backend changed since the API started" }
    : { status: "current" };
}

/** Short and long forms of the same commit compare equal. */
export function sameCommit(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length);
  return n >= 7 && a.slice(0, n).toLowerCase() === b.slice(0, n).toLowerCase();
}

export function short(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Parse `git reflog --date=unix --format=%gd%x09%gs`.
 *
 * With `--date=unix`, `%gd` renders as `HEAD@{1757432400}` — the time HEAD
 * moved, which is what matters here, not the commit's author date.
 */
export function parseReflog(text: string): ReflogEntry[] {
  const out: ReflogEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const match = /@\{(\d+)\}/.exec(line.slice(0, tab));
    if (!match) continue;
    out.push({ at: Number(match[1]) * 1000, subject: line.slice(tab + 1).trim() });
  }
  return out;
}
