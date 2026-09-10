/**
 * The stale-build decision.
 *
 * The scenario these exist for: a teammate pulls `main`, keeps the dev server
 * that was already running, and sees a control that no longer exists in the
 * source. The page must say so. The opposite failure matters just as much: a
 * warning that fires on your own commits gets ignored within a day, and then it
 * is not there for the case above.
 */

import { describe, expect, it } from "vitest";

import {
  classifyBackend,
  classifyFrontend,
  isOwnCommit,
  parseReflog,
  sameCommit,
  touches,
  type ReflogEntry,
} from "./classify";

const BUILT = "84a041100000000000000000000000000000000a";
const PULLED = "28ff21d00000000000000000000000000000000b";
const OWN = "c0ffee100000000000000000000000000000000c";
const START = 1_788_000_000_000;
const FRONTEND_CHANGE = ["frontend/src/components/CommandPill.tsx"];

const at = (s: number, sha: string, subject: string): ReflogEntry => ({ at: START + s * 1000, sha, subject });

function frontend(overrides: Partial<Parameters<typeof classifyFrontend>[0]>) {
  return classifyFrontend({
    builtSha: BUILT,
    headSha: PULLED,
    builtAt: START,
    mode: "dev",
    changedPaths: FRONTEND_CHANGE,
    reflog: [],
    ...overrides,
  });
}

describe("frontend dev server", () => {
  it("is stale after a pull brought frontend changes underneath it", () => {
    const verdict = frontend({ reflog: [at(60, PULLED, "pull: Fast-forward")] });
    expect(verdict).toEqual({ status: "stale", reason: "pull: Fast-forward" });
  });

  it("is stale after a checkout, merge, rebase or reset", () => {
    for (const subject of [
      "checkout: moving from main to integrate/chunk-view",
      "merge fix/map-alignment: Merge made by the 'ort' strategy.",
      "rebase (finish): returning to refs/heads/main",
      "reset: moving to origin/main",
    ]) {
      expect(frontend({ reflog: [at(1, PULLED, subject)] }).status).toBe("stale");
    }
  });

  it("stays current across your own commits — Vite already hot-reloaded those files", () => {
    const verdict = frontend({
      headSha: OWN,
      reflog: [at(1, OWN, "commit: Fix the map"), at(2, OWN, "commit (amend): Fix the map")],
    });
    expect(verdict.status).toBe("current");
  });

  it("forgets what was undone: look at another branch, come back, then commit", () => {
    // Without this the warning would stay up until a restart, for a checkout
    // that left nothing behind — the kind of false alarm that teaches people
    // to ignore it.
    const verdict = frontend({
      headSha: OWN,
      reflog: [
        at(1, PULLED, "checkout: moving from main to someone-elses-branch"),
        at(2, BUILT, "checkout: moving from someone-elses-branch to main"),
        at(3, OWN, "commit: Carry on"),
      ],
    });
    expect(verdict.status).toBe("current");
  });

  it("still warns when the pull came after returning to the build", () => {
    const verdict = frontend({
      reflog: [
        at(1, OWN, "checkout: moving from main to x"),
        at(2, BUILT, "checkout: moving from x to main"),
        at(3, PULLED, "pull: Fast-forward"),
      ],
    });
    expect(verdict).toEqual({ status: "stale", reason: "pull: Fast-forward" });
  });

  it("ignores reflog entries from before the server started", () => {
    const verdict = frontend({ reflog: [{ at: START - 1, sha: PULLED, subject: "pull: Fast-forward" }] });
    expect(verdict.status).toBe("current");
  });

  it("does not warn when the pull only touched docs or the backend", () => {
    const verdict = frontend({
      changedPaths: ["context.md", "backend/app/main.py"],
      reflog: [at(1, PULLED, "pull: Fast-forward")],
    });
    expect(verdict.status).toBe("current");
  });

  it("is current when nothing moved", () => {
    expect(frontend({ headSha: BUILT }).status).toBe("current");
  });

  it("says nothing when there is no git to ask", () => {
    expect(frontend({ builtSha: null }).status).toBe("unknown");
    expect(frontend({ headSha: null }).status).toBe("unknown");
  });
});

describe("frontend bundle (vite preview)", () => {
  it("is stale after ANY frontend change, including your own commits — dist does not reload", () => {
    const verdict = frontend({ mode: "preview", reflog: [at(1, PULLED, "commit: x")] });
    expect(verdict.status).toBe("stale");
  });

  it("is not stale when only docs changed", () => {
    expect(frontend({ mode: "preview", changedPaths: ["README.md"] }).status).toBe("current");
  });
});

describe("backend process", () => {
  it("is stale after any backend change, own commits included — uvicorn never reloads", () => {
    const verdict = classifyBackend({
      startedSha: BUILT,
      headSha: PULLED,
      changedPaths: ["backend/app/assistant/prompt.py"],
    });
    expect(verdict.status).toBe("stale");
  });

  it("is current when the change was frontend-only", () => {
    expect(classifyBackend({ startedSha: BUILT, headSha: PULLED, changedPaths: FRONTEND_CHANGE }).status).toBe(
      "current",
    );
  });

  it("says nothing when the API did not report a commit", () => {
    expect(classifyBackend({ startedSha: null, headSha: PULLED, changedPaths: [] }).status).toBe("unknown");
  });
});

describe("helpers", () => {
  it("parses git's real reflog format, oldest first", () => {
    // Verbatim shape of `git reflog --date=unix --format=%gd%x09%H%x09%gs`,
    // which prints newest first.
    const text = [
      `HEAD@{1789017662}\t${PULLED}\tcheckout: moving from main to integrate/chunk-view`,
      `HEAD@{1788887541}\t${BUILT}\tcommit: Fix the map's squish`,
      "",
    ].join("\n");
    expect(parseReflog(text)).toEqual([
      { at: 1_788_887_541_000, sha: BUILT, subject: "commit: Fix the map's squish" },
      { at: 1_789_017_662_000, sha: PULLED, subject: "checkout: moving from main to integrate/chunk-view" },
    ]);
  });

  it("keeps an entry with an empty subject, as a worktree's first one has", () => {
    expect(parseReflog(`HEAD@{1}\t${BUILT}\t`)).toEqual([{ at: 1000, sha: BUILT, subject: "" }]);
  });

  it("parses Windows line endings", () => {
    expect(parseReflog(`HEAD@{1}\t${BUILT}\tpull: Fast-forward\r\n`)).toEqual([
      { at: 1000, sha: BUILT, subject: "pull: Fast-forward" },
    ]);
  });

  it("preserves git's order when entries share a second", () => {
    const text = [`HEAD@{5}\t${PULLED}\tmerge x: Fast-forward`, `HEAD@{5}\t${BUILT}\tcheckout: moving to main`].join(
      "\n",
    );
    expect(parseReflog(text).map((e) => e.subject)).toEqual(["checkout: moving to main", "merge x: Fast-forward"]);
  });

  it("treats every commit form as own work, and nothing else", () => {
    expect(isOwnCommit("commit: x")).toBe(true);
    expect(isOwnCommit("commit (amend): x")).toBe(true);
    expect(isOwnCommit("commit (merge): x")).toBe(true);
    expect(isOwnCommit("pull: Fast-forward")).toBe(false);
    expect(isOwnCommit("committed: x")).toBe(false);
    expect(isOwnCommit("")).toBe(false);
  });

  it("matches short and full commit ids", () => {
    expect(sameCommit("28ff21d", PULLED)).toBe(true);
    expect(sameCommit("28FF21D", PULLED)).toBe(true);
    expect(sameCommit("28ff21e", PULLED)).toBe(false);
    // Fewer than seven characters is too ambiguous to call a match.
    expect(sameCommit("28ff2", PULLED)).toBe(false);
  });

  it("scopes paths by top-level directory, not by prefix string", () => {
    expect(touches(["frontend/src/App.tsx"], ["frontend"])).toBe(true);
    expect(touches(["frontend-old/x.ts"], ["frontend"])).toBe(false);
  });
});
