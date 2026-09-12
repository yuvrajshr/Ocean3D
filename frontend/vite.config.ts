import { execFileSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

import { classifyBackend, classifyFrontend, parseReflog, type BuildMode } from "./src/build/classify";

/** Run git in the repo; null if git isn't available or this isn't a checkout. */
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
 * Build identity: the page shows which commit it was built from, and the server
 * reports when the code on disk has moved past it.
 *
 * __BUILD__ is fixed when this config loads (dev server start or vite build).
 * /__build answers live, so after a git pull it shows the new HEAD while the page
 * still has the old one. See src/build/classify.ts for how "stale" is decided.
 * Available in vite and vite preview only; on a static host the check does nothing.
 */
function buildIdentity(): Plugin {
  const sha = git("rev-parse", "HEAD");
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const builtAt = Date.now();

  /** Paths changed between two commits; [] if unknown. */
  const changedBetween = (from: string | null, to: string | null): string[] => {
    if (!from || !to) return [];
    // Run from the repo root so paths come back as "frontend/...", "backend/...".
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
      // ``from`` isn't in this clone (rewritten history), so assume everything changed.
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

// The browser can't reach ERDDAP directly (no CORS, incomplete TLS chain), so
// everything goes through the backend, proxied here in dev so /api works the same
// in dev and production.
export default defineConfig({
  plugins: [react(), buildIdentity()],
  server: {
    port: 5173,
    // Fail instead of moving to 5174; otherwise an old server on 5173 keeps serving
    // the open tab and a pull looks like it changed nothing.
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
