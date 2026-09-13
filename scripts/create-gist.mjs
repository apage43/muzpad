// Explicit publishing command; normal builds and deployments never create gists.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { sources } from "./catalog.mjs";
const [directory, entry = "song.muz", title = "muz project"] =
  process.argv.slice(2);
if (!directory)
  throw new Error(
    "Usage: node scripts/create-gist.mjs DIRECTORY [ENTRY] [TITLE]",
  );
const source = await sources(resolve(directory));
if (!source[entry]) throw new Error(`Missing entry ${entry}`);
const files = {},
  paths = {};
for (const [path, content] of Object.entries(source)) {
  const name = path.includes("/")
    ? `nested-${Buffer.from(path).toString("base64url")}.${path.split(".").at(-1)}`
    : path;
  if (files[name]) throw new Error(`Gist filename collision: ${name}`);
  files[name] = { content };
  if (name !== path) paths[name] = path;
}
files["muzpad.json"] = {
  content: JSON.stringify({ title, entry, paths }, null, 2),
};
const result = JSON.parse(
  execFileSync("gh", ["api", "--method", "POST", "/gists", "--input", "-"], {
    input: JSON.stringify({ description: title, public: false, files }),
    encoding: "utf8",
    maxBuffer: 8_000_000,
  }),
);
console.log(
  JSON.stringify({
    id: result.id,
    url: result.html_url,
    public: result.public,
    revision: result.history[0].version,
  }),
);
