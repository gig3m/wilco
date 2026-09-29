import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

const here = path.dirname(fileURLToPath(import.meta.url));

// Serves client/harness/index.html on its own dev server (see
// ./README.md) -- deliberately separate from ../vite.config.ts, which
// builds the SHIPPED app to client/dist. This config has no `build`
// section at all: the harness is never built, only served, so there is
// no artifact for static.ts to ever accidentally pick up.
//
// `root` is this directory (not `client/`), so index.html's `/src/...`
// stylesheet links -- copied verbatim from the real app's own
// index.html, to render with the identical tokens/base/components
// cascade -- need an alias back to the real `client/src/`, and
// `server.fs.allow` has to be widened past `root` to actually reach it.
export default defineConfig({
  root: here,
  // `root` being this directory makes Vite's default publicDir resolve to
  // client/harness/public, which does not exist -- so /fonts/*.woff2
  // 404s into the SPA fallback (text/html) and every @font-face in
  // tokens.css silently fails to load. Point publicDir at the real
  // client/public so the harness serves the SAME woff2 files the shipped
  // app does, not a directory of its own. See shoot.mjs's font-load
  // assertion, which exists because this was previously broken.
  publicDir: path.resolve(here, "../public"),
  plugins: [preact()],
  resolve: {
    alias: [{ find: "/src", replacement: path.resolve(here, "../src") }],
  },
  server: {
    port: 8140,
    strictPort: true,
    fs: { allow: [path.resolve(here, "..")] },
  },
});
