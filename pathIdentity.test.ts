import { getPeerPathNormalizationVersion, validatePeerPathIdentity } from "./pathIdentity.ts";
import type { Config, PeerConf, PeerStorageConf } from "./types.ts";

function assertEquals<T>(actual: T, expected: T, message: string) {
    if (actual !== expected) {
        throw new Error(`${message}\nactual=${String(actual)}\nexpected=${String(expected)}`);
    }
}

function assertThrows(run: () => unknown, message: string) {
    let threw = false;
    try {
        run();
    } catch {
        threw = true;
    }
    if (!threw) throw new Error(message);
}

function storagePeer(name: string, options: Partial<PeerStorageConf> = {}): PeerStorageConf {
    return {
        type: "storage",
        name,
        baseDir: "",
        ...options,
    };
}

function couchDBPeer(name: string, pathNormalizationVersion?: 0 | 1): PeerConf {
    return {
        type: "couchdb",
        name,
        database: "db",
        username: "user",
        password: "pass",
        url: "http://localhost:5984",
        passphrase: "",
        obfuscatePassphrase: "",
        baseDir: "",
        ...(pathNormalizationVersion === undefined ? {} : { pathNormalizationVersion }),
    };
}

Deno.test("path identity version defaults to Legacy and accepts explicit modes", () => {
    assertEquals(getPeerPathNormalizationVersion(storagePeer("default")), 0, "omitted version should use Legacy");
    assertEquals(
        getPeerPathNormalizationVersion(storagePeer("legacy", { pathNormalizationVersion: 0 })),
        0,
        "version 0 should use Legacy",
    );
    assertEquals(
        getPeerPathNormalizationVersion(storagePeer("nfc", { pathNormalizationVersion: 1 })),
        1,
        "version 1 should use NFC",
    );
    assertEquals(
        getPeerPathNormalizationVersion(couchDBPeer("remote-default")),
        0,
        "CouchDB omitted version should use Legacy",
    );
    assertEquals(getPeerPathNormalizationVersion(couchDBPeer("remote-nfc", 1)), 1, "CouchDB version 1 should use NFC");
    assertEquals(
        getPeerPathNormalizationVersion(storagePeer("case-sensitive", { handleFilenameCaseSensitive: true })),
        0,
        "case policy should not change the path identity mode",
    );
});

Deno.test("path identity version rejects unsupported runtime values", () => {
    for (const version of [null, false, -1, 2, NaN, Infinity, "1", {}]) {
        const peer = storagePeer("invalid", { pathNormalizationVersion: version as unknown as 0 | 1 });
        assertThrows(() => getPeerPathNormalizationVersion(peer), `version ${String(version)} should be rejected`);
    }
});

Deno.test("path identity validation accepts agreeing modes in the same group", () => {
    const config: Config = {
        peers: [storagePeer("legacy-default"), storagePeer("legacy-explicit", { pathNormalizationVersion: 0 })],
    };
    validatePeerPathIdentity(config);
});

Deno.test("path identity validation rejects a mode mismatch in one group", () => {
    const config: Config = {
        peers: [storagePeer("legacy"), storagePeer("nfc", { group: "", pathNormalizationVersion: 1 })],
    };
    assertThrows(() => validatePeerPathIdentity(config), "different versions in one group should be rejected");
});

Deno.test("path identity validation permits different modes in independent groups", () => {
    const config: Config = {
        peers: [
            storagePeer("legacy", { group: "legacy", pathNormalizationVersion: 0 }),
            storagePeer("nfc", { group: "nfc", pathNormalizationVersion: 1 }),
        ],
    };
    validatePeerPathIdentity(config);
});
