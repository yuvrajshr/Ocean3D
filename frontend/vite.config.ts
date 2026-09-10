import { execFileSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

import { classifyBackend, classifyFrontend, parseReflog, type BuildMode } from "./src/build/classify";

/** Run git from the repo; null when git is absent or this is not a checkout. */
function git(...args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      cwd: __dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Build identity: the page states which commit it was built from, and the
 * server says when the code on disk has moved past it.
 *
 * `__BUILD__` is fixed when this config loads — at dev-server start, or at
 * `vite build`. `/__build` is answered live, so after a `git pull` it reports
 * the new HEAD while the page still carries the old one. See
 * `src/build/classify.ts` for why "HEAD moved" alone is not the test.
 *
 * Served in both `vite` and `vite preview`. A static host has no such endpoint,
 * so the check quietly does nothing there and the stamp still renders.
 */
function buildIdentity(): Plugin {
  const sha = git("rev-parse", "HEAD");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const builtAt = Date.now();

  /** Repo-relative paths changed between two commits; [] when unknown. */
  const changedBetween = (from: string | null, to: string | null): string[] => {
    if (!from || !to) return [];
    // Run from the repo top so the paths come back as "frontend/…", "backend/…".
    const top = git("rev-parse", "--show-toplevel");
    try {
      return execFileSync("git", ["diff", "--name-only", from, to], {
        cwd: top ?? __dirname,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split(/\r?\n/)
        .filter(Boolean);
    } catch {
      // `from` is not in this clone (a squashed or rewritten history): treat
      // it as changed everywhere, which errs toward asking for a restart.
      return ["frontend", "backend"];
    }
  };

  const handler = (mode: BuildMode) => (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith("/__build")) return next();
    const url = new URL(req.url, "http://local");
    const builtSha = url.searchParams.get("ui");
    const builtAtParam = Number(url.searchParams.get("since")) || 0;
    const apiSha = url.searchParams.get("api");
    const headSha = git("rev-parse", "HEAD");

    const ui = classifyFrontend({
      builtSha,
      headSha,
      builtAt: builtAtParam,
      mode,
      changedPaths: changedBetween(builtSha, headSha),
      reflog: parseReflog(git("reflog", "--date=unix", "--format=%gd%x09%H%x09%gs", "-200") ?? ""),
    });
    const api = classifyBackend({
      startedSha: apiSha,
      headSha,
      changedPaths: changedBetween(apiSha, headSha),
    });

    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ head: headSha, branch: git("rev-parse", "--abbrev-ref", "HEAD"), mode, ui, api }));
  };

  return {
    name: "ocean3d-build-identity",
    config: () => ({
      define: {
        __BUILD__: JSON.stringify({ sha, branch, builtAt }),
      },
    }),
    configureServer: (server) => {
      server.middlewares.use(handler("dev"));
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(handler("preview"));
    },
  };
}

// The frontend never talks to erddap.incois.gov.in directly — it has no CORS
// headers and an incomplete TLS chain. Everything goes through the FastAPI
// backend, which is proxied here in dev so the app uses same-origin /api paths
// in both development and production.
export default defineConfig({
  plugins: [react(), buildIdentity()],
  server: {
    port: 5173,
    // Fail instead of drifting to 5174. Without this, an old dev server still
    // holding 5173 keeps answering the tab everyone already has open while the
    // fresh one hides on the next port — so a `git pull` appears to change
    // nothing. That is how a deleted control stayed on a teammate's screen for
    // two days after it left `main` (next_session.md §1g).
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
