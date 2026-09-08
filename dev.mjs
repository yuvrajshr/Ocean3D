/**
 * dev.mjs — start the backend and the frontend together.
 *
 *   npm run dev            both, with prefixed output
 *   npm run dev -- --open  ...and open the browser once both answer
 *
 * Why a script rather than `concurrently`: this needs to do three things a
 * generic runner does not, all of which come straight out of next_session.md §2.
 *
 *   1. Resolve the venv python itself (Scripts/ on Windows, bin/ elsewhere) and
 *      say so plainly when it is missing, instead of failing as "ENOENT python".
 *
 *   2. Refuse to start a second instance on a port that already answers.
 *      CLAUDE.md §8 says not to, and a second Vite on :5174 is worse than an
 *      error, because every screenshot afterwards is of the wrong server.
 *
 *   3. **If either process exits, take the other down with it.** This is the
 *      one that matters. Vite dying on its own produced a blank page and a null
 *      canvas that "looked exactly like a rendering bug", and a backend that
 *      quietly died renders an app that draws nothing, because the browser
 *      cannot reach ERDDAP directly. A half-running stack is the single most
 *      expensive failure mode this repo has recorded, so it is now impossible:
 *      you either have both or you have a message saying which one went.
 *
 * Vite is invoked as `node node_modules/vite/bin/vite.js`, not through npm. That
 * sidesteps the npm.cmd shell layer whose exit 127 is the failure §2 describes.
 *
 * Zero dependencies, on purpose — the root package.json carries puppeteer for
 * the screenshot harness and nothing else needs to change to run the app.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const BACKEND = join(ROOT, "backend");
const FRONTEND = join(ROOT, "frontend");

const BACKEND_PORT = 8000;
const FRONTEND_PORT = 5173;
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`;
const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;

const isWindows = process.platform === "win32";
const wantsOpen = process.argv.includes("--open");

// ── output ────────────────────────────────────────────────────────────────
const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColour ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => paint("2", s);
const bold = (s) => paint("1", s);

const TAGS = {
  backend: { label: "backend ", colour: "36" }, // cyan
  frontend: { label: "frontend", colour: "35" }, // magenta
};

function relay(name, stream) {
  const { label, colour } = TAGS[name];
  const prefix = paint(colour, `[${label}]`);
  let carry = "";
  stream.on("data", (chunk) => {
    const lines = (carry + chunk.toString()).split(/\r?\n/);
    carry = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) console.log(`${prefix} ${line}`);
  });
}

function fail(message, hint) {
  console.error(`\n${paint("31", "Cannot start.")} ${message}`);
  if (hint) console.error(dim(`  ${hint}\n`));
  process.exit(1);
}

// ── preflight ─────────────────────────────────────────────────────────────
const python = isWindows
  ? join(BACKEND, ".venv", "Scripts", "python.exe")
  : join(BACKEND, ".venv", "bin", "python");

if (!existsSync(python)) {
  fail(
    `No Python virtualenv at ${dim(python)}`,
    isWindows
      ? "Create it with:  cd backend && python -m venv .venv && .venv\\Scripts\\python -m pip install -r requirements.txt"
      : "Create it with:  cd backend && python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt",
  );
}

const viteBin = join(FRONTEND, "node_modules", "vite", "bin", "vite.js");
if (!existsSync(viteBin)) {
  fail(
    `Frontend dependencies are not installed (no ${dim("frontend/node_modules/vite")}).`,
    "Install them with:  cd frontend && npm install",
  );
}

/**
 * Resolves true when something is already listening on the port.
 *
 * Both stacks are probed, and this is not defensive padding: Vite binds the
 * hostname `localhost`, which on Windows resolves to `::1` first, so an
 * IPv4-only probe reports a perfectly healthy dev server as down. Uvicorn is
 * bound explicitly to 127.0.0.1 and answers only on v4. Checking one family
 * would therefore either hang the readiness wait or, worse, let the
 * already-running guard pass and start a duplicate on another port.
 */
const portInUse = (port) => {
  const probe = (host) =>
    new Promise((resolve) => {
      const socket = createConnection({ port, host });
      const done = (answer) => {
        socket.destroy();
        resolve(answer);
      };
      socket.setTimeout(1000);
      socket.once("connect", () => done(true));
      socket.once("timeout", () => done(false));
      socket.once("error", () => done(false));
    });
  return Promise.all([probe("127.0.0.1"), probe("::1")]).then((r) => r.includes(true));
};

const [backendBusy, frontendBusy] = await Promise.all([
  portInUse(BACKEND_PORT),
  portInUse(FRONTEND_PORT),
]);

if (backendBusy || frontendBusy) {
  const which = [
    backendBusy ? `backend on :${BACKEND_PORT}` : null,
    frontendBusy ? `frontend on :${FRONTEND_PORT}` : null,
  ]
    .filter(Boolean)
    .join(" and ");
  fail(
    `Something is already listening — ${which}.`,
    "A second instance would bind a different port and every screenshot after it would be of the wrong server. Stop the running one first, or just use it.",
  );
}

// ── launch ────────────────────────────────────────────────────────────────
const children = new Map();
let shuttingDown = false;

function start(name, command, args, cwd) {
  const child = spawn(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    // POSIX: own process group, so we can signal the whole tree.
    detached: !isWindows,
    env: { ...process.env, FORCE_COLOR: useColour ? "1" : "0" },
  });
  relay(name, child.stdout);
  relay(name, child.stderr);
  children.set(name, child);

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    const how = signal ? `signal ${signal}` : `code ${code}`;
    console.error(
      `\n${paint("31", `The ${name} exited (${how}).`)} ` +
        `Stopping the other half too — a half-running stack renders a blank\n` +
        dim("  page that looks like a bug in the 3D, not a dead server (next_session.md §2)."),
    );
    shutdown(typeof code === "number" && code !== 0 ? code : 1);
  });

  child.on("error", (err) => {
    console.error(paint("31", `Failed to launch the ${name}: ${err.message}`));
    shutdown(1);
  });

  return child;
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (isWindows) {
    // uvicorn's reloader and vite both spawn children; /T takes the tree.
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children.values()) killTree(child);
  setTimeout(() => process.exit(code), 400);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(dim("\nStopping both…"));
    shutdown(0);
  });
}

console.log(bold("\nOcean3D — starting backend and frontend\n"));
console.log(dim(`  backend   ${python} -m uvicorn app.main:app --port ${BACKEND_PORT}`));
console.log(dim(`  frontend  node node_modules/vite/bin/vite.js --port ${FRONTEND_PORT}\n`));

// Backend first: the browser cannot reach ERDDAP directly, so nothing renders
// without it (CONTRIBUTING §2).
start(
  "backend",
  python,
  ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(BACKEND_PORT)],
  BACKEND,
);
start("frontend", process.execPath, [viteBin, "--port", String(FRONTEND_PORT), "--strictPort"], FRONTEND);

// ── report readiness ──────────────────────────────────────────────────────
const waitForPort = async (port, timeoutMs = 90000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !shuttingDown) {
    if (await portInUse(port)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
};

const [backendUp, frontendUp] = await Promise.all([
  waitForPort(BACKEND_PORT),
  waitForPort(FRONTEND_PORT),
]);

if (shuttingDown) {
  // One of them already died; its own handler is printing the reason.
} else if (backendUp && frontendUp) {
  console.log(
    `\n${paint("32", "Both up.")}  ` +
      `${bold("App")} ${FRONTEND_URL}   ${bold("API")} ${BACKEND_URL}   ${dim("docs " + BACKEND_URL + "/docs")}\n` +
      dim("  Ctrl+C stops both.\n"),
  );
  if (wantsOpen) {
    const [cmd, args] = isWindows
      ? ["cmd", ["/c", "start", "", FRONTEND_URL]]
      : process.platform === "darwin"
        ? ["open", [FRONTEND_URL]]
        : ["xdg-open", [FRONTEND_URL]];
    spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
  }
} else {
  console.error(
    paint("31", `\nTimed out waiting for ${!backendUp ? "the backend" : "the frontend"} to listen.`),
  );
  shutdown(1);
}
