import { DirectFileManipulator } from "@vrtmrz/livesync-commonlib";
import { MILESTONE_DOCID, TweakValuesTemplate, type FilePathWithPrefix } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { decodeBinary } from "@vrtmrz/livesync-commonlib/compat/string_and_binary/convert";
import { getDocData } from "@vrtmrz/livesync-commonlib/compat/common/utils";
import { defaultLogger, setGlobalLogFunction } from "octagonal-wheels/common/logger";
import { PeerCouchDB } from "../../PeerCouchDB.ts";
import { PeerStorage } from "../../PeerStorage.ts";
import { Hub } from "../../Hub.ts";
import type { FileData, PeerCouchDBConf } from "../../types.ts";

const couchDbUrl = Deno.env.get("COUCHDB_URL") ?? "http://127.0.0.1:5989";
const couchDbUsername = Deno.env.get("COUCHDB_USERNAME") ?? "admin";
const couchDbPassword = Deno.env.get("COUCHDB_PASSWORD") ?? "testpassword";
const authHeader = `Basic ${btoa(`${couchDbUsername}:${couchDbPassword}`)}`;

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function assertEquals<T>(actual: T, expected: T, message: string): void {
    if (actual !== expected) {
        throw new Error(`${message}\nactual=${String(actual)}\nexpected=${String(expected)}`);
    }
}

async function waitForCouchDb(): Promise<void> {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${couchDbUrl}/_up`, { headers: { authorization: authHeader } });
            if (response.ok) return;
        } catch {
            // CouchDB is still starting.
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`CouchDB did not become ready at ${couchDbUrl} within 60 seconds`);
}

async function requestDatabase(database: string, method: "PUT" | "DELETE"): Promise<Response> {
    return await fetch(`${couchDbUrl}/${database}`, {
        method,
        headers: { authorization: authHeader },
    });
}

function makeConfig(name: string, database: string): PeerCouchDBConf {
    return {
        type: "couchdb",
        name,
        database,
        username: couchDbUsername,
        password: couchDbPassword,
        url: couchDbUrl,
        passphrase: "content-encryption-passphrase",
        obfuscatePassphrase: "path-obfuscation-passphrase",
        baseDir: "",
    };
}

Deno.test("PeerCouchDB exchanges files with distinct content and path passphrases", async () => {
    await waitForCouchDb();

    const suffix = crypto.randomUUID().replaceAll("-", "");
    const database = `livesync_bridge_${suffix}`;
    const created = await requestDatabase(database, "PUT");
    assert(created.ok, `Could not create integration database: HTTP ${created.status} ${await created.text()}`);

    const peerA = new PeerCouchDB(makeConfig(`integration-a-${suffix}`, database), () => Promise.resolve());
    const peerB = new PeerCouchDB(makeConfig(`integration-b-${suffix}`, database), () => Promise.resolve());
    const path = "note.md" as FilePathWithPrefix;
    const serviceLogs: string[] = [];
    setGlobalLogFunction((message) => serviceLogs.push(String(message)));

    try {
        await Promise.all([peerA.start(), peerB.start()]);
        assert(peerA.man.liveSyncLocalDB.isReady, "The first direct database should finish initialisation");
        assert(peerB.man.liveSyncLocalDB.isReady, "The second direct database should finish initialisation");

        const first: FileData = {
            ctime: 1_700_000_000_000,
            mtime: 1_700_000_000_000,
            size: 5,
            data: ["hello"],
        };
        assert(await peerA.put(path, first), "The first peer should store the file");

        const readByB = await peerB.get(path);
        assert(readByB !== false, "The second peer should read the file");
        assertEquals(readByB.data.join(""), "hello", "The second peer should receive the original content");

        const second: FileData = {
            ...first,
            mtime: first.mtime + 10_000,
            size: 7,
            data: ["updated"],
        };
        assert(await peerB.put(path, second), "The second peer should update the file");

        const readByA = await peerA.get(path);
        assert(readByA !== false, "The first peer should read the updated file");
        assertEquals(readByA.data.join(""), "updated", "The first peer should receive the updated content");

        assert(await peerB.delete(path), "The second peer should delete the file");
        assertEquals(await peerA.get(path), false, "The first peer should observe the deletion");

        const failedInitialisationLogs = serviceLogs.filter((message) =>
            message.includes("Failed to open KeyValueDB") ||
            message.includes("No replicator is available") ||
            message.includes("prevented the database from being ready")
        );
        assertEquals(
            failedInitialisationLogs.length,
            0,
            `Direct database initialisation should not run unrelated application services: ${failedInitialisationLogs.join("; ")}`,
        );
    } finally {
        await Promise.allSettled([peerA.stop(), peerB.stop()]);
        await Promise.allSettled([peerA.man?.close(), peerB.man?.close()]);
        setGlobalLogFunction(defaultLogger);
        await requestDatabase(database, "DELETE");
    }
});

Deno.test("PeerCouchDB uses a recovery code to read and write an existing ID-v1 vault", async () => {
    await waitForCouchDb();

    const suffix = crypto.randomUUID().replaceAll("-", "");
    const database = `livesync_bridge_id_v1_${suffix}`;
    const created = await requestDatabase(database, "PUT");
    assert(created.ok, `Could not create integration database: HTTP ${created.status} ${await created.text()}`);

    const idDerivationKey = "0123456789abcdef".repeat(4);
    const reference = new DirectFileManipulator({
        ...makeConfig(`reference-${suffix}`, database),
        idDerivationKey,
        idDerivationVersion: 1,
        encryptInternalMetadata: true,
    }, { fetch: globalThis.fetch });
    const peer = new PeerCouchDB({
        ...makeConfig(`integration-id-v1-${suffix}`, database),
        idDerivationKey: ` sls-id-v1:${idDerivationKey} `,
        useRemoteTweaks: true,
    }, async () => {});
    const settings = new Map<string, string>();
    peer.getSetting = (key) => settings.get(key) ?? null;
    peer.setSetting = (key, value) => { settings.set(key, value); };

    try {
        await reference.ready.promise;
        const info = { ctime: 1_700_000_000_000, mtime: 1_700_000_000_000, size: 4 };
        assert(await reference.put("existing.md", new Blob(["seed"], { type: "text/plain" }), info, "plain"),
            "The reference writer should seed a note before the bridge starts");

        const milestone = await fetch(`${couchDbUrl}/${database}/${MILESTONE_DOCID}`, {
            method: "PUT",
            headers: { authorization: authHeader, "content-type": "application/json" },
            body: JSON.stringify({
                _id: MILESTONE_DOCID,
                created: 12345,
                tweak_values: {
                    PREFERRED: {
                        ...TweakValuesTemplate,
                        encrypt: true,
                        usePathObfuscation: true,
                        idDerivationVersion: 1,
                        encryptInternalMetadata: true,
                    },
                },
            }),
        });
        assert(milestone.ok, `Could not store remote tweaks: HTTP ${milestone.status} ${await milestone.text()}`);

        await peer.start();
        assertEquals(peer.config.encryptInternalMetadata, true, "The bridge should apply the remote metadata encryption setting");
        const seed = await peer.get("existing.md" as FilePathWithPrefix);
        assert(seed !== false, "The recovery code should allow the bridge to find the existing note");
        assertEquals(seed.data.join(""), "seed", "The bridge should read the existing content");

        for (const path of ["new.md", "i:settings.json", "drawing.excalidraw"]) {
            const data = path.endsWith(".excalidraw") ? new TextEncoder().encode("file") : ["file"];
            assert(await peer.put(path, { ...info, data }), `The bridge should write ${path}`);
            const read = await reference.get(path as FilePathWithPrefix);
            assert(read !== false, `The reference reader should find ${path} at its ID-v1 document ID`);
            const content = read.type === "newnote"
                ? new TextDecoder().decode(decodeBinary(read.data))
                : getDocData(read.data);
            assertEquals(content, "file", `The reference reader should recover the content of ${path}`);

            const id = await reference.path2id(path as FilePathWithPrefix);
            const response = await fetch(`${couchDbUrl}/${database}/${encodeURIComponent(id)}`, {
                headers: { authorization: authHeader },
            });
            const raw = await response.json();
            assert(response.ok, `The raw document for ${path} should exist`);
            assert(typeof raw.path === "string" && raw.path.startsWith("/\\:"), `The stored metadata for ${path} should be encrypted`);
            assertEquals(raw.size, 0, `The stored size for ${path} should be concealed`);
        }
    } finally {
        await peer.stop();
        await Promise.allSettled([reference.close(), peer.man?.close()]);
        await (await requestDatabase(database, "DELETE")).text();
    }
});

Deno.test("PeerCouchDB allows legacy writes with a whitespace-only ID key", async () => {
    await waitForCouchDb();

    const suffix = crypto.randomUUID().replaceAll("-", "");
    const database = `livesync_bridge_blank_id_${suffix}`;
    const created = await requestDatabase(database, "PUT");
    assert(created.ok, `Could not create integration database: HTTP ${created.status} ${await created.text()}`);

    const peer = new PeerCouchDB({
        ...makeConfig(`integration-blank-id-${suffix}`, database),
        idDerivationKey: " \t\n",
    }, async () => {});
    const man = new DirectFileManipulator(peer.config, { fetch: globalThis.fetch });
    try {
        await man.ready.promise;
        const path = "legacy.md" as FilePathWithPrefix;
        assert(await man.put(path, new Blob(["legacy"], { type: "text/plain" }), {
            ctime: 1_700_000_000_000,
            mtime: 1_700_000_000_000,
            size: 6,
        }, "plain"), "An omitted ID key should allow a legacy write");
        const read = await man.get(path);
        assert(read !== false, "The legacy document should be readable");
        assertEquals(getDocData(read.data), "legacy", "The legacy document should retain its content");
    } finally {
        await man.close();
        await (await requestDatabase(database, "DELETE")).text();
    }
});


Deno.test("PeerCouchDB resumes a stopped peer and delivers offline changes to storage", async () => {
    await waitForCouchDb();
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const database = `livesync_bridge_checkpoint_${suffix}`;
    const created = await requestDatabase(database, "PUT");
    assert(created.ok, `Could not create checkpoint database: HTTP ${created.status} ${await created.text()}`);
    const tempDir = await Deno.makeTempDir({ prefix: "peer-couchdb-checkpoint-" });
    const config = { ...makeConfig(`checkpoint-${suffix}`, database), passphrase: "", obfuscatePassphrase: "" };
    const writer = new DirectFileManipulator(config, { fetch: globalThis.fetch });
    const hub = new Hub({ peers: [] });
    const delivered: string[] = [];
    const dispatch: typeof hub.dispatch = async (source, path, data) => {
        await hub.dispatch(source, path, data);
        delivered.push(path);
    };
    const first = new PeerCouchDB({ ...config }, dispatch);
    const restarted = new PeerCouchDB({ ...config }, dispatch);
    const storage = new PeerStorage({
        type: "storage", name: `checkpoint-storage-${suffix}`, baseDir: tempDir, scanOfflineChanges: false,
    }, async () => {});
    const storageSettings = new Map<string, string>();
    storage.getSetting = (key) => storageSettings.get(key) ?? null;
    storage.setSetting = (key, value) => { storageSettings.set(key, value); };
    const waitForFile = async (path: string, content: string) => {
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
            try {
                if (await Deno.readTextFile(`${tempDir}/${path}`) === content && delivered.includes(path)) return;
            } catch (error) {
                if (!(error instanceof Deno.errors.NotFound)) throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error(`The changes feed did not deliver ${path} to storage`);
    };
    const info = { ctime: 1_700_000_000_000, mtime: 1_700_000_002_000, size: 6 };
    try {
        await writer.ready.promise;
        const milestone = await fetch(`${couchDbUrl}/${database}/${MILESTONE_DOCID}`, {
            method: "PUT",
            headers: { authorization: authHeader, "content-type": "application/json" },
            body: JSON.stringify({ _id: MILESTONE_DOCID, created: Date.now() }),
        });
        assert(milestone.ok, `Could not create the checkpoint milestone: ${await milestone.text()}`);
        hub.peers = [first, storage];
        await first.start();
        assert(await writer.put("before.md", new Blob(["before"], { type: "text/plain" }), info, "plain"), "The first note should be written");
        await waitForFile("before.md", "before");
        const saved = first.getSetting("since");
        assert(saved !== null && saved !== "" && saved !== "now", "The running peer should save a concrete feed position");
        await first.stop();
        await first.man.close();
        delivered.length = 0;

        assert(await writer.put("offline.md", new Blob(["missed"], { type: "text/plain" }), info, "plain"), "A note should be written while the peer is stopped");
        assertEquals(restarted.getSetting("since"), saved, "The new peer instance should read the persisted position");
        hub.peers = [restarted, storage];
        await restarted.start();
        await waitForFile("offline.md", "missed");
        assertEquals(delivered.includes("before.md"), false, "The resumed feed should not replay the note before its saved position");
        assert(restarted.getSetting("since") !== saved, "The offline change should advance the saved position");
    } finally {
        await Promise.allSettled([first.stop(), restarted.stop()]);
        await Promise.allSettled([writer.close(), first.man?.close(), restarted.man?.close()]);
        localStorage.removeItem(first._getKey("since"));
        localStorage.removeItem(first._getKey("remote-created"));
        await (await requestDatabase(database, "DELETE")).text();
        await Deno.remove(tempDir, { recursive: true });
    }
});
