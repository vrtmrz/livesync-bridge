import type { DirectFileManipulator } from "@vrtmrz/livesync-commonlib";
import { PeerCouchDB } from "./PeerCouchDB.ts";
import { validatePeerPathIdentity } from "./pathIdentity.ts";
import type { Config, PeerCouchDBConf, PeerStorageConf } from "./types.ts";

function assert(value: unknown, message: string): asserts value {
    if (!value) throw new Error(message);
}
async function rejects(operation: () => Promise<unknown>, message: string) {
    let rejected = false;
    try {
        await operation();
    } catch {
        rejected = true;
    }
    assert(rejected, message);
}
function harness(
    options: {
        peer?: Partial<PeerCouchDBConf>;
        tweaks?: Record<string, unknown>;
        disableCheckingConfigMismatch?: boolean;
        validateConfiguration?: () => void;
    } = {},
) {
    const config: PeerCouchDBConf = {
        type: "couchdb",
        name: "configuration-peer",
        baseDir: "",
        url: "http://localhost:5989",
        database: "test",
        username: "",
        password: "",
        passphrase: "",
        obfuscatePassphrase: "",
        ...options.peer,
    };
    const peer = new PeerCouchDB(config, async () => {}, {
        disableCheckingConfigMismatch: options.disableCheckingConfigMismatch,
        validateConfiguration: options.validateConfiguration,
    });
    peer.normalLog = () => {};
    const settings = new Map<string, string>();
    peer.getSetting = (key) => settings.get(peer._getKey(key)) ?? null;
    peer.setSetting = (key, value) => {
        settings.set(peer._getKey(key), value);
    };
    (peer as unknown as { _buildManipulator(): void })._buildManipulator = () => {
        peer.man = { ...peer.man, since: peer.getSetting("since") ?? "" } as DirectFileManipulator;
    };
    const milestone = { created: 7, tweak_values: options.tweaks ?? { PREFERRED: {} } };
    let watchCount = 0;
    let startingSince = "";
    peer.man = {
        ready: { promise: Promise.resolve() },
        since: "",
        options: config,
        rawGet: () => Promise.resolve(milestone),
        liveSyncLocalDB: { initializeDatabase: () => Promise.resolve(true) },
        beginWatch: () => {
            watchCount++;
            startingSince = peer.man.since;
        },
    } as unknown as DirectFileManipulator;
    return {
        peer,
        config,
        settings,
        connect: () => (peer as unknown as { _connectAndWatch(): Promise<void> })._connectAndWatch(),
        watches: () => watchCount,
        startingSince: () => startingSince,
    };
}

for (const version of [0, 1] as const) {
    for (const preferred of [{}, { handleFilenameCaseSensitive: false }]) {
        Deno.test(
            `CouchDB rejects remote filename case mismatch before watching, version=${version}, advertised=${"handleFilenameCaseSensitive" in preferred}`,
            async () => {
                const h = harness({
                    peer: { pathNormalizationVersion: version, handleFilenameCaseSensitive: true },
                    tweaks: { PREFERRED: preferred },
                });
                await rejects(h.connect, "Different remote case rules must reject the connection");
                assert(h.watches() === 0, "Rejected settings must not start a changes feed");
                assert(
                    h.config.handleFilenameCaseSensitive === true,
                    "A rejected remote must not rewrite the configured value",
                );
            },
        );
    }
}

Deno.test("CouchDB accepts omitted and false remote case values as equal", async () => {
    const h = harness({ tweaks: { PREFERRED: { handleFilenameCaseSensitive: false } } });
    await h.connect();
    assert(h.watches() === 1, "Matching defaults must start watching");
});

Deno.test("CouchDB mismatch override keeps configured case settings and starts watching", async () => {
    const h = harness({ peer: { handleFilenameCaseSensitive: true }, disableCheckingConfigMismatch: true });
    await h.connect();
    assert(
        h.watches() === 1 && h.config.handleFilenameCaseSensitive === true,
        "Override must permit the mismatch without changing case policy",
    );
});

Deno.test(
    "CouchDB uses the preferred remote tweaks and validates their effective case policy before watching",
    async () => {
        let validated = false;
        const h = harness({
            peer: { useRemoteTweaks: true },
            tweaks: {
                previousDevice: { handleFilenameCaseSensitive: false },
                PREFERRED: { handleFilenameCaseSensitive: true },
            },
            validateConfiguration: () => {
                assert(
                    h.config.handleFilenameCaseSensitive === true,
                    "The preferred case policy must be applied before validation",
                );
                assert(h.watches() === 0, "Validation must precede the changes feed");
                validated = true;
            },
        });
        await h.connect();
        assert(validated && h.watches() === 1, "Effective configuration must be checked before watching");
    },
);

for (const disabled of [false, true]) {
    Deno.test(`CouchDB remote tweak adoption checks group agreement, override=${disabled}`, async () => {
        const storage: PeerStorageConf = { type: "storage", name: "storage", baseDir: "", pathNormalizationVersion: 1 };
        const h = harness({
            peer: { pathNormalizationVersion: 1, useRemoteTweaks: true },
            tweaks: { PREFERRED: { handleFilenameCaseSensitive: true } },
            disableCheckingConfigMismatch: disabled,
            validateConfiguration: () => {
                const config: Config = Object.assign(
                    { peers: [h.config, storage] },
                    { disableCheckingConfigMismatch: disabled },
                );
                validatePeerPathIdentity(config);
            },
        });
        if (disabled) await h.connect();
        else await rejects(h.connect, "Remote adoption must not silently introduce a group mismatch");
        assert(h.watches() === (disabled ? 1 : 0), "Only an explicit override may start a mismatched group");
        assert(
            storage.handleFilenameCaseSensitive === undefined,
            "Remote adoption must not change another peer's policy",
        );
    });
}

for (const savedSequence of [undefined, "12-sensitive"]) {
    Deno.test(
        `CouchDB reloads the effective NFC case checkpoint after remote adoption, saved=${savedSequence}`,
        async () => {
            const h = harness({
                peer: { pathNormalizationVersion: 1, useRemoteTweaks: true },
                tweaks: { PREFERRED: { handleFilenameCaseSensitive: true } },
            });
            h.peer.setSetting("since", "99-insensitive");
            h.peer.setSetting("remote-created", "7");
            h.peer.man.since = "99-insensitive";
            h.config.handleFilenameCaseSensitive = true;
            h.peer.setSetting("remote-created", "7");
            if (savedSequence) h.peer.setSetting("since", savedSequence);
            h.config.handleFilenameCaseSensitive = false;
            await h.connect();
            assert(
                h.startingSince() === (savedSequence ?? ""),
                "The watch must use only the effective policy's sequence",
            );
            h.config.handleFilenameCaseSensitive = false;
            assert(h.peer.getSetting("since") === "99-insensitive", "Another policy's saved state must remain intact");
        },
    );
}

Deno.test(
    "CouchDB explicit remote adoption uses the established false default when the case value is absent",
    async () => {
        const h = harness({
            peer: { useRemoteTweaks: true, handleFilenameCaseSensitive: true },
            tweaks: { PREFERRED: {} },
        });
        await h.connect();
        assert(
            h.config.handleFilenameCaseSensitive === false && h.watches() === 1,
            "Explicit adoption must use the remote effective default",
        );
    },
);
