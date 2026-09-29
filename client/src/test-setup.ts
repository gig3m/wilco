/**
 * Global test setup.
 *
 * 🚨 Its only job is to make sure nothing stays mounted between tests. The
 * client suite OOM-killed this host twice on 2026-09-05 (six kills across two
 * boots, 57–60 GB anon-rss on a 60 GB machine, taking the other
 * services on it down too) because `render` tore down only the PREVIOUS
 * render. The last render of every file stayed mounted, and once `App` grew a
 * `setInterval` poll each orphan kept firing for the rest of the run.
 *
 * A leak like that is invisible in a green suite. This is the thing that
 * makes it structurally impossible rather than something to remember.
 */
import { afterEach } from "vitest";
import { cleanupRenders } from "./test-utils";

afterEach(() => {
  cleanupRenders();
});
