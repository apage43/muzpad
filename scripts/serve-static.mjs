// Test/preview server: deliberately ordinary static files, mounted below a URL prefix.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
const root = resolve("dist");
createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (!url.pathname.startsWith("/studio/")) {
    response.writeHead(404).end();
    return;
  }
  const file = resolve(
    root,
    decodeURIComponent(url.pathname.slice(8)) || "index.html",
  );
  if (!file.startsWith(root + "/") && file !== resolve(root, "index.html")) {
    response.writeHead(403).end();
    return;
  }
  try {
    response.setHeader(
      "Content-Type",
      {
        ".html": "text/html",
        ".js": "text/javascript",
        ".css": "text/css",
        ".wasm": "application/wasm",
        ".json": "application/json",
      }[extname(file)] ?? "application/octet-stream",
    );
    response.end(await readFile(file));
  } catch {
    response.writeHead(404).end();
  }
}).listen(4173, "127.0.0.1");
