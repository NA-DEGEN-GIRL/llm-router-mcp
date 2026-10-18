import { readFileSync } from "node:fs";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  INPUT_MODES,
  OUTPUT_MODES,
  LlmRouterError,
  capturePane,
  checkProviders,
  ensureSession,
  headlessAsk,
  killSession,
  listProviders,
  pruneState,
  sendInput,
  status,
  terminateChildren,
  tmuxAsk,
  waitForResponse,
  waitForStart,
  writeInputFile
} from "./core.js";
import { MEDIA_MODES, xSearch } from "./x-search.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// Longer delays overflow Node's timers.
const MAX_MS = 2147483647;
const millis = () => z.number().int().positive().max(MAX_MS);

const providerSchema = z
  .enum([
    "codex",
    "claude",
    "grok",
    "antigravity",
    "agy",
    "gemini",
    "google",
    "gpt",
    "openai",
    "xai"
  ])
  .describe(
    "LLM provider. Aliases: agy/gemini/google -> antigravity, gpt/openai -> codex, xai -> grok."
  );

const optionalCommon = {
  provider: providerSchema,
  sessionName: z
    .string()
    .optional()
    .describe(
      "tmux session name (letters, numbers, underscore, dash). Defaults to provider defaults such as codex-mcp."
    ),
  timeoutMs: millis()
    .optional()
    .describe(
      "Wait time in milliseconds. For a tmux answer this is one window (default 10 minutes), extended while the CLI keeps working up to maxWaitMs; for a headless call the whole limit (default 25 minutes); a new session gets at most 60 seconds to show its prompt."
    ),
  stateDir: z
    .string()
    .optional()
    .describe("Runtime state directory for generated Markdown input, prompts, and responses."),
  model: z
    .string()
    .optional()
    .describe("Provider model to request, passed to the CLI's model flag.")
};

const waitExtension = {
  maxWaitMs: millis()
    .optional()
    .describe("Cap on a tmux answer wait including extensions. Default 25 minutes."),
  stallMs: millis()
    .optional()
    .describe("Stop waiting early when the CLI's screen has not changed for this long. Default 5 minutes.")
};

const nonceSchema = z
  .string()
  .optional()
  .describe(
    "Optional caller-supplied unique nonce (6-96 letters, numbers, underscore, dash). Generated when omitted."
  );

const sessionCreation = {
  command: z
    .union([z.string(), z.array(z.string()).min(1)])
    .optional()
    .describe(
      "Command used only if the tmux session must be created. A string runs through tmux's default-shell; a list runs directly as program and arguments."
    ),
  cwd: z
    .string()
    .optional()
    .describe(
      "Working directory used only if the tmux session must be created. Defaults to a provider scratch workdir."
    ),
  trustCwd: z
    .boolean()
    .optional()
    .describe(
      "Answer the CLI's folder-trust prompt with yes. Defaults to true only for the router's own scratch workdir."
    ),
  columns: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional()
};

const inputModeSchema = z
  .enum(INPUT_MODES)
  .optional()
  .describe(
    "How the request reaches the TUI: paste the whole prompt, or paste one line asking the model to read the prompt file. Defaults to file on Windows (except Claude) and paste elsewhere."
  );

const outputModeSchema = z
  .enum(OUTPUT_MODES)
  .optional()
  .describe(
    "How the answer comes back: file (default) has the model write it to a Markdown file, with the pane as fallback; pane reads it from the tmux pane between the markers."
  );

export async function main() {
  const server = new McpServer({
    name: "llm-router-mcp",
    version
  });

  server.registerTool(
    "llm_list_providers",
    {
      title: "List LLM providers",
      description:
        "Show the providers supported by llm-router-mcp, their default sessions, models, and input modes. With check=true, also report whether tmux and each CLI can be found.",
      inputSchema: {
        check: z
          .boolean()
          .optional()
          .describe("Also look up tmux and each provider CLI on PATH.")
      }
    },
    tool(async ({ check }) => ({
      providers: listProviders(),
      ...(check ? { check: await checkProviders() } : {})
    }))
  );

  server.registerTool(
    "llm_write_input",
    {
      title: "Write Markdown input",
      description:
        "Write a Markdown prompt to the llm-router state directory and return inputPath for tmux or headless calls.",
      inputSchema: {
        provider: providerSchema.optional(),
        markdown: z.string().min(1).describe("Markdown prompt content."),
        filename: z
          .string()
          .optional()
          .describe("Optional .md filename. Path components are ignored."),
        stateDir: optionalCommon.stateDir
      }
    },
    tool(async (args) => await writeInputFile(args))
  );

  server.registerTool(
    "llm_tmux_start",
    {
      title: "Start persistent LLM tmux session",
      description:
        "Create or reuse a provider tmux session and wait until the CLI shows its input prompt. Reusing the session preserves conversation context.",
      inputSchema: {
        provider: optionalCommon.provider,
        sessionName: optionalCommon.sessionName,
        model: optionalCommon.model,
        timeoutMs: optionalCommon.timeoutMs,
        stateDir: optionalCommon.stateDir,
        ...sessionCreation
      }
    },
    tool(async (args, extra) => await ensureSession({ ...args, signal: extra.signal }))
  );

  server.registerTool(
    "llm_tmux_send",
    {
      title: "Send Markdown input to persistent LLM",
      description:
        "Send a Markdown input file through tmux and return nonce markers. Use llm_tmux_wait to collect the answer.",
      inputSchema: {
        provider: optionalCommon.provider,
        inputPath: z.string().describe("Absolute or relative path to a .md/.markdown input file."),
        nonce: nonceSchema,
        sessionName: optionalCommon.sessionName,
        model: optionalCommon.model,
        inputMode: inputModeSchema,
        outputMode: outputModeSchema,
        timeoutMs: optionalCommon.timeoutMs,
        stateDir: optionalCommon.stateDir,
        ...sessionCreation
      }
    },
    tool(async (args, extra) => await sendInput({ ...args, signal: extra.signal }))
  );

  server.registerTool(
    "llm_tmux_wait_start",
    {
      title: "Wait for persistent LLM start marker",
      description:
        "Wait until the provider prints the start marker for a nonce. This confirms the request began.",
      inputSchema: {
        provider: optionalCommon.provider,
        nonce: z.string().describe("Nonce returned by llm_tmux_send."),
        sessionName: optionalCommon.sessionName,
        timeoutMs: optionalCommon.timeoutMs,
        pollMs: millis().optional(),
        captureLines: z.number().int().positive().optional(),
        stateDir: optionalCommon.stateDir
      }
    },
    tool(async (args, extra) => await waitForStart({ ...args, signal: extra.signal }))
  );

  server.registerTool(
    "llm_tmux_wait",
    {
      title: "Wait for persistent LLM response",
      description:
        "Wait until the provider prints the done marker for a nonce. The answer is also written to a Markdown response file.",
      inputSchema: {
        provider: optionalCommon.provider,
        nonce: z.string().describe("Nonce returned by llm_tmux_send."),
        sessionName: optionalCommon.sessionName,
        timeoutMs: optionalCommon.timeoutMs,
        ...waitExtension,
        pollMs: millis().optional(),
        captureLines: z.number().int().positive().optional(),
        stateDir: optionalCommon.stateDir
      }
    },
    tool(
      async (args, extra) =>
        await waitForResponse({
          ...args,
          signal: extra.signal,
          onProgress: progressSender(extra)
        })
    )
  );

  server.registerTool(
    "llm_tmux_ask",
    {
      title: "Ask persistent LLM and wait",
      description:
        "Convenience tool: send a Markdown input file to a provider through tmux, then wait for the done nonce marker.",
      inputSchema: {
        provider: optionalCommon.provider,
        inputPath: z.string().describe("Absolute or relative path to a .md/.markdown input file."),
        nonce: nonceSchema,
        sessionName: optionalCommon.sessionName,
        model: optionalCommon.model,
        inputMode: inputModeSchema,
        outputMode: outputModeSchema,
        timeoutMs: optionalCommon.timeoutMs,
        ...waitExtension,
        pollMs: millis().optional(),
        captureLines: z.number().int().positive().optional(),
        stateDir: optionalCommon.stateDir,
        ...sessionCreation
      }
    },
    tool(
      async (args, extra) =>
        await tmuxAsk({ ...args, signal: extra.signal, onProgress: progressSender(extra) })
    )
  );

  server.registerTool(
    "llm_headless_ask",
    {
      title: "Ask LLM once without persistent context",
      description:
        "Run a one-shot provider CLI call for questions that do not need persistent context. Input and output are Markdown files.",
      inputSchema: {
        provider: optionalCommon.provider,
        inputPath: z
          .string()
          .optional()
          .describe("Absolute or relative path to a .md/.markdown input file. Use this or markdown."),
        markdown: z
          .string()
          .optional()
          .describe("Markdown prompt content. Written to inputPath automatically when inputPath is omitted."),
        filename: z.string().optional(),
        nonce: nonceSchema,
        model: optionalCommon.model,
        cwd: z
          .string()
          .optional()
          .describe("Working directory for the one-shot command. Defaults to a provider scratch workdir."),
        timeoutMs: optionalCommon.timeoutMs,
        stateDir: optionalCommon.stateDir
      }
    },
    tool(async (args, extra) => await headlessAsk({ ...args, signal: extra.signal }))
  );

  server.registerTool(
    "llm_tmux_status",
    {
      title: "Check persistent LLM tmux status",
      description:
        "Capture tmux pane state and optionally check whether a nonce has started or completed.",
      inputSchema: {
        provider: optionalCommon.provider,
        nonce: z
          .string()
          .optional()
          .describe("Optional nonce to check for start/done markers in pane output."),
        sessionName: optionalCommon.sessionName,
        lines: z.number().int().positive().optional()
      }
    },
    tool(async (args) => await status(args))
  );

  server.registerTool(
    "llm_tmux_capture",
    {
      title: "Capture persistent LLM tmux pane",
      description: "Return raw tmux pane text for debugging.",
      inputSchema: {
        provider: optionalCommon.provider,
        sessionName: optionalCommon.sessionName,
        lines: z.number().int().positive().optional()
      }
    },
    tool(async (args) => ({ paneText: await capturePane(args) }))
  );

  server.registerTool(
    "llm_tmux_kill",
    {
      title: "Kill persistent LLM tmux session",
      description:
        "Kill a provider tmux session. Its conversation context is lost; the next tmux call starts a fresh CLI.",
      inputSchema: {
        provider: optionalCommon.provider,
        sessionName: optionalCommon.sessionName
      }
    },
    tool(async (args) => ({ killed: await killSession(args) }))
  );

  server.registerTool(
    "llm_x_search",
    {
      title: "Search X (Twitter) through Grok",
      description:
        "Search posts on X with Grok's X search tools, which other providers lack. Returns structured posts (URL, author, time, text, counts) with their photos and videos. media: urls (default) returns media URLs only; describe has Grok look at photos and video frames and describe them; download saves photos (and videos with includeVideo) under the state directory so you can open them, with still frames for videos when ffmpeg is installed.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("What to search for. X search operators such as from:, filter:images, or min_faves: work."),
        mode: z.enum(["latest", "top"]).optional().describe("latest (default) or top posts."),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum posts, default 10."),
        from: z.string().optional().describe("Only posts from this handle."),
        since: z.string().optional().describe("Posted on or after this date (YYYY-MM-DD)."),
        until: z.string().optional().describe("Posted before this date (YYYY-MM-DD)."),
        lang: z.string().optional().describe("Language code, such as en or ko."),
        media: z.enum(MEDIA_MODES).optional(),
        includeVideo: z
          .boolean()
          .optional()
          .describe("With media=download, also download videos and GIFs (up to 10 files and 50 MB per search)."),
        model: optionalCommon.model,
        timeoutMs: optionalCommon.timeoutMs,
        stateDir: optionalCommon.stateDir
      }
    },
    tool(async (args, extra) => await xSearch({ ...args, signal: extra.signal }))
  );

  // Old prompts, answers, and media go after the retention period.
  const prune = () => pruneState().catch(() => {});
  prune();
  setInterval(prune, 60 * 60 * 1000).unref();

  await server.connect(new StdioServerTransport());

  // When the client goes away, abort running tool calls (their abort handlers
  // stop waits and kill headless CLIs) and make sure no CLI outlives us.
  let closing = false;
  const shutdown = async () => {
    if (closing) {
      return;
    }
    closing = true;
    // Synchronously, before aborting the calls: a kill started from an abort
    // handler may not have run by the time the process exits.
    terminateChildren();
    try {
      await server.close();
    } catch {
      // Closing is best effort.
    }
    process.exit(0);
  };
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, shutdown);
  }
}

function tool(handler) {
  return async (args, extra) => {
    try {
      return jsonContent(await handler(args, extra));
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                error: error instanceof Error ? error.message : String(error),
                ...(error instanceof LlmRouterError ? { details: error.details } : {})
              },
              null,
              2
            )
          }
        ]
      };
    }
  };
}

function progressSender(extra) {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined) {
    return undefined;
  }
  let progress = 0;
  return async ({ message }) => {
    progress += 1;
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress, message }
    });
  };
}

function jsonContent(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}
