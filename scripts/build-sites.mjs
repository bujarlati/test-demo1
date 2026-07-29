import { copyFile, cp, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const textExtensions = new Set([".css", ".html", ".js", ".json", ".map", ".svg", ".txt"]);
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const staticAssets = {};

async function collectStaticAssets(directory, urlPrefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    const urlPath = `${urlPrefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectStaticAssets(filePath, urlPath);
      continue;
    }
    const extension = path.extname(entry.name).toLowerCase();
    const contents = await readFile(filePath);
    staticAssets[urlPath] = {
      body: textExtensions.has(extension) ? contents.toString("utf8") : contents.toString("base64"),
      encoding: textExtensions.has(extension) ? "utf8" : "base64",
      contentType: contentTypes[extension] ?? "application/octet-stream",
    };
  }
}

await collectStaticAssets("dist");

await build({
  entryPoints: ["server/index.ts"],
  outfile: "dist/server/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["cloudflare:node"],
  define: {
    __SITES_STATIC_ASSETS__: JSON.stringify(staticAssets),
  },
  banner: {
    js: 'import { httpServerHandler } from "cloudflare:node"; import { createRequire } from "node:module"; const require = createRequire(process.cwd() + "/package.json");',
  },
  footer: {
    js: 'export default httpServerHandler({ port: Number(process.env.PORT ?? 8787) });',
  },
});

await build({
  entryPoints: ["server/index.ts"],
  outfile: "dist/node/server.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});

await mkdir("dist/.openai", { recursive: true });
await copyFile(".openai/hosting.json", "dist/.openai/hosting.json");
await cp("server/database/migrations", "dist/server/database/migrations", { recursive: true });
await cp("server/database/migrations", "dist/node/database/migrations", { recursive: true });
