import { defaultLoggerEnv } from "./lib/src/common/logger.ts";
import { LOG_LEVEL_DEBUG } from "./lib/src/common/logger.ts";
import { Hub } from "./Hub.ts";
import { Config } from "./types.ts";
import { parseArgs } from "jsr:@std/cli";

const KEY = "LSB_";
defaultLoggerEnv.minLogLevel = LOG_LEVEL_DEBUG;
const configFile = Deno.env.get(`${KEY}CONFIG`) || "./dat/config.json";

// Survive transient errors from pouchdb-adapter-http's node-fetch shim.
//
// Under burst load (e.g. bulk imports, large folder renames, vault wipes via
// scanOfflineChanges), the Node→Deno compatibility layer in node-fetch can
// emit:
//
//   Uncaught (in promise) TypeError: expected AsyncWrap
//       at _getNewAsyncId (node:net:...)
//       at Socket.connect (node:net:...)
//       at file:///app/node_modules/.deno/node-fetch@2.6.9/...
//
// Without a global handler this rejection terminates the Deno process. Docker
// then restarts the container, which begins watching "from now" and loses any
// in-flight filesystem events — corrupting the sync state (CouchDB has docs
// disk does not, or vice versa).
//
// Swallowing the rejection here is correct: PouchDB's replicator will retry the
// failed batch on the next change event, and chokidar/scanOfflineChanges will
// re-emit anything missed. A surviving process is strictly better than a
// restarted one for sync convergence.
globalThis.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  const message = reason instanceof Error ? reason.message : String(reason);
  const isAsyncWrapBug = message.includes("expected AsyncWrap") ||
    (reason instanceof Error &&
      typeof reason.stack === "string" &&
      reason.stack.includes("node-fetch"));

  if (isAsyncWrapBug) {
    console.error(
      "[bridge] Swallowed node-fetch/AsyncWrap rejection (see fix/asyncwrap-survive-burst):",
      message,
    );
  } else {
    console.error("[bridge] Unhandled promise rejection (kept alive):", reason);
  }
  event.preventDefault();
});

console.log("LiveSync Bridge is now starting...");
let config: Config = { peers: [] };
const flags = parseArgs(Deno.args, {
  boolean: ["reset"],
  // string: ["version"],
  default: { reset: false },
});
if (flags.reset) {
  localStorage.clear();
}
try {
  const confText = await Deno.readTextFile(configFile);
  config = JSON.parse(confText);
} catch (ex) {
  console.error("Could not parse configuration!");
  console.error(ex);
}
console.log("LiveSync Bridge is now started!");
const hub = new Hub(config);
hub.start();
