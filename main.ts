import { defaultLoggerEnv } from "./lib/src/common/logger.ts";
import { LOG_LEVEL_DEBUG } from "./lib/src/common/logger.ts";
import { Hub } from "./Hub.ts";
import { Config } from "./types.ts";
import { parseArgs } from "jsr:@std/cli";
import { dirname } from "@std/path";

// Last-resort safety net for a long-running sync daemon. A transient backend
// hiccup — e.g. CouchDB returning a non-JSON body while still warming up at
// boot — can surface as an unhandled promise rejection from deep inside
// PouchDB's fire-and-forget init, which Deno treats as fatal. That previously
// crash-looped the bridge into systemd's start limit and left it down silently
// for days. Log and keep running instead; the per-peer supervisor re-establishes
// the actual sync.
//
// One rejection class needs special handling, though. Under burst load (bulk
// imports, large folder renames, vault wipes via scanOfflineChanges) the
// Node→Deno compat layer in pouchdb-adapter-http's node-fetch shim can emit
// `TypeError: expected AsyncWrap` from the socket-create path. Swallowing it is
// correct for the *transient* case — PouchDB retries the batch. But we observed
// a *persistent* mode in production where it fires on every changes-feed retry,
// turning the supervisor's reconnect loop into a tight spin that never makes
// progress; only a fresh Deno process gets a clean node-fetch socket pool. So
// we count AsyncWrap rejections in a sliding window and trip a circuit breaker:
// if they fire often enough that the watch is clearly not recovering, exit and
// let Docker's restart policy bring us up clean. The volume-persisted `since`
// checkpoint in PeerCouchDB makes the restart resume mid-stream, not from "now".
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
                `[LSB] AsyncWrap threshold reached (${asyncWrapCount} rejections in ${
                    Math.round((now - asyncWrapWindowStart) / 1000)
                }s); exiting for Docker restart to get a fresh socket pool.`,
            );
            // Don't preventDefault — let the process die so Docker restarts us
            // clean; PeerCouchDB resumes from the persisted `since` checkpoint.
            Deno.exit(1);
        }
        console.error(
            `[LSB] Swallowed node-fetch/AsyncWrap rejection (${asyncWrapCount}/${ASYNC_WRAP_EXIT_THRESHOLD} in window):`,
            message,
        );
    } else {
        console.error("[LSB] Unhandled rejection (kept alive):", reason);
    }
    event.preventDefault();
});

const KEY = "LSB_"
defaultLoggerEnv.minLogLevel = LOG_LEVEL_DEBUG;
const configFile = Deno.env.get(`${KEY}CONFIG`) || "./dat/config.json";

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

// Health heartbeat for the container HealthCmd. The check runs inside the
// container, so there's no need to expose a socket — we just write the health
// state to a file on a timer. The recorded `ts` doubles as a liveness signal:
// a wedged event loop stops updating it, so a stale file reads as unhealthy.
// The probe checks freshness AND `restartWorthy`. Set LSB_HEALTH_FILE="" to disable.
const healthFile = Deno.env.get(`${KEY}HEALTH_FILE`) ?? "/tmp/lsb-health.json";
if (healthFile) {
    const tmpFile = `${healthFile}.tmp`;
    // Make sure the directory exists, so a custom LSB_HEALTH_FILE in a not-yet-
    // created dir doesn't make every beat fail (→ stale file → false unhealthy).
    await Deno.mkdir(dirname(healthFile), { recursive: true }).catch(() => {});
    const beat = async () => {
        try {
            const h = await hub.healthProbe();
            // Write-then-rename so the probe never reads a half-written file (a torn
            // read would parse-fail and report a false "unhealthy"). ts is stamped
            // after the (possibly I/O-bound) health probe, so it still reflects a
            // live event loop.
            await Deno.writeTextFile(tmpFile, JSON.stringify({ ts: Date.now(), ...h }));
            await Deno.rename(tmpFile, healthFile);
        } catch (e) {
            console.error("[LSB] failed to write health heartbeat:", e);
        }
    };
    // Self-scheduling (not setInterval) so a slow probe can never overlap the next
    // beat — overlapping beats would race on the shared temp file.
    const scheduleBeat = async () => {
        await beat();
        setTimeout(scheduleBeat, 10000);
    };
    scheduleBeat();
}