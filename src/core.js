import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const IS_WINDOWS = process.platform === "win32";

// Each CLI runs with one of two permission levels (LLM_ROUTER_MCP_PERMISSIONS):
// "full" (the default) lets it use any tool without asking, because a task sent
// through the MCP may need shell commands, edits, or the network; "scoped"
// only lets it read the prompt file and write the answer file, and denies the
// rest without asking. Neither level ever waits for an approval on screen.
export const PROVIDERS = {
  codex: {
    id: "codex",
    displayName: "Codex",
    envName: "CODEX",
    executable: "codex",
    defaultSessionName: "codex-mcp",
    defaultModel: "",
    supportsModelFlag: true,
    // ConPTY hands pasted text to Codex as keystrokes; a one-line pointer to the
    // prompt file is the only input that cannot be split or left unsubmitted.
    defaultInputMode: IS_WINDOWS ? "file" : "paste",
    readyPattern: /^[ \t]*›(?![ \t]*\d+\.)/m,
    tmuxArgs(model, { requestDir, permissions }) {
      return [
        "codex",
        ...(model ? ["-m", model] : []),
        // The alternate screen leaves no tmux scrollback.
        "--no-alt-screen",
        // The update prompt would take the first request as its answer.
        "-c",
        "check_for_update_on_startup=false",
        // tmux-windows runs panes in a Job Object without breakaway, so Codex
        // cannot detach its shared app-server daemon there.
        ...(IS_WINDOWS ? ["--no-daemon"] : []),
        ...(permissions === "full"
          ? ["--dangerously-bypass-approvals-and-sandbox"]
          : ["--ask-for-approval", "never", "--add-dir", requestDir])
      ];
    },
    headless({ model, outputPath, permissions }) {
      return {
        args: [
          "exec",
          ...(model ? ["-m", model] : []),
          ...(permissions === "full" ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
          "--skip-git-repo-check",
          "--ephemeral",
          "--color",
          "never",
          "--output-last-message",
          outputPath,
          "-"
        ],
        stdin: true,
        outputPath
      };
    }
  },
  claude: {
    id: "claude",
    displayName: "Claude",
    envName: "CLAUDE",
    executable: "claude",
    defaultSessionName: "claude-mcp",
    defaultModel: "sonnet",
    supportsModelFlag: true,
    // Claude Code handles bracketed paste on every platform.
    defaultInputMode: "paste",
    readyPattern: /⏵⏵|\? for shortcuts|shift\+tab to cycle/i,
    tmuxArgs(model, { requestDir, permissions }) {
      return [
        "claude",
        ...(model ? ["--model", model] : []),
        ...(permissions === "full"
          ? ["--dangerously-skip-permissions"]
          : ["--permission-mode", "dontAsk", "--allowedTools", "Write,Edit"]),
        // The prompt and answer files live outside the workspace.
        "--add-dir",
        requestDir
      ];
    },
    headless({ model, permissions }) {
      return {
        args: [
          "-p",
          "--output-format",
          "text",
          ...(permissions === "full"
            ? ["--dangerously-skip-permissions"]
            : ["--permission-mode", "dontAsk"]),
          "--no-session-persistence",
          ...(model ? ["--model", model] : [])
        ],
        stdin: true
      };
    }
  },
  grok: {
    id: "grok",
    displayName: "Grok",
    envName: "GROK",
    executable: "grok",
    defaultSessionName: "grok-mcp",
    defaultModel: "",
    supportsModelFlag: true,
    // Under ConPTY newlines inside a paste reach Grok as Enter and split the
    // request into several messages.
    defaultInputMode: IS_WINDOWS ? "file" : "paste",
    // An empty input line: ">" or "❯", boxed unless --minimal.
    readyPattern: /^[ \t]*(?:│[ \t]*)?[>❯][ \t]*(?:│[ \t]*)?$/m,
    tmuxArgs(model, { permissions }) {
      return [
        "grok",
        "--no-alt-screen",
        // The default renderer redraws its own viewport and leaves no tmux
        // scrollback; minimal mode prints finished blocks to scrollback.
        "--minimal",
        ...(model ? ["-m", model] : []),
        ...(permissions === "full"
          ? ["--permission-mode", "bypassPermissions"]
          : ["--permission-mode", "dontAsk", "--allow", "Write", "--allow", "Edit"])
      ];
    },
    headless({ model, promptPath, permissions }) {
      return {
        args: [
          ...(model ? ["-m", model] : []),
          "--prompt-file",
          promptPath,
          "--output-format",
          "plain",
          "--permission-mode",
          permissions === "full" ? "bypassPermissions" : "dontAsk",
          "--max-turns",
          "80",
          "--no-memory"
        ],
        stdin: false
      };
    }
  },
  antigravity: {
    id: "antigravity",
    displayName: "Antigravity",
    envName: "ANTIGRAVITY",
    executable: "agy",
    defaultSessionName: "antigravity-mcp",
    defaultModel: "",
    supportsModelFlag: true,
    defaultInputMode: IS_WINDOWS ? "file" : "paste",
    readyPattern: /\? for shortcuts/i,
    tmuxArgs(model, { requestDir, permissions }) {
      return [
        "agy",
        ...(model ? ["--model", model] : []),
        // Without it agy asks before touching files outside its workspace.
        "--add-dir",
        requestDir,
        ...(permissions === "full" ? ["--dangerously-skip-permissions"] : ["--mode", "accept-edits"])
      ];
    },
    headless({ model, prompt, promptPath, timeoutMs, argvPromptOk, permissions }) {
      const args = [
        "--print-timeout",
        durationForAgy(timeoutMs),
        ...(model ? ["--model", model] : []),
        ...(permissions === "full" ? ["--dangerously-skip-permissions"] : [])
      ];
      // agy --print takes the prompt as its value and does not read stdin.
      if (argvPromptOk && quotedArgLength(prompt) <= AGY_MAX_ARGV_PROMPT_CHARS && !prompt.includes("\0")) {
        args.push(`--print=${prompt}`);
      } else {
        args.push("--add-dir", path.dirname(promptPath), `--print=${filePointerLine(promptPath)}`);
      }
      return { args, stdin: false };
    }
  }
};

export const PERMISSION_LEVELS = ["full", "scoped"];
export const OUTPUT_MODES = ["file", "pane"];

export function resolvePermissions() {
  const level = process.env.LLM_ROUTER_MCP_PERMISSIONS || "full";
  if (!PERMISSION_LEVELS.includes(level)) {
    throw new LlmRouterError(`LLM_ROUTER_MCP_PERMISSIONS must be one of: ${PERMISSION_LEVELS.join(", ")}`, {
      permissions: level
    });
  }
  return level;
}

export const PROVIDER_ALIASES = {
  agy: "antigravity",
  google: "antigravity",
  gemini: "antigravity",
  gpt: "codex",
  openai: "codex",
  xai: "grok"
};

export const INPUT_MODES = ["paste", "file"];

const DEFAULT_CAPTURE_LINES = 4000;
// A wait for an answer runs in windows: at the end of one it goes on for
// another while the CLI is still visibly working, up to a total cap, and stops
// early when the screen has not changed for the stall time. The cap stays under
// the 30 minutes MCP clients are usually given for one tool call.
const DEFAULT_TIMEOUT_MS = 600000;
const DEFAULT_MAX_WAIT_MS = 1500000;
const DEFAULT_STALL_MS = 300000;
// Headless CLIs print nothing while they work, so only the cap applies.
const DEFAULT_HEADLESS_TIMEOUT_MS = DEFAULT_MAX_WAIT_MS;
const DEFAULT_POLL_MS = 300;
const DEFAULT_READY_TIMEOUT_MS = 60000;
const DEFAULT_COLUMNS = 160;
const DEFAULT_ROWS = 50;
const AGY_MAX_ARGV_PROMPT_CHARS = 24000;
const SUBMIT_RETRIES = 2;
const PROGRESS_INTERVAL_MS = 5000;
// Node's setTimeout fires at once for anything longer.
const MAX_TIMEOUT_MS = 2147483647;
// tmux client calls; a busy tmux-windows server can take seconds to answer.
const TMUX_TIMEOUT_MS = 15000;
// Lines at the bottom of the screen where a CLI draws its input prompt.
const READY_LINES = 12;
// How long a session that was already running may take to look ready.
const REATTACH_TIMEOUT_MS = 15000;

// Variables that tie a process to the Claude Code session that launched the
// MCP server. Provider CLIs started from here must not inherit them.
const HOST_SESSION_ENV = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_HOST_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
  "CLAUDE_CODE_TERMINAL_MCP_TOOLS",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_DESKTOP_APP_VERSION",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_PID"
]);

// Startup screens that would swallow the first request. `choose` dialogs are
// answered by moving the selection to the matching option; `keys` dialogs by
// sending those keys; the others need the user.
const STARTUP_DIALOGS = [
  { kind: "trust", test: /Do you trust the contents of this project\?/i, choose: /Yes, I trust/i },
  { kind: "trust", test: /Yes, I trust this folder/i, choose: /Yes, I trust this folder/i },
  { kind: "trust", test: /Do you trust the files in this folder\?/i, choose: /Yes, proceed/i },
  { kind: "trust", test: /Trust this folder\?/i, choose: /Trust and continue/i },
  {
    kind: "trust",
    test: /Do you trust the contents of this directory\?[\s\S]*Yes, continue/i,
    choose: /Yes, continue/i
  },
  {
    kind: "trust",
    test: /Do you trust the contents of this directory\?[\s\S]*Yes, proceed/i,
    keys: ["y"]
  },
  { kind: "update", test: /Update available[\s\S]*\bSkip\b/i, keys: ["Escape"] },
  // Shown the first time Claude Code runs with --dangerously-skip-permissions,
  // which the router passes on purpose.
  { kind: "notice", test: /Bypass Permissions mode/i, choose: /Yes, I accept/i },
  // The fullscreen renderer would leave no scrollback to read answers from.
  { kind: "notice", test: /Try the new fullscreen renderer\?/i, choose: /Not now/i },
  { kind: "onboarding", test: /Choose the text style that looks best/i },
  {
    kind: "login",
    test: /Select login method|Please log ?in|Log ?in to continue|Sign ?in with|not logged in|Authenticate with/i
  },
  // Unknown variants: never type a request into them.
  { kind: "trust", test: /Do you trust\b|\btrust (?:this|the) (?:folder|directory|project|workspace)\?/i }
];

// Questions a CLI asks while it works (tool permissions, menus); text typed
// while one is open would answer it. Only the shape of a menu counts, because
// answers use the same phrases ("Do you want to proceed?").
// "❯ 1. Yes" style, or Grok's "3 (•) Yes" radio buttons.
const MENU_SELECTED =
  /^[ \t]*(?:│[ \t]*)?(?:[❯›>▸●][ \t]*\d+\.[ \t]+\S|\d+[ \t]+\([•●]\)[ \t]+\S)/;
const MENU_OPTION =
  /^[ \t]*(?:│[ \t]*)?(?:(?:[❯›>▸●][ \t]*)?\d+\.[ \t]+\S|\d+[ \t]+\([○•●]\)[ \t]+\S)/;
const PENDING_PROMPT_YES_NO = /\((?:y\/n|Y\/n|y\/N)\)[ \t]*$/;

const sessionLocks = new Map();
const executableCache = new Map();
// Headless CLIs still running, so a shutting-down server can end them.
const liveChildren = new Map();

export class LlmRouterError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "LlmRouterError";
    this.details = details;
  }
}

export function listProviders() {
  return Object.values(PROVIDERS).map((provider) => {
    try {
      return describeProvider(provider);
    } catch (error) {
      // A bad LLM_ROUTER_MCP_<P>_MODEL must not hide the other providers.
      return { id: provider.id, displayName: provider.displayName, error: error.message };
    }
  });
}

function describeProvider(provider) {
  return {
    id: provider.id,
    displayName: provider.displayName,
    aliases: Object.keys(PROVIDER_ALIASES).filter((alias) => PROVIDER_ALIASES[alias] === provider.id),
    executable: provider.executable,
    defaultSessionName: provider.defaultSessionName,
    defaultModel: resolveModel(provider.id) || "CLI default/latest",
    supportsModelFlag: provider.supportsModelFlag,
    defaultInputMode: resolveInputMode(provider.id),
    defaultTmuxCommand: buildTmuxCommand(provider.id),
    headlessAvailable: true
  };
}

export async function checkProviders() {
  const env = childEnv();
  let tmux;
  try {
    tmux = { available: true, version: await tmuxVersion(), path: findExecutable("tmux", env) };
  } catch (error) {
    tmux = { available: false, error: error.message, path: findExecutable("tmux", env) };
  }
  return {
    platform: process.platform,
    tmux,
    providers: Object.values(PROVIDERS).map((provider) => {
      const resolvedPath = findExecutable(provider.executable, env);
      return {
        id: provider.id,
        executable: provider.executable,
        available: resolvedPath !== null,
        path: resolvedPath
      };
    })
  };
}

export function normalizeProvider(provider) {
  const raw = String(provider || "").trim().toLowerCase();
  const id = PROVIDER_ALIASES[raw] || raw;
  if (!PROVIDERS[id]) {
    throw new LlmRouterError("provider must be one of: codex, claude, grok, antigravity", {
      provider
    });
  }
  return id;
}

export function providerConfig(provider) {
  return PROVIDERS[normalizeProvider(provider)];
}

export function defaultStateDir() {
  return (
    process.env.LLM_ROUTER_MCP_STATE_DIR ||
    path.join(os.homedir(), ".local", "state", "llm-router-mcp")
  );
}

export function defaultWorkDir(provider, stateDir = defaultStateDir()) {
  const config = providerConfig(provider);
  return path.join(path.resolve(stateDir), "workdirs", config.id);
}

export function makeNonce() {
  return crypto.randomUUID();
}

export function markerSet(provider, nonce) {
  const config = providerConfig(provider);
  validateNonce(nonce);
  return {
    nonce,
    startMarker: `${config.envName}_TMUX_STARTED:${nonce}`,
    doneMarker: `${config.envName}_TMUX_DONE:${nonce}`,
    startPrefix: `${config.envName}_TMUX_STARTED:`,
    donePrefix: `${config.envName}_TMUX_DONE:`
  };
}

export function validateNonce(nonce) {
  // No "." or ":": a marker must end where its nonce ends, and the nonce names
  // files on case-folding, colon-hostile file systems.
  if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{6,96}$/.test(nonce)) {
    throw new LlmRouterError(
      "nonce must be 6-96 chars and contain only letters, numbers, underscore, or dash",
      { nonce }
    );
  }
}

export function validateSessionName(sessionName) {
  // tmux turns "." and ":" in session names into "_", so names with them could
  // never be found again.
  if (typeof sessionName !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(sessionName)) {
    throw new LlmRouterError(
      "sessionName must be 1-120 chars and contain only letters, numbers, underscore, or dash",
      { sessionName }
    );
  }
}

export function normalizeTimeout(timeoutMs, fallback = DEFAULT_TIMEOUT_MS) {
  if (timeoutMs === undefined || timeoutMs === null) {
    return fallback;
  }
  const parsed = Number(timeoutMs);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new LlmRouterError("timeoutMs must be a positive number", { timeoutMs });
  }
  return Math.min(Math.trunc(parsed), MAX_TIMEOUT_MS);
}

export function normalizeDimension(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 20) {
    throw new LlmRouterError("terminal dimensions must be numbers >= 20", { value });
  }
  return Math.trunc(parsed);
}

export function resolveModel(provider, requestedModel) {
  const config = providerConfig(provider);
  const envModel = process.env[`LLM_ROUTER_MCP_${config.envName}_MODEL`];
  const model = requestedModel ?? envModel ?? config.defaultModel;
  const value = typeof model === "string" ? model.trim() : "";
  // The model reaches command lines, including cmd.exe ones.
  if (value && !/^[A-Za-z0-9][A-Za-z0-9._:@/+\[\]-]{0,127}$/.test(value)) {
    throw new LlmRouterError("model may contain only letters, numbers, and . _ : @ / + - [ ]", {
      model
    });
  }
  return value;
}

export function resolveInputMode(provider, requestedMode) {
  const config = providerConfig(provider);
  const mode =
    requestedMode ||
    process.env[`LLM_ROUTER_MCP_${config.envName}_INPUT_MODE`] ||
    process.env.LLM_ROUTER_MCP_INPUT_MODE ||
    config.defaultInputMode;
  if (!INPUT_MODES.includes(mode)) {
    throw new LlmRouterError(`inputMode must be one of: ${INPUT_MODES.join(", ")}`, {
      inputMode: mode
    });
  }
  return mode;
}

export function resolveOutputMode(provider, requestedMode) {
  const config = providerConfig(provider);
  const mode =
    requestedMode ||
    process.env[`LLM_ROUTER_MCP_${config.envName}_OUTPUT_MODE`] ||
    process.env.LLM_ROUTER_MCP_OUTPUT_MODE ||
    "file";
  if (!OUTPUT_MODES.includes(mode)) {
    throw new LlmRouterError(`outputMode must be one of: ${OUTPUT_MODES.join(", ")}`, {
      outputMode: mode
    });
  }
  return mode;
}

export function buildTmuxArgv(provider, model, stateDir = defaultStateDir()) {
  const config = providerConfig(provider);
  return config.tmuxArgs(config.supportsModelFlag ? resolveModel(config.id, model) : "", {
    requestDir: requestDirFor(config.id, stateDir),
    permissions: resolvePermissions()
  });
}

function requestDirFor(provider, stateDir) {
  return path.join(path.resolve(stateDir), "requests", provider);
}

export function buildTmuxCommand(provider, model) {
  return resolveLaunch(provider, { model }).display;
}

function resolveLaunch(provider, { command, model, stateDir } = {}) {
  const config = providerConfig(provider);
  const custom = command ?? process.env[`LLM_ROUTER_MCP_${config.envName}_CMD`];
  if (Array.isArray(custom)) {
    if (custom.length === 0 || custom.some((part) => typeof part !== "string" || part === "")) {
      throw new LlmRouterError("command must be a non-empty string or a list of non-empty strings", {
        command
      });
    }
    return { argv: custom, display: custom.map(shellQuote).join(" "), custom: true };
  }
  if (typeof custom === "string" && custom.trim()) {
    // One argument: tmux runs it through its default-shell.
    return { argv: [custom], display: custom, custom: true };
  }
  const argv = buildTmuxArgv(provider, model, stateDir);
  return { argv, display: argv.map(shellQuote).join(" "), custom: false };
}

export async function runCommand(command, args = [], options = {}) {
  const timeoutMs = normalizeTimeout(options.timeoutMs, 15000);
  const env = childEnv(options.env);
  const launch = resolveSpawn(command, args, env);
  const groupKill = Boolean(options.killTree) && !IS_WINDOWS;
  const startedAt = Date.now();

  if (options.signal?.aborted) {
    throw new LlmRouterError("request was cancelled", { command, args, cancelled: true });
  }

  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(launch.command, launch.args, {
        cwd: options.cwd,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        windowsVerbatimArguments: launch.verbatim,
        detached: groupKill
      });
    } catch (error) {
      reject(
        new LlmRouterError(`failed to run command: ${command}`, {
          command,
          args,
          cause: error.message
        })
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    if (options.killTree) {
      // Until it exits, not until we stop waiting: a killed process group may
      // ignore SIGTERM, and a shutdown must still find it.
      liveChildren.set(child, groupKill);
      child.on("close", () => liveChildren.delete(child));
    }

    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };

    const timer = setTimeout(() => {
      finish(() => {
        killProcessTree(child, groupKill);
        reject(
          new LlmRouterError(`command timed out after ${timeoutMs}ms`, {
            command,
            args,
            stdout,
            stderr,
            timedOut: true,
            elapsedMs: Date.now() - startedAt
          })
        );
      });
    }, timeoutMs);

    const onAbort = () => {
      finish(() => {
        killProcessTree(child, groupKill);
        reject(
          new LlmRouterError("request was cancelled", {
            command,
            args,
            stdout,
            stderr,
            cancelled: true,
            elapsedMs: Date.now() - startedAt
          })
        );
      });
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    // A child that exits without reading its input closes the pipe early.
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      finish(() => {
        reject(
          new LlmRouterError(`failed to run command: ${command}`, {
            command,
            args,
            cause: error.message,
            ...(error.code === "ENOENT" ? { hint: `${command} was not found on PATH` } : {})
          })
        );
      });
    });
    child.on("close", (code, signal) => {
      finish(() => {
        const result = {
          command,
          args,
          code,
          signal,
          stdout,
          stderr,
          elapsedMs: Date.now() - startedAt
        };
        if (code !== 0 && !options.allowFailure) {
          const reason = stderr.trim().split("\n")[0];
          reject(
            new LlmRouterError(
              `command failed: ${command} ${args.join(" ")}${reason ? `: ${reason}` : ""}`,
              { ...result }
            )
          );
          return;
        }
        resolve(result);
      });
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}

export async function runTmux(args, options = {}) {
  return await runCommand("tmux", [...tmuxGlobalArgs(), ...args], options);
}

export async function tmuxVersion() {
  const result = await runCommand("tmux", ["-V"]);
  return result.stdout.trim();
}

export async function hasSession(options = {}) {
  const sessionName = resolveSessionName(options.provider, options.sessionName);
  validateSessionName(sessionName);
  const result = await runTmux(["has-session", "-t", sessionTarget(sessionName)], {
    allowFailure: true,
    timeoutMs: TMUX_TIMEOUT_MS
  });
  return result.code === 0;
}

export async function killSession(options = {}) {
  const sessionName = resolveSessionName(options.provider, options.sessionName);
  validateSessionName(sessionName);
  const result = await runTmux(["kill-session", "-t", sessionTarget(sessionName)], {
    allowFailure: true,
    timeoutMs: TMUX_TIMEOUT_MS
  });
  return result.code === 0;
}

export async function ensureSession(options = {}) {
  const sessionName = resolveSessionName(options.provider, options.sessionName);
  validateSessionName(sessionName);
  return await withSessionLock(sessionKey(sessionName), () => openSession(options));
}

// ensureSession without the session lock, for callers that hold it.
async function openSession(options) {
  const provider = normalizeProvider(options.provider);
  const config = providerConfig(provider);
  const sessionName = resolveSessionName(provider, options.sessionName);
  validateSessionName(sessionName);
  const stateDir = path.resolve(options.stateDir || defaultStateDir());
  const timeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_READY_TIMEOUT_MS);
  const columns = normalizeDimension(options.columns, DEFAULT_COLUMNS);
  const rows = normalizeDimension(options.rows, DEFAULT_ROWS);

  throwIfAborted(options.signal);
  await tmuxVersion();

  let info = await paneInfo(sessionName);
  let replacedDeadSession = null;
  if (info?.dead) {
    replacedDeadSession = {
      exitStatus: info.deadStatus,
      paneTail: tailLines(bottomLines(await safeCapture(sessionName, 200), 200), 60)
    };
    await killSession({ provider, sessionName });
    info = null;
  }

  let created = false;
  let launch = null;
  let modelMismatch = null;
  if (info === null) {
    const envCwd = process.env[`LLM_ROUTER_MCP_${config.envName}_CWD`];
    const cwd = path.resolve(
      options.cwd || envCwd || (await ensureDefaultWorkDir(provider, stateDir))
    );
    // Only the router's own scratch workdir is trusted without asking, and
    // for Codex only when it is its own git root (Codex trusts the repository).
    const managed =
      !options.cwd &&
      !envCwd &&
      (provider !== "codex" || (await pathExists(path.join(cwd, ".git"))));
    const trust = options.trustCwd ?? managed;
    launch = resolveLaunch(provider, { ...options, stateDir });
    await ensurePrivateDir(requestDirFor(provider, stateDir));
    if (!(await pathExists(cwd))) {
      throw new LlmRouterError(`cwd does not exist: ${cwd}`, { provider, sessionName, cwd });
    }
    const target = paneTarget(sessionName);
    try {
      await runTmux(
        [
          "new-session",
          "-d",
          "-x",
          String(columns),
          "-y",
          String(rows),
          "-s",
          sessionName,
          "-c",
          cwd,
          ...(await hostEnvOverrides()),
          "--",
          ...launch.argv,
          ";",
          // Keep a pane whose CLI exits so its last output (an error, a login
          // request) can still be read.
          "set-option",
          "-w",
          "-t",
          target,
          "remain-on-exit",
          "on",
          ";",
          // Later calls (also from other MCP server processes) act on how the
          // session was started, not on their own options.
          "set-option",
          "-t",
          target,
          "@llm_router_trust",
          trust ? "1" : "0",
          ";",
          "set-option",
          "-t",
          target,
          "@llm_router_cwd",
          cwd,
          ";",
          "set-option",
          "-t",
          target,
          "@llm_router_model",
          launch.custom ? "" : resolveModel(provider, options.model),
          ";",
          "set-option",
          "-t",
          target,
          "@llm_router_command",
          launch.display,
          ";",
          "set-option",
          "-t",
          target,
          "@llm_router_custom",
          launch.custom ? "1" : "0",
          ";",
          "set-option",
          "-t",
          target,
          "@llm_router_requests",
          requestDirFor(provider, stateDir)
        ],
        { timeoutMs: TMUX_TIMEOUT_MS }
      );
      created = true;
    } catch (error) {
      // Another MCP server process created it first; follow its record.
      if (!/duplicate session/i.test(error.message)) {
        throw error;
      }
      launch = null;
    }
    info = await paneInfo(sessionName);
    if (!info) {
      throw new LlmRouterError(`tmux session ${sessionName} disappeared right after it was created`, {
        provider,
        sessionName
      });
    }
  } else if (options.model !== undefined && info.custom === "0") {
    const requested = resolveModel(provider, options.model);
    if (requested !== info.model) {
      modelMismatch = { requested: requested || "CLI default/latest", running: info.model || "CLI default/latest" };
    }
  }

  // The trust answer is decided by how the session was started; a call can
  // only widen it by asking explicitly.
  const trustCwd = options.trustCwd === true || info.trust === "1";
  // Sessions started with a custom command have no known input prompt. One
  // without a record (an older router version, or started by hand) is taken
  // to run the built-in CLI unless this call names a command.
  const custom = launch
    ? launch.custom
    : info.custom
      ? info.custom !== "0"
      : Boolean(options.command ?? process.env[`LLM_ROUTER_MCP_${config.envName}_CMD`]);
  // A session that has shown its input prompt once is past its startup
  // screens; what it shows now is conversation. One that never got there (a
  // start that was cancelled or blocked) is still treated as starting.
  const readiness =
    info.ready === "1"
      ? { ready: true, actions: [], paneText: "" }
      : await waitUntilReady({
          sessionName,
          // The full time for a start the router began (perhaps in a call that
          // was cancelled); a short look at a session it knows nothing about.
          timeoutMs: created || info.custom ? timeoutMs : Math.min(timeoutMs, REATTACH_TIMEOUT_MS),
          readyPattern: readyPatternFor(config, custom),
          trustCwd,
          signal: options.signal
        });

  if (readiness.ready && info.ready !== "1") {
    await runTmux(["set-option", "-t", paneTarget(sessionName), "@llm_router_ready", "1"], {
      allowFailure: true,
      timeoutMs: TMUX_TIMEOUT_MS
    });
  }

  const paneText = readiness.paneText || (await safeCapture(sessionName, 80));
  return {
    provider,
    sessionName,
    command: launch ? launch.display : info.command,
    cwd: info.cwd,
    requestDir: info.requestDir,
    created,
    running: !readiness.ended && !readiness.dead,
    ready: readiness.ready,
    blocker: readiness.blocker || null,
    exitStatus: readiness.exitStatus ?? null,
    timedOut: Boolean(readiness.timedOut),
    cancelled: Boolean(readiness.cancelled),
    custom,
    dialogsAnswered: readiness.actions,
    modelMismatch,
    replacedDeadSession,
    attachCommand: attachCommand(sessionName),
    columns,
    rows,
    paneTail: tailLines(paneText, 80)
  };
}



export async function capturePane(options = {}) {
  const provider = normalizeProvider(options.provider);
  const sessionName = resolveSessionName(provider, options.sessionName);
  const lines = Math.max(1, Math.trunc(Number(options.lines || DEFAULT_CAPTURE_LINES)));

  validateSessionName(sessionName);
  return await capturePaneText(sessionName, lines);
}

export async function writeInputFile(options = {}) {
  const provider = options.provider ? normalizeProvider(options.provider) : "shared";
  const markdown = options.markdown;
  if (typeof markdown !== "string" || markdown.length === 0) {
    throw new LlmRouterError("markdown must be a non-empty string");
  }

  const stateDir = path.resolve(options.stateDir || defaultStateDir());
  const inputDir = path.join(stateDir, "inputs", provider);
  await ensurePrivateDir(inputDir);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const requestedName = options.filename
    ? path.basename(options.filename)
    : `${timestamp}-${crypto.randomBytes(4).toString("hex")}.md`;
  const safeName = requestedName.replace(/[^A-Za-z0-9_.-]/g, "_");
  const filename = /\.(md|markdown)$/i.test(safeName) ? safeName : `${safeName}.md`;
  const inputPath = path.join(inputDir, filename);

  await writePrivateFile(inputPath, markdown);
  return { inputPath, bytes: Buffer.byteLength(markdown, "utf8") };
}

export async function sendInput(options = {}) {
  const provider = normalizeProvider(options.provider);
  const config = providerConfig(provider);
  const sessionName = resolveSessionName(provider, options.sessionName);
  const stateDir = path.resolve(options.stateDir || defaultStateDir());
  const timeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const nonce = options.nonce || makeNonce();
  const { startMarker, doneMarker } = markerSet(provider, nonce);
  const inputMode = resolveInputMode(provider, options.inputMode);
  const outputMode = resolveOutputMode(provider, options.outputMode);

  validateSessionName(sessionName);
  const inputPath = path.resolve(requireInputPath(options.inputPath));
  validateMarkdownPath(inputPath);
  const markdown = await fs.readFile(inputPath, "utf8");
  if (markdown.includes(startMarker) || markdown.includes(doneMarker)) {
    throw new LlmRouterError(
      "input file already contains the generated nonce markers; pass a different nonce",
      { inputPath, nonce }
    );
  }

  return await withSessionLock(sessionKey(sessionName), async () => {
    throwIfAborted(options.signal);
    const session = await openSession({
      provider,
      sessionName,
      command: options.command,
      cwd: options.cwd,
      // timeoutMs is for the answer; starting gets its own minute.
      timeoutMs: DEFAULT_READY_TIMEOUT_MS,
      stateDir,
      columns: options.columns,
      rows: options.rows,
      model: options.model,
      trustCwd: options.trustCwd,
      signal: options.signal
    });
    throwIfAborted(options.signal);
    if (!session.ready) {
      if (session.created && (session.blocker === "login" || session.blocker === "onboarding")) {
        // The router cannot finish these screens; start clean next time.
        await killSession({ provider, sessionName });
      }
      throw sessionNotReadyError(config, session);
    }
    const screen = await safeCapture(sessionName, null);
    if (hasPendingPrompt(screen, readyPatternFor(config, session.custom))) {
      throw new LlmRouterError(
        `${config.displayName} is waiting for an answer on its screen; attach with "${session.attachCommand}" and answer it, then retry.`,
        { ...session, blocker: "prompt", paneTail: tailLines(screen, 40) }
      );
    }
    if ((await safeCapture(sessionName, DEFAULT_CAPTURE_LINES)).includes(startMarker)) {
      throw new LlmRouterError("this nonce was already used in the session; pass a different nonce", {
        nonce
      });
    }

    // Where the running CLI was allowed to read and write (--add-dir), which
    // may be another state directory than this call's.
    const requestDir = session.requestDir || requestDirFor(config.id, stateDir);
    await ensurePrivateDir(requestDir);
    const answerPath = answerPathFor(requestDir, nonce);
    await fs.rm(answerPath, { force: true });

    const prompt = buildPrompt({
      provider,
      mode: "tmux",
      inputPath,
      markdown,
      nonce,
      model: options.model,
      answerPath: outputMode === "file" ? answerPath : null
    });

    if (prompt.includes(startMarker) || prompt.includes(doneMarker)) {
      throw new LlmRouterError(
        "internal prompt unexpectedly contains full markers before the model can emit them",
        { provider, nonce }
      );
    }

    const promptPath = path.join(requestDir, `${safeFilePart(nonce)}.prompt.md`);
    await writePrivateFile(promptPath, prompt);

    let pastePath = promptPath;
    if (inputMode === "file") {
      pastePath = path.join(requestDir, `${safeFilePart(nonce)}.line.txt`);
      await writePrivateFile(pastePath, filePointerLine(promptPath));
    }

    const submitted = await submitToTmux({
      sessionName,
      pastePath,
      nonce,
      startMarker,
      doneMarker,
      signal: options.signal
    });

    return {
      provider,
      sessionName,
      nonce,
      inputPath,
      promptPath,
      inputMode,
      outputMode,
      answerPath: outputMode === "file" ? answerPath : null,
      startMarker,
      doneMarker,
      sent: true,
      submitAttempts: submitted.attempts,
      sessionCreated: session.created,
      dialogsAnswered: session.dialogsAnswered,
      ...(session.modelMismatch
        ? {
            modelMismatch: session.modelMismatch,
            warning: `the session runs ${session.modelMismatch.running}; kill it or use another sessionName to change the model`
          }
        : {}),
      attachCommand: session.attachCommand,
      sentAt: new Date().toISOString()
    };
  });
}

export async function waitForResponse(options = {}) {
  const provider = normalizeProvider(options.provider);
  const config = providerConfig(provider);
  const sessionName = resolveSessionName(provider, options.sessionName);
  const windowMs = normalizeTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const maxWaitMs = Math.max(windowMs, normalizeTimeout(options.maxWaitMs, DEFAULT_MAX_WAIT_MS));
  const stallMs = normalizeTimeout(
    options.stallMs ?? process.env.LLM_ROUTER_MCP_STALL_MS,
    DEFAULT_STALL_MS
  );
  const pollMs = normalizeTimeout(options.pollMs, DEFAULT_POLL_MS);
  const { nonce, startMarker, doneMarker } = markerSet(
    provider,
    requireNonce(options.nonce)
  );
  const stateDir = path.resolve(options.stateDir || defaultStateDir());
  const captureLines = options.captureLines || DEFAULT_CAPTURE_LINES;
  const startedAt = Date.now();
  const hardDeadline = startedAt + maxWaitMs;
  let deadline = startedAt + windowMs;
  let extensions = 0;
  const progress = progressReporter(options.onProgress, startedAt);
  let started = false;
  let startSeenAt = null;
  let lastPane = "";
  let lastChangeAt = Date.now();
  let nextPaneCheckAt = Date.now() + PROGRESS_INTERVAL_MS;
  let promptSince = null;

  validateSessionName(sessionName);
  const sessionInfo = await paneInfo(sessionName);
  const readyPattern = readyPatternFor(config, sessionInfo?.custom !== "0");
  const answerPath = answerPathFor(
    sessionInfo?.requestDir || requestDirFor(config.id, stateDir),
    nonce
  );

  const incomplete = async (state, title, error) => {
    const fallbackPath = await writeFallbackFile({
      provider,
      stateDir,
      nonce,
      title: `${config.displayName} ${title}`,
      paneTail: lastPane,
      error
    });
    return {
      provider,
      sessionName,
      nonce,
      started,
      completed: false,
      timedOut: false,
      sessionEnded: false,
      cancelled: false,
      startMarker,
      doneMarker,
      startSeenAt,
      completedAt: null,
      answer: null,
      responsePath: null,
      fallbackPath,
      elapsedMs: Date.now() - startedAt,
      extensions,
      paneTail: tailLines(lastPane, 160),
      ...state,
      ...(error ? { error: error instanceof Error ? error.message : String(error) } : {})
    };
  };

  for (;;) {
    if (options.signal?.aborted) {
      return await incomplete({ cancelled: true }, "tmux wait was cancelled before done marker");
    }
    if (Date.now() > deadline) {
      // Still working: give it another window, up to the cap.
      if (Date.now() - lastChangeAt < stallMs && deadline < hardDeadline) {
        deadline = Math.min(deadline + windowMs, hardDeadline);
        extensions += 1;
        await progress.report(`${config.displayName} is still working; waiting longer`, true);
      } else {
        break;
      }
    }

    let pane;
    try {
      pane = await capturePaneText(sessionName, captureLines);
    } catch (error) {
      if (!(await hasSession({ provider, sessionName }))) {
        return await incomplete(
          { sessionEnded: true },
          "tmux session ended before done marker",
          error
        );
      }
      throw error;
    }
    if (pane !== lastPane) {
      lastPane = pane;
      lastChangeAt = Date.now();
    }
    const quietMs = Date.now() - lastChangeAt;

    const found = locateMarkers(pane, startMarker, doneMarker);
    if (found.started && !started) {
      started = true;
      startSeenAt = new Date().toISOString();
      await progress.report(`${config.displayName} started answering`, true);
    }

    // Markers sharing a line with other text may be a mention rather than the
    // real thing, and a done marker without a start means the start scrolled
    // out of the captured history: accept those once the pane has gone quiet.
    let completed = found.completed && (found.confident || quietMs >= 3000);
    const startLost = !found.completed && found.doneWithoutStart && quietMs >= 3000;
    // The answer file, when the model wrote one, is the answer; the pane is
    // the fallback. A written file also covers a forgotten done marker.
    let fileAnswer = completed || startLost || (started && quietMs >= 5000)
      ? await readAnswerFile(answerPath)
      : null;
    if (fileAnswer === null && (completed || startLost) && found.answer !== null && /answer written/i.test(found.answer)) {
      // The note says the file is there; give the write a moment.
      await sleep(1000);
      fileAnswer = await readAnswerFile(answerPath);
    }
    if (fileAnswer !== null && !completed && !startLost) {
      completed = true;
    }
    if (completed || startLost) {
      const answer = fileAnswer ?? (completed ? found.answer : null);
      const answerSource = fileAnswer !== null ? "file" : answer !== null ? "pane" : null;
      const response = await writeResponseFile({ provider, stateDir, nonce, answer });
      const fallbackPath = answer !== null
        ? null
        : await writeFallbackFile({
            provider,
            stateDir,
            nonce,
            title: `${config.displayName} done marker found but start marker scrolled out of history`,
            paneTail: lastPane,
            full: true
          });
      return {
        provider,
        sessionName,
        nonce,
        started: found.started || started,
        completed: true,
        timedOut: false,
        sessionEnded: false,
        cancelled: false,
        startMissing: !completed && fileAnswer === null,
        answerSource,
        answerPath: fileAnswer !== null ? answerPath : null,
        startMarker,
        doneMarker,
        startSeenAt,
        completedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt,
        extensions,
        answer,
        responsePath: response.responsePath,
        responseBytes: response.bytes,
        fallbackPath,
        paneTail: tailLines(lastPane, 120)
      };
    }

    // A question on the screen would hold the request until the timeout; hand
    // it back to the caller instead. Streaming text keeps changing, a question
    // waits.
    if (quietMs >= 2000 && hasPendingPrompt(pane, readyPattern)) {
      promptSince ??= Date.now();
      if (Date.now() - promptSince >= 1000) {
        return await incomplete(
          { blocked: "prompt", attachCommand: attachCommand(sessionName) },
          "is waiting for an answer on its screen before done marker"
        );
      }
    } else {
      promptSince = null;
    }

    // A working TUI animates a spinner or a timer; a screen frozen this long
    // belongs to a CLI that is stuck, not busy.
    if (quietMs >= stallMs) {
      return await incomplete(
        { stalled: true, attachCommand: attachCommand(sessionName) },
        `showed no activity for ${Math.round(quietMs / 1000)}s before done marker`
      );
    }

    if (Date.now() >= nextPaneCheckAt) {
      nextPaneCheckAt = Date.now() + PROGRESS_INTERVAL_MS;
      const info = await paneInfo(sessionName);
      if (!info || info.dead) {
        return await incomplete(
          { sessionEnded: true, exitStatus: info?.deadStatus ?? null },
          info
            ? `exited (status ${info.deadStatus}) before done marker`
            : "tmux session ended before done marker"
        );
      }
      await progress.report(
        started
          ? `${config.displayName} is answering`
          : `waiting for ${config.displayName} to start`
      );
    }

    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }

  return await incomplete({ timedOut: true }, "tmux wait timed out before done marker");
}

export async function waitForStart(options = {}) {
  const provider = normalizeProvider(options.provider);
  const sessionName = resolveSessionName(provider, options.sessionName);
  const timeoutMs = normalizeTimeout(options.timeoutMs, 30000);
  const pollMs = normalizeTimeout(options.pollMs, DEFAULT_POLL_MS);
  const { nonce, startMarker, doneMarker } = markerSet(
    provider,
    requireNonce(options.nonce)
  );
  const deadline = Date.now() + timeoutMs;
  let lastPane = "";
  let previousPane = null;
  let changedAt = Date.now();
  let nextPaneCheckAt = Date.now() + PROGRESS_INTERVAL_MS;

  validateSessionName(sessionName);
  const readyPattern = readyPatternFor(
    providerConfig(provider),
    (await paneInfo(sessionName))?.custom !== "0"
  );

  const result = (state) => ({
    provider,
    sessionName,
    nonce,
    started: false,
    completed: false,
    timedOut: false,
    cancelled: false,
    sessionEnded: false,
    startMarker,
    doneMarker,
    startSeenAt: null,
    paneTail: tailLines(lastPane, 160),
    ...state
  });

  while (Date.now() <= deadline) {
    if (options.signal?.aborted) {
      return result({ cancelled: true });
    }
    try {
      lastPane = await capturePaneText(
        sessionName,
        options.captureLines || DEFAULT_CAPTURE_LINES
      );
    } catch (error) {
      if (!(await hasSession({ provider, sessionName }))) {
        return result({ sessionEnded: true, error: error.message });
      }
      throw error;
    }
    const found = locateMarkers(lastPane, startMarker, doneMarker);

    if (found.started || found.completed || found.doneWithoutStart) {
      return result({
        started: found.started,
        completed: found.completed || found.doneWithoutStart,
        startSeenAt: found.started ? new Date().toISOString() : null,
        paneTail: tailLines(lastPane, 120)
      });
    }
    if (lastPane !== previousPane) {
      previousPane = lastPane;
      changedAt = Date.now();
    }
    // A question before the start marker would hold the wait until the timeout.
    if (Date.now() - changedAt >= 3000 && hasPendingPrompt(lastPane, readyPattern)) {
      return result({ blocked: "prompt", attachCommand: attachCommand(sessionName) });
    }

    if (Date.now() >= nextPaneCheckAt) {
      nextPaneCheckAt = Date.now() + PROGRESS_INTERVAL_MS;
      const info = await paneInfo(sessionName);
      if (!info || info.dead) {
        return result({ sessionEnded: true, exitStatus: info?.deadStatus ?? null });
      }
    }

    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }

  return result({ timedOut: true });
}


export async function tmuxAsk(options = {}) {
  const sent = await sendInput(options);
  const waited = await waitForResponse({
    provider: sent.provider,
    sessionName: sent.sessionName,
    nonce: sent.nonce,
    timeoutMs: options.timeoutMs,
    maxWaitMs: options.maxWaitMs,
    stallMs: options.stallMs,
    pollMs: options.pollMs,
    captureLines: options.captureLines,
    stateDir: options.stateDir,
    onProgress: options.onProgress,
    signal: options.signal
  });
  return { ...sent, ...waited, mode: "tmux" };
}

export async function headlessAsk(options = {}) {
  const provider = normalizeProvider(options.provider);
  const config = providerConfig(provider);
  const stateDir = path.resolve(options.stateDir || defaultStateDir());
  const timeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_HEADLESS_TIMEOUT_MS);
  const nonce = options.nonce || makeNonce();
  const { startMarker, doneMarker } = markerSet(provider, nonce);
  const input =
    options.inputPath !== undefined
      ? { inputPath: path.resolve(requireInputPath(options.inputPath)) }
      : await writeInputFile({
          provider,
          markdown: options.markdown,
          filename: options.filename,
          stateDir
        });
  const inputPath = input.inputPath;
  validateMarkdownPath(inputPath);

  const markdown = await fs.readFile(inputPath, "utf8");
  const prompt = buildPrompt({
    provider,
    mode: "headless",
    inputPath,
    markdown,
    nonce,
    model: options.model
  });
  if (prompt.includes(startMarker) || prompt.includes(doneMarker)) {
    throw new LlmRouterError(
      "internal prompt unexpectedly contains full markers before the model can emit them",
      { provider, nonce }
    );
  }

  const requestDir = path.join(stateDir, "requests", config.id);
  const responseDir = path.join(stateDir, "responses", config.id);
  await ensurePrivateDir(requestDir);
  await ensurePrivateDir(responseDir);
  const promptPath = path.join(requestDir, `${safeFilePart(nonce)}.headless.prompt.md`);
  await writePrivateFile(promptPath, prompt);

  const cwd =
    options.cwd ||
    process.env[`LLM_ROUTER_MCP_${config.envName}_CWD`] ||
    (await ensureDefaultWorkDir(provider, stateDir));
  if (!(await pathExists(cwd))) {
    throw new LlmRouterError(`cwd does not exist: ${cwd}`, { provider, cwd });
  }
  const model = resolveModel(provider, options.model);
  const run = await runHeadlessProvider({
    provider,
    model,
    prompt,
    promptPath,
    outputPath: path.join(responseDir, `${safeFilePart(nonce)}.last-message.md`),
    cwd,
    timeoutMs,
    signal: options.signal
  });

  const raw = await writeRawResponseFile({
    provider,
    stateDir,
    nonce,
    stdout: run.stdout,
    stderr: run.stderr,
    code: run.code
  });
  const output = await readHeadlessOutput(run);
  const found = locateMarkers(output, startMarker, doneMarker, { raw: true });
  const answer = run.code === 0 ? headlessAnswer(output, startMarker, doneMarker) : null;
  const response = await writeResponseFile({ provider, stateDir, nonce, answer });

  return {
    provider,
    mode: "headless",
    nonce,
    inputPath,
    promptPath,
    startMarker,
    doneMarker,
    cwd,
    model: model || "CLI default/latest",
    command: run.command,
    args: run.args.map(summarizeArg),
    exitCode: run.code,
    success: run.code === 0,
    timedOut: Boolean(run.timedOut),
    cancelled: Boolean(run.cancelled),
    markersFound: found.completed,
    elapsedMs: run.elapsedMs,
    answer,
    responsePath: response.responsePath,
    responseBytes: response.bytes,
    rawResponsePath: raw.rawResponsePath,
    rawResponseBytes: raw.bytes,
    stderr: run.stderr.trim() || null
  };
}

export async function status(options = {}) {
  const provider = normalizeProvider(options.provider);
  const sessionName = resolveSessionName(provider, options.sessionName);
  validateSessionName(sessionName);
  const info = await paneInfo(sessionName);
  let markerStatus = null;
  let paneTail = "";

  if (info) {
    paneTail = await capturePaneText(sessionName, options.lines || 160);
    if (options.nonce) {
      const { startMarker, doneMarker } = markerSet(provider, options.nonce);
      const found = locateMarkers(paneTail, startMarker, doneMarker);
      markerStatus = {
        nonce: options.nonce,
        started: found.started,
        completed: found.completed,
        startMarker,
        doneMarker
      };
    }
  }

  return {
    provider,
    sessionName,
    running: Boolean(info) && !info.dead,
    exists: Boolean(info),
    exitStatus: info?.dead ? info.deadStatus : null,
    currentCommand: info?.currentCommand || null,
    attachCommand: attachCommand(sessionName),
    markerStatus,
    paneTail
  };
}

/**
 * Finds the answer between the start and done markers in pane or stdout text.
 *
 * TUIs render Markdown, so a marker can share a line with the answer when the
 * model does not leave a blank line around it, and reasoning summaries may
 * mention the markers before the real ones are printed. `confident` is false
 * when the pair found is not on lines of its own, so callers can wait for the
 * output to settle before trusting it. `raw` keeps the text as printed
 * (headless output has no TUI decoration to remove).
 */
export function locateMarkers(text, startMarker, doneMarker, { raw = false } = {}) {
  const value = String(text || "").replace(/\r/g, "");
  const starts = markerOccurrences(value, startMarker);
  const dones = markerOccurrences(value, doneMarker);
  const notFound = {
    started: starts.length > 0,
    completed: false,
    confident: false,
    doneWithoutStart: dones.length > 0 && starts.length === 0,
    answer: null
  };

  // The real start marker is normally a line of its own and comes after any
  // mention, so a later standalone start supersedes an earlier pair.
  const standaloneStarts = starts.filter((occurrence) => occurrence.standalone);
  let start;
  let done;
  if (standaloneStarts.length > 0) {
    start = standaloneStarts[standaloneStarts.length - 1];
    const after = dones.filter((occurrence) => occurrence.index > start.index);
    done = after.find((occurrence) => occurrence.standalone) || after[0];
  } else {
    done = dones.find((occurrence) => starts.some((candidate) => candidate.index < occurrence.index));
    start = done && starts.filter((candidate) => candidate.index < done.index).pop();
  }
  if (!start || !done) {
    return notFound;
  }
  return {
    started: true,
    completed: true,
    confident: start.standalone && done.standalone,
    doneWithoutStart: false,
    answer: textBetween(value, start.index + startMarker.length, done.index, raw)
  };
}

const QUOTE_CHARS = new Set(["`", '"', "'", "“", "”", "‘", "’"]);
const BULLET_ONLY = /^[\s●•⏺◆♦✦▸›>*–—-]*$/;

function markerOccurrences(text, marker) {
  const occurrences = [];
  let index = text.indexOf(marker);
  while (index !== -1) {
    const before = text[index - 1];
    const after = text[index + marker.length];
    // Skip quoted mentions and longer tokens that merely contain the marker.
    const quoted = QUOTE_CHARS.has(before) || QUOTE_CHARS.has(after);
    const embedded =
      (before !== undefined && /[A-Za-z0-9_]/.test(before)) ||
      (after !== undefined && /[A-Za-z0-9_-]/.test(after));
    if (!quoted && !embedded) {
      occurrences.push({ index, standalone: isStandaloneMarker(text, index, marker.length) });
    }
    index = text.indexOf(marker, index + marker.length);
  }
  return occurrences;
}

// Alone on its line apart from a TUI bullet, indentation, or a timestamp.
function isStandaloneMarker(text, index, length) {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const newline = text.indexOf("\n", index + length);
  const lineEnd = newline === -1 ? text.length : newline;
  return (
    BULLET_ONLY.test(text.slice(lineStart, index)) &&
    /^[\s*]*$/.test(cleanPaneLine(text.slice(index + length, lineEnd)))
  );
}

function textBetween(text, from, to, raw) {
  const trimEnd = (line) => line.replace(/[ \t]+$/, "");
  const lines = text.slice(from, to).split("\n");
  // The rest of the start marker's row: a timestamp, or the closing "**" of
  // a bold marker, is not part of the answer.
  let head = (raw ? trimEnd(lines[0]) : cleanPaneLine(lines[0])).trim();
  if (/^[*_]+$/.test(head)) {
    head = "";
  }
  if (lines.length === 1) {
    return head;
  }
  let rest = lines.slice(1).map(trimEnd);
  if (!raw) {
    rest = rest
      // Tool-call output rows a TUI draws inside the answer.
      .filter((line) => !/^[ \t]*⎿/.test(line))
      // The bullet a TUI puts before each message block, at the left edge.
      .map((line) => line.replace(/^[●⏺•✦◆♦](?=[ \t])/, " "));
  }
  // What precedes the done marker on its row, unless it is just a bullet.
  if (BULLET_ONLY.test(rest[rest.length - 1])) {
    rest[rest.length - 1] = "";
  }
  const body = raw ? rest : stripCommonIndent(rest);
  const result = head ? [head, ...body] : body;
  while (result.length && result[0].trim() === "") {
    result.shift();
  }
  while (result.length && result[result.length - 1].trim() === "") {
    result.pop();
  }
  return result.join("\n").trimEnd();
}

function headlessAnswer(output, startMarker, doneMarker) {
  const found = locateMarkers(output, startMarker, doneMarker, { raw: true });
  if (found.completed) {
    return found.answer;
  }
  // Only one marker: keep the side of it that holds the answer.
  let text = String(output || "").replace(/\r/g, "");
  const starts = markerOccurrences(text, startMarker);
  const dones = markerOccurrences(text, doneMarker);
  if (starts.length > 0) {
    text = text.slice(starts[starts.length - 1].index + startMarker.length);
  } else if (dones.length > 0) {
    text = text.slice(0, dones[0].index);
  }
  return text
    .split("\n")
    .filter((line) => {
      const bare = line.trim().replace(/^[*_]+|[*_]+$/g, "");
      return bare !== startMarker && bare !== doneMarker;
    })
    .join("\n")
    .trim();
}

function hasPendingPrompt(text, readyPattern) {
  // An idle input prompt at the bottom means nothing is waiting.
  if (readyPattern && readyPattern.test(bottomLines(text, READY_LINES))) {
    return false;
  }
  const lines = bottomLines(text, 20).split("\n");
  if (PENDING_PROMPT_YES_NO.test(lines[lines.length - 1] || "")) {
    return true;
  }
  // A selected numbered option with another numbered option next to it.
  return lines.some(
    (line, index) =>
      MENU_SELECTED.test(line) &&
      lines
        .slice(Math.max(0, index - 4), index + 5)
        .some((other, otherIndex) => otherIndex + Math.max(0, index - 4) !== index && MENU_OPTION.test(other))
  );
}

function readyPatternFor(config, custom = false) {
  const pattern = process.env[`LLM_ROUTER_MCP_${config.envName}_READY_PATTERN`];
  if (!pattern) {
    return custom ? null : config.readyPattern;
  }
  try {
    return new RegExp(pattern, "m");
  } catch (error) {
    throw new LlmRouterError(
      `LLM_ROUTER_MCP_${config.envName}_READY_PATTERN is not a valid regular expression`,
      { pattern, cause: error.message }
    );
  }
}

async function waitUntilReady({ sessionName, timeoutMs, readyPattern, trustCwd, signal }) {
  const deadline = Date.now() + timeoutMs;
  const actions = [];
  let last = null;
  let changedAt = Date.now();
  let dialogTries = 0;

  while (Date.now() <= deadline) {
    if (signal?.aborted) {
      return { ready: false, cancelled: true, actions, paneText: last || "" };
    }
    const info = await paneInfo(sessionName);
    if (!info) {
      return { ready: false, ended: true, actions, paneText: last || "" };
    }
    // Only the visible screen: an answered dialog may linger in scrollback.
    const text = await safeCapture(sessionName, null);
    if (info.dead) {
      // tmux-windows scrolls the last output above "Pane is dead".
      return {
        ready: false,
        dead: true,
        exitStatus: info.deadStatus,
        actions,
        paneText: await safeCapture(sessionName, 200)
      };
    }
    if (text !== last) {
      last = text;
      changedAt = Date.now();
    }
    const quietMs = Date.now() - changedAt;
    const promptVisible = Boolean(readyPattern) && readyPattern.test(bottomLines(text, READY_LINES));
    const dialog = promptVisible ? null : detectStartupDialog(text);
    if (dialog) {
      // Let the dialog finish drawing before reading its selection.
      if (quietMs < 400) {
        await sleep(150);
        continue;
      }
      const allowed = dialog.kind !== "trust" || trustCwd;
      if (allowed && (dialog.choose || dialog.keys) && dialogTries < 4) {
        dialogTries += 1;
        if (await answerDialog(sessionName, dialog)) {
          actions.push(dialog.kind);
          last = null;
          await sleep(500);
          continue;
        }
      }
      return { ready: false, blocker: dialog.kind, actions, paneText: text };
    }

    if (hasPendingPrompt(text, readyPattern)) {
      // An unknown menu will not go away by itself.
      if (quietMs >= 3000) {
        return { ready: false, blocker: "dialog", actions, paneText: text };
      }
    } else if (text.trim() !== "" && quietMs >= 1000 && (!readyPattern || promptVisible)) {
      // Built-in CLIs must show their input prompt: typing into a screen that
      // is not recognised could answer a question on it.
      return { ready: true, actions, paneText: text };
    }
    await sleep(250);
  }

  return { ready: false, timedOut: true, actions, paneText: last || "" };
}

function sessionNotReadyError(config, session) {
  const where = `tmux session ${session.sessionName}`;
  let message;
  if (session.cancelled) {
    message = "request was cancelled";
  } else if (session.blocker === "trust") {
    message = `${config.displayName} is asking whether to trust ${session.cwd || "its folder"}. Attach with "${session.attachCommand}" and answer it, or pass trustCwd: true.`;
  } else if (session.blocker === "dialog") {
    message = `${config.displayName} is showing a question the router does not know how to answer. Attach with "${session.attachCommand}", answer it, and retry.`;
  } else if (session.blocker === "login" || session.blocker === "onboarding") {
    message = session.created
      ? `${config.displayName} needs first-run setup or login. Run "${config.executable}" once in a terminal and finish it, then retry (the ${where} was closed).`
      : `${config.displayName} shows a setup or login screen. Attach with "${session.attachCommand}" to finish it, or kill the session and run "${config.executable}" once in a terminal.`;
  } else if (session.exitStatus !== null && session.exitStatus !== undefined) {
    message = `${config.displayName} exited with status ${session.exitStatus} before it was ready; see paneTail.`;
  } else if (!session.running) {
    message = `${where} ended before ${config.displayName} was ready; see paneTail.`;
  } else if (session.timedOut) {
    message = `${config.displayName} did not show its input prompt in time; see paneTail or attach with "${session.attachCommand}".`;
  } else {
    message = `${config.displayName} is not ready for input; see paneTail.`;
  }
  return new LlmRouterError(message, session);
}

async function hostEnvOverrides() {
  if (process.env.LLM_ROUTER_MCP_SCRUB_ENV === "0") {
    return [];
  }
  // A server this process starts inherits the scrubbed environment. One that
  // was already running may hold the variables; blank them for this session.
  if (!tmuxAtLeast(await tmuxVersion(), 3, 2)) {
    return [];
  }
  const result = await runTmux(["show-environment", "-g"], {
    allowFailure: true,
    timeoutMs: TMUX_TIMEOUT_MS
  });
  if (result.code !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.split("=")[0])
    .filter((name) => name && !name.startsWith("-") && HOST_SESSION_ENV.has(name.toUpperCase()))
    .flatMap((name) => ["-e", `${name}=`]);
}

// "tmux 3.4", "tmux 3.1c", "tmux next-3.7-win32"; unparsable means a dev build.
function tmuxAtLeast(versionText, major, minor) {
  const match = /(\d+)\.(\d+)/.exec(versionText || "");
  if (!match) {
    return true;
  }
  const [have, haveMinor] = [Number(match[1]), Number(match[2])];
  return have > major || (have === major && haveMinor >= minor);
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new LlmRouterError("request was cancelled", { cancelled: true });
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Runtime state holds prompts and answers; keep it to the owner on POSIX.
async function ensurePrivateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (!IS_WINDOWS) {
    // An older version created it with the default mode.
    await fs.chmod(dir, 0o700).catch(() => {});
  }
}

async function writePrivateFile(filePath, content) {
  await fs.writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
}

function buildPrompt({ provider, mode, inputPath, markdown, nonce, model, answerPath }) {
  const config = providerConfig(provider);
  const { startPrefix, donePrefix } = markerSet(provider, nonce);
  const requestedModel = resolveModel(provider, model);
  const modelInstruction =
    requestedModel && !config.supportsModelFlag
      ? `\nThe MCP caller requested model: ${requestedModel}. This CLI does not expose a known model flag here; if the UI/agent supports in-session selection, use that model.\n`
      : "";

  return `You are being asked through llm-router-mcp from ${mode === "tmux" ? "a persistent tmux session" : "a headless one-shot run"} for ${config.displayName}.

The request and the final answer are Markdown artifacts. Read the Markdown input exactly and answer in Markdown.

Automation markers are required so the MCP client can detect progress and completion.

Before any substantive work, print a start marker on its own line, followed by an empty line.
- literal prefix: ${startPrefix}
- nonce: ${nonce}
- format: prefix immediately followed by nonce, with no spaces
${
  answerPath
    ? `
Write your complete final answer as Markdown to this file, creating or overwriting it, with your file-writing tool:
${answerPath}

After the file is written, print an empty line and then a done marker on its own line.`
    : `
After the final answer is complete, print an empty line and then a done marker on its own line.`
}
- literal prefix: ${donePrefix}
- nonce: ${nonce}
- format: prefix immediately followed by nonce, with no spaces

Print both markers as plain text: not in a code block, backticks, quotes, or bold. Do not print the done marker until the answer is finished.${
  answerPath
    ? `
Between the two markers, print only a short note such as "Answer written to the file." If you cannot write the file, print the whole answer between the markers instead.`
    : ""
}
Use tools (shell commands, file edits, web access) when the request needs them; for ordinary questions, just answer.
${modelInstruction}
Markdown input file path:
${inputPath}

Markdown input begins below.

--- BEGIN MCP MARKDOWN INPUT ---
${markdown}
--- END MCP MARKDOWN INPUT ---
`;
}

function answerPathFor(requestDir, nonce) {
  return path.join(requestDir, `${safeFilePart(nonce)}.answer.md`);
}

async function readAnswerFile(answerPath) {
  try {
    const text = await fs.readFile(answerPath, "utf8");
    return text.trim() ? text.replace(/\r\n/g, "\n").replace(/\s+$/, "") : null;
  } catch {
    return null;
  }
}

function filePointerLine(promptPath) {
  return `Read the Markdown request file at ${promptPath} and follow its instructions exactly.`;
}

async function runHeadlessProvider({
  provider,
  model,
  prompt,
  promptPath,
  outputPath,
  cwd,
  timeoutMs,
  signal
}) {
  const config = providerConfig(provider);
  const command = config.executable;
  const launch = resolveSpawn(command, [], childEnv());
  const specFor = (argvPromptOk) =>
    config.headless({
      model,
      prompt,
      promptPath,
      outputPath,
      timeoutMs: Math.max(1000, timeoutMs - 5000),
      argvPromptOk,
      permissions: resolvePermissions()
    });
  // cmd.exe cannot carry a multi-line argument.
  let spec = specFor(launch.via !== "cmd");
  if (spec.outputPath) {
    await fs.rm(spec.outputPath, { force: true });
  }

  const run = async () =>
    await runCommand(command, spec.args, {
      cwd,
      input: spec.stdin ? prompt : undefined,
      timeoutMs,
      allowFailure: true,
      killTree: true,
      signal
    });
  try {
    let result;
    try {
      result = await run();
    } catch (error) {
      // The prompt did not fit on the command line after all.
      if (!/E2BIG|ENAMETOOLONG/.test(error.details?.cause || "")) {
        throw error;
      }
      const fallback = specFor(false);
      if (fallback.args.join("\0") === spec.args.join("\0")) {
        throw error;
      }
      spec = fallback;
      result = await run();
    }
    return { ...result, outputPath: spec.outputPath };
  } catch (error) {
    if (error instanceof LlmRouterError && (error.details.timedOut || error.details.cancelled)) {
      return {
        command,
        args: spec.args,
        code: null,
        signal: null,
        stdout: error.details.stdout || "",
        stderr: error.details.stderr || "",
        elapsedMs: error.details.elapsedMs ?? null,
        timedOut: Boolean(error.details.timedOut),
        cancelled: Boolean(error.details.cancelled),
        outputPath: spec.outputPath
      };
    }
    throw error;
  }
}

async function readHeadlessOutput(run) {
  if (run.outputPath) {
    if (!IS_WINDOWS) {
      // Codex creates this file with its own umask.
      await fs.chmod(run.outputPath, 0o600).catch(() => {});
    }
    try {
      const text = await fs.readFile(run.outputPath, "utf8");
      if (text.trim()) {
        return text;
      }
    } catch {
      // Fall back to stdout when the CLI did not write its last message.
    }
  }
  return run.stdout;
}


async function submitToTmux({ sessionName, pastePath, nonce, startMarker, doneMarker, signal }) {
  const target = paneTarget(sessionName);
  const bufferName = `llm-router-${safeFilePart(nonce)}`.replace(/[^A-Za-z0-9_-]/g, "-");
  const hasMarker = (text) => text.includes(startMarker) || text.includes(doneMarker);
  const beforePaste = await safeCapture(sessionName, null);

  // After this point a cancel is ignored: half a submit would leave the
  // request in the input box, to be sent along with the next one.
  throwIfAborted(signal);
  await runTmux(["load-buffer", "-b", bufferName, pastePath], { timeoutMs: TMUX_TIMEOUT_MS });
  try {
    await runTmux(["paste-buffer", "-p", "-b", bufferName, "-t", target], {
      timeoutMs: TMUX_TIMEOUT_MS
    });
  } finally {
    await runTmux(["delete-buffer", "-b", bufferName], {
      allowFailure: true,
      timeoutMs: TMUX_TIMEOUT_MS
    });
  }

  // Let the input settle before Enter: TUIs that see a paste as fast
  // keystrokes take an Enter that arrives during the burst as a newline. A CLI
  // that has just started may take seconds to show the paste at all.
  const shown = await waitForPaneChange(sessionName, beforePaste, 10000);
  await waitForPaneQuiet(sessionName, { quietMs: 500, maxMs: 5000 });
  const beforeEnter = await safeCapture(sessionName, null);
  await runTmux(["send-keys", "-t", target, "Enter"], { timeoutMs: TMUX_TIMEOUT_MS });

  let attempts = 1;
  // Only a paste the TUI visibly took can be left waiting for Enter.
  while (shown && attempts <= SUBMIT_RETRIES) {
    await sleep(400);
    const first = await safeCapture(sessionName, null);
    if (hasMarker(first)) {
      break;
    }
    await sleep(2000);
    const second = await safeCapture(sessionName, null);
    // A working TUI animates a spinner or timer; a screen that has not moved
    // since just after Enter still holds the unsent input.
    if (
      hasMarker(second) ||
      second !== first ||
      second === "" ||
      beforeEnter === ""
    ) {
      break;
    }
    await runTmux(["send-keys", "-t", target, "Enter"], { timeoutMs: TMUX_TIMEOUT_MS });
    attempts += 1;
  }
  return { attempts };
}

async function waitForPaneChange(sessionName, previous, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if ((await safeCapture(sessionName, null)) !== previous) {
      return true;
    }
    await sleep(150);
  }
  return false;
}




function detectStartupDialog(text) {
  const bottom = bottomLines(text, 40);
  return STARTUP_DIALOGS.find((dialog) => dialog.test.test(bottom)) || null;
}

async function answerDialog(sessionName, dialog) {
  const target = paneTarget(sessionName);
  if (dialog.keys) {
    for (const key of dialog.keys) {
      await runTmux(["send-keys", "-t", target, key], { timeoutMs: TMUX_TIMEOUT_MS });
    }
    return true;
  }
  for (let moves = 0; moves < 8; moves += 1) {
    const selected = selectedOption(await safeCapture(sessionName, null));
    if (selected === null) {
      return false;
    }
    if (dialog.choose.test(selected)) {
      await runTmux(["send-keys", "-t", target, "Enter"], { timeoutMs: TMUX_TIMEOUT_MS });
      return true;
    }
    await runTmux(["send-keys", "-t", target, "Down"], { timeoutMs: TMUX_TIMEOUT_MS });
    await sleep(250);
  }
  return false;
}

function selectedOption(text) {
  const lines = bottomLines(text, 40).split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^[ \t]*[❯›>▸][ \t]+(\S.*)$/.exec(lines[index]);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}


async function waitForPaneQuiet(sessionName, { quietMs, maxMs }) {
  const deadline = Date.now() + maxMs;
  let last = await safeCapture(sessionName, null);
  let changedAt = Date.now();
  while (Date.now() < deadline) {
    await sleep(150);
    const text = await safeCapture(sessionName, null);
    if (text !== last) {
      last = text;
      changedAt = Date.now();
    } else if (Date.now() - changedAt >= quietMs) {
      return;
    }
  }
}

async function paneInfo(sessionName) {
  const result = await runTmux(
    [
      "display-message",
      "-p",
      "-t",
      paneTarget(sessionName),
      [
        "#{session_name}",
        "#{pane_dead}",
        "#{pane_dead_status}",
        "#{pane_current_command}",
        "#{@llm_router_trust}",
        "#{@llm_router_custom}",
        "#{@llm_router_model}",
        "#{@llm_router_cwd}",
        "#{@llm_router_command}",
        "#{@llm_router_ready}",
        "#{@llm_router_requests}"
      ].join("\t")
    ],
    { allowFailure: true, timeoutMs: TMUX_TIMEOUT_MS }
  );
  const [name, dead, deadStatus, currentCommand, trust, custom, model, cwd, command, ready, requestDir] =
    result.stdout
    .replace(/\r?\n$/, "")
    .split("\t");
  // display-message succeeds with empty fields when the target does not exist.
  if (result.code !== 0 || name !== sessionName) {
    return null;
  }
  return {
    dead: dead === "1",
    deadStatus: deadStatus === undefined || deadStatus === "" ? null : Number(deadStatus),
    currentCommand: currentCommand || null,
    // Empty when the session was not started by the router.
    trust: trust || "",
    custom: custom || "",
    model: custom === "0" ? model || "" : null,
    cwd: cwd || null,
    command: command || null,
    ready: ready || "",
    requestDir: requestDir || null
  };
}

// lines === null captures only the visible screen.
async function capturePaneText(sessionName, lines) {
  const result = await runTmux(
    [
      "capture-pane",
      "-p",
      ...(joinWrappedLines() ? ["-J"] : []),
      "-t",
      paneTarget(sessionName),
      ...(lines === null ? [] : ["-S", `-${lines}`])
    ],
    { timeoutMs: TMUX_TIMEOUT_MS }
  );
  return stripAnsi(result.stdout).replace(/\r/g, "");
}

async function safeCapture(sessionName, lines) {
  try {
    return await capturePaneText(sessionName, lines);
  } catch {
    return "";
  }
}

function joinWrappedLines() {
  const value = process.env.LLM_ROUTER_MCP_TMUX_JOIN_LINES;
  if (value === "1" || value === "0") {
    return value === "1";
  }
  // ConPTY marks every full-width row as wrapped, so -J would glue a whole TUI
  // screen into one line.
  return !IS_WINDOWS;
}

function tmuxGlobalArgs() {
  if (process.env.LLM_ROUTER_MCP_TMUX_SOCKET) {
    return ["-S", process.env.LLM_ROUTER_MCP_TMUX_SOCKET];
  }
  if (process.env.LLM_ROUTER_MCP_TMUX_LABEL) {
    return ["-L", process.env.LLM_ROUTER_MCP_TMUX_LABEL];
  }
  return [];
}

function attachCommand(sessionName) {
  return ["tmux", ...tmuxGlobalArgs(), "attach", "-t", sessionName].map(shellQuote).join(" ");
}

function sessionTarget(sessionName) {
  return `=${sessionName}`;
}

function paneTarget(sessionName) {
  return `=${sessionName}:`;
}

function sessionKey(sessionName) {
  return `${tmuxGlobalArgs().join(" ")}|${sessionName}`;
}

async function withSessionLock(key, callback) {
  const previous = sessionLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => current);
  sessionLocks.set(key, chained);
  await previous;
  try {
    return await callback();
  } finally {
    release();
    if (sessionLocks.get(key) === chained) {
      sessionLocks.delete(key);
    }
  }
}

function progressReporter(onProgress, startedAt) {
  let lastAt = 0;
  return {
    async report(message, force = false) {
      if (typeof onProgress !== "function") {
        return;
      }
      const now = Date.now();
      if (!force && now - lastAt < PROGRESS_INTERVAL_MS) {
        return;
      }
      lastAt = now;
      try {
        // Awaited so a notification never arrives after the tool result.
        await onProgress({ message, elapsedMs: now - startedAt });
      } catch {
        // Progress is best effort.
      }
    }
  };
}



async function ensureDefaultWorkDir(provider, stateDir) {
  const config = providerConfig(provider);
  const cwd = defaultWorkDir(provider, stateDir);
  await ensurePrivateDir(cwd);

  const agentsText = `# AGENTS.md

This is a private scratch workspace for llm-router-mcp ${config.displayName} chat automation.

- For ordinary questions, answer directly.
- Use tools (shell commands, file edits, web access) when a request needs them.
- Preserve the ${config.envName}_TMUX_STARTED/${config.envName}_TMUX_DONE nonce marker protocol requested by llm-router-mcp.
`;
  await writeIfChanged(path.join(cwd, "AGENTS.md"), agentsText);
  if (provider === "claude") {
    // Claude Code reads CLAUDE.md, not AGENTS.md.
    await writeIfChanged(path.join(cwd, "CLAUDE.md"), agentsText.replace("# AGENTS.md", "# CLAUDE.md"));
  }

  try {
    await fs.access(path.join(cwd, ".git"));
  } catch {
    try {
      await runCommand("git", ["init", "-q"], {
        cwd,
        allowFailure: true,
        timeoutMs: 10000
      });
    } catch {
      // git is optional; Codex only needs it to skip its repository check.
    }
  }

  return cwd;
}

async function writeIfChanged(filePath, content) {
  try {
    if ((await fs.readFile(filePath, "utf8")) === content) {
      return;
    }
  } catch {
    // Missing file: write it.
  }
  await writePrivateFile(filePath, content);
}

async function writeResponseFile({ provider, stateDir, nonce, answer }) {
  const config = providerConfig(provider);
  const responseDir = path.join(stateDir, "responses", config.id);
  await ensurePrivateDir(responseDir);
  const responsePath = path.join(responseDir, `${safeFilePart(nonce)}.response.md`);
  const content = answer === null || answer === undefined ? "" : `${answer}\n`;
  await writePrivateFile(responsePath, content);
  return {
    responsePath,
    bytes: Buffer.byteLength(content, "utf8")
  };
}

async function writeRawResponseFile({ provider, stateDir, nonce, stdout, stderr, code }) {
  const config = providerConfig(provider);
  const responseDir = path.join(stateDir, "responses", config.id);
  await ensurePrivateDir(responseDir);
  const rawResponsePath = path.join(responseDir, `${safeFilePart(nonce)}.raw.md`);
  const content = `# Raw ${config.displayName} Headless Response

- nonce: ${nonce}
- exitCode: ${code}
- writtenAt: ${new Date().toISOString()}

## stdout

\`\`\`text
${stdout || ""}
\`\`\`

## stderr

\`\`\`text
${stderr || ""}
\`\`\`
`;
  await writePrivateFile(rawResponsePath, content);
  return {
    rawResponsePath,
    bytes: Buffer.byteLength(content, "utf8")
  };
}

async function writeFallbackFile({ provider, stateDir, nonce, title, paneTail, error, full = false }) {
  const config = providerConfig(provider);
  const responseDir = path.join(stateDir, "responses", config.id);
  await ensurePrivateDir(responseDir);
  const fallbackPath = path.join(responseDir, `${safeFilePart(nonce)}.fallback.md`);
  const content = `# ${title}

- nonce: ${nonce}
- writtenAt: ${new Date().toISOString()}
${error ? `- error: ${error instanceof Error ? error.message : String(error)}\n` : ""}
## ${full ? "Captured pane history" : "Captured pane tail"}

\`\`\`text
${full ? paneTail || "" : tailLines(paneTail || "", 240)}
\`\`\`
`;
  await writePrivateFile(fallbackPath, content);
  return fallbackPath;
}

function resolveSessionName(provider, sessionName) {
  const config = providerConfig(provider);
  return (
    sessionName ||
    process.env[`LLM_ROUTER_MCP_${config.envName}_SESSION`] ||
    config.defaultSessionName
  );
}

function safeFilePart(value) {
  // NTFS and APFS ignore case, so a nonce with capitals gets a hash suffix to
  // keep "Review-1" and "review-1" apart.
  if (/[A-Z]/.test(value)) {
    const hash = crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
    return `${value.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}-${hash}`;
  }
  // ":" would name an NTFS alternate data stream on Windows.
  return value.replace(/[^A-Za-z0-9_.-]/g, "-");
}

function cleanPaneLine(line) {
  return line
    // A scrollbar column at the right edge.
    .replace(/[ \t]{2,}[█▌▐]+[ \t]*$/, "")
    .replace(/^[ \t]*[█▌▐]+[ \t]*$/, "")
    .replace(/[ \t]{2,}\d{1,2}:\d{2}\s*(?:AM|PM)[ \t]*$/i, "")
    .replace(/[ \t]{2,}(?:오전|오후)\s*\d{1,2}:\d{2}[ \t]*$/, "")
    .replace(/[ \t]+$/g, "");
}

function stripCommonIndent(lines) {
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) {
    return lines;
  }
  const common = Math.min(
    ...nonEmpty.map((line) => {
      const match = /^[ \t]*/.exec(line);
      return match ? match[0].length : 0;
    })
  );
  if (common <= 0) {
    return lines;
  }
  return lines.map((line) => line.slice(Math.min(common, line.length)));
}

function stripAnsi(value) {
  return value.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    ""
  );
}

function tailLines(value, count) {
  const lines = value.split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

function bottomLines(value, count) {
  return tailLines(value.replace(/\n+$/, ""), count);
}

function requireInputPath(inputPath) {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw new LlmRouterError("inputPath is required and must point to a Markdown file");
  }
  return inputPath;
}

function requireNonce(nonce) {
  if (typeof nonce !== "string" || nonce.length === 0) {
    throw new LlmRouterError("nonce is required");
  }
  return nonce;
}

function validateMarkdownPath(inputPath) {
  if (!/\.(md|markdown)$/i.test(inputPath)) {
    throw new LlmRouterError("inputPath must end with .md or .markdown", { inputPath });
  }
}

function summarizeArg(arg) {
  return arg.length > 200 ? `${arg.slice(0, 80)}... (${arg.length} chars)` : arg;
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) {
    return value;
  }
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function envValue(env, name) {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

function childEnv(extra = {}) {
  const scrub = process.env.LLM_ROUTER_MCP_SCRUB_ENV !== "0";
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || (scrub && HOST_SESSION_ENV.has(key.toUpperCase()))) {
      continue;
    }
    env[key] = value;
  }
  // Windows keeps the variable as "Path"; adding "PATH" next to it would leave
  // the child with two.
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") || "PATH";
  const home = os.homedir();
  env[pathKey] = [
    process.env.LLM_ROUTER_MCP_PATH_PREFIX || "",
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    // Grok's installer puts it here and only adds it to shell profiles.
    path.join(home, ".grok", "bin"),
    env[pathKey] || ""
  ]
    .filter(Boolean)
    .join(path.delimiter);
  return { ...env, ...extra };
}

/**
 * Finds a command on PATH the way a shell would. On Windows this includes
 * PATHEXT, which Node's spawn does not apply, so npm's .cmd shims are found.
 */
export function findExecutable(command, env = childEnv()) {
  const pathValue = envValue(env, "PATH") || "";
  const extensions = IS_WINDOWS
    ? (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD")
        .split(";")
        .filter(Boolean)
        .map((ext) => ext.toLowerCase())
    : [""];
  const cacheKey = `${command}\0${pathValue}\0${extensions.join(";")}`;
  const cached = executableCache.get(cacheKey);
  if (cached && isRunnableFile(cached)) {
    return cached;
  }

  const bases =
    path.isAbsolute(command) || /[\\/]/.test(command)
      ? [path.resolve(command)]
      : pathValue
          .split(path.delimiter)
          .filter(Boolean)
          .map((dir) => path.join(dir.replace(/^"(.*)"$/, "$1"), command));

  for (const base of bases) {
    const candidates = IS_WINDOWS
      ? [
          ...(extensions.includes(path.extname(base).toLowerCase()) ? [base] : []),
          ...extensions.map((ext) => `${base}${ext}`)
        ]
      : [base];
    for (const candidate of candidates) {
      if (isRunnableFile(candidate)) {
        executableCache.set(cacheKey, candidate);
        return candidate;
      }
    }
  }
  return null;
}

function isRunnableFile(filePath) {
  try {
    if (!fsSync.statSync(filePath).isFile()) {
      return false;
    }
    if (!IS_WINDOWS) {
      fsSync.accessSync(filePath, fsSync.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

function resolveSpawn(command, args, env) {
  if (!IS_WINDOWS) {
    return { command, args, verbatim: false, via: "direct" };
  }
  const resolvedPath = findExecutable(command, env);
  if (!resolvedPath) {
    return { command, args, verbatim: false, via: "direct" };
  }
  const ext = path.extname(resolvedPath).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat") {
    return { command: resolvedPath, args, verbatim: false, via: "direct" };
  }

  // Node refuses to spawn .cmd files without a shell. Run npm shims' scripts
  // with node directly, everything else through cmd.exe.
  const shim = readNpmCmdShim(resolvedPath);
  if (shim) {
    return { command: shim.node, args: [shim.script, ...args], verbatim: false, via: "npm-shim" };
  }
  if (args.some((arg) => /[\r\n]/.test(arg))) {
    throw new LlmRouterError(`cannot pass a multi-line argument through cmd.exe to ${resolvedPath}`, {
      command
    });
  }
  // A batch file parses %* again, and cmd has no escape for a quote inside
  // quotes, so what follows one would run as commands.
  if (args.some((arg) => arg.includes('"'))) {
    throw new LlmRouterError(`cannot pass an argument containing a double quote through cmd.exe to ${resolvedPath}`, {
      command
    });
  }
  const line = [escapeCmdCommand(resolvedPath), ...args.map(escapeCmdArgument)].join(" ");
  return {
    command: envValue(env, "COMSPEC") || "cmd.exe",
    args: ["/d", "/s", "/c", `"${line}"`],
    verbatim: true,
    via: "cmd"
  };
}

function readNpmCmdShim(cmdPath) {
  let text;
  try {
    if (fsSync.statSync(cmdPath).size > 16384) {
      return null;
    }
    text = fsSync.readFileSync(cmdPath, "utf8");
  } catch {
    return null;
  }
  // npm's cmd-shim: "%_prog%" is node unless the script's shebang named
  // another interpreter, and older shims call node directly.
  const usesNode = /SET "_prog=node"/i.test(text) || !/_prog/i.test(text);
  // Variables the shim sets for the script (env -S in its shebang) would be
  // lost when running the script directly.
  const setsVariables = /^[ \t]*@?SET[ \t]+"?(?!dp0=|_prog=|PATHEXT=)[A-Za-z_]/im.test(text);
  if (setsVariables) {
    return null;
  }
  const match =
    /"%_prog%"\s+"%~?dp0%?\\([^"\r\n]+?\.[cm]?js)"\s+%\*/i.exec(text) ||
    /(?:^|[\s(])"?(?:%~?dp0%?\\)?node(?:\.exe)?"?\s+"%~?dp0%?\\([^"\r\n]+?\.[cm]?js)"\s+%\*/im.exec(text);
  if (!match || !usesNode) {
    return null;
  }
  const dir = path.dirname(cmdPath);
  const script = path.join(dir, match[1]);
  if (!isRunnableFile(script)) {
    return null;
  }
  const bundledNode = path.join(dir, "node.exe");
  return { node: isRunnableFile(bundledNode) ? bundledNode : process.execPath, script };
}

// cmd.exe quoting, as done by cross-spawn.
const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdCommand(value) {
  return value.replace(CMD_META_CHARS, "^$1");
}

function escapeCmdArgument(value) {
  let arg = String(value);
  arg = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  arg = arg.replace(/(?=(\\+?)?)\1$/, "$1$1");
  arg = `"${arg}"`;
  return arg.replace(CMD_META_CHARS, "^$1");
}

/** Ends every headless CLI still running; for use while the server exits. */
export function terminateChildren() {
  for (const [child, groupKill] of liveChildren) {
    if (!child.pid) {
      continue;
    }
    if (IS_WINDOWS) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      continue;
    }
    try {
      process.kill(groupKill ? -child.pid : child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  liveChildren.clear();
}

function killProcessTree(child, groupKill) {
  if (!child.pid) {
    return;
  }
  if (IS_WINDOWS) {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    killer.on("error", () => child.kill());
    return;
  }
  if (groupKill) {
    try {
      process.kill(-child.pid, "SIGTERM");
      setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }, 3000).unref();
      return;
    } catch {
      // Fall through to the single process.
    }
  }
  child.kill("SIGTERM");
}

function quotedArgLength(value) {
  const quotes = (value.match(/"/g) || []).length;
  const backslashesBeforeQuotes = (value.match(/\\+(?="|$)/g) || []).join("").length;
  return value.length + 2 + quotes + backslashesBeforeQuotes;
}

function durationForAgy(timeoutMs) {
  const seconds = Math.max(1, Math.ceil(normalizeTimeout(timeoutMs, 300000) / 1000));
  return `${seconds}s`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
