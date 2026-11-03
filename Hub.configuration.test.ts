import { Hub } from "./Hub.ts";
import type { Peer } from "./Peer.ts";
import type { Config } from "./types.ts";

Deno.test("Hub rejects an invalid path identity configuration before stopping existing peers", () => {
    const config: Config = {
        peers: [
            { type: "storage", name: "legacy", baseDir: "", group: "shared", pathNormalizationVersion: 0 },
            { type: "storage", name: "nfc", baseDir: "", group: "shared", pathNormalizationVersion: 1 },
        ],
    };
    const hub = new Hub(config);
    let stopCalled = false;
    const existingPeer = {
        stop: () => {
            stopCalled = true;
        },
    } as unknown as Peer;
    hub.peers = [existingPeer];

    let threw = false;
    try {
        hub.start();
    } catch {
        threw = true;
    }

    if (!threw) throw new Error("Hub.start should reject the invalid path identity configuration");
    if (stopCalled) throw new Error("Hub.start should validate before stopping existing peers");
    if (hub.peers.length !== 1 || hub.peers[0] !== existingPeer) {
        throw new Error("Hub.start should preserve existing peers when validation fails");
    }
});
