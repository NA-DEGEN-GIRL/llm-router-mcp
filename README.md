# llm-router-mcp

`llm-router-mcp` is a local stdio MCP server for asking the LLM CLIs you use
most from one MCP client:

- Codex
- Claude
- Grok
- Antigravity (`agy`)

It supports both persistent provider sessions and isolated one-shot calls, on
Linux, macOS, and Windows.

| Workflow | Use it when | Main tool |
| --- | --- | --- |
| Persistent `tmux` session | You want the provider to keep multi-turn context. | `llm_tmux_ask` |
| Headless one-shot | You want an isolated answer that should not enter long-lived context. | `llm_headless_ask` |
| Split send/wait | You want to start a long request and poll or inspect it later. | `llm_tmux_send` + `llm_tmux_wait` |

Both workflows use Markdown files for input and output. In a persistent
session the model writes its answer to a Markdown file and prints nonce
markers so the MCP can tell when it starts and finishes; the router reads the
file, not the terminal (the pane is only a fallback). Headless calls read the
CLI's printed answer. The high-level tools handle all of this and return the
answer plus response file paths.

Every CLI runs with full permissions by default, so a task sent through the
MCP can use shell commands, file edits, and the network without anyone
approving them. See [Permissions](#permissions).

## Requirements

- Node.js 20+
- `tmux`. On Windows use the native port
  [tmux-windows](https://github.com/arndawg/tmux-windows)
  (`winget install arndawg.tmux-windows`); no WSL or MSYS2 tmux is needed.
- The desired CLIs installed and logged in on the same machine that launches the
  MCP server:
  - `codex`
  - `claude`
  - `grok`
  - `agy`

Run each CLI once in a terminal before using it through the MCP, so first-run
setup (theme, login) is done. Folder-trust prompts for the router's own scratch
workdirs are answered automatically; see [Startup screens](#startup-screens).

## Quick Start

```bash
git clone https://github.com/NA-DEGEN-GIRL/llm-router-mcp.git "$HOME/llm-router-mcp"
cd "$HOME/llm-router-mcp"
npm install
npm test
```

`npm test` uses fake provider commands and its own `tmux` server (label
`lrm-test-*`), so it never touches your sessions. It verifies the MCP server
starts, exposes the expected tools, builds provider command lines, and writes
Markdown request and response files. It does not require the real LLM CLIs to
be logged in.

`npm run test:real` asks the real, logged-in CLIs through the MCP server:
a headless question, a two-turn tmux conversation that must remember a
codeword, and a 60-line answer. It uses its own `tmux` server (label
`lrm-e2e`) and kills its sessions afterwards. Pass provider names to test only
some of them: `npm run test:real -- codex grok`.

## Codex MCP Config

Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.llm-router]
command = "node"
args = ["/absolute/path/to/llm-router-mcp/bin/llm-router-mcp.js"]
# Codex stops waiting for a tool after 60 seconds by default, which is shorter
# than most persistent-session answers.
tool_timeout_sec = 900

[mcp_servers.llm-router.env]
LLM_ROUTER_MCP_STATE_DIR = "/absolute/path/to/.local/state/llm-router-mcp"
```

Restart Codex after changing MCP config.

Use real absolute paths in `args` and `LLM_ROUTER_MCP_STATE_DIR`. Some MCP
clients do not expand `~` or `$HOME` when they launch a command. On Windows,
write paths with forward slashes or doubled backslashes, for example
`"C:/Users/me/llm-router-mcp/bin/llm-router-mcp.js"`.

## Other MCP Clients

The server is a normal stdio MCP server, so it can also be used from Claude,
Grok, Antigravity, or any MCP client that can launch a local command.

JSON-style clients can use:

```json
{
  "mcpServers": {
    "llm-router": {
      "command": "node",
      "args": ["/absolute/path/to/llm-router-mcp/bin/llm-router-mcp.js"],
      "env": {
        "LLM_ROUTER_MCP_STATE_DIR": "/absolute/path/to/.local/state/llm-router-mcp"
      }
    }
  }
}
```

The machine running this MCP must have the target CLI installed and logged in.
For example, asking Grok through this MCP requires `grok` to be available on the
same `PATH` used by the MCP process. `llm_list_providers` with `check: true`
shows which CLIs the server can find.

Long `llm_tmux_ask` and `llm_tmux_wait` calls send MCP progress notifications
every few seconds when the client asks for them, and stop when the client
cancels the request.

## Tools

| Tool | Purpose |
| --- | --- |
| `llm_list_providers` | List providers, aliases, default sessions, models, and input modes. `check: true` also looks up `tmux` and each CLI. |
| `llm_write_input` | Write a Markdown prompt into the state directory and return `inputPath`. |
| `llm_headless_ask` | Run one provider once without persistent context. Accepts `markdown` or `inputPath`. |
| `llm_tmux_ask` | Send a Markdown input to a persistent provider session and wait for the final answer. |
| `llm_tmux_start` | Create or reuse a provider `tmux` session and wait until it shows its input prompt. Reuse preserves context. |
| `llm_tmux_send` | Send a Markdown input to a persistent session and return nonce markers. |
| `llm_tmux_wait_start` | Wait until the provider prints the nonce start marker. |
| `llm_tmux_wait` | Wait for the nonce done marker and write the response Markdown file. |
| `llm_tmux_status` | Check whether a session is running, whether its CLI exited, and whether a nonce started or completed. |
| `llm_tmux_capture` | Capture recent `tmux` pane text for debugging stuck sessions. |
| `llm_tmux_kill` | Kill a provider session. Its context is lost; the next call starts a fresh CLI. |

Tool responses are returned as JSON text. Successful ask calls include the
extracted `answer`, a Markdown `responsePath`, nonce marker metadata, and
timing details; headless calls also return the raw stdout/stderr log path.
Failed calls return an MCP error result whose JSON has `error` and `details`
(for example the pane text of a CLI that did not start). Timed-out or blocked
`tmux` waits write a fallback Markdown file so the partial pane output is
still inspectable. `llm_tmux_start` does not fail when a session is not ready:
it returns `ready: false` with a `blocker` (`trust`, `login`, `dialog`, ...)
and the pane text.

Session options for `llm_tmux_start`, `llm_tmux_send`, and `llm_tmux_ask`:

| Option | Meaning |
| --- | --- |
| `command` | Command for a new session. A string runs through tmux's `default-shell`; a list runs directly as program and arguments. |
| `model` | Model for a new session. A running session keeps its model; the result then has `modelMismatch` and a `warning`. |
| `cwd` | Working directory for a new session. Defaults to the provider's scratch workdir. |
| `trustCwd` | Answer the CLI's folder-trust prompt with yes. Defaults to true only for a session the router started in its own scratch workdir. |
| `inputMode` | `paste` pastes the whole prompt; `file` pastes one line asking the model to read the prompt file. See below. |
| `outputMode` | `file` (default) has the model write the answer to a Markdown file; `pane` reads it from the tmux pane. See below. |
| `columns`, `rows` | Size of a new session's window (default 160x50). |

## Usage Examples

One-shot request with no persistent context:

```text
llm_headless_ask(
  provider="grok",
  markdown="# Review\n\nGive a second opinion on this API."
)
```

Persistent provider context:

```text
llm_write_input(
  provider="claude",
  filename="design-review.md",
  markdown="# Design Review\n\nReview this plan..."
)

llm_tmux_ask(
  provider="claude",
  inputPath="/path/from/llm_write_input/design-review.md"
)
```

Long-running request with separate send and wait:

```text
llm_tmux_send(provider="codex", inputPath="/path/to/prompt.md")
llm_tmux_wait(provider="codex", nonce="nonce-returned-by-send", timeoutMs=900000)
```

Specific model:

```text
llm_tmux_ask(provider="codex", model="gpt-5.5", inputPath="/path/to/prompt.md")
llm_headless_ask(provider="claude", model="opus", markdown="# Task\n\n...")
llm_headless_ask(provider="agy", model="gemini-3.8-flash-low", markdown="# Task\n\n...")
```

## Provider Behavior

| Provider | Aliases | Persistent command | Headless command | Default model |
| --- | --- | --- | --- | --- |
| `codex` | `gpt`, `openai` | `codex --no-alt-screen -c check_for_update_on_startup=false --dangerously-bypass-approvals-and-sandbox` | `codex exec --dangerously-bypass-approvals-and-sandbox --ephemeral --output-last-message ... -` | Codex config default. |
| `claude` | none | `claude --model sonnet --dangerously-skip-permissions --add-dir <requests>` | `claude -p --dangerously-skip-permissions --no-session-persistence --model sonnet` | `sonnet` alias. |
| `grok` | `xai` | `grok --no-alt-screen --minimal --permission-mode bypassPermissions` | `grok --prompt-file ... --permission-mode bypassPermissions` | CLI default/latest. |
| `antigravity` | `agy`, `gemini`, `google` | `agy --add-dir <requests> --dangerously-skip-permissions` | `agy --dangerously-skip-permissions --print=<prompt>` | CLI default/latest. |

(Commands as run with the default `full` permissions; Codex also gets
`--no-daemon` on Windows.)

`model` is passed to each CLI's model flag (`-m` or `--model`); set
`LLM_ROUTER_MCP_<PROVIDER>_MODEL` to change a default. Run `agy models` or
`grok models` to list model names.

The persistent commands are passed to `tmux` as an argument list, so no shell
quoting is involved. `--add-dir <requests>` gives Claude and Antigravity
access to the folder that holds the prompt and answer files. Codex runs with
`--no-alt-screen` and Grok with `--no-alt-screen --minimal` so earlier output
stays in tmux scrollback for the pane fallback; Grok's default renderer redraws
its own viewport and would lose the start of long answers.

`agy --print` takes the prompt as its value. Prompts longer than about 24,000
characters are passed as a one-line pointer to the prompt file instead.

### Permissions

`LLM_ROUTER_MCP_PERMISSIONS` picks one of two levels for every CLI, in tmux
sessions and headless calls alike. Neither ever waits for an approval on
screen.

| Level | Meaning | Flags |
| --- | --- | --- |
| `full` (default) | Any tool without asking: shell commands, edits anywhere, network. | Codex `--dangerously-bypass-approvals-and-sandbox`, Claude `--dangerously-skip-permissions`, Grok `--permission-mode bypassPermissions`, Antigravity `--dangerously-skip-permissions` |
| `scoped` | Read the prompt file and write the answer file; everything else that would need approval is denied. | Codex `--ask-for-approval never --add-dir <requests>` (your Codex sandbox applies), Claude `--permission-mode dontAsk --allowedTools Write,Edit`, Grok `--permission-mode dontAsk --allow Write --allow Edit`, Antigravity `--mode accept-edits` |

A session keeps the level it was started with; kill it to change the level.

### Output modes

`file` (the default) adds to the prompt: write the complete answer as Markdown
to `requests/<provider>/<nonce>.answer.md`, then print the done marker, with
only a short note in the chat. When the done marker appears the router reads
that file, so the answer has no terminal wrapping or TUI decoration and no
length limit. If the model could not write the file, it prints the answer in
the chat instead and the router reads it from the pane (`answerSource` in the
result says which). A written answer file also completes the request when the
model forgets the done marker.

`pane` asks for the answer in the chat and reads it from the tmux pane between
the markers. Override with the `outputMode` option or
`LLM_ROUTER_MCP_<PROVIDER>_OUTPUT_MODE` / `LLM_ROUTER_MCP_OUTPUT_MODE`.

### Input modes

`paste` pastes the generated prompt with bracketed paste and presses Enter.
`file` writes the prompt to `requests/<provider>/<nonce>.prompt.md` and pastes
one line: "Read the Markdown request file at ... and follow its instructions
exactly." The model then reads the file with its own file tool.

Defaults: `paste` everywhere for Claude and on Linux/macOS for all providers;
`file` for Codex, Grok, and Antigravity on Windows. Override with the
`inputMode` option or `LLM_ROUTER_MCP_<PROVIDER>_INPUT_MODE` /
`LLM_ROUTER_MCP_INPUT_MODE`.

After pasting, the router waits for the screen to settle before pressing Enter,
and presses Enter again (at most twice) if nothing moved afterwards, which
happens when a TUI took the first Enter as part of the paste.

### Startup screens

A new session is ready when the CLI shows its input prompt. Before that the
router handles known startup screens:

| Screen | Action |
| --- | --- |
| Folder trust (Codex, Claude, Grok, Antigravity) | Answered with yes for a session the router started in its own scratch workdir (for Codex only when that workdir is its own git repository), or when `trustCwd: true`. Otherwise the call fails and tells you to attach and answer it. |
| Codex update prompt | Skipped. |
| Claude "Try the new fullscreen renderer?" | Answered "Not now" (fullscreen would leave no scrollback to read). |
| Claude "Bypass Permissions mode" warning | Accepted, since the router starts it that way on purpose (`full` permissions). |
| First-run setup or login (any provider) | `llm_tmux_send`/`llm_tmux_ask` fail; if that call started the session, they also close it. Run the CLI once in a terminal and finish setup. |
| Any other menu | The call fails with `blocker: "dialog"` and the attach command. |

The router never types a request into a screen it does not recognise: a new
session of a built-in CLI is ready only when its input prompt is on screen. If
a CLI update changes its prompt so a session never becomes ready, set
`LLM_ROUTER_MCP_<PROVIDER>_READY_PATTERN` to a regular expression that matches
the new prompt. Sessions started with a custom `command` have no known prompt;
they are ready once their screen has been quiet for a second, unless that
variable is set. When a CLI shows a numbered menu with a selected option, or a
trailing `(y/n)`, while it works (a tool permission, for example),
`llm_tmux_send` refuses to type into it and `llm_tmux_wait` returns early with
`blocked: "prompt"` and the attach command. Other kinds of question are not
recognised and hold a wait until its timeout.

What the router decided when it created a session is stored on the tmux
session itself (`@llm_router_*` options): whether its folder may be trusted,
its working directory and model, and whether it has been ready. Later calls,
also from other MCP server processes, follow that record rather than their own
options, so a folder you declined is not trusted by a later call that leaves
out `cwd`, and the conversation in a session the router has seen ready is not
mistaken for a startup screen. A session without that record (started by hand
or by an older version) is treated as running the built-in CLI. Calls for the
same session are serialised within one MCP server process; `llm_tmux_kill`
does not wait for them. A request that was already pasted when its call is
cancelled is still submitted, so it never lingers in the input box.

If a provider CLI exits, its pane stays open (`remain-on-exit`) so the last
output can be read; the next call replaces the dead session.

## Windows

The router runs natively on Windows with tmux-windows and the Windows builds of
the CLIs. Differences from Linux:

- Commands are looked up through `PATH` and `PATHEXT`. npm `.cmd` shims (such as
  `codex.cmd`) are run with `node` directly; other `.cmd` files through
  `cmd.exe`. Child processes start without console windows.
- ConPTY delivers pasted text to most TUIs as keystrokes, so newlines in a paste
  can submit early. That is why `file` input is the default there.
- Codex runs with `--no-daemon`: tmux-windows keeps pane processes in a Job
  Object that does not allow the breakaway Codex's background server needs.
- `capture-pane -J` is not used, because ConPTY marks full-width rows as wrapped
  and `-J` would glue the screen into one line. Long lines stay wrapped at the
  pane width (`LLM_ROUTER_MCP_TMUX_JOIN_LINES=1` turns `-J` back on).
- tmux-windows keeps a server log per socket label in
  `%LOCALAPPDATA%\tmux\`; the test suites use fixed labels so they do not add
  a new file on every run.

## Runtime State

By default, state is stored under:

```text
~/.local/state/llm-router-mcp
```

It contains:

- `inputs/` Markdown inputs
- `requests/` generated internal prompts
- `responses/` Markdown model outputs and raw logs
- `workdirs/` scratch workdirs for each provider

Runtime state may contain private project details and model responses. On
Linux and macOS its directories are created with mode `0700` and its files
with `0600`. Keep it outside the repo and prune it periodically if it grows
large.

Answers read from the pane (`outputMode: "pane"`, or the fallback) come from
tmux scrollback, which holds tmux's `history-limit` lines (2000 by default).
For longer answers in that mode, raise `history-limit` in your tmux
configuration; otherwise the result has `startMissing: true`, no `answer`, and
a fallback file with the whole captured history.

## Environment Variables

| Variable | Meaning |
| --- | --- |
| `LLM_ROUTER_MCP_STATE_DIR` | State directory. |
| `LLM_ROUTER_MCP_<PROVIDER>_MODEL` | Default model (`CODEX`, `CLAUDE`, `GROK`, `ANTIGRAVITY`). |
| `LLM_ROUTER_MCP_<PROVIDER>_CMD` | Shell command for new tmux sessions instead of the built-in one. |
| `LLM_ROUTER_MCP_<PROVIDER>_CWD` | Working directory instead of the scratch workdir. |
| `LLM_ROUTER_MCP_<PROVIDER>_SESSION` | Default tmux session name. |
| `LLM_ROUTER_MCP_PERMISSIONS` | `full` (default) or `scoped`; see [Permissions](#permissions). |
| `LLM_ROUTER_MCP_<PROVIDER>_INPUT_MODE`, `LLM_ROUTER_MCP_INPUT_MODE` | `paste` or `file`. |
| `LLM_ROUTER_MCP_<PROVIDER>_OUTPUT_MODE`, `LLM_ROUTER_MCP_OUTPUT_MODE` | `file` or `pane`. |
| `LLM_ROUTER_MCP_<PROVIDER>_READY_PATTERN` | Regular expression for the CLI's input prompt. |
| `LLM_ROUTER_MCP_TMUX_LABEL`, `LLM_ROUTER_MCP_TMUX_SOCKET` | Use a separate tmux server (`tmux -L` / `-S`). |
| `LLM_ROUTER_MCP_TMUX_JOIN_LINES` | `1` or `0` to force `capture-pane -J` on or off. |
| `LLM_ROUTER_MCP_PATH_PREFIX` | Directories searched before `PATH` (`~/.local/bin`, `~/.npm-global/bin`, and `~/.grok/bin` are always added). |
| `LLM_ROUTER_MCP_SCRUB_ENV` | `0` keeps variables that tie a process to the launching Claude Code session (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, ...). Otherwise they are removed from headless CLIs and blanked (`new-session -e NAME=`) in new tmux sessions when the tmux server has them. |

## Troubleshooting

**The MCP server does not appear in my client.** Restart the MCP client after
editing config, confirm `node` is available to that client, and check the
client's MCP server logs.

**A provider CLI is not found.** The MCP inherits the `PATH` from the process
that launched it, which can differ from your interactive shell. Run
`llm_list_providers` with `check: true`, then use `LLM_ROUTER_MCP_PATH_PREFIX`
or adjust the launching environment.

**A provider says authentication is required.** Log in with that provider's CLI
outside the MCP first, then retry. This is especially common for fresh
Antigravity CLI installs and for Claude's first interactive start.

**Codex gives up after a minute.** Raise `tool_timeout_sec` for the server in
`~/.codex/config.toml`, or use `llm_tmux_send` and then `llm_tmux_wait`.

**A persistent session is stuck.** Use `llm_tmux_capture`, or attach directly:

```bash
tmux attach -t claude-mcp
```

Then kill it with `llm_tmux_kill` or:

```bash
tmux kill-session -t claude-mcp
```

**A request timed out.** Check the returned fallback or raw response path. For
long provider runs, prefer `llm_tmux_send` followed by `llm_tmux_wait` with a
larger `timeoutMs`.

## Security Notes

- This MCP runs local CLIs with the same OS account privileges as the MCP
  client, and by default with every approval and sandbox turned off
  (`LLM_ROUTER_MCP_PERMISSIONS=full`). A request, or text a model reads while
  working on it, can make it run any command or change any file that account
  can reach. Set `LLM_ROUTER_MCP_PERMISSIONS=scoped` when that is too much.
- Folder-trust prompts are answered automatically only for the router's own
  scratch workdirs. For any other `cwd`, answer them yourself or pass
  `trustCwd: true` deliberately.
- Do not commit runtime state. Inputs, generated prompts, raw responses, and
  response Markdown files may contain private project details.
- The default state directory is outside the repo:
  `~/.local/state/llm-router-mcp`.
- `.gitignore` excludes common local state paths in case the state directory is
  pointed at the project.
- This MCP automates local CLIs. It does not bypass login, provider policy, or
  model-side refusal behavior.
- Headless Antigravity calls pass the prompt as a command-line argument
  (`agy --print=<prompt>`, as agy requires). While the call runs, the prompt
  shows in the process list; on Linux any local user can read it through
  `ps` or `/proc` unless `/proc` is mounted with `hidepid`. Prompts that
  would not fit are passed as a pointer to the prompt file instead.
- Model names are limited to letters, numbers, and `. _ : @ / + - [ ]`,
  because they end up on command lines.
- On Linux and macOS the router also tightens state directories that an older
  version created with the default mode.
- Persistent `tmux` sessions preserve conversation context. Use
  `llm_headless_ask` for sensitive one-off questions that should not enter a
  long-lived provider session.

Before staging or publishing changes, scan tracked files for accidental secrets:

```bash
grep -RInEi '(api[_-]?key|token|secret|password|authorization|bearer|oauth|credential|cookie|private[_-]?key)' \
  . --exclude-dir=node_modules --exclude-dir=.git --exclude=package-lock.json
```

For history scanning, use a dedicated tool such as
[`trufflehog`](https://github.com/trufflesecurity/trufflehog) or
[`git-secrets`](https://github.com/awslabs/git-secrets).

## Useful Commands

```bash
tmux ls
tmux attach -t codex-mcp
tmux attach -t claude-mcp
tmux attach -t grok-mcp
tmux attach -t antigravity-mcp
```

Kill a session:

```bash
tmux kill-session -t grok-mcp
```

With `LLM_ROUTER_MCP_TMUX_LABEL` set, add `-L <label>` to these commands; the
`attachCommand` field in tool results already includes it.
