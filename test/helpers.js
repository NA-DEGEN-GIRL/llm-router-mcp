import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runCommand } from "../src/core.js";

export const IS_WINDOWS = process.platform === "win32";
export const PROVIDERS = ["codex", "claude", "grok", "antigravity"];
export const FAKE_LLM = path.resolve("test/fixtures/fake-llm.js");
export const ECHO_ARGS = path.resolve("test/fixtures/echo-args.js");

// Settings from the developer's shell (a tmux socket, models, commands) must
// not leak into the tests.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("LLM_ROUTER_MCP_")) {
    delete process.env[name];
  }
}

// Every test file talks to its own tmux server so it never touches the
// user's sessions. The label is stable because tmux-windows keeps a server
// log per label.
export const TMUX_LABEL = `lrm-test-${path.basename(process.argv[1] || "run", ".js").replace(/[^A-Za-z0-9_-]/g, "-")}`;
process.env.LLM_ROUTER_MCP_TMUX_LABEL = TMUX_LABEL;

export async function tmuxAvailable() {
  try {
    const result = await runCommand("tmux", ["-V"], { allowFailure: true, timeoutMs: 5000 });
    return result.code === 0;
  } catch {
    return false;
  }
}

export async function killTestServer() {
  await runCommand("tmux", ["-L", TMUX_LABEL, "kill-server"], {
    allowFailure: true,
    timeoutMs: 10000
  }).catch(() => {});
}

export async function tempDir(t, prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });
  return dir;
}

export function fakeCommand(...flags) {
  return [process.execPath, FAKE_LLM, ...flags];
}

export function uniqueName(label) {
  return `lrm-${label}-${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`;
}

/**
 * Puts fake codex/claude/grok/agy commands first on the PATH the router uses.
 * On Windows codex is an npm-style .cmd shim (run through node directly) and
 * the others are plain .cmd scripts (run through cmd.exe).
 */
export async function installFakeClis(t) {
  const fakeBin = await tempDir(t, "llm-router-fake-bin-");
  if (IS_WINDOWS) {
    const scriptDir = path.join(fakeBin, "node_modules", "fake-llm", "bin");
    await fs.mkdir(scriptDir, { recursive: true });
    await fs.copyFile(FAKE_LLM, path.join(scriptDir, "fake-llm.js"));
    await fs.writeFile(path.join(fakeBin, "codex.cmd"), npmShim("node_modules\\fake-llm\\bin\\fake-llm.js"));
    for (const name of ["claude", "grok", "agy"]) {
      await fs.writeFile(path.join(fakeBin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${FAKE_LLM}" %*\r\n`);
    }
  } else {
    for (const name of ["codex", "claude", "grok", "agy"]) {
      await fs.writeFile(
        path.join(fakeBin, name),
        `#!/usr/bin/env bash\nexec ${shellQuote(process.execPath)} ${shellQuote(FAKE_LLM)} "$@"\n`,
        { mode: 0o755 }
      );
    }
  }
  const old = process.env.LLM_ROUTER_MCP_PATH_PREFIX;
  process.env.LLM_ROUTER_MCP_PATH_PREFIX = fakeBin;
  t.after(() => {
    if (old === undefined) {
      delete process.env.LLM_ROUTER_MCP_PATH_PREFIX;
    } else {
      process.env.LLM_ROUTER_MCP_PATH_PREFIX = old;
    }
  });
  return fakeBin;
}

// The shim npm writes for a package's bin entry.
export function npmShim(relativeScript) {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relativeScript}" %*`,
    ""
  ].join("\r\n");
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}
