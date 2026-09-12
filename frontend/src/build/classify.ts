/**
 * Is the running code older than the code on disk?
 *
 * Pure functions, so they run in the Vite server (see vite.config.ts) and in
 * tests; the git calls happen in the config.
 *
 * "HEAD moved" isn't the right test:
 * - The frontend dev server hot-reloads, so your own commits are already on
 *   screen. It's only stale when files change underneath it (pull, merge,
 *   checkout, rebase, reset), counting from the last time the checkout matched
 *   the build.
 * - The backend doesn't reload (no --reload), so any change under backend/
 *   since it started counts.
 *
 * Both only look at their own paths, so a docs-only pull doesn't warn.
 */

export interface ReflogEntry {
  /** When HEAD moved, in ms since the epoch. */
  at: number;
  /** The commit HEAD pointed at after the move. */
  sha: string;
  /** Reflog subject, e.g. "pull: Fast-forward" or "commit: Fix the map". */
  subject: string;
}

export type BuildMode = "dev" | "preview";

export interface BuildVerdict {
  status: "current" | "stale" | "unknown";
  /** What made it stale, in git's words where possible. */
  reason?: string;
}

/** A reflog subject for changes a running dev server has already picked up. */
export function isOwnCommit(subject: string): boolean {
  // "commit:", "commit (amend):", "commit (initial):", "commit (merge):".
  // A conflicted merge is committed as "commit (merge)" after being resolved
  // under the running server; the merge that brought in other files is logged
  // separately as "merge ..." or "pull ..." and is caught below.
  return /^commit\b/.test(subject);
}

/** True if any changed path is under one of the given top-level dirs. */
export function touches(changedPaths: string[], dirs: string[]): boolean {
  return changedPaths.some((path) => dirs.some((dir) => path === dir || path.startsWith(`${dir}/`)));
}

/** Frontend: a Vite dev server (hot-reloads) or a built bundle (doesn't). */
export function classifyFrontend(input: {
  /** Commit the page was built from. */
  builtSha: string | null;
  /** Commit currently checked out. */
  headSha: string | null;
  /** When the page was built. Earlier reflog entries are ignored. */
  builtAt: number;
  mode: BuildMode;
  /** Paths changed between builtSha and headSha. */
  changedPaths: string[];
  /** Oldest first, as parseReflog returns it. */
  reflog: ReflogEntry[];
}): BuildVerdict {
  const { builtSha, headSha, builtAt, mode, changedPaths, reflog } = input;

  // No git (zip download, container): skip the comparison. The stamp still shows.
  if (!builtSha || !headSha) return { status: "unknown" };
  if (sameCommit(builtSha, headSha)) return { status: "current" };
  if (!touches(changedPaths, ["frontend"])) return { status: "current" };

  // A built bundle never reloads, so any frontend change since the build makes
  // it stale, including your own commits.
  if (mode === "preview") return { status: "stale", reason: "frontend changed since this bundle was built" };

  const since = reflog.filter((entry) => entry.at >= builtAt);
  // Only changes after the checkout last matched the build count.
  let from = 0;
  since.forEach((entry, i) => {
    if (sameCommit(entry.sha, builtSha)) from = i + 1;
  });
  const foreign = since.slice(from).find((entry) => !isOwnCommit(entry.subject));

  return foreign ? { status: "stale", reason: foreign.subject } : { status: "current" };
}

/** API process: never reloads, so any backend change since start counts. */
export function classifyBackend(input: {
  /** Commit the API process started from (GET /api/build). */
  startedSha: string | null;
  headSha: string | null;
  /** Paths changed between startedSha and headSha. */
  changedPaths: string[];
}): BuildVerdict {
  const { startedSha, headSha, changedPaths } = input;
  if (!startedSha || !headSha) return { status: "unknown" };
  if (sameCommit(startedSha, headSha)) return { status: "current" };
  return touches(changedPaths, ["backend"])
    ? { status: "stale", reason: "backend changed since the API started" }
    : { status: "current" };
}

/** Short and full forms of the same commit compare equal. */
export function sameCommit(a: string, b: string): boolean {
  const n = Math.min(a.length, b.length);
  return n >= 7 && a.slice(0, n).toLowerCase() === b.slice(0, n).toLowerCase();
}

export function short(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * Parse git reflog --date=unix --format=%gd%x09%H%x09%gs, oldest first.
 *
 * With --date=unix, %gd is HEAD@{1757432400}, the time HEAD moved. Git prints
 * newest first and entries often share a second, so we keep git's order instead
 * of sorting by time. The subject can be empty (a worktree's first entry).
 */
export function parseReflog(text: string): ReflogEntry[] {
  const out: ReflogEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const [selector = "", sha = "", ...rest] = line.split("\t");
    const match = /@\{(\d+)\}/.exec(selector);
    if (!match || !sha.trim()) continue;
    out.push({ at: Number(match[1]) * 1000, sha: sha.trim(), subject: rest.join("\t").trim() });
  }
  return out.reverse();
}
