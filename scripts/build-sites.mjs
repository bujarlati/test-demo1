import { copyFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";

await build({
  entryPoints: ["server/index.ts"],
  outfile: "dist/server/index.js",
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
