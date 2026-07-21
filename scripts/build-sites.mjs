import { copyFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";

await build({
  entryPoints: ["server/index.ts"],
  outfile: "dist/server/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["cloudflare:node"],
  banner: {
    js: 'import { httpServerHandler } from "cloudflare:node"; import { createRequire } from "node:module"; const require = createRequire(process.cwd() + "/package.json");',
  },
  footer: {
    js: 'export default httpServerHandler({ port: Number(process.env.PORT ?? 8787) });',
  },
});

await mkdir("dist/.openai", { recursive: true });
await copyFile(".openai/hosting.json", "dist/.openai/hosting.json");
