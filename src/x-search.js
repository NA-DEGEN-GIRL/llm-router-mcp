import fs from "node:fs/promises";
import path from "node:path";

import {
  LlmRouterError,
  defaultStateDir,
  ensureDefaultWorkDir,
  ensurePrivateDir,
  findExecutable,
  makeNonce,
  normalizeTimeout,
  resolveModel,
  resolvePermissions,
  runCommand,
  writePrivateFile
} from "./core.js";

// X search goes through Grok, whose CLI has X search tools that other
// providers' CLIs lack.
export const MEDIA_MODES = ["urls", "describe", "download"];

const DEFAULT_TIMEOUT_MS = 600000;
const MAX_LIMIT = 50;
const MAX_MEDIA_FILES = 10;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const VIDEO_FRAMES = 5;
// X serves post media from these hosts; nothing else is downloaded.
const MEDIA_HOSTS = ["pbs.twimg.com", "video.twimg.com"];

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    posts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: { type: "string" },
          author: { type: "string" },
          createdAt: { type: "string" },
          text: { type: "string" },
          likes: { type: "integer" },
          reposts: { type: "integer" },
          replies: { type: "integer" },
          media: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type: { type: "string" },
                url: { type: "string" },
                previewUrl: { type: "string" },
                durationMs: { type: "integer" },
                altText: { type: "string" },
                description: { type: "string" }
              },
              required: ["type", "url"]
            }
          }
        },
        required: ["url", "author", "createdAt", "text", "media"]
      }
    }
  },
  required: ["summary", "posts"]
};

export async function xSearch(options = {}) {
  const query = typeof options.query === "string" ? options.query.trim() : "";
  if (!query) {
    throw new LlmRouterError("query must be a non-empty string");
  }
  const mode = options.mode || "latest";
  if (!["latest", "top"].includes(mode)) {
    throw new LlmRouterError("mode must be latest or top", { mode });
  }
  const media = options.media || "urls";
  if (!MEDIA_MODES.includes(media)) {
    throw new LlmRouterError(`media must be one of: ${MEDIA_MODES.join(", ")}`, { media });
  }
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.trunc(Number(options.limit || 10))));
  for (const key of ["since", "until"]) {
    if (options[key] !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(options[key])) {
      throw new LlmRouterError(`${key} must be a date like 2026-10-18`, { [key]: options[key] });
    }
  }
  if (options.from !== undefined && !/^@?[A-Za-z0-9_]{1,15}$/.test(options.from)) {
    throw new LlmRouterError("from must be an X handle", { from: options.from });
  }
  if (options.lang !== undefined && !/^[a-z]{2,3}$/.test(options.lang)) {
    throw new LlmRouterError("lang must be a language code such as en or ko", { lang: options.lang });
  }

  const stateDir = path.resolve(options.stateDir || defaultStateDir());
  const timeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const nonce = makeNonce();
  const requestDir = path.join(stateDir, "requests", "grok");
  const responseDir = path.join(stateDir, "responses", "grok");
  await ensurePrivateDir(requestDir);
  await ensurePrivateDir(responseDir);

  const promptPath = path.join(requestDir, `${nonce}.x-search.prompt.md`);
  await writePrivateFile(promptPath, buildSearchPrompt({ ...options, query, mode, media, limit }));
  const model = resolveModel("grok", options.model);
  const permissions = resolvePermissions();
  const cwd = await ensureDefaultWorkDir("grok", stateDir);
  const run = await runCommand(
    "grok",
    [
      ...(model ? ["-m", model] : []),
      "--prompt-file",
      promptPath,
      "--json-schema",
      JSON.stringify(RESULT_SCHEMA),
      "--permission-mode",
      permissions === "full" ? "bypassPermissions" : "dontAsk",
      "--max-turns",
      "40",
      "--no-memory"
    ],
    { cwd, timeoutMs, allowFailure: true, killTree: true, signal: options.signal }
  );

  const rawResponsePath = path.join(responseDir, `${nonce}.x-search.raw.json`);
  await writePrivateFile(rawResponsePath, run.stdout || run.stderr || "");
  if (run.code !== 0) {
    throw new LlmRouterError(`grok exited with status ${run.code}`, {
      stderr: run.stderr.trim().slice(-2000),
      rawResponsePath
    });
  }
  const parsed = parseSearchResult(run.stdout);
  if (!parsed.result) {
    throw new LlmRouterError("grok did not return search results in the expected form", {
      reason: parsed.error,
      rawResponsePath
    });
  }

  const posts = normalizePosts(parsed.result.posts).slice(0, limit);
  let mediaDir = null;
  let mediaNotes = [];
  if (media === "download") {
    mediaDir = path.join(stateDir, "media", nonce);
    mediaNotes = await downloadMedia(posts, mediaDir, {
      includeVideo: Boolean(options.includeVideo),
      signal: options.signal
    });
  }

  const responsePath = path.join(responseDir, `${nonce}.x-search.md`);
  await writePrivateFile(responsePath, renderMarkdown(query, parsed.result.summary, posts));

  return {
    query,
    mode,
    media,
    summary: String(parsed.result.summary || ""),
    posts,
    mediaDir,
    ...(mediaNotes.length ? { mediaNotes } : {}),
    model: model || "CLI default/latest",
    costUsd: parsed.envelope?.total_cost_usd ?? null,
    elapsedMs: run.elapsedMs,
    responsePath,
    rawResponsePath
  };
}

function buildSearchPrompt({ query, mode, media, limit, since, until, from, lang }) {
  const filters = [
    from ? `- only posts from @${from.replace(/^@/, "")}` : "",
    since ? `- posted on or after ${since}` : "",
    until ? `- posted before ${until}` : "",
    lang ? `- in language "${lang}"` : ""
  ].filter(Boolean);
  const mediaRule =
    media === "describe"
      ? "For every photo, look at the image itself (download it to a temporary directory outside the current folder, view it, then delete it) and write what it shows in `description`. For every video, do the same with a few still frames and describe the video from them. Never leave downloaded files behind."
      : "Do not download or open media; copy the media URLs, types, preview URLs, durations, and alt text exactly as the search returns them.";
  return `Search X (Twitter) with your X search tools and return what you find.

Query: ${query}
Order: ${mode === "top" ? "most relevant / popular first" : "most recent first"}
Maximum posts: ${limit}
${filters.length ? `Filters:\n${filters.join("\n")}\n` : ""}
Rules:
- Use only real results from your X search tools; never invent posts, URLs, or numbers.
- url is the post's x.com URL, author is "Name (@handle)", createdAt is ISO 8601, text is the full post text.
- media lists every photo, video, or GIF attached to the post (an empty list when there are none); type is photo, video, or gif.
- ${mediaRule}
- summary is two or three sentences on what the posts say overall.
- Answer with the JSON object only, with no text before or after it.
`;
}

export function parseSearchResult(stdout) {
  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    // Plain output: the object is somewhere in it.
    const object = extractJsonObject(stdout);
    return object ? { result: object, envelope: null } : { result: null, error: "output was not JSON" };
  }
  const structured = envelope?.structuredOutput;
  if (structured && typeof structured === "object" && Array.isArray(structured.posts) && structured.posts.length) {
    return { result: structured, envelope };
  }
  // The model sometimes writes a sentence before the JSON, so the CLI could
  // not parse it; the text still holds it.
  const text = envelope?.text ?? envelope?.result ?? "";
  const object = extractJsonObject(text);
  if (object) {
    return { result: object, envelope };
  }
  if (structured && typeof structured === "object") {
    return { result: structured, envelope };
  }
  return { result: null, envelope, error: envelope?.structuredOutputError || "no JSON object in the answer" };
}

// The model may write a placeholder object before the real one, so the last
// object with posts wins.
function extractJsonObject(text) {
  const value = String(text || "");
  const found = [];
  for (let start = value.indexOf("{"); start !== -1; start = value.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
      const char = value[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const object = JSON.parse(value.slice(start, index + 1));
            if (object && Array.isArray(object.posts)) {
              found.push(object);
              start = index;
            }
          } catch {
            // Not this one.
          }
          break;
        }
      }
    }
  }
  return found.filter((object) => object.posts.length > 0).pop() || found.pop() || null;
}

function normalizePosts(posts) {
  if (!Array.isArray(posts)) {
    return [];
  }
  return posts
    .filter((post) => post && typeof post === "object" && typeof post.url === "string")
    .map((post) => ({
      url: post.url,
      author: String(post.author || ""),
      createdAt: String(post.createdAt || ""),
      text: String(post.text || ""),
      ...(Number.isFinite(post.likes) ? { likes: post.likes } : {}),
      ...(Number.isFinite(post.reposts) ? { reposts: post.reposts } : {}),
      ...(Number.isFinite(post.replies) ? { replies: post.replies } : {}),
      media: (Array.isArray(post.media) ? post.media : [])
        .filter((item) => item && typeof item.url === "string")
        .map((item) => ({
          type: ["photo", "video", "gif"].includes(item.type) ? item.type : "photo",
          url: item.url,
          ...(item.previewUrl ? { previewUrl: item.previewUrl } : {}),
          ...(Number.isFinite(item.durationMs) ? { durationMs: item.durationMs } : {}),
          ...(item.altText ? { altText: item.altText } : {}),
          ...(item.description ? { description: item.description } : {})
        }))
    }));
}

/**
 * Downloads post media into mediaDir: photos always, videos and GIFs only when
 * asked. Videos also get still frames when ffmpeg is installed, because no
 * provider CLI can watch a video but all of them can look at an image.
 */
async function downloadMedia(posts, mediaDir, { includeVideo, signal }) {
  const notes = [];
  const allowedHosts = mediaHosts();
  let files = 0;
  let bytes = 0;
  const ffmpeg = findExecutable("ffmpeg");

  for (const [postIndex, post] of posts.entries()) {
    for (const [mediaIndex, item] of post.media.entries()) {
      const isVideo = item.type !== "photo";
      if (isVideo && !includeVideo) {
        continue;
      }
      if (files >= MAX_MEDIA_FILES) {
        notes.push(`stopped after ${MAX_MEDIA_FILES} files`);
        return notes;
      }
      let url;
      try {
        url = new URL(item.url);
      } catch {
        notes.push(`skipped an invalid URL: ${item.url}`);
        continue;
      }
      if (!allowedHosts.includes(url.hostname) || !isAllowedProtocol(url)) {
        notes.push(`skipped ${item.url}: not an X media host`);
        continue;
      }
      const extension = path.extname(url.pathname) || (isVideo ? ".mp4" : ".jpg");
      const target = path.join(mediaDir, `${postIndex + 1}-${mediaIndex + 1}${extension}`);
      try {
        await ensurePrivateDir(mediaDir);
        const size = await fetchToFile(url, target, MAX_MEDIA_BYTES - bytes, signal);
        files += 1;
        bytes += size;
        item.path = target;
        item.bytes = size;
      } catch (error) {
        notes.push(`could not download ${item.url}: ${error.message}`);
        continue;
      }
      if (isVideo) {
        if (ffmpeg) {
          item.frames = await extractFrames(ffmpeg, target, item.durationMs, signal);
        } else {
          notes.push("ffmpeg is not installed, so videos have no still frames");
        }
      }
    }
  }
  return [...new Set(notes)];
}

function mediaHosts() {
  const extra = (process.env.LLM_ROUTER_MCP_X_MEDIA_HOSTS || "").split(",").map((host) => host.trim());
  return [...MEDIA_HOSTS, ...extra.filter(Boolean)];
}

function isAllowedProtocol(url) {
  // Plain http only for a local server (used by the tests).
  return url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname));
}

async function fetchToFile(url, target, maxBytes, signal) {
  if (maxBytes <= 0) {
    throw new Error("media size limit reached");
  }
  const response = await fetch(url, { signal, redirect: "follow" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) {
    throw new Error(`file is ${declared} bytes, over the ${maxBytes} byte limit`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new Error(`file is over the ${maxBytes} byte limit`);
    }
    chunks.push(chunk);
  }
  await fs.writeFile(target, Buffer.concat(chunks), { mode: 0o600 });
  return size;
}

async function extractFrames(ffmpeg, videoPath, durationMs, signal) {
  const seconds = Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : 10;
  const frames = [];
  for (let index = 0; index < VIDEO_FRAMES; index += 1) {
    const at = ((index + 0.5) * seconds) / VIDEO_FRAMES;
    const framePath = videoPath.replace(/\.[^.]+$/, `.frame${index + 1}.jpg`);
    const result = await runCommand(
      ffmpeg,
      ["-v", "error", "-y", "-ss", at.toFixed(2), "-i", videoPath, "-frames:v", "1", "-q:v", "3", framePath],
      { allowFailure: true, timeoutMs: 30000, signal }
    ).catch(() => null);
    if (result?.code === 0) {
      frames.push(framePath);
    }
  }
  return frames;
}

function renderMarkdown(query, summary, posts) {
  const lines = [`# X search: ${query}`, "", String(summary || "").trim(), ""];
  for (const post of posts) {
    lines.push(`## ${post.author} - ${post.createdAt}`, "", post.url, "", post.text, "");
    for (const item of post.media) {
      lines.push(`- ${item.type}: ${item.path || item.url}${item.description ? ` - ${item.description}` : ""}`);
      for (const frame of item.frames || []) {
        lines.push(`  - frame: ${frame}`);
      }
    }
    if (post.media.length) {
      lines.push("");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
