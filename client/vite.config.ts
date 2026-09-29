import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// Builds to client/dist, which static.ts serves in production (see
// src/server/main.ts). Asset layout is deliberately stable/predictable
// (assets/ with content-hashed names) so serveStatic's cache-control split
// -- immutable for anything under assets/, no-cache for index.html -- holds
// without static.ts needing to know Vite's internals.
export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "assets",
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name].[hash].js",
        chunkFileNames: "assets/[name].[hash].js",
        assetFileNames: "assets/[name].[hash][extname]",
      },
    },
  },
  test: {
    // 🚨 happy-dom LOADS AN IFRAME'S src FOR REAL. Once the body frame
    // shipped, every test that rendered a message issued a live DNS lookup
    // and TLS connection to the body origin -- `getaddrinfo ENOTFOUND
    // mailbody.invalid` in the output, a 214-second suite (from ~6s), and a
    // test run whose result depended on the network. Turning page loading
    // off keeps the element, its attributes and our assertions about them
    // intact while never fetching anything.
    // `disableIframePageLoading` is the DEPRECATED spelling and it THROWS a
    // NotSupportedError instead of quietly skipping the load, which escapes
    // as an unhandled error and kills the worker. The supported option is
    // navigation.disableChildFrameNavigation, which simply does not
    // navigate.
    //
    // The cast is because vitest's own happy-dom option type still describes
    // the older settings shape and does not know about `navigation` -- the
    // runtime does, and this is the spelling happy-dom 15 documents.
    // Unmounts anything left over after every test -- see test-setup.ts.
    // Without it the last render of each file stays mounted and keeps its
    // timers running for the whole run.
    setupFiles: ["./src/test-setup.ts"],

    environmentOptions: {
      happyDOM: {
        // Scripts never run in a DOMParser document in a browser; happy-dom
        // runs them unless told not to (a paste test tripped on it, row 45).
        settings: { navigation: { disableChildFrameNavigation: true }, disableJavaScriptEvaluation: true },
      } as Record<string, unknown>,
    },

    // 🚨 A TEST RUN MUST NOT BE ABLE TO TAKE THE HOST DOWN.
    //
    // On 2026-09-05 a runaway render loop in one test consumed the box's
    // 60 GB. The kernel OOM-killed the vitest worker
    // (`oom_reaper: reaped process ... (node (vitest 1))`), Docker started
    // restarting containers under the memory pressure, and the machine —
    // which also runs other services — had to be rebooted.
    //
    // The bug was mine and is fixed. This is the part that must hold
    // REGARDLESS of which test misbehaves next: a worker that runs away
    // dies on its own heap limit in seconds, with a stack, instead of
    // taking the host with it. 1.5 GB is roughly 4x the suite's real high
    // water mark, so it constrains nothing legitimate.
    //
    // `maxForks` bounds the blast radius the same way: unbounded workers
    // multiply any per-worker leak by the core count. (Do not also set
    // `maxWorkers` — vitest rejects the pair as conflicting.)
    pool: "forks",
    poolOptions: {
      forks: {
        // minForks too: it defaults to the CPU count, and a maxForks below
        // that is rejected as a conflict.
        minForks: 1,
        maxForks: 4,
        execArgv: ["--max-old-space-size=1536"],
      },
    },
    // A test that hangs is a test that is looping. Fail it rather than
    // letting it run until something else notices.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
  server: {
    // The client dev server proxies API calls straight to the running Node
    // server (npm start / docker compose) rather than needing a second CORS
    // story -- same-origin from the browser's point of view.
    proxy: {
      "/api": "http://localhost:8794",
      "/healthz": "http://localhost:8794",
    },
  },
});
