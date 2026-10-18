import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { installFakeClis, tempDir } from "./helpers.js";
import { pruneState } from "../src/core.js";
import { parseSearchResult, xSearch } from "../src/x-search.js";

async function mediaServer(t) {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "image/jpeg" });
    response.end(Buffer.from(`fake media for ${request.url}`));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function withEnv(t, values) {
  const old = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

test("x search returns structured posts and media URLs without downloading", async (t) => {
  await installFakeClis(t);
  const stateDir = await tempDir(t, "llm-router-x-");
  const result = await xSearch({ query: "claude code", limit: 5, stateDir, timeoutMs: 20000 });

  assert.equal(result.summary, "Fake posts about the query.");
  assert.equal(result.posts.length, 1);
  assert.equal(result.posts[0].text, "about claude code");
  assert.equal(result.posts[0].media[0].url, "https://pbs.twimg.com/media/fake.jpg");
  assert.equal(result.posts[0].media[0].path, undefined);
  assert.equal(result.mediaDir, null);
  assert.match(await fs.readFile(result.responsePath, "utf8"), /# X search: claude code/);
  // Nothing was downloaded.
  await assert.rejects(fs.access(path.join(stateDir, "media")));
});

test("x search downloads only X media, and videos only when asked", async (t) => {
  await installFakeClis(t);
  const stateDir = await tempDir(t, "llm-router-x-");
  const base = await mediaServer(t);
  withEnv(t, { FAKE_X_MEDIA_URL: `${base}/media/a.jpg`, LLM_ROUTER_MCP_X_MEDIA_HOSTS: "127.0.0.1" });

  const photos = await xSearch({ query: "q", media: "download", stateDir, timeoutMs: 20000 });
  const [photo, foreign, video] = photos.posts[0].media;
  assert.match(await fs.readFile(photo.path, "utf8"), /fake media for \/media\/a\.jpg/);
  assert.equal(foreign.path, undefined);
  assert.ok(photos.mediaNotes.some((note) => /not an X media host/.test(note)));
  assert.equal(video.path, undefined);

  const withVideo = await xSearch({ query: "q", media: "download", includeVideo: true, stateDir, timeoutMs: 20000 });
  assert.match(withVideo.posts[0].media[2].path, /\.mp4$/);
});

test("x search finds the real object after a placeholder in the text", async (t) => {
  await installFakeClis(t);
  const stateDir = await tempDir(t, "llm-router-x-");
  const result = await xSearch({ query: "FAKE_TEXT_JSON", stateDir, timeoutMs: 20000 });
  assert.equal(result.posts.length, 1);

  assert.equal(parseSearchResult("not json at all").result, null);
  await assert.rejects(xSearch({ query: "q", since: "yesterday" }), /since/);
  await assert.rejects(xSearch({ query: "q", from: "not a handle!" }), /handle/);
  await assert.rejects(xSearch({ query: " " }), /query/);
});

test("old state files are pruned and recent ones kept", async (t) => {
  const stateDir = await tempDir(t, "llm-router-prune-");
  const old = path.join(stateDir, "responses", "grok", "old.response.md");
  const recent = path.join(stateDir, "requests", "grok", "new.prompt.md");
  const oldMedia = path.join(stateDir, "media", "nonce-1", "1-1.jpg");
  const workdirFile = path.join(stateDir, "workdirs", "grok", "AGENTS.md");
  for (const file of [old, recent, oldMedia, workdirFile]) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "x");
  }
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  for (const file of [old, oldMedia, workdirFile]) {
    await fs.utimes(file, longAgo, longAgo);
  }

  const { removed } = await pruneState(stateDir, 14);
  assert.equal(removed, 2);
  await assert.rejects(fs.access(old));
  await assert.rejects(fs.access(path.dirname(oldMedia)));
  await fs.access(recent);
  await fs.access(workdirFile);
  assert.deepEqual(await pruneState(stateDir, 0), { removed: 0 });
});
