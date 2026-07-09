// Serves dist/ over HTTP with a /preview.html route that renders the real
// bundle against fake data (tools/preview-stub.js provides window.clipQuota).
// Hash-proof: the stub is injected into dist/index.html at request time.
// Usage: npm run preview:fake  → http://127.0.0.1:5199/preview.html
// UI states: ?click=tab:Claude | settings | status:Anthropic | expand:ChatGPT, ?scroll=1400
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const port = Number(process.env.PREVIEW_PORT || 5199);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json"
};

createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === "/" || pathname === "/preview.html") {
    const html = readFileSync(join(dist, "index.html"), "utf8").replace(
      /<script type="module"/,
      '<script src="./preview-stub.js"></script>\n    <script type="module"'
    );
    res.writeHead(200, { "content-type": MIME[".html"] });
    res.end(html);
    return;
  }
  if (pathname === "/preview-stub.js") {
    res.writeHead(200, { "content-type": MIME[".js"] });
    res.end(readFileSync(join(root, "tools", "preview-stub.js")));
    return;
  }

  const file = normalize(join(dist, pathname));
  if (!file.startsWith(dist) || !existsSync(file)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(port, "127.0.0.1", () => {
  console.log(`preview: http://127.0.0.1:${port}/preview.html`);
});
