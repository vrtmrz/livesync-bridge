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
globalThis.addEventListener("unhandledrejection", (event) => {
    event.preventDefault();
    console.error("[LSB] Unhandled rejection (kept alive):", event.reason);
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