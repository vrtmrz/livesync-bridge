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

Deno.test("Hub rejects case disagreement before stopping existing peers", () => {
    const config: Config = {
        peers: [
            { type: "storage", name: "default", baseDir: "" },
            { type: "storage", name: "sensitive", baseDir: "", handleFilenameCaseSensitive: true },
        ],
    };
    const hub = new Hub(config);
    let stopped = false;
    const existing = {
        stop: () => {
            stopped = true;
        },
    } as unknown as Peer;
    hub.peers = [existing];
    let rejected = false;
    try {
        hub.start();
    } catch {
        rejected = true;
    }
    if (!rejected || stopped || hub.peers[0] !== existing) {
        throw new Error("Invalid case settings must be rejected before replacing existing peers");
    }
});

for (const disabled of [false, true]) {
    Deno.test(`Hub checks effective case settings before delivery, override=${disabled}`, async () => {
        const sourceConfig = {
            type: "storage" as const,
            name: "source",
            baseDir: "",
            pathNormalizationVersion: 1 as const,
        };
        const targetConfig = {
            type: "storage" as const,
            name: "target",
            baseDir: "",
            pathNormalizationVersion: 1 as const,
            handleFilenameCaseSensitive: false,
        };
        const hub = new Hub(
            Object.assign({ peers: [sourceConfig, targetConfig] }, { disableCheckingConfigMismatch: disabled }),
        );
        let delivered = 0;
        const source = { config: sourceConfig } as unknown as Peer;
        const target = {
            config: targetConfig,
            put: () => {
                delivered++;
                return Promise.resolve(true);
            },
        } as unknown as Peer;
        hub.peers = [source, target];
        targetConfig.handleFilenameCaseSensitive = true;
        let rejected = false;
        try {
            await hub.dispatch(source, "A.md", { ctime: 1, mtime: 1, size: 4, data: ["note"] });
        } catch {
            rejected = true;
        }
        if (rejected !== !disabled || delivered !== (disabled ? 1 : 0)) {
            throw new Error("Delivery must honour the current effective case policy and explicit override");
        }
    });
}
