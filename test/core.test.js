import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  IS_WINDOWS,
  PROVIDERS,
  ECHO_ARGS,
  TMUX_LABEL,
  fakeCommand,
  installFakeClis,
  killTestServer,
  npmShim,
  tempDir,
  tmuxAvailable,
  uniqueName
} from "./helpers.js";
import {
  buildTmuxArgv,
  buildTmuxCommand,
  ensureSession,
  findExecutable,
  headlessAsk,
  killSession,
  listProviders,
  locateMarkers,
  runCommand,
  sendInput,
  status,
  tmuxAsk,
  resolveModel,
  validateNonce,
  validateSessionName,
  waitForResponse,
  writeInputFile
} from "../src/core.js";

const HAS_TMUX = await tmuxAvailable();
const tmuxTest = HAS_TMUX ? test : test.skip;

test.after(killTestServer);

async function input(t, provider, markdown) {
  const stateDir = await tempDir(t, "llm-router-state-");
  const written = await writeInputFile({ provider, markdown, filename: `${provider}.md`, stateDir });
  return { stateDir, inputPath: written.inputPath };
}

function cleanupSession(t, provider, sessionName) {
  t.after(async () => {
    await killSession({ provider, sessionName });
  });
}

test("provider list and tmux commands expose all requested CLIs", () => {
  const providers = listProviders();
  assert.deepEqual(
    providers.map((provider) => provider.id),
    PROVIDERS
  );
  assert.match(buildTmuxCommand("codex", "gpt-test"), /^codex -m gpt-test --no-alt-screen /);
  assert.match(buildTmuxCommand("codex"), /check_for_update_on_startup=false/);
  // The prompt and answer files live in the request directory of the state
  // directory; by default every CLI may use any tool without asking.
  const requests = (provider) => path.join(path.resolve("/state"), "requests", provider);
  assert.deepEqual(buildTmuxArgv("claude", "opus", "/state"), [
    "claude",
    "--model",
    "opus",
    "--dangerously-skip-permissions",
    "--add-dir",
    requests("claude")
  ]);
  assert.match(buildTmuxCommand("codex"), /--dangerously-bypass-approvals-and-sandbox$/);
  assert.match(buildTmuxCommand("grok", "grok-test"), /^grok --no-alt-screen --minimal -m grok-test --permission-mode bypassPermissions$/);
  assert.deepEqual(buildTmuxArgv("antigravity", undefined, "/state"), [
    "agy",
    "--add-dir",
    requests("antigravity"),
    "--dangerously-skip-permissions"
  ]);
  assert.equal(buildTmuxArgv("codex").includes("--no-daemon"), IS_WINDOWS);

  // Scoped: read the prompt, write the answer, deny the rest without asking.
  process.env.LLM_ROUTER_MCP_PERMISSIONS = "scoped";
  try {
    assert.deepEqual(buildTmuxArgv("claude", "opus", "/state").slice(3), [
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      "Write,Edit",
      "--add-dir",
      requests("claude")
    ]);
    assert.deepEqual(buildTmuxArgv("codex", undefined, "/state").slice(-4), [
      "--ask-for-approval",
      "never",
      "--add-dir",
      requests("codex")
    ]);
    assert.match(buildTmuxCommand("grok"), /--permission-mode dontAsk --allow Write --allow Edit$/);
    assert.match(buildTmuxCommand("antigravity"), /--mode accept-edits$/);
  } finally {
    delete process.env.LLM_ROUTER_MCP_PERMISSIONS;
  }

  const byId = Object.fromEntries(providers.map((provider) => [provider.id, provider]));
  assert.equal(byId.claude.defaultInputMode, "paste");
  assert.equal(byId.codex.defaultInputMode, IS_WINDOWS ? "file" : "paste");
  assert.equal(byId.codex.defaultModel, "CLI default/latest");
  assert.deepEqual(byId.antigravity.aliases, ["agy", "google", "gemini"]);
});

test("names, nonces, and models that could be misread are rejected", () => {
  assert.throws(() => validateSessionName("a.b"), /sessionName/);
  assert.throws(() => validateSessionName("a:b"), /sessionName/);
  validateSessionName("codex-mcp_2");
  // A nonce must end where its marker ends, and it names files.
  assert.throws(() => validateNonce("abc.def"), /nonce/);
  assert.throws(() => validateNonce("abc:def"), /nonce/);
  validateNonce("Abc_123-x");
  // Models reach command lines.
  assert.throws(() => resolveModel("codex", 'gpt" & calc'), /model/);
  assert.equal(resolveModel("antigravity", "gemini-3.8-flash-low"), "gemini-3.8-flash-low");
  assert.equal(resolveModel("codex", "openai/gpt-5.5@2026"), "openai/gpt-5.5@2026");
  assert.equal(resolveModel("claude", "opus[1m]"), "opus[1m]");
  // A bad default for one provider does not hide the others.
  process.env.LLM_ROUTER_MCP_CLAUDE_MODEL = "bad model";
  try {
    const listed = listProviders();
    assert.equal(listed.length, 4);
    assert.match(listed.find((provider) => provider.id === "claude").error, /model/);
    assert.equal(listed.find((provider) => provider.id === "codex").error, undefined);
  } finally {
    delete process.env.LLM_ROUTER_MCP_CLAUDE_MODEL;
  }
});

test("marker extraction copes with TUI rendering", () => {
  const start = "GROK_TMUX_STARTED:nonce-1";
  const done = "GROK_TMUX_DONE:nonce-1";

  const plain = locateMarkers(`  ● ${start}\n\n    Answer line\n      nested\n\n    ${done}\n`, start, done);
  assert.equal(plain.completed, true);
  assert.equal(plain.answer, "Answer line\n  nested");

  // Markdown renderers join lines when the model leaves no blank line.
  const merged = locateMarkers(`${start} first part\n     more text END ${done}`, start, done);
  assert.equal(merged.answer, "first part\nmore text END");
  assert.equal(locateMarkers(`${start} inline answer ${done}`, start, done).answer, "inline answer");

  // Reasoning summaries quote the markers before the real ones.
  const quoted = locateMarkers(
    `Thinking: print \`${start}\` then \`${done}\`\n${start}\n\nreal answer\n\n${done}*`,
    start,
    done
  );
  assert.equal(quoted.answer, "real answer");

  // A timestamp on the marker row and longer nonces sharing the prefix are
  // ignored; the answer's own lines are kept as they are.
  const decorated = locateMarkers(
    `${done}-other\n${start}                    12:43 AM\n\n     line one   ██ 80%\n     ${done}`,
    start,
    done
  );
  assert.equal(decorated.answer, "line one   ██ 80%");

  // Mentions in quotes do not count; an unquoted mention of both markers is
  // superseded by the real, standalone start that follows it.
  const mentioned = locateMarkers(
    `I will print "${start}" first.\nPlan: ${start} then ${done}.\n${start}\n\nstill writing`,
    start,
    done
  );
  assert.equal(mentioned.completed, false);
  assert.equal(mentioned.started, true);
  const finished = locateMarkers(`Plan: ${start} then ${done}.\n● ${start}\n\nthe answer\n\n  ${done}`, start, done);
  assert.equal(finished.answer, "the answer");
  assert.equal(finished.confident, true);
  // A pair sharing lines with text is found but not trusted at once.
  assert.equal(locateMarkers(`${start} inline answer ${done}`, start, done).confident, false);

  // Table pipes and times in the answer are content.
  const table = locateMarkers(`${start}\n\n| a | b |\n|---|---|\nmeet at 9:30\n\n${done}`, start, done);
  assert.equal(table.answer, "| a | b |\n|---|---|\nmeet at 9:30");
  // Headless output is kept as printed.
  const raw = locateMarkers(`${start}\n\n    code block\nend |\n\n${done}`, start, done, { raw: true });
  assert.equal(raw.answer, "    code block\nend |");

  // Bold markers, a done marker mentioned inside the answer, and the chrome
  // Claude Code draws around tool calls.
  assert.equal(
    locateMarkers(`**${start}**\n\nThe answer.\n\n**${done}**`, start, done, { raw: true }).answer,
    "The answer."
  );
  assert.equal(
    locateMarkers(`${start}\n\nI print ${done} at the end.\nMore.\n\n${done}`, start, done).answer,
    `I print ${done} at the end.\nMore.`
  );
  assert.equal(
    locateMarkers(
      `● ${start}\n\n⏺ Read(req.md)\n  ⎿  Read 10 lines\n\n⏺ Here is the answer\n  second line\n\n  ${done}`,
      start,
      done
    ).answer,
    "Read(req.md)\n\nHere is the answer\nsecond line"
  );

  const notDone = locateMarkers(`${start}\nstill going`, start, done);
  assert.equal(notDone.started, true);
  assert.equal(notDone.completed, false);
  assert.equal(notDone.answer, null);
  const startMissing = locateMarkers(`tail of answer\n${done}`, start, done);
  assert.equal(startMissing.completed, false);
  assert.equal(startMissing.doneWithoutStart, true);
  // A done that only precedes the start belongs to nothing.
  const reversed = locateMarkers(`${done}\n${start}\nanswer`, start, done);
  assert.equal(reversed.completed, false);
  assert.equal(reversed.doneWithoutStart, false);
});

tmuxTest("tmux ask keeps context and supports paste and file input for each provider", async (t) => {
  for (const provider of PROVIDERS) {
    for (const inputMode of ["paste", "file"]) {
      const sessionName = uniqueName(`${provider}-${inputMode}`);
      cleanupSession(t, provider, sessionName);
      const { stateDir, inputPath } = await input(t, provider, `# ${provider} review\n\nA long Markdown prompt.\n`);

      for (const turn of [1, 2]) {
        const result = await tmuxAsk({
          provider,
          inputPath,
          inputMode,
          sessionName,
          command: fakeCommand(),
          cwd: process.cwd(),
          stateDir,
          timeoutMs: 20000,
          pollMs: 50
        });

        assert.equal(result.mode, "tmux");
        assert.equal(result.inputMode, inputMode);
        // By default the model writes the answer file.
        assert.equal(result.outputMode, "file");
        assert.equal(result.answerSource, "file");
        assert.equal(result.sent, true);
        assert.equal(result.completed, true, `${provider}/${inputMode} turn ${turn}`);
        assert.equal(result.timedOut, false);
        assert.equal(result.sessionCreated, turn === 1);
        // The fake submits only on the Enter after the paste.
        assert.equal(result.submitAttempts, 1);
        // The same CLI process answers the second turn.
        assert.match(result.answer, new RegExp(`^fake tmux ${turn} answer\\nprompt bytes \\d+$`));
        assert.equal(await fs.readFile(result.responsePath, "utf8"), `${result.answer}\n`);

        const current = await status({ provider, sessionName, nonce: result.nonce });
        assert.equal(current.running, true);
        assert.equal(current.markerStatus.started, true);
        assert.equal(current.markerStatus.completed, true);
      }
    }
  }
});

tmuxTest("tmux ask extracts answers whose markers share lines or are quoted first", async (t) => {
  const sessionName = uniqueName("merged");
  cleanupSession(t, "grok", sessionName);
  const { stateDir, inputPath } = await input(t, "grok", "QUOTED_MARKER MERGED_MARKERS");
  const result = await tmuxAsk({
    provider: "grok",
    inputPath,
    outputMode: "pane",
    sessionName,
    command: fakeCommand(),
    cwd: process.cwd(),
    stateDir,
    timeoutMs: 20000,
    pollMs: 50
  });
  assert.equal(result.completed, true);
  assert.equal(result.answer, "fake tmux 1 answer first line\nsecond line END");
});

tmuxTest("the answer file is the answer, with the pane as fallback", async (t) => {
  const sessionName = uniqueName("answer-file");
  cleanupSession(t, "claude", sessionName);
  const stateDir = await tempDir(t, "llm-router-state-");
  const ask = async (markdown, extra = {}) => {
    const { inputPath } = await writeInputFile({ provider: "claude", markdown, stateDir });
    return await tmuxAsk({
      provider: "claude",
      inputPath,
      sessionName,
      command: fakeCommand(),
      cwd: process.cwd(),
      stateDir,
      timeoutMs: 30000,
      pollMs: 50,
      ...extra
    });
  };

  const written = await ask("SAY: | a | b |\n");
  assert.equal(written.answerSource, "file");
  assert.equal(written.answer, "| a | b |");
  assert.match(written.answerPath, /\.answer\.md$/);
  assert.equal(await fs.readFile(written.responsePath, "utf8"), "| a | b |\n");

  // The model could not write the file and answered in the chat.
  const inPane = await ask("SAY: from the pane\nNO_FILE");
  assert.equal(inPane.answerSource, "pane");
  assert.equal(inPane.answer, "from the pane");

  // The file was written but the done marker never came.
  const forgot = await ask("SAY: written anyway\nFORGET_DONE");
  assert.equal(forgot.completed, true);
  assert.equal(forgot.answerSource, "file");
  assert.equal(forgot.answer, "written anyway");
});

tmuxTest("tmux send presses Enter again when the TUI kept it as part of the paste", async (t) => {
  const sessionName = uniqueName("swallow");
  cleanupSession(t, "codex", sessionName);
  const { stateDir, inputPath } = await input(t, "codex", "Question");
  const result = await tmuxAsk({
    provider: "codex",
    inputPath,
    inputMode: "file",
    sessionName,
    command: fakeCommand("--fake-swallow-enter"),
    cwd: process.cwd(),
    stateDir,
    timeoutMs: 30000,
    pollMs: 50
  });
  assert.equal(result.completed, true);
  assert.equal(result.submitAttempts, 2);
  assert.match(result.answer, /fake tmux 1 answer/);
});

tmuxTest("folder trust prompts are answered only for the router's own workdir", async (t) => {
  // Kill the sessions before their workdir under stateDir is removed.
  const managed = uniqueName("trust-managed");
  const foreign = uniqueName("trust-foreign");
  cleanupSession(t, "antigravity", managed);
  cleanupSession(t, "antigravity", foreign);
  const { stateDir, inputPath } = await input(t, "antigravity", "Question");

  const result = await tmuxAsk({
    provider: "antigravity",
    inputPath,
    sessionName: managed,
    command: fakeCommand("--fake-trust"),
    stateDir,
    timeoutMs: 30000,
    pollMs: 50
  });
  assert.equal(result.completed, true);
  assert.deepEqual(result.dialogsAnswered, ["trust"]);

  const blocked = (error) => {
    assert.match(error.message, /trust/);
    assert.equal(error.details.blocker, "trust");
    return true;
  };
  await assert.rejects(
    sendInput({
      provider: "antigravity",
      inputPath,
      sessionName: foreign,
      command: fakeCommand("--fake-trust"),
      cwd: process.cwd(),
      stateDir,
      timeoutMs: 30000
    }),
    blocked
  );
  // A later call without cwd does not make the router trust that folder.
  await assert.rejects(
    sendInput({ provider: "antigravity", inputPath, sessionName: foreign, stateDir, timeoutMs: 30000 }),
    blocked
  );
  const trusted = await tmuxAsk({
    provider: "antigravity",
    inputPath,
    sessionName: foreign,
    stateDir,
    trustCwd: true,
    timeoutMs: 30000,
    pollMs: 50
  });
  assert.equal(trusted.completed, true);
  assert.deepEqual(trusted.dialogsAnswered, ["trust"]);
});

tmuxTest("answers are not mistaken for setup screens or questions", async (t) => {
  const sessionName = uniqueName("answers");
  cleanupSession(t, "codex", sessionName);
  const stateDir = await tempDir(t, "llm-router-state-");
  const ask = async (text) => {
    const { inputPath } = await writeInputFile({ provider: "codex", markdown: `SAY: ${text}`, stateDir });
    // The answer must be on the screen for this test.
    return await tmuxAsk({
      provider: "codex",
      inputPath,
      inputMode: "file",
      outputMode: "pane",
      sessionName,
      command: fakeCommand(),
      cwd: process.cwd(),
      stateDir,
      timeoutMs: 20000,
      pollMs: 50
    });
  };
  // Every call reads the session's state from tmux, as a restarted server would.
  for (const text of [
    "If the user is not logged in, show Sign in with GitHub.",
    "Do you trust the contents of this directory? Only if you wrote it.",
    "Do you want to proceed with option B? (y/n)",
    "done"
  ]) {
    const result = await ask(text);
    assert.equal(result.completed, true, text);
    assert.equal(result.answer, text);
  }
  assert.equal((await status({ provider: "codex", sessionName })).running, true);
});

tmuxTest("sessions without the router's record are treated as the built-in CLI", async (t) => {
  // As left by an older router version or started by hand.
  const sessionName = uniqueName("unmarked");
  cleanupSession(t, "grok", sessionName);
  const stateDir = await tempDir(t, "llm-router-state-");
  await runCommand("tmux", ["-L", TMUX_LABEL, "new-session", "-d", "-s", sessionName, "-x", "160", "-y", "50", "--", ...fakeCommand()]);
  const ask = async (text) => {
    const { inputPath } = await writeInputFile({ provider: "grok", markdown: `SAY: ${text}`, stateDir });
    return await tmuxAsk({
      provider: "grok",
      inputPath,
      inputMode: "file",
      outputMode: "pane",
      sessionName,
      stateDir,
      timeoutMs: 20000,
      pollMs: 50
    });
  };
  const first = await ask("If you are not logged in, run grok login first.");
  assert.equal(first.completed, true);
  // Forget what the router recorded, as after an upgrade.
  for (const option of ["@llm_router_ready", "@llm_router_custom", "@llm_router_trust"]) {
    await runCommand("tmux", ["-L", TMUX_LABEL, "set-option", "-u", "-t", `=${sessionName}:`, option], { allowFailure: true });
  }
  const second = await ask("still here");
  assert.equal(second.completed, true);
  assert.equal(second.answer, "still here");
});

tmuxTest("questions on the screen stop a send or a wait", async (t) => {
  const menu = uniqueName("menu");
  cleanupSession(t, "grok", menu);
  const { stateDir, inputPath } = await input(t, "grok", "Question");
  await assert.rejects(
    sendInput({
      provider: "grok",
      inputPath,
      sessionName: menu,
      command: fakeCommand("--fake-menu"),
      cwd: process.cwd(),
      stateDir,
      timeoutMs: 20000
    }),
    (error) => {
      assert.equal(error.details.blocker, "dialog");
      return true;
    }
  );

  const permission = uniqueName("permission");
  cleanupSession(t, "grok", permission);
  const asked = await input(t, "grok", "PROMPT_MENU");
  const startedAt = Date.now();
  const result = await tmuxAsk({
    provider: "grok",
    inputPath: asked.inputPath,
    outputMode: "pane",
    sessionName: permission,
    command: fakeCommand(),
    cwd: process.cwd(),
    stateDir: asked.stateDir,
    timeoutMs: 60000,
    pollMs: 50
  });
  assert.equal(result.completed, false);
  assert.equal(result.blocked, "prompt");
  assert.ok(Date.now() - startedAt < 30000);
});

tmuxTest("a cancelled send types nothing", async (t) => {
  const sessionName = uniqueName("cancel");
  cleanupSession(t, "claude", sessionName);
  const { stateDir, inputPath } = await input(t, "claude", "Question");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    sendInput({
      provider: "claude",
      inputPath,
      sessionName,
      command: fakeCommand(),
      cwd: process.cwd(),
      stateDir,
      signal: controller.signal
    }),
    /cancelled/
  );
  assert.equal((await status({ provider: "claude", sessionName })).exists, false);
});

tmuxTest("a CLI that exits is reported and its session is replaced", async (t) => {
  const sessionName = uniqueName("exit");
  cleanupSession(t, "claude", sessionName);
  const { stateDir, inputPath } = await input(t, "claude", "Question");

  await assert.rejects(
    sendInput({
      provider: "claude",
      inputPath,
      sessionName,
      command: fakeCommand("--fake-exit", "3"),
      cwd: process.cwd(),
      stateDir,
      timeoutMs: 20000
    }),
    (error) => {
      assert.match(error.message, /exited with status 3/);
      assert.match(error.details.paneTail, /fake fatal error/);
      return true;
    }
  );

  const session = await ensureSession({
    provider: "claude",
    sessionName,
    command: fakeCommand(),
    cwd: process.cwd(),
    stateDir,
    timeoutMs: 20000
  });
  assert.equal(session.ready, true);
  assert.equal(session.created, true);
  assert.equal(session.replacedDeadSession.exitStatus, 3);
});

tmuxTest("tmux wait returns timeout state and Markdown fallback when done marker is missing", async (t) => {
  const sessionName = uniqueName("timeout");
  cleanupSession(t, "grok", sessionName);
  const { stateDir, inputPath } = await input(t, "grok", "NO_DONE_MARKER");

  const sent = await sendInput({
    provider: "grok",
    inputPath,
    outputMode: "pane",
    sessionName,
    command: fakeCommand(),
    cwd: process.cwd(),
    stateDir,
    timeoutMs: 20000
  });
  assert.equal(sent.sent, true);

  const waited = await waitForResponse({
    provider: "grok",
    sessionName,
    nonce: sent.nonce,
    timeoutMs: 300,
    pollMs: 50,
    stateDir
  });
  assert.equal(waited.started, true);
  assert.equal(waited.completed, false);
  assert.equal(waited.timedOut, true);
  assert.match(waited.fallbackPath, /\.fallback\.md$/);
  assert.match(await fs.readFile(waited.fallbackPath, "utf8"), /timed out/);
});

test("headless ask uses one-shot CLI calls and writes Markdown outputs", async (t) => {
  await installFakeClis(t);
  const stateDir = await tempDir(t, "llm-router-headless-");

  for (const provider of PROVIDERS) {
    const result = await headlessAsk({
      provider,
      markdown: `# ${provider} one shot\n\nReturn a short answer.`,
      filename: `${provider}.md`,
      stateDir,
      cwd: process.cwd(),
      timeoutMs: 20000,
      model: "test-model"
    });

    assert.equal(result.mode, "headless");
    assert.equal(result.success, true, `${provider}: ${result.stderr}`);
    assert.equal(result.exitCode, 0);
    assert.equal(result.markersFound, true);
    // Codex's answer comes from --output-last-message, not its stdout.
    assert.match(
      result.answer,
      provider === "codex" ? /^fake headless answer \(last message\)\n/ : /^fake headless answer\n/
    );
    assert.match(result.responsePath, /\.response\.md$/);
    assert.match(result.rawResponsePath, /\.raw\.md$/);
    assert.equal(await fs.readFile(result.responsePath, "utf8"), `${result.answer}\n`);
  }
});

test("headless ask reports a timeout with the partial output", async (t) => {
  const fakeBin = await installFakeClis(t);
  const stateDir = await tempDir(t, "llm-router-headless-timeout-");
  const slow = `${process.execPath}`;
  if (IS_WINDOWS) {
    await fs.writeFile(
      path.join(fakeBin, "claude.cmd"),
      `@echo off\r\n"${slow}" -e "process.stdout.write('partial'); setTimeout(() => {}, 60000)"\r\n`
    );
  } else {
    await fs.writeFile(
      path.join(fakeBin, "claude"),
      `#!/usr/bin/env bash\nexec '${slow}' -e "process.stdout.write('partial'); setTimeout(() => {}, 60000)"\n`,
      { mode: 0o755 }
    );
  }
  const startedAt = Date.now();
  const result = await headlessAsk({
    provider: "claude",
    markdown: "slow",
    stateDir,
    cwd: process.cwd(),
    timeoutMs: 1500
  });
  assert.equal(result.success, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.answer, null);
  assert.ok(Date.now() - startedAt < 15000);
  assert.match(await fs.readFile(result.rawResponsePath, "utf8"), /partial/);
});

test("commands are found through PATHEXT and npm shims on Windows", { skip: !IS_WINDOWS }, async (t) => {
  const bin = await tempDir(t, "llm-router-exec-");
  const scriptDir = path.join(bin, "node_modules", "echo", "bin");
  await fs.mkdir(scriptDir, { recursive: true });
  await fs.copyFile(ECHO_ARGS, path.join(scriptDir, "echo.js"));
  await fs.writeFile(path.join(bin, "echoshim.cmd"), npmShim("node_modules\\echo\\bin\\echo.js"));
  await fs.writeFile(path.join(bin, "echoshim"), "#!/bin/sh\n");
  await fs.writeFile(path.join(bin, "echocmd.cmd"), `@echo off\r\n"${process.execPath}" "${ECHO_ARGS}" %*\r\n`);
  const env = { PATH: bin, PATHEXT: ".COM;.EXE;.BAT;.CMD" };

  // The extension-less sh script npm also writes is not runnable on Windows.
  assert.equal(findExecutable("echoshim", env), path.join(bin, "echoshim.cmd"));
  assert.equal(findExecutable("missing-command", env), null);

  const old = process.env.LLM_ROUTER_MCP_PATH_PREFIX;
  process.env.LLM_ROUTER_MCP_PATH_PREFIX = bin;
  t.after(() => {
    if (old === undefined) {
      delete process.env.LLM_ROUTER_MCP_PATH_PREFIX;
    } else {
      process.env.LLM_ROUTER_MCP_PATH_PREFIX = old;
    }
  });
  const args = ["--model", "a b", "C:\\dir with space\\file.md", "x=1"];
  for (const command of ["echoshim", "echocmd"]) {
    const result = await runCommand(command, args, { timeoutMs: 15000 });
    assert.deepEqual(JSON.parse(result.stdout), args, command);
  }
  await assert.rejects(runCommand("echocmd", ["two\nlines"]), /multi-line argument/);
  // A batch file would parse an embedded quote again.
  await assert.rejects(runCommand("echocmd", ['a" & calc & "b']), /double quote/);
});
