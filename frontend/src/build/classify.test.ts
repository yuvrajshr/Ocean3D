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

import { classifyBackend, classifyFrontend, isOwnCommit, parseReflog, sameCommit, touches } from "./classify";

const OLD = "84a041100000000000000000000000000000000a";
const NEW = "28ff21d00000000000000000000000000000000b";
const START = 1_788_000_000_000;
const FRONTEND_CHANGE = ["frontend/src/components/CommandPill.tsx"];

function frontend(overrides: Partial<Parameters<typeof classifyFrontend>[0]>) {
  return classifyFrontend({
    builtSha: OLD,
    headSha: NEW,
    builtAt: START,
    mode: "dev",
    changedPaths: FRONTEND_CHANGE,
    reflog: [],
    ...overrides,
  });
}

describe("frontend dev server", () => {
  it("is stale after a pull brought frontend changes underneath it", () => {
    const verdict = frontend({ reflog: [{ at: START + 60_000, subject: "pull: Fast-forward" }] });
    expect(verdict).toEqual({ status: "stale", reason: "pull: Fast-forward" });
  });

  it("is stale after a checkout, merge, rebase or reset", () => {
    for (const subject of [
      "checkout: moving from main to integrate/chunk-view",
      "merge fix/map-alignment: Merge made by the 'ort' strategy.",
      "rebase (finish): returning to refs/heads/main",
      "reset: moving to origin/main",
    ]) {
      expect(frontend({ reflog: [{ at: START + 1, subject }] }).status).toBe("stale");
    }
  });

  it("stays current across your own commits — Vite already hot-reloaded those files", () => {
    const verdict = frontend({
      reflog: [
        { at: START + 1_000, subject: "commit: Fix the map" },
        { at: START + 2_000, subject: "commit (amend): Fix the map" },
      ],
    });
    expect(verdict.status).toBe("current");
  });

  it("ignores reflog entries from before the server started", () => {
    const verdict = frontend({ reflog: [{ at: START - 1, subject: "pull: Fast-forward" }] });
    expect(verdict.status).toBe("current");
  });

  it("does not warn when the pull only touched docs or the backend", () => {
    const verdict = frontend({
      changedPaths: ["context.md", "backend/app/main.py"],
      reflog: [{ at: START + 1, subject: "pull: Fast-forward" }],
    });
    expect(verdict.status).toBe("current");
  });

  it("is current when nothing moved", () => {
    expect(frontend({ headSha: OLD }).status).toBe("current");
  });

  it("says nothing when there is no git to ask", () => {
    expect(frontend({ builtSha: null }).status).toBe("unknown");
    expect(frontend({ headSha: null }).status).toBe("unknown");
  });
});

describe("frontend bundle (vite preview)", () => {
  it("is stale after ANY frontend change, including your own commits — dist does not reload", () => {
    const verdict = frontend({ mode: "preview", reflog: [{ at: START + 1, subject: "commit: x" }] });
    expect(verdict.status).toBe("stale");
  });

  it("is not stale when only docs changed", () => {
    expect(frontend({ mode: "preview", changedPaths: ["README.md"] }).status).toBe("current");
  });
});

describe("backend process", () => {
  it("is stale after any backend change, own commits included — uvicorn never reloads", () => {
    const verdict = classifyBackend({ startedSha: OLD, headSha: NEW, changedPaths: ["backend/app/assistant/prompt.py"] });
    expect(verdict.status).toBe("stale");
  });

  it("is current when the change was frontend-only", () => {
    expect(classifyBackend({ startedSha: OLD, headSha: NEW, changedPaths: FRONTEND_CHANGE }).status).toBe("current");
  });

  it("says nothing when the API did not report a commit", () => {
    expect(classifyBackend({ startedSha: null, headSha: NEW, changedPaths: [] }).status).toBe("unknown");
  });
});

describe("helpers", () => {
  it("parses git's real reflog format", () => {
    const text = [
      "HEAD@{1789017662}\tcheckout: moving from main to integrate/chunk-view",
      "HEAD@{1788887541}\tcommit: Fix the map's squish",
      "",
    ].join("\n");
    expect(parseReflog(text)).toEqual([
      { at: 1_789_017_662_000, subject: "checkout: moving from main to integrate/chunk-view" },
      { at: 1_788_887_541_000, subject: "commit: Fix the map's squish" },
    ]);
  });

  it("parses Windows line endings", () => {
    expect(parseReflog("HEAD@{1}\tpull: Fast-forward\r\n")).toEqual([{ at: 1000, subject: "pull: Fast-forward" }]);
  });

  it("treats every commit form as own work, and nothing else", () => {
    expect(isOwnCommit("commit: x")).toBe(true);
    expect(isOwnCommit("commit (amend): x")).toBe(true);
    expect(isOwnCommit("commit (merge): x")).toBe(true);
    expect(isOwnCommit("pull: Fast-forward")).toBe(false);
    expect(isOwnCommit("committed: x")).toBe(false);
  });

  it("matches short and full commit ids", () => {
    expect(sameCommit("28ff21d", NEW)).toBe(true);
    expect(sameCommit("28FF21D", NEW)).toBe(true);
    expect(sameCommit("28ff21e", NEW)).toBe(false);
    // Fewer than seven characters is too ambiguous to call a match.
    expect(sameCommit("28ff2", NEW)).toBe(false);
  });

  it("scopes paths by top-level directory, not by prefix string", () => {
    expect(touches(["frontend/src/App.tsx"], ["frontend"])).toBe(true);
    expect(touches(["frontend-old/x.ts"], ["frontend"])).toBe(false);
  });
});
