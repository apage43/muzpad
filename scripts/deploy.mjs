// Publishing happens only when this command is explicitly invoked.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const args = new Set(process.argv.slice(2));
for (const arg of args)
  if (arg !== "--dry-run") throw new Error(`Unknown option ${arg}`);

execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
if (args.has("--dry-run"))
  console.log("Dry run complete. No live deployment.");
else
  execFileSync("npx", ["wrangler", "deploy"], { cwd: root, stdio: "inherit" });
