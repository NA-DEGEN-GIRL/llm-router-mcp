import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  IS_WINDOWS,
  TMUX_LABEL,
  fakeCommand,
  installFakeClis,
  killTestServer,
  tempDir,
  tmuxAvailable,
  uniqueName
} from "./helpers.js";
import { killSession } from "../src/core.js";

const HAS_TMUX = await tmuxAvailable();

test.after(killTestServer);

async function connect(t, extraEnv = {}) {
  const client = new Client({
    name: "llm-router-mcp-test-client",
    version: "0.0.0"
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["bin/llm-router-mcp.js"],
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv, LLM_ROUTER_MCP_TMUX_LABEL: TMUX_LABEL },
    stderr: "pipe"
  });
  await client.connect(transport);
  t.after(async () => {
    await client.close();
  });
  return client;
}

test("stdio MCP server exposes the unified LLM router tools", async (t) => {
  const client = await connect(t);
  const result = await client.listTools();
  const names = result.tools.map((tool) => tool.name).sort();

  assert.deepEqual(names, [
    "llm_headless_ask",
    "llm_list_providers",
    "llm_tmux_ask",
    "llm_tmux_capture",
    "llm_tmux_kill",
    "llm_tmux_send",
    "llm_tmux_start",
    "llm_tmux_status",
    "llm_tmux_wait",
    "llm_tmux_wait_start",
    "llm_write_input"
  ]);

  const listed = parseToolResult(
    await client.callTool({ name: "llm_list_providers", arguments: { check: true } })
  );
  assert.equal(listed.providers.length, 4);
  assert.equal(listed.check.providers.length, 4);
  assert.equal(typeof listed.check.tmux.available, "boolean");
});

test("tool errors come back as error results with details", async (t) => {
  const client = await connect(t);
  const result = await client.callTool({
    name: "llm_tmux_status",
    arguments: { provider: "codex", sessionName: "bad.name" }
  });
  assert.equal(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  assert.match(body.error, /sessionName/);
  assert.equal(body.details.sessionName, "bad.name");
});

test("stdio MCP server can ask a provider through a tmux-backed fake session", { skip: !HAS_TMUX }, async (t) => {
  const tmp = await tempDir(t, "llm-router-mcp-stdio-");
  const sessionName = uniqueName("stdio");
  t.after(async () => {
    await killSession({ provider: "claude", sessionName });
  });

  const client = await connect(t);
  const written = parseToolResult(
    await client.callTool({
      name: "llm_write_input",
      arguments: {
        provider: "claude",
        markdown: "End-to-end MCP request.",
        filename: "stdio.md",
        stateDir: tmp
      }
    })
  );

  const progress = [];
  const asked = parseToolResult(
    await client.callTool(
      {
        name: "llm_tmux_ask",
        arguments: {
          provider: "claude",
          inputPath: written.inputPath,
          sessionName,
          command: fakeCommand(),
          cwd: process.cwd(),
          stateDir: tmp,
          timeoutMs: 20000,
          pollMs: 50
        }
      },
      CallToolResultSchema,
      { onprogress: (notification) => progress.push(notification) }
    )
  );

  assert.equal(asked.completed, true);
  assert.equal(asked.timedOut, false);
  assert.match(asked.answer, /fake tmux/);
  assert.match(asked.responsePath, /\.response\.md$/);
  assert.match(await fs.readFile(asked.responsePath, "utf8"), /fake tmux/);
  assert.ok(progress.length >= 1, "progress notifications were sent");

  const killed = parseToolResult(
    await client.callTool({ name: "llm_tmux_kill", arguments: { provider: "claude", sessionName } })
  );
  assert.equal(killed.killed, true);
});

test("a client that disconnects takes running headless CLIs with it", async (t) => {
  const fakeBin = await installFakeClis(t);
  const stateDir = await tempDir(t, "llm-router-mcp-shutdown-");
  const pidFile = path.join(stateDir, "slow.pid");
  const slowScript = path.join(stateDir, "slow.js");
  await fs.writeFile(
    slowScript,
    `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\nsetTimeout(() => {}, 120000);\n`
  );
  if (IS_WINDOWS) {
    await fs.writeFile(path.join(fakeBin, "claude.cmd"), `@echo off\r\n"${process.execPath}" "${slowScript}"\r\n`);
  } else {
    await fs.writeFile(path.join(fakeBin, "claude"), `#!/usr/bin/env bash\nexec '${process.execPath}' '${slowScript}'\n`, {
      mode: 0o755
    });
  }

  const client = await connect(t, { LLM_ROUTER_MCP_PATH_PREFIX: fakeBin });
  const call = client
    .callTool({
      name: "llm_headless_ask",
      arguments: { provider: "claude", markdown: "slow", stateDir, cwd: process.cwd(), timeoutMs: 120000 }
    })
    .catch(() => null);
  let pid = null;
  for (let i = 0; i < 100 && pid === null; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    pid = Number(await fs.readFile(pidFile, "utf8").catch(() => "")) || null;
  }
  assert.ok(pid, "the slow CLI started");
  await client.close();
  await call;

  let alive = true;
  for (let i = 0; i < 50 && alive; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, "the headless CLI was killed");
});

function parseToolResult(result) {
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}
