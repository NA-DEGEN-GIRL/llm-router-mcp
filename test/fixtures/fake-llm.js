#!/usr/bin/env node

import fs from "node:fs";

const args = process.argv.slice(2);
const POINTER = /Read the Markdown request file at (.+?) and follow its instructions exactly\./;

if (args.includes("--version") || args.includes("version")) {
  console.log("fake-llm 0.1.0");
  process.exit(0);
}

if (args.includes("--json-schema")) {
  // grok's structured X search answer.
  const prompt = readHeadlessPrompt(args);
  const mediaUrl = process.env.FAKE_X_MEDIA_URL || "https://pbs.twimg.com/media/fake.jpg";
  const result = {
    summary: "Fake posts about the query.",
    posts: [
      {
        url: "https://x.com/fake/status/1",
        author: "Fake (@fake)",
        createdAt: "2026-10-18T00:00:00Z",
        text: `about ${/Query: (.*)/.exec(prompt)?.[1] || ""}`,
        likes: 3,
        media: [
          { type: "photo", url: mediaUrl, altText: "a fake photo" },
          { type: "photo", url: "https://example.com/not-x-media.jpg" },
          { type: "video", url: mediaUrl.replace(/\.jpg$/, ".mp4"), durationMs: 2000 }
        ]
      }
    ]
  };
  const textual = prompt.includes("FAKE_TEXT_JSON");
  process.stdout.write(
    JSON.stringify({
      // Like grok when the model writes a placeholder before the real object.
      text: textual
        ? `Here you go: {"summary":"","posts":[]}${JSON.stringify(result)}`
        : JSON.stringify(result),
      structuredOutput: textual ? null : result,
      total_cost_usd: 0.01
    })
  );
} else if (isHeadless(args)) {
  const prompt = readHeadlessPrompt(args);
  const outputIndex = args.indexOf("--output-last-message");
  if (outputIndex !== -1 && args[outputIndex + 1]) {
    // Codex prints a transcript on stdout and the final message to the file.
    fs.writeFileSync(args[outputIndex + 1], answer(prompt, "headless", "last message"));
    process.stdout.write(`fake transcript\n${answer(prompt, "headless", "stdout")}`);
  } else {
    process.stdout.write(answer(prompt, "headless"));
  }
} else {
  interactive();
}

function interactive() {
  const exitIndex = args.indexOf("--fake-exit");
  if (exitIndex !== -1) {
    process.stdout.write("fake fatal error before ready\n");
    setTimeout(() => process.exit(Number(args[exitIndex + 1] || 1)), 200);
    return;
  }

  if (args.includes("--fake-menu")) {
    // A question that never goes away.
    process.stdout.write("Pick one\n> 1. Allow\n  2. Deny\n");
    process.stdin.resume();
    return;
  }

  const swallowEnter = args.includes("--fake-swallow-enter");
  let trustPending = args.includes("--fake-trust");
  let buffer = "";
  let partial = "";
  let requestCount = 0;
  let waitingForEnter = null;
  let enterToSkip = 0;

  if (trustPending) {
    process.stdout.write(
      "Do you trust the contents of this project?\n\n> Yes, I trust this folder\n  No, exit\n"
    );
  } else {
    process.stdout.write("fake LLM ready\n> ");
  }

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    // Bracketed paste markers reach a cooked-mode reader as plain text.
    partial += chunk.replace(/\r\n?/g, "\n").replace(/\x1b\[20[01]~/g, "");
    let newline = partial.indexOf("\n");
    while (newline !== -1) {
      onLine(partial.slice(0, newline));
      partial = partial.slice(newline + 1);
      newline = partial.indexOf("\n");
    }
  });

  function onLine(line) {
    if (trustPending) {
      trustPending = false;
      process.stdout.write("\x1b[2J\x1b[Htrusted\nfake LLM ready\n> ");
      return;
    }
    if (waitingForEnter !== null) {
      if (line.trim() === "") {
        if (enterToSkip > 0) {
          enterToSkip -= 1;
          return;
        }
        const request = waitingForEnter;
        waitingForEnter = null;
        respond(request);
      }
      return;
    }

    buffer += `${line}\n`;
    let request = null;
    // A pasted prompt is submitted by the Enter that follows it; a pointer
    // line arrives with its Enter.
    let enters = 0;
    const pointer = POINTER.exec(line);
    if (pointer) {
      request = fs.readFileSync(pointer[1], "utf8");
    } else if (buffer.includes("--- END MCP MARKDOWN INPUT ---")) {
      request = buffer;
      enters = 1;
    }
    if (request === null) {
      return;
    }
    buffer = "";
    if (swallowEnter) {
      // Like a TUI that took the first Enter as part of the paste.
      enters += 1;
    }
    if (enters === 0) {
      respond(request);
      return;
    }
    waitingForEnter = request;
    enterToSkip = enters - 1;
  }

  function respond(request) {
    requestCount += 1;
    const ticks = /^TICKS: (\d+)$/m.exec(request);
    if (ticks) {
      // A slow answer that keeps the screen moving, like a spinner.
      let left = Number(ticks[1]);
      const timer = setInterval(() => {
        process.stdout.write(`working ${left}\n`);
        left -= 1;
        if (left <= 0) {
          clearInterval(timer);
          process.stdout.write(answer(request, `tmux ${requestCount}`));
          process.stdout.write("> ");
        }
      }, 200);
      return;
    }
    process.stdout.write(answer(request, `tmux ${requestCount}`));
    process.stdout.write("> ");
  }
}

function isHeadless(args) {
  return (
    args.includes("exec") ||
    args.includes("-p") ||
    args.includes("--prompt-file") ||
    args.some((arg) => arg.startsWith("--print"))
  );
}

function readHeadlessPrompt(args) {
  const promptFileIndex = args.indexOf("--prompt-file");
  if (promptFileIndex !== -1 && args[promptFileIndex + 1]) {
    return fs.readFileSync(args[promptFileIndex + 1], "utf8");
  }
  const print = args.find((arg) => arg.startsWith("--print="));
  if (print) {
    const value = print.slice("--print=".length);
    const pointer = POINTER.exec(value);
    return pointer ? fs.readFileSync(pointer[1], "utf8") : value;
  }
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function answer(prompt, mode, variant = "") {
  const markers = findMarkers(prompt);
  if (!markers) {
    return `fake ${mode} response without markers\n`;
  }
  const start = `${markers.startPrefix}${markers.nonce}`;
  const done = `${markers.donePrefix}${markers.nonce}`;
  const label = variant ? `fake ${mode} answer (${variant})` : `fake ${mode} answer`;

  // Asked to write the answer to a file: do that and only note it in the chat.
  const answerFile = /with your file-writing tool:\n(.+)\n/.exec(prompt);
  if (answerFile && !prompt.includes("NO_FILE")) {
    const say = /^SAY: (.*)$/m.exec(prompt);
    const body = say ? say[1] : `${label}\nprompt bytes ${Buffer.byteLength(prompt, "utf8")}`;
    fs.writeFileSync(answerFile[1].trim(), `${body}\n`);
    if (prompt.includes("FORGET_DONE")) {
      return `${start}\n\nAnswer written to the file.\n`;
    }
    return `${start}\n\nAnswer written to the file.\n\n${done}\n`;
  }
  let out = "";

  if (prompt.includes("QUOTED_MARKER")) {
    out += `Thinking: I will print \`${start}\` and later \`${done}\` as asked.\n`;
  }
  if (prompt.includes("NO_DONE_MARKER")) {
    return `${out}${start}\n\nfake ${mode} started without done marker\n`;
  }
  if (prompt.includes("PROMPT_MENU")) {
    // Stops on a permission question, as a CLI asking to run a tool does.
    return `${out}${start}\n\nNeed permission to continue\n> 1. Yes, allow\n  2. No\n`;
  }
  const say = /^SAY: (.*)$/m.exec(prompt);
  if (say) {
    return `${out}${start}\n\n${say[1]}\n\n${done}\n`;
  }
  if (prompt.includes("MERGED_MARKERS")) {
    // What a Markdown renderer shows when the model leaves no blank lines.
    return `${out}${start} ${label} first line\n  second line END ${done}\n`;
  }
  return `${out}${start}\n\n${label}\nprompt bytes ${Buffer.byteLength(prompt, "utf8")}\n\n${done}\n`;
}

function findMarkers(value) {
  const prefixes = [...value.matchAll(/- literal prefix:\s*([A-Z_]+_TMUX_(?:STARTED|DONE):)/g)].map(
    (match) => match[1]
  );
  const nonceMatch = /- nonce:\s*([A-Za-z0-9_.:-]{6,96})/.exec(value);
  if (prefixes.length < 2 || !nonceMatch) {
    return null;
  }
  return {
    startPrefix: prefixes[0],
    donePrefix: prefixes[1],
    nonce: nonceMatch[1]
  };
}
