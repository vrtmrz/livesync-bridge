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
        syncInternalFiles: true,
    }, { fetch: globalThis.fetch });
    const peer = new PeerCouchDB({
        ...makeConfig(`integration-id-v1-${suffix}`, database),
        idDerivationKey: ` sls-id-v1:${idDerivationKey} `,
        includeInternal: [".claude/**"],
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
        assert(await reference.put(
            "i:settings.json",
            new Blob(["legacy"], { type: "text/plain" }),
            { ...info, size: "legacy".length },
            "plain",
        ), "The reference writer should seed the legacy raw internal path before the bridge starts");

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

        for (const [sharedPath, logicalPath] of [
            ["new.md", "new.md"],
            [".claude/settings.json", "i:.claude/settings.json"],
            ["drawing.excalidraw", "drawing.excalidraw"],
        ] as const) {
            const data = sharedPath.endsWith(".excalidraw")
                ? new TextEncoder().encode("file")
                : ["file"];
            assert(await peer.put(sharedPath, { ...info, data }), `The bridge should write ${sharedPath}`);
            const read = await reference.get(logicalPath as FilePathWithPrefix);
            assert(read !== false, `The reference reader should find ${logicalPath} at its ID-v1 document ID`);
            const content = read.type === "newnote"
                ? new TextDecoder().decode(decodeBinary(read.data))
                : getDocData(read.data);
            assertEquals(content, "file", `The reference reader should recover the content of ${sharedPath}`);

            const id = await reference.path2id(logicalPath as FilePathWithPrefix);
            const response = await fetch(`${couchDbUrl}/${database}/${encodeURIComponent(id)}`, {
                headers: { authorization: authHeader },
            });
            const raw = await response.json();
            assert(response.ok, `The raw document for ${sharedPath} should exist`);
            assert(typeof raw.path === "string" && raw.path.startsWith("/\\:"), `The stored metadata for ${sharedPath} should be encrypted`);
            assertEquals(raw.size, 0, `The stored size for ${sharedPath} should be concealed`);
        }

        const legacyPath = "i:settings.json" as FilePathWithPrefix;
        assertEquals(await peer.get(legacyPath), false, "The bridge should reject a raw-prefixed shared-path read");
        assertEquals(await peer.getMeta(legacyPath), false, "The bridge should reject a raw-prefixed Metadata read");
        assertEquals(
            await peer.put(legacyPath, { ...info, data: ["replacement"], size: "replacement".length }),
            false,
            "The bridge should reject a raw-prefixed write",
        );
        assertEquals(await peer.delete(legacyPath), false, "The bridge should reject a raw-prefixed deletion");
        const legacyRead = await reference.get(legacyPath);
        assert(legacyRead !== false, "The reference reader should retain the seeded legacy internal path");
        const legacyContent = legacyRead.type === "newnote"
            ? new TextDecoder().decode(decodeBinary(legacyRead.data))
            : getDocData(legacyRead.data);
        assertEquals(legacyContent, "legacy", "Rejected raw-prefixed operations should preserve legacy content");
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

for (const baseDir of ["", "blog/"]) {
    for (const encryptInternalMetadata of [false, true]) {
        Deno.test(
            [
                "PeerCouchDB routes selected hidden files bidirectionally",
                `baseDir: ${baseDir || "empty"}`,
                `encrypted metadata: ${encryptInternalMetadata}`,
            ].join(" | "),
            async () => {
                await waitForCouchDb();
                const suffix = crypto.randomUUID().replaceAll("-", "");
                const database = `livesync_bridge_internal_${suffix}`;
                const created = await requestDatabase(database, "PUT");
                assert(
                    created.ok,
                    `Could not create internal-file database: HTTP ${created.status} ${await created
                        .text()}`,
                );
                const tempDir = await Deno.makeTempDir({
                    prefix: "peer-couchdb-internal-",
                });
                const configName = [
                    "internal",
                    baseDir || "root",
                    encryptInternalMetadata,
                    suffix,
                ].join("-");
                const config = {
                    ...makeConfig(configName, database),
                    baseDir,
                    encryptInternalMetadata,
                };
                const writer = new DirectFileManipulator(
                    { ...config, syncInternalFiles: true },
                    { fetch: globalThis.fetch },
                );
                const hub = new Hub({ peers: [] });
                const delivered = new Map<string, boolean>();
                const localDispatches: Array<{ path: string; deleted: boolean }> = [];
                const peerOperations: Array<
                    { path: string; deleted: boolean; accepted: boolean }
                > = [];
                const dispatch = async (
                    source: Parameters<Hub["dispatch"]>[0],
                    path: string,
                    data: FileData | false,
                ) => {
                    await hub.dispatch(source, path, data);
                    if (source === peer) delivered.set(path, data !== false);
                    if (source === storage) {
                        localDispatches.push({ path, deleted: data === false });
                    }
                };
                const peer = new PeerCouchDB({
                    ...config,
                    includeInternal: [".claude/**"],
                    useRemoteTweaks: true,
                }, dispatch);
                const storage = new PeerStorage({
                    type: "storage",
                    name: `internal-storage-${suffix}`,
                    baseDir: tempDir,
                    scanOfflineChanges: false,
                }, dispatch);
                for (const instance of [peer, storage]) {
                    const settings = new Map<string, string>();
                    instance.getSetting = (key) => settings.get(key) ?? null;
                    instance.setSetting = (key, value) => {
                        settings.set(key, value);
                    };
                }
                hub.peers = [peer, storage];

                const waitFor = async (
                    condition: () => boolean | Promise<boolean>,
                    message: string,
                ) => {
                    const deadline = Date.now() + 10_000;
                    while (Date.now() < deadline) {
                        if (await condition()) return;
                        await new Promise((resolve) => setTimeout(resolve, 25));
                    }
                    throw new Error(message);
                };
                const readStorageText = async (
                    path: string,
                ): Promise<string | false> => {
                    try {
                        return await Deno.readTextFile(`${tempDir}/${path}`);
                    } catch (error) {
                        if (error instanceof Deno.errors.NotFound) return false;
                        throw error;
                    }
                };
                const readWriterText = async (
                    path: string,
                ): Promise<string | false> => {
                    const result = await writer.get(path as FilePathWithPrefix);
                    if (result === false) return false;
                    return result.type === "newnote"
                        ? new TextDecoder().decode(decodeBinary(result.data))
                        : getDocData(result.data);
                };
                const waitForFile = async (path: string, content: string | false) => {
                    await waitFor(
                        async () =>
                            (await readStorageText(path)) === content &&
                            delivered.get(path) === (content !== false),
                        `The changes feed did not deliver ${path} to storage: ${content}`,
                    );
                };
                const waitForWriterText = async (
                    path: string,
                    content: string | false,
                ) => {
                    await waitFor(
                        async () => (await readWriterText(path)) === content,
                        `CouchDB did not reach the expected content for ${path}: ${content}`,
                    );
                };

                const hiddenSharedPath = ".claude/settings.json" as FilePathWithPrefix;
                const hiddenDocumentPath =
                    "i:.claude/settings.json" as FilePathWithPrefix;
                const hiddenAliasPath =
                    `${baseDir}.claude/settings.json` as FilePathWithPrefix;
                const excludedSharedPath = ".obsidian/app.json" as FilePathWithPrefix;
                const excludedDocumentPath =
                    "i:.obsidian/app.json" as FilePathWithPrefix;
                const excludedAliasPath =
                    `${baseDir}.obsidian/app.json` as FilePathWithPrefix;
                const ordinaryDocumentPath = `${baseDir}note.md` as FilePathWithPrefix;
                const info = {
                    ctime: 1_700_000_000_000,
                    mtime: 1_700_000_002_000,
                    size: 6,
                };
                const writeInternal = async (
                    path: FilePathWithPrefix,
                    content: string,
                    mtime: number,
                ) => {
                    return await writer.put(path, new Blob([content]), {
                        ...info,
                        mtime,
                        size: new TextEncoder().encode(content).byteLength,
                    }, "newnote");
                };
                let markerCount = 0;
                const writeMarker = async (content: string) => {
                    markerCount++;
                    assert(
                        await writer.put(
                            ordinaryDocumentPath,
                            new Blob([content], { type: "text/plain" }),
                            {
                                ...info,
                                mtime: info.mtime + markerCount * 2_000,
                                size: new TextEncoder().encode(content).byteLength,
                            },
                            "plain",
                        ),
                        `The reference writer should write the marker ${content}`,
                    );
                    await waitForFile("note.md", content);
                };

                try {
                    await writer.ready.promise;
                    await Deno.mkdir(`${tempDir}/.obsidian`, { recursive: true });
                    await Deno.writeTextFile(
                        `${tempDir}/.obsidian/app.json`,
                        "local-existing",
                    );
                    assert(
                        await writer.put(
                            ordinaryDocumentPath,
                            new Blob(["normal"], { type: "text/plain" }),
                            info,
                            "plain",
                        ),
                        "The reference writer should seed a normal note",
                    );
                    assert(
                        await writeInternal(hiddenDocumentPath, "hidden", info.mtime),
                        "The reference writer should seed the selected hidden document",
                    );
                    assert(
                        await writeInternal(
                            excludedDocumentPath,
                            "remote-existing",
                            info.mtime + 1,
                        ),
                        "The reference writer should seed an unmatched hidden document",
                    );

                    const id = await writer.path2id(hiddenDocumentPath);
                    const rawResponse = await fetch(
                        `${couchDbUrl}/${database}/${encodeURIComponent(id)}`,
                        {
                            headers: { authorization: authHeader },
                        },
                    );
                    assert(rawResponse.ok, "The hidden document should exist in CouchDB");
                    const raw = await rawResponse.json();
                    assertEquals(
                        raw.path.startsWith("/\\:"),
                        encryptInternalMetadata,
                        "The fixture must exercise the selected internal metadata encryption mode",
                    );
                    assertEquals(
                        raw.children.length === 0,
                        encryptInternalMetadata,
                        "Encrypted metadata must conceal chunk references",
                    );

                    const milestone = await fetch(
                        `${couchDbUrl}/${database}/${MILESTONE_DOCID}`,
                        {
                            method: "PUT",
                            headers: {
                                authorization: authHeader,
                                "content-type": "application/json",
                            },
                            body: JSON.stringify({
                                _id: MILESTONE_DOCID,
                                created: Date.now(),
                                tweak_values: {
                                    PREFERRED: {
                                        ...TweakValuesTemplate,
                                        encrypt: true,
                                        usePathObfuscation: true,
                                        encryptInternalMetadata,
                                    },
                                },
                            }),
                        },
                    );
                    assert(
                        milestone.ok,
                        `Could not create the internal-file milestone: ${await milestone
                            .text()}`,
                    );
                    await peer.start();
                    await waitForFile("note.md", "normal");
                    await waitForFile(".claude/settings.json", "hidden");

                    assertEquals(
                        delivered.has(excludedSharedPath),
                        false,
                        "An unmatched hidden file must not be dispatched",
                    );
                    assertEquals(
                        await readStorageText(excludedSharedPath),
                        "local-existing",
                        "The incoming unmatched file must preserve existing local data",
                    );
                    assertEquals(
                        await readWriterText(excludedDocumentPath),
                        "remote-existing",
                        "The reference writer should retain the unmatched document",
                    );
                    assertEquals(
                        await readWriterText(excludedAliasPath),
                        false,
                        "An unmatched hidden file must not have an ordinary alias",
                    );

                    const received = await peer.get(hiddenSharedPath);
                    assert(
                        received !== false,
                        "The bridge should read the selected file through its shared path",
                    );
                    assertEquals(
                        received.data instanceof Uint8Array
                            ? new TextDecoder().decode(received.data)
                            : received.data.join(""),
                        "hidden",
                        "The shared-path read should address the internal document",
                    );
                    const receivedMeta = await peer.getMeta(hiddenSharedPath);
                    assert(
                        receivedMeta !== false,
                        "The bridge should read metadata through the same shared path",
                    );
                    assertEquals(
                        receivedMeta.size,
                        "hidden".length,
                        "The Metadata lookup should address the internal document",
                    );
                    assertEquals(
                        await peer.man.path2id(hiddenDocumentPath),
                        id,
                        "The bridge and reference writer should use the same internal document ID",
                    );
                    assertEquals(
                        await readWriterText(hiddenAliasPath),
                        false,
                        "The selected hidden file must not have an ordinary alias",
                    );

                    assert(
                        await writeInternal(
                            hiddenDocumentPath,
                            "changed",
                            info.mtime + 2_000,
                        ),
                        "The reference writer should update the hidden file",
                    );
                    await waitForFile(".claude/settings.json", "changed");
                    assert(
                        await writer.delete(hiddenDocumentPath),
                        "The reference writer should delete the hidden file",
                    );
                    await waitForFile(".claude/settings.json", false);

                    assert(
                        await writeInternal(
                            excludedDocumentPath,
                            "remote-updated",
                            info.mtime + 4_000,
                        ),
                        "The reference writer should update the unmatched hidden file",
                    );
                    await writeMarker("marker-after-unmatched-update");
                    assertEquals(
                        await readStorageText(excludedSharedPath),
                        "local-existing",
                        "An unmatched incoming write must preserve existing local data",
                    );
                    assert(
                        await writer.delete(excludedDocumentPath),
                        "The reference writer should delete the unmatched hidden file",
                    );
                    await writeMarker("marker-after-unmatched-delete");
                    assertEquals(
                        await readStorageText(excludedSharedPath),
                        "local-existing",
                        "An unmatched incoming deletion must preserve existing local data",
                    );

                    const originalPut = peer.put.bind(peer);
                    peer.put = async (path, data) => {
                        const accepted = await originalPut(path, data);
                        peerOperations.push({ path, deleted: false, accepted });
                        return accepted;
                    };
                    const originalDelete = peer.delete.bind(peer);
                    peer.delete = async (path) => {
                        const accepted = await originalDelete(path);
                        peerOperations.push({ path, deleted: true, accepted });
                        return accepted;
                    };
                    const dispatchLocal = async (
                        path: string,
                        deleted: boolean,
                        accepted: boolean,
                    ) => {
                        const dispatchIndex = localDispatches.length;
                        const operationIndex = peerOperations.length;
                        const absolutePath = `${tempDir}/${path}`;
                        if (deleted) {
                            await storage.dispatchDeleted(absolutePath);
                        } else {
                            await storage.dispatch(absolutePath);
                        }
                        await waitFor(
                            () => localDispatches.length > dispatchIndex,
                            `PeerStorage did not dispatch the local change for ${path}`,
                        );
                        assertEquals(
                            localDispatches[dispatchIndex].path,
                            path,
                            `PeerStorage should route the shared path for ${path}`,
                        );
                        assertEquals(
                            localDispatches[dispatchIndex].deleted,
                            deleted,
                            `PeerStorage should preserve the operation kind for ${path}`,
                        );
                        assertEquals(
                            peerOperations.length,
                            operationIndex + 1,
                            `The Hub should make one CouchDB operation for ${path}`,
                        );
                        assertEquals(
                            peerOperations[operationIndex].path,
                            path,
                            `The CouchDB operation should use the shared path for ${path}`,
                        );
                        assertEquals(
                            peerOperations[operationIndex].deleted,
                            deleted,
                            `The CouchDB operation should preserve the operation kind for ${path}`,
                        );
                        assertEquals(
                            peerOperations[operationIndex].accepted,
                            accepted,
                            `The CouchDB peer should ${
                                accepted ? "accept" : "reject"
                            } ${path}`,
                        );
                    };

                    await Deno.mkdir(`${tempDir}/.claude`, { recursive: true });
                    await Deno.writeTextFile(
                        `${tempDir}/.claude/settings.json`,
                        "local-created",
                    );
                    await dispatchLocal(hiddenSharedPath, false, true);
                    await waitForWriterText(hiddenDocumentPath, "local-created");
                    const internalId = await writer.path2id(hiddenDocumentPath);
                    assertEquals(
                        internalId,
                        id,
                        "A local creation should use the received file internal ID",
                    );
                    assertEquals(
                        await readWriterText(hiddenAliasPath),
                        false,
                        "A local creation must not create an ordinary alias",
                    );

                    const locallyRead = await peer.get(hiddenSharedPath);
                    assert(
                        locallyRead !== false,
                        "The bridge should read its local creation by the shared path",
                    );
                    assertEquals(
                        locallyRead.data instanceof Uint8Array
                            ? new TextDecoder().decode(locallyRead.data)
                            : locallyRead.data.join(""),
                        "local-created",
                        "The local creation should be readable through the shared path",
                    );
                    const localMeta = await peer.getMeta(hiddenSharedPath);
                    assert(
                        localMeta !== false,
                        "The bridge should look up local Metadata by the shared path",
                    );
                    assertEquals(
                        localMeta.size,
                        "local-created".length,
                        "The Metadata lookup should address the local internal document",
                    );

                    await Deno.writeTextFile(
                        `${tempDir}/.claude/settings.json`,
                        "local-updated",
                    );
                    await dispatchLocal(hiddenSharedPath, false, true);
                    await waitForWriterText(hiddenDocumentPath, "local-updated");
                    assertEquals(
                        await writer.path2id(hiddenDocumentPath),
                        internalId,
                        "A local update should retain the same internal document ID",
                    );
                    assertEquals(
                        await readWriterText(hiddenAliasPath),
                        false,
                        "A local update must not create an ordinary alias",
                    );

                    await Deno.remove(`${tempDir}/.claude/settings.json`);
                    await dispatchLocal(hiddenSharedPath, true, true);
                    await waitForWriterText(hiddenDocumentPath, false);
                    assertEquals(
                        await peer.get(hiddenSharedPath),
                        false,
                        "The shared-path read should observe deletion of the internal document",
                    );
                    assertEquals(
                        await readWriterText(hiddenAliasPath),
                        false,
                        "A local deletion must not create an ordinary alias",
                    );

                    assert(
                        await writer.put(
                            hiddenAliasPath,
                            new Blob(["legacy-alias"], { type: "text/plain" }),
                            {
                                ...info,
                                mtime: info.mtime + 8_000,
                                size: "legacy-alias".length,
                            },
                            "plain",
                        ),
                        "The reference writer should seed the legacy ordinary alias",
                    );
                    const aliasId = await writer.path2id(hiddenAliasPath);
                    assert(aliasId !== id, "The ordinary alias should have its own document ID");
                    const rawAliasResponse = await fetch(
                        couchDbUrl + "/" + database + "/" + encodeURIComponent(aliasId),
                        { headers: { authorization: authHeader } },
                    );
                    assert(rawAliasResponse.ok, "The ordinary alias should exist in CouchDB");
                    const rawAlias = await rawAliasResponse.json();
                    assert(
                        typeof rawAlias.path === "string" && rawAlias.path !== hiddenAliasPath,
                        "The fixture should encrypt the ordinary alias Metadata path",
                    );
                    const assertCollisionUnchanged = async () => {
                        assertEquals(
                            await readWriterText(hiddenAliasPath),
                            "legacy-alias",
                            "A blocked internal operation must preserve the live ordinary alias",
                        );
                        assertEquals(
                            await readWriterText(hiddenDocumentPath),
                            false,
                            "A blocked internal operation must leave the internal document missing",
                        );
                    };
                    assertEquals(
                        await peer.get(hiddenSharedPath),
                        false,
                        "A live ordinary alias should block internal reads",
                    );
                    assertEquals(
                        await peer.getMeta(hiddenSharedPath),
                        false,
                        "A live ordinary alias should block internal Metadata reads",
                    );
                    assertEquals(
                        await peer.delete(hiddenSharedPath),
                        false,
                        "A live ordinary alias should block internal deletion",
                    );
                    const recoveryData: FileData = {
                        ...info,
                        mtime: info.mtime + 9_000,
                        size: "collision-recovery".length,
                        data: ["collision-recovery"],
                    };
                    assertEquals(
                        await peer.put(hiddenSharedPath, recoveryData),
                        false,
                        "A live ordinary alias should block internal writes",
                    );
                    await assertCollisionUnchanged();

                    assert(
                        await writer.delete(hiddenAliasPath),
                        "The reference writer should delete the ordinary alias",
                    );
                    assertEquals(
                        await readWriterText(hiddenAliasPath),
                        false,
                        "The encrypted ordinary alias should be deleted",
                    );
                    assertEquals(
                        await readWriterText(hiddenDocumentPath),
                        false,
                        "Deleting the alias should leave the internal document missing",
                    );
                    const rawDeletedAlias = await fetch(
                        `${couchDbUrl}/${database}/${encodeURIComponent(aliasId)}`,
                        { headers: { authorization: authHeader } },
                    );
                    const rawDeletedAliasBody = await rawDeletedAlias.text();
                    const rawDeletedAliasDoc = rawDeletedAlias.ok
                        ? JSON.parse(rawDeletedAliasBody) as {
                            deleted?: boolean;
                            _deleted?: boolean;
                        }
                        : undefined;
                    assert(
                        rawDeletedAlias.status === 404 ||
                            (rawDeletedAlias.ok &&
                                (rawDeletedAliasDoc?.deleted === true ||
                                    rawDeletedAliasDoc?._deleted === true)),
                        "A deleted encrypted alias should no longer be live in CouchDB",
                    );
                    assert(
                        await peer.put(hiddenSharedPath, recoveryData),
                        "A later write of the same payload should create the selected internal document",
                    );
                    await waitForWriterText(hiddenDocumentPath, "collision-recovery");
                    assertEquals(
                        await writer.path2id(hiddenDocumentPath),
                        id,
                        "The recovered local write should use the same internal document ID",
                    );
                    assertEquals(
                        await readWriterText(hiddenAliasPath),
                        false,
                        "The recovered internal write must leave the deleted alias absent",
                    );

                    await Deno.writeTextFile(`${tempDir}/note.md`, "local-note");
                    await dispatchLocal("note.md", false, true);
                    await waitForWriterText(ordinaryDocumentPath, "local-note");
                    const localNote = await peer.get("note.md" as FilePathWithPrefix);
                    assert(
                        localNote !== false,
                        "The ordinary note control should remain readable",
                    );
                    assertEquals(
                        localNote.data instanceof Uint8Array
                            ? new TextDecoder().decode(localNote.data)
                            : localNote.data.join(""),
                        "local-note",
                        "The ordinary note should retain its normal mapping",
                    );

                    assert(
                        await writeInternal(
                            excludedDocumentPath,
                            "remote-preserved",
                            info.mtime + 6_000,
                        ),
                        "The reference writer should recreate the unmatched document for local rejection checks",
                    );
                    await writeMarker("marker-after-unmatched-recreate");
                    assertEquals(
                        await readStorageText(excludedSharedPath),
                        "local-existing",
                        "An unmatched incoming recreation must preserve existing local data",
                    );

                    await Deno.writeTextFile(
                        `${tempDir}/.obsidian/app.json`,
                        "local-unmatched-update",
                    );
                    await dispatchLocal(excludedSharedPath, false, false);
                    assertEquals(
                        await readWriterText(excludedDocumentPath),
                        "remote-preserved",
                        "An unmatched local write must preserve existing CouchDB data",
                    );
                    assertEquals(
                        await readWriterText(excludedAliasPath),
                        false,
                        "An unmatched local write must not create an ordinary alias",
                    );
                    assertEquals(
                        await peer.get(excludedSharedPath),
                        false,
                        "The bridge should not expose an unmatched hidden file",
                    );

                    await Deno.remove(`${tempDir}/.obsidian/app.json`);
                    await dispatchLocal(excludedSharedPath, true, false);
                    assertEquals(
                        await readWriterText(excludedDocumentPath),
                        "remote-preserved",
                        "An unmatched local deletion must preserve existing CouchDB data",
                    );
                    assertEquals(
                        await readWriterText(excludedAliasPath),
                        false,
                        "An unmatched local deletion must not leave an ordinary alias",
                    );
                    assertEquals(
                        delivered.has(excludedSharedPath),
                        false,
                        "An unmatched hidden file must never be dispatched from CouchDB",
                    );
                } finally {
                    await peer.stop();
                    await Promise.allSettled([writer.close(), peer.man?.close()]);
                    await (await requestDatabase(database, "DELETE")).text();
                    await Deno.remove(tempDir, { recursive: true });
                }
            },
        );
    }
}
