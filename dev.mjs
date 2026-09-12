/**
 * Start the backend and frontend together.
 *
 *   npm run dev            both, with prefixed output
 *   npm run dev -- --open  and open the browser once both are up
 *
 * A small script instead of concurrently, because it also:
 *   1. finds the venv python (Scripts/ on Windows, bin/ elsewhere) and says so
 *      clearly if it's missing
 *   2. refuses to start if a port is already in use, instead of starting a
 *      second copy on another port
 *   3. stops both if either one exits, so you never end up with half the app
 *      running (the frontend shows nothing without the backend)
 *
 * Vite is run as node node_modules/vite/bin/vite.js rather than through npm, to
 * avoid npm.cmd's shell on Windows. No dependencies.
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

// --- output ---
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

// --- preflight ---
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
 * Resolves true if something is already listening on the port.
 *
 * Checks both IPv4 and IPv6: Vite binds "localhost", which is ::1 first on
 * Windows, while uvicorn listens on 127.0.0.1 only.
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

// --- launch ---
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
        `Stopping the other one too — the app shows a blank page\n` +
        dim("  without both running."),
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
    // uvicorn and vite both spawn children; /T kills the whole tree.
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

// Backend first; the frontend can't show anything without it.
start(
  "backend",
  python,
  ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", String(BACKEND_PORT)],
  BACKEND,
);
start("frontend", process.execPath, [viteBin, "--port", String(FRONTEND_PORT), "--strictPort"], FRONTEND);

// --- readiness ---
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
  // One of them already exited; its own handler prints why.
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
