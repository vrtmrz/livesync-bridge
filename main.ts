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
// Swallowing the rejection here is correct for the *burst* case: PouchDB's
// replicator will retry the failed batch on the next change event, and
// chokidar/scanOfflineChanges will re-emit anything missed. A surviving process
// is strictly better than a restarted one for sync convergence.
//
// But we observed a *persistent* failure mode in production: the AsyncWrap
// error fires inside the changes-feed's socket-create path on every retry,
// turning the bridge's .on("error") → setTimeout(10s) → beginWatch chain into
// a tight loop that swallows rejections forever without ever processing a
// change. The watch never recovers in-process — only a fresh Deno process
// gets a clean node-fetch socket pool. So we count rejections in a sliding
// window and trip a circuit breaker: if AsyncWrap fires often enough that the
// watch is clearly not recovering, exit and let Docker's restart policy bring
// us up clean. The since-checkpoint persistence in PeerCouchDB ensures we
// resume mid-stream instead of replaying from "now".
const ASYNC_WRAP_WINDOW_MS = 5 * 60 * 1000;
const ASYNC_WRAP_EXIT_THRESHOLD = 30; // ~one per 10s for 5 min == permanently broken
let asyncWrapCount = 0;
let asyncWrapWindowStart = Date.now();
globalThis.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  const message = reason instanceof Error ? reason.message : String(reason);
  const isAsyncWrapBug = message.includes("expected AsyncWrap") ||
    (reason instanceof Error &&
      typeof reason.stack === "string" &&
      reason.stack.includes("node-fetch"));

  if (isAsyncWrapBug) {
    const now = Date.now();
    if (now - asyncWrapWindowStart > ASYNC_WRAP_WINDOW_MS) {
      asyncWrapCount = 0;
      asyncWrapWindowStart = now;
    }
    asyncWrapCount++;
    if (asyncWrapCount >= ASYNC_WRAP_EXIT_THRESHOLD) {
      console.error(
        `[bridge] AsyncWrap threshold reached (${asyncWrapCount} rejections in ${
          Math.round((now - asyncWrapWindowStart) / 1000)
        }s); exiting for Docker restart to get a fresh socket pool.`,
      );
      // Don't preventDefault — let the process die. Docker's restart policy
      // brings us back with clean state; PeerCouchDB resumes from the
      // persisted since checkpoint.
      Deno.exit(1);
    }
    console.error(
      `[bridge] Swallowed node-fetch/AsyncWrap rejection (${asyncWrapCount}/${ASYNC_WRAP_EXIT_THRESHOLD} in window):`,
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
