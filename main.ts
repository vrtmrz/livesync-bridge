import { defaultLoggerEnv } from "./lib/src/common/logger.ts";
import { LOG_LEVEL_DEBUG } from "./lib/src/common/logger.ts";
import { Hub } from "./Hub.ts";
import { Config, isCouchDBPeer, isStoragePeer } from "./types.ts";
import { parseArgs } from "jsr:@std/cli";

const KEY = "LSB_"
defaultLoggerEnv.minLogLevel = LOG_LEVEL_DEBUG;
const configFile = Deno.env.get(`${KEY}CONFIG`) || "./dat/config.json";

console.log("LiveSync Bridge is now starting...");

globalThis.addEventListener("unhandledrejection", (event) => {
    event.preventDefault();
    console.error(`Unhandled rejection: ${event.reason}`);
});
let config: Config = { peers: [] };
const flags = parseArgs(Deno.args, {
    boolean: ["reset"],
    default: { reset: false },
});

if (flags.reset) {
    const kv = await Deno.openKv();
    for await (const entry of kv.list()) {
        kv.delete(entry.key);
    }
    console.log("Storage cleared.");
}

function validateConfig(cfg: unknown): cfg is Config {
    if (!cfg || typeof cfg !== "object") return false;
    const c = cfg as Record<string, unknown>;
    if (!Array.isArray(c.peers)) {
        console.error("Config error: 'peers' must be an array");
        return false;
    }
    for (let i = 0; i < c.peers.length; i++) {
        const peer = c.peers[i] as Record<string, unknown>;
        if (!peer.type || !["storage", "couchdb"].includes(peer.type as string)) {
            console.error(`Config error: peers[${i}].type must be "storage" or "couchdb"`);
            return false;
        }
        if (!peer.name) {
            console.error(`Config error: peers[${i}].name is required`);
            return false;
        }
        if (peer.type === "storage" && !peer.baseDir) {
            console.error(`Config error: peers[${i}].baseDir is required for storage peer`);
            return false;
        }
        if (peer.type === "couchdb") {
            if (!peer.database) {
                console.error(`Config error: peers[${i}].database is required for couchdb peer`);
                return false;
            }
            if (!peer.url) {
                console.error(`Config error: peers[${i}].url is required for couchdb peer`);
                return false;
            }
        }
    }
    return true;
}

try {
    const confText = await Deno.readTextFile(configFile);
    const parsed = JSON.parse(confText);
    if (!validateConfig(parsed)) {
        Deno.exit(1);
    }
    config = parsed;
} catch (ex) {
    console.error("Could not parse configuration!");
    console.error(ex);
    Deno.exit(1);
}
console.log("LiveSync Bridge is now started!");
const hub = new Hub(config);
hub.start();