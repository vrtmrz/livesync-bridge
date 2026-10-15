import { DirectFileManipulator } from "@vrtmrz/livesync-commonlib";
import type { DispatchFun } from "./Peer.ts";
import { PeerCouchDB } from "./PeerCouchDB.ts";
import type { PeerCouchDBConf } from "./types.ts";

function assertEquals(actual: unknown, expected: unknown, message: string) {
    if (actual !== expected) throw new Error(`${message}: expected=${expected}, actual=${actual}`);
}

function makePeer(settings = new Map<string, string>(), overrides: Partial<PeerCouchDBConf> = {}, dispatcher: DispatchFun = async () => {}) {
    const peer = new PeerCouchDB({
        type: "couchdb", name: "checkpoint-peer", baseDir: "",
        url: "https://one.example.test/proxy", database: "notes", username: "", password: "",
        passphrase: "", obfuscatePassphrase: "", ...overrides,
    }, dispatcher);
    peer.setSetting = (key, value) => { settings.set(peer._getKey(key), value); };
    peer.getSetting = (key) => settings.get(peer._getKey(key)) ?? null;
    peer.normalLog = () => {};
    peer.sendLog = () => {};
    peer.man = { since: peer.getSetting("since") ?? "" } as DirectFileManipulator;
    return peer;
}

for (const [description, overrides] of [
    ["server", { url: "https://two.example.test/proxy" }],
    ["database", { database: "other-notes" }],
    ["peer", { name: "another-peer" }],
    ["base directory", { baseDir: "subfolder/" }],
    ["proxy path", { url: "https://one.example.test/other-proxy" }],
] as const) {
    Deno.test(`CouchDB checkpoints are isolated by ${description}`, () => {
        const settings = new Map<string, string>();
        const first = makePeer(settings);
        first.advanceSince("41-first");
        first.setSetting("remote-created", "7");
        const other = makePeer(settings, overrides);
        assertEquals(other.getSetting("since"), null, "A different scope must not inherit the previous sequence");
        assertEquals(other.getSetting("remote-created"), null, "The remote generation must have the same scope");
        other.advanceSince("9-other");
        other.setSetting("remote-created", "7");
        const restored = makePeer(settings);
        assertEquals(restored.getSetting("since"), "41-first", "Returning to the original remote must restore its sequence");
        assertEquals(restored.getSetting("remote-created"), "7", "The original remote generation must remain available");
    });
}

Deno.test("CouchDB checkpoint identity normalises endpoints and excludes credentials", () => {
    const settings = new Map<string, string>();
    const first = makePeer(settings, { url: "https://alice:old-secret@ONE.example.test:443/proxy/", password: "old-password" });
    first.advanceSince("41-token");
    first.setSetting("remote-created", "7");
    const restored = makePeer(settings, { url: "https://bob:new-secret@one.example.test/proxy", password: "new-password" });
    assertEquals(restored.getSetting("since"), "41-token", "Credential rotation and equivalent URLs must preserve the sequence");
    assertEquals(restored.getSetting("remote-created"), "7", "Equivalent endpoints must preserve the generation");
    assertEquals([...settings.keys()].some((key) => /alice|bob|secret|password/.test(key)), false, "Checkpoint keys must not contain credentials");
});

Deno.test("CouchDB checkpoint scopes cannot collide through separator characters", () => {
    const settings = new Map<string, string>();
    const first = makePeer(settings, { name: "alpha-couchdb-beta", baseDir: "gamma" });
    const other = makePeer(settings, { name: "alpha", baseDir: "beta-couchdb-gamma" });
    first.advanceSince("41-token");
    assertEquals(other.getSetting("since"), null, "Different peer scopes must remain separate even when legacy keys collide");
});

Deno.test("CouchDB checkpoint scoping preserves other peer setting keys", () => {
    const peer = makePeer();
    assertEquals(peer._getKey("other-setting"), "checkpoint-peer-couchdb--other-setting", "Unrelated settings must retain their existing keys");
});

type Change = {
    seq: string;
    doc: { _id: string; path: string; type: string; data: string[]; size: number; ctime: number; mtime: number; deleted?: boolean };
};

async function attachWatch(peer: PeerCouchDB, created: number | false = 7) {
    let onChange!: (event: Change) => Promise<void>;
    let startingSince: string | undefined;
    const feed = {
        on(event: string, handler: unknown) {
            if (event === "change") onChange = handler as typeof onChange;
            return feed;
        },
    };
    peer.man = {
        since: peer.getSetting("since") ?? "",
        watching: false,
        ready: { promise: Promise.resolve() },
        rawGet: () => Promise.resolve(created === false ? false : { created }),
        getByMeta: (doc: Change["doc"]) => Promise.resolve(doc),
        beginWatch: DirectFileManipulator.prototype.beginWatch,
        liveSyncLocalDB: { localDatabase: { changes(options: { since: string }) { startingSince = options.since; return feed; } } },
    } as unknown as DirectFileManipulator;
    await (peer as unknown as { _connectAndWatch(): Promise<void> })._connectAndWatch();
    return {
        startingSince,
        emit: (seq: string, deleted = false) => onChange({ seq, doc: {
            _id: "note", path: "note.md", type: "plain", data: ["note"], size: 4, ctime: 1, mtime: 2, deleted,
        } }),
    };
}

Deno.test("CouchDB does not reuse legacy checkpoints without a remote identity", async () => {
    const settings = new Map([
        ["checkpoint-peer-couchdb--since", "999-old"],
        ["checkpoint-peer-couchdb--remote-created", "7"],
    ]);
    const peer = makePeer(settings);
    assertEquals(peer.getSetting("since"), null, "An unbound legacy sequence must not be trusted");
    const watch = await attachWatch(peer);
    assertEquals(watch.startingSince, "", "An unrecognised remote must be read from the beginning");
    assertEquals(peer.getSetting("since"), "", "The initial position must be persisted before any change arrives");
    assertEquals(settings.get("checkpoint-peer-couchdb--since"), "999-old", "Legacy state must be left untouched");
});

Deno.test("CouchDB persists a rebuilt database's reset before starting its feed", async () => {
    const settings = new Map<string, string>();
    const peer = makePeer(settings);
    peer.setSetting("since", "100-old-database");
    peer.setSetting("remote-created", "7");
    const watch = await attachWatch(peer, 8);
    assertEquals(watch.startingSince, "", "A new generation must start from the beginning");
    assertEquals(makePeer(settings).getSetting("since"), "", "A restart before the first change must not restore the old sequence");
    assertEquals(peer.getSetting("remote-created"), "8", "The new generation must be recorded");
});

Deno.test("CouchDB clears an old checkpoint when the remote is empty", async () => {
    const peer = makePeer();
    peer.setSetting("since", "100-old-database");
    peer.setSetting("remote-created", "7");
    await attachWatch(peer, false);
    assertEquals(peer.man.since, "", "An empty remote must discard the old in-memory sequence");
    assertEquals(peer.getSetting("since"), "", "An empty remote must discard the old saved sequence");
    assertEquals(peer.getSetting("remote-created"), "0", "The empty remote marker must remain scoped to this peer");
});

Deno.test("CouchDB persists the feed sequence after dispatch and resumes a new peer from it", async () => {
    const settings = new Map<string, string>();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const peer = makePeer(settings, {}, async () => { started.resolve(); await release.promise; });
    peer.setSetting("since", "40-token");
    peer.setSetting("remote-created", "7");
    const watch = await attachWatch(peer);
    const pending = watch.emit("41-token");
    await started.promise;
    try {
        assertEquals(peer.getSetting("since"), "40-token", "A pending dispatch must not advance its own checkpoint");
    } finally {
        release.resolve();
        await pending;
    }
    assertEquals(peer.man.since, "41-token", "A reconnect must use the delivered change's position");
    const restarted = makePeer(settings);
    assertEquals((await attachWatch(restarted)).startingSince, "41-token", "A new peer instance must resume from the saved position");
});

Deno.test("CouchDB does not advance the checkpoint of a rejected dispatch", async () => {
    const peer = makePeer(undefined, {}, () => Promise.reject(new Error("Controlled destination failure")));
    peer.setSetting("since", "40-token");
    peer.setSetting("remote-created", "7");
    const watch = await attachWatch(peer);
    await watch.emit("41-token");
    assertEquals(peer.getSetting("since"), "40-token", "A rejected dispatch must retain its own checkpoint");
});

Deno.test("CouchDB checkpoints a dispatched deletion", async () => {
    let deletion = false;
    const peer = makePeer(undefined, {}, (_source, _path, data) => { deletion = data === false; return Promise.resolve(); });
    peer.setSetting("remote-created", "7");
    const watch = await attachWatch(peer);
    await watch.emit("41-token", true);
    assertEquals(deletion, true, "The hub must receive the deletion");
    assertEquals(peer.getSetting("since"), "41-token", "A delivered deletion must advance the checkpoint");
});
