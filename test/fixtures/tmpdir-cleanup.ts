/**
 * A child process that uses `tempDir()` and then exits, so the PARENT can
 * check whether the directory actually went away.
 *
 * Removal happens in a `process.on("exit")` handler, so it cannot be observed
 * from inside the process that registered it — by the time it runs there is
 * no more test to assert in. Spawning is the only way to prove it, and
 * proving it is the point: this is the one piece of the /tmp fix that nothing
 * else covers, and if it silently stops working the leak comes back.
 *
 * Argument `throw` makes it die on an uncaught exception instead of returning
 * normally, which is the case that matters most: a FAILING run has to clean
 * up too, or the leak returns exactly when the suite is red and someone is
 * running it over and over.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { tempDir } from "../tmpdir.ts";

const dir = tempDir("cleanup-probe");
// A real file, so the removal has to be recursive rather than an empty rmdir.
writeFileSync(path.join(dir, "wilco.db"), "not really a database");
// The parent reads this off stdout; it is the only channel that survives.
process.stdout.write(`${dir}\n`);

if (process.argv[2] === "throw") {
  throw new Error("deliberate crash: a failing run must still clean up");
}
