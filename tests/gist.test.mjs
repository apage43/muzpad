import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGist, parseGist } from "../src/gist.js";
const id = "a".repeat(32),
  revision = "b".repeat(40);
const fixture = () => ({
  description: "A piece",
  files: {
    "song.muz": { content: 'use "parts/voice.muz" as v; v.main' },
    "nested.muz": { content: "let main = 1;" },
    "muzpad.json": {
      content: JSON.stringify({
        title: "Nested piece",
        entry: "song.muz",
        paths: { "nested.muz": "parts/voice.muz" },
      }),
    },
    "index.html": { content: "<script>nope</script>" },
  },
});
const response = (data) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json" },
  });
test("gist inputs accept IDs and revision URLs but reject other hosts and paths", () => {
  assert.equal(
    parseGist(` https://gist.github.com/someone/${id}/${revision}#file-song `),
    `${id}/${revision}`,
  );
  assert.equal(parseGist(id.toUpperCase()), id);
  for (const input of [
    `https://example.com/${id}`,
    `https://gist.github.com/${id}/raw`,
    "../whatever",
    `http://gist.github.com/${id}`,
  ])
    assert.throws(() => parseGist(input));
});
test("imports mapped nested source and metadata, retaining the requested share reference", async () => {
  const result = await loadGist(`${id}/${revision}`, {
    fetcher: async (url, options) => {
      assert.equal(url, `https://api.github.com/gists/${id}/${revision}`);
      assert.equal(options.credentials, "omit");
      assert.equal(options.cache, "no-store");
      return response(fixture());
    },
  });
  assert.equal(result.gist, `${id}/${revision}`);
  assert.equal(result.title, "Nested piece");
  assert.equal(result.files["parts/voice.muz"], "let main = 1;");
  assert.deepEqual(Object.keys(result.files), ["song.muz", "parts/voice.muz"]);
});
test("fetches truncated text from GitHub raw storage and rejects unsafe or incomplete imports", async () => {
  const data = fixture();
  data.files["nested.muz"] = {
    truncated: true,
    raw_url: `https://gist.githubusercontent.com/user/${id}/raw/nested.muz`,
  };
  const result = await loadGist(id, {
    fetcher: async (url, options) => {
      assert.equal(options.cache, "no-store");
      return url.includes("api.github")
        ? response(data)
        : new Response("full source");
    },
  });
  assert.equal(result.files["parts/voice.muz"], "full source");
  data.files["nested.muz"].raw_url = "https://example.com/file";
  await assert.rejects(
    loadGist(id, { fetcher: async () => response(data) }),
    /Unsupported gist file URL/,
  );
  for (const path of [
    "../evil.muz",
    "/absolute.muz",
    "__proto__/evil.muz",
    "song.muz",
  ]) {
    const invalid = fixture();
    invalid.files["muzpad.json"].content = JSON.stringify({
      paths: { "nested.muz": path },
    });
    await assert.rejects(
      loadGist(id, { fetcher: async () => response(invalid) }),
      /unsupported or duplicate/,
    );
  }
  await assert.rejects(
    loadGist(id, {
      fetcher: async () => response({ ...fixture(), truncated: true }),
    }),
    /incomplete/,
  );
  const huge = fixture();
  huge.files["song.muz"].content = "x".repeat(4_000_001);
  await assert.rejects(
    loadGist(id, { fetcher: async () => response(huge) }),
    /4 MB/,
  );
  await assert.rejects(
    loadGist(id, { fetcher: async () => new Response("", { status: 403 }) }),
    /limiting/,
  );
  await assert.rejects(
    loadGist(id, { fetcher: async () => new Response("", { status: 404 }) }),
    /not found/,
  );
});
