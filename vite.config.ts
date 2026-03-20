import { defineConfig, Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";

function figmaInline(): Plugin {
  return {
    name: "figma-inline",
    apply: "build",
    enforce: "post",
    closeBundle() {
      console.log("[figmaInline] closeBundle called");
      const distDir = path.resolve(__dirname, "dist");
      const htmlPath = path.join(distDir, "index.html");
      const jsPath = path.join(distDir, "assets", "index.js");

      if (!fs.existsSync(htmlPath) || !fs.existsSync(jsPath)) return;

      const html = fs.readFileSync(htmlPath, "utf8");
      const js = fs.readFileSync(jsPath, "utf8");
      console.log("[figmaInline] html size:", html.length, "js size:", js.length);

      // DEBUG: count before escaping
      const countBefore = (js.match(/<\/script>/gi) || []).length;
      console.log("[figmaInline] </script> in raw JS:", countBefore);

      // Escape </script> inside JS to prevent premature tag closing
      const safeJs = js.replace(/<\/script>/gi, "<\\/script>").replace(/<!--/g, "<\\!--");
      const countAfter = (safeJs.match(/<\/script>/gi) || []).length;
      console.log("[figmaInline] </script> after escape:", countAfter);

      // Replace external script tag with inline script
      const inlined = html.replace(
        /<script\b[^>]*src=["'][^"']*index\.js["'][^>]*><\/script>/,
        `<script>${safeJs}</script>`,
      );

      fs.writeFileSync(htmlPath, inlined);
      // Keep JS file for inspection - remove deletion temporarily
      // fs.rmSync(jsPath);
      // try { fs.rmdirSync(path.join(distDir, "assets")); } catch {}
    },
  };
}

export default defineConfig({
  root: path.resolve(__dirname, "src/ui"),
  plugins: [react(), figmaInline()],
  base: "./",
  publicDir: false,
  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, "src/ui/index.html"),
      output: {
        format: "iife",
        inlineDynamicImports: true,
        entryFileNames: "assets/[name].js",
        assetFileNames: "assets/[name].[ext]",
      },
    },
  },
});
