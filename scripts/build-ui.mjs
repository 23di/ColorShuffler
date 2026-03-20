#!/usr/bin/env node
/**
 * Builds the UI as a single self-contained HTML file for the Figma plugin sandbox.
 * Uses esbuild to bundle React/TS, then inlines JS + CSS into one HTML file.
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// 1. Bundle the UI TypeScript/React into a single IIFE JS string
const result = await build({
  entryPoints: [resolve(root, "src/ui/main.tsx")],
  bundle: true,
  write: false,          // don't write to disk — we'll inline it
  outdir: resolve(root, "dist"),  // required for CSS splitting
  format: "iife",
  target: "es6",
  platform: "browser",
  minify: true,
  loader: {
    ".tsx": "tsx",
    ".ts": "ts",
    ".css": "css",
  },
  jsx: "automatic",
});

// Separate JS and CSS outputs
let jsCode = "";
let cssCode = "";
for (const file of result.outputFiles) {
  if (file.path.endsWith(".js")) {
    jsCode = file.text;
  } else if (file.path.endsWith(".css")) {
    cssCode = file.text;
  }
}

// 2. Escape </script> and <!-- inside the JS to prevent HTML parser breakage
const safeJs = jsCode
  .replace(/<\/script/gi, "<\\/script")
  .replace(/<!--/g, "<\\!--");

// 3. Build the self-contained HTML
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<style>${cssCode}</style>
</head>
<body>
<div id="root"></div>
<script>${safeJs}</script>
</body>
</html>`;

// 4. Write to dist/
mkdirSync(resolve(root, "dist"), { recursive: true });
writeFileSync(resolve(root, "dist/index.html"), html, "utf8");

console.log(
  `[build-ui] OK — ${(Buffer.byteLength(html) / 1024).toFixed(1)} kB`
);
