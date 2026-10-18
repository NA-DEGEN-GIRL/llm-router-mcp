#!/usr/bin/env node
// Smoke test against the real, logged-in provider CLIs through the stdio MCP
// server. It uses its own tmux server (label lrm-e2e) and kills its sessions
// when done; responses go to the normal state directory.
//
//   npm run test:real                 # all providers
//   npm run test:real -- codex grok   # some of them

import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

const ALL = ["codex", "claude", "grok", "antigravity"];
const providers = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
const label = process.env.LLM_ROUTER_MCP_TMUX_LABEL || "lrm-e2e";
const timeoutMs = Number(process.env.E2E_TIMEOUT_MS || 300000);
const codeword = `ORCHID-${Math.floor(Math.random() * 900 + 100)}`;

// A socket from the shell would take precedence over the label.
const env = { ...process.env, LLM_ROUTER_MCP_TMUX_LABEL: label };
delete env.LLM_ROUTER_MCP_TMUX_SOCKET;

const client = new Client({ name: "llm-router-e2e", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["bin/llm-router-mcp.js"],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env,
    stderr: "inherit"
  })
);

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args }, CallToolResultSchema, {
    timeout: timeoutMs + 60000,
    resetTimeoutOnProgress: true,
    onprogress: () => {}
  });
  const text = result.content?.[0]?.text ?? "";
  if (result.isError) {
    // Errors raised before the tool runs (bad arguments) are plain text.
    let reason = text;
    try {
      reason = JSON.parse(text).error ?? text;
    } catch {
      // Not JSON.
    }
    throw new Error(`${name}: ${reason}`);
  }
  return JSON.parse(text);
}

async function tmuxAsk(provider, sessionName, markdown) {
  const written = await call("llm_write_input", { provider, markdown });
  return await call("llm_tmux_ask", {
    provider,
    sessionName,
    inputPath: written.inputPath,
    timeoutMs
  });
}

const TOOL_TASK =
  'Run the shell command "node --version" and reply with exactly the version it printed, nothing else.';
// The CLI's shell may find another node than this one.
function hasNodeVersion(answer) {
  return typeof answer === "string" && /\bv\d+\.\d+\.\d+\b/.test(answer);
}

function check(results, name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
}

async function runProvider(provider) {
  const results = [];
  const sessionName = `e2e-${provider}`;
  const started = Date.now();
  try {
    const headless = await call("llm_headless_ask", {
      provider,
      markdown: "What is 17 * 23? Reply with just the number.",
      timeoutMs
    });
    check(results, "headless", headless.success && /\b391\b/.test(headless.answer || ""), {
      answer: headless.answer,
      markersFound: headless.markersFound,
      elapsedMs: headless.elapsedMs
    });

    // Tools work without anyone approving them.
    const headlessTool = await call("llm_headless_ask", {
      provider,
      markdown: TOOL_TASK,
      timeoutMs
    });
    check(results, "headless shell tool", headlessTool.success && hasNodeVersion(headlessTool.answer), {
      answer: headlessTool.answer
    });

    const first = await tmuxAsk(
      provider,
      sessionName,
      `Remember this codeword for later: ${codeword}. Reply with just the word "stored".`
    );
    check(results, "tmux turn 1", first.completed && /stored/i.test(first.answer || ""), {
      answer: first.answer,
      answerSource: first.answerSource,
      inputMode: first.inputMode,
      submitAttempts: first.submitAttempts,
      dialogsAnswered: first.dialogsAnswered
    });

    const second = await tmuxAsk(
      provider,
      sessionName,
      "What codeword did I ask you to remember? Reply with just the codeword."
    );
    check(results, "tmux turn 2 keeps context", second.completed && (second.answer || "").includes(codeword), {
      answer: second.answer,
      answerSource: second.answerSource,
      submitAttempts: second.submitAttempts
    });

    const tool = await tmuxAsk(provider, sessionName, TOOL_TASK);
    check(results, "tmux shell tool", tool.completed && hasNodeVersion(tool.answer), {
      answer: tool.answer,
      answerSource: tool.answerSource
    });

    const long = await tmuxAsk(
      provider,
      sessionName,
      "Write a Markdown numbered list from 1 to 60 where item N is exactly `N squared is <N*N>`. No other text."
    );
    const items = (long.answer || "").split("\n").filter((line) => /squared is/.test(line));
    check(
      results,
      "tmux long answer",
      long.completed &&
        items.length === 60 &&
        /1 squared is 1\b/.test(items[0]) &&
        /60 squared is 3600/.test(items[59]),
      {
        lines: items.length,
        first: items[0],
        last: items.at(-1),
        answerSource: long.answerSource,
        startMissing: long.startMissing
      }
    );
    if (provider === "grok") {
      // X search with photos downloaded (videos are large).
      const x = await call("llm_x_search", {
        query: "from:NASA filter:images",
        limit: 3,
        media: "download",
        timeoutMs
      });
      const photos = x.posts.flatMap((post) => post.media).filter((item) => item.path);
      check(results, "x search with photos", x.posts.length > 0 && photos.length > 0, {
        posts: x.posts.length,
        photos: photos.length,
        first: x.posts[0]?.url
      });
    }
  } catch (error) {
    check(results, "error", false, error.message);
  } finally {
    await call("llm_tmux_kill", { provider, sessionName }).catch(() => {});
  }
  return { provider, elapsedMs: Date.now() - started, results };
}

const outcomes = await Promise.all(providers.map(runProvider));
await client.close();

let failed = 0;
for (const outcome of outcomes) {
  console.log(`\n## ${outcome.provider} (${Math.round(outcome.elapsedMs / 1000)}s)`);
  for (const result of outcome.results) {
    failed += result.ok ? 0 : 1;
    console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name} ${JSON.stringify(result.detail)}`);
  }
}
process.exit(failed ? 1 : 0);
