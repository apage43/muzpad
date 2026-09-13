/** Parse a gist ID or GitHub gist URL, optionally pinned to a revision. */
export function parseGist(input) {
  let value = input.trim();
  if (value.includes("://")) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "gist.github.com")
      throw new Error("Enter a gist.github.com URL or a gist ID.");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length > 1 && !/^[a-f0-9]{32,40}$/i.test(parts[0])) parts.shift();
    value = parts.join("/");
  }
  if (!/^[a-f0-9]{32,40}(?:\/[a-f0-9]{40})?$/i.test(value))
    throw new Error(
      "Enter a gist.github.com URL or a gist ID, optionally followed by /revision.",
    );
  return value.toLowerCase();
}

function safePath(path) {
  return (
    typeof path === "string" &&
    !path.includes("\\") &&
    !path.includes(":") &&
    !/[\u0000-\u001f]/.test(path) &&
    path
      .split("/")
      .every(
        (p) =>
          p &&
          ![".", "..", "__proto__", "constructor", "prototype"].includes(p),
      )
  );
}
async function boundedText(response, limit) {
  if (Number(response.headers.get("content-length")) > limit)
    throw new Error("Gist exceeds the import size limit.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("Gist exceeds the import size limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

/** Anonymous, read-only import. Never execute gist HTML or send GitHub credentials.
 * @param {string} input
 * @param {{signal?: AbortSignal, fetcher?: typeof fetch}} options
 */
export async function loadGist(input, { signal, fetcher = fetch } = {}) {
  const ref = parseGist(input);
  signal = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(30_000),
  ]);
  const response = await fetcher(`https://api.github.com/gists/${ref}`, {
    signal,
    credentials: "omit",
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) {
    if (response.status === 404)
      throw new Error(
        "Gist not found. Check the link and whether it was deleted.",
      );
    if ([403, 429].includes(response.status))
      throw new Error("GitHub is limiting gist requests. Try again later.");
    throw new Error(`GitHub could not load the gist (${response.status}).`);
  }
  const data = JSON.parse(await boundedText(response, 12_000_000));
  if (data.truncated)
    throw new Error(
      "GitHub returned an incomplete file list. Use a smaller gist.",
    );
  const items = Object.entries(data.files ?? {});
  if (items.length > 500)
    throw new Error("Open a gist with at most 500 files.");
  const contents = Object.create(null);
  let total = 0;
  for (const [name, item] of items) {
    if (name !== "muzpad.json" && !/\.(muz|md)$/i.test(name)) continue;
    let content = item.content;
    if (item.truncated || typeof content !== "string") {
      const raw = new URL(item.raw_url);
      if (
        raw.protocol !== "https:" ||
        raw.hostname !== "gist.githubusercontent.com"
      )
        throw new Error("Unsupported gist file URL.");
      const file = await fetcher(raw.href, { signal, credentials: "omit" });
      if (!file.ok) throw new Error(`Could not load ${name} (${file.status}).`);
      content = await boundedText(file, 4_000_000 - total);
    }
    total += new TextEncoder().encode(content).length;
    if (total > 4_000_000)
      throw new Error("Open a gist with at most 4 MB of text.");
    contents[name] = content;
  }
  let settings;
  try {
    settings = JSON.parse(contents["muzpad.json"] ?? "{}");
  } catch {
    throw new Error("The gist contains invalid muzpad.json metadata.");
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    throw new Error("Invalid muzpad.json metadata.");
  const files = Object.create(null);
  for (const [name, content] of Object.entries(contents)) {
    if (name === "muzpad.json") continue;
    const path = settings.paths?.[name] ?? name;
    if (
      !safePath(path) ||
      !/\.(muz|md)$/i.test(path) ||
      Object.hasOwn(files, path)
    )
      throw new Error(
        "Gist contains an unsupported or duplicate project path.",
      );
    files[path] = content;
  }
  const entries = Object.keys(files).filter((p) => p.endsWith(".muz"));
  if (!entries.length)
    throw new Error("This gist contains no muz source files.");
  const entry = entries.includes(settings.entry)
    ? settings.entry
    : entries.includes("song.muz")
      ? "song.muz"
      : entries[0];
  return {
    id: `gist-${ref.split("/")[0]}`,
    gist: ref,
    title:
      typeof settings.title === "string"
        ? settings.title
        : data.description || "Untitled gist",
    entry,
    files,
    entries: [
      entry,
      ...(Array.isArray(settings.entries)
        ? settings.entries.filter((p) => entries.includes(p))
        : []),
    ],
  };
}
