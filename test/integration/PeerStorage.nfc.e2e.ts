import { join } from "@std/path";
import { DirectFileManipulator } from "@vrtmrz/livesync-commonlib";
import {
    MILESTONE_DOCID,
    TweakValuesTemplate,
    VERSIONING_DOCID,
    type FilePathWithPrefix,
} from "@vrtmrz/livesync-commonlib/compat/common/types";
import { getDocData } from "@vrtmrz/livesync-commonlib/compat/common/utils";
import { Hub } from "../../Hub.ts";
import { PeerCouchDB } from "../../PeerCouchDB.ts";
import { validatePeerPathIdentity } from "../../pathIdentity.ts";
import type { FileData, PeerCouchDBConf, PeerStorageConf } from "../../types.ts";
import { watcherTest } from "./watcherTest.ts";

const server = Deno.env.get("COUCHDB_URL") ?? "http://127.0.0.1:5989";
const username = Deno.env.get("COUCHDB_USERNAME") ?? "admin";
const password = Deno.env.get("COUCHDB_PASSWORD") ?? "testpassword";
const authorization = `Basic ${btoa(`${username}:${password}`)}`;
const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}
async function request(database: string, path = "", init: RequestInit = {}): Promise<Response> {
    return await fetch(`${server}/${database}${path}`, {
        ...init,
        headers: { authorization, "content-type": "application/json" },
    });
}
async function waitFor(condition: () => Promise<boolean> | boolean, message: string) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (await condition()) return;
        await sleep(50);
    }
    throw new Error(message);
}
function config(name: string, database: string, encrypted: boolean, caseSensitive = true): PeerCouchDBConf {
    return {
        type: "couchdb",
        name,
        baseDir: "",
        group: "nfc",
        database,
        url: server,
        username,
        password,
        pathNormalizationVersion: 1,
        ...(caseSensitive ? { handleFilenameCaseSensitive: true } : {}),
        passphrase: encrypted ? "nfc-content-passphrase" : "",
        obfuscatePassphrase: encrypted ? "nfc-path-passphrase" : "",
    };
}
async function remoteText(writer: DirectFileManipulator, path: string): Promise<string | false> {
    const entry = await writer.get(path as FilePathWithPrefix);
    return entry === false ? false : getDocData(entry.data);
}
async function fileEquals(path: string, expected: string): Promise<boolean> {
    try {
        return (await Deno.readTextFile(path)) === expected;
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
    }
}
async function writeRemote(writer: DirectFileManipulator, path: string, text: string) {
    const now = Date.now();
    const blob = new Blob([text], { type: "text/plain" });
    assert(
        await writer.put(path as FilePathWithPrefix, blob, { ctime: now, mtime: now, size: blob.size }),
        "The remote update must be saved",
    );
}
async function revision(database: string, id: string): Promise<{ rev: string; parent?: string }> {
    const response = await request(database, `/${encodeURIComponent(id)}?revs=true&conflicts=true`);
    assert(response.ok, `Metadata must remain readable: ${response.status}`);
    const doc = await response.json();
    assert(!doc._conflicts?.length, "Serial round trips must not manufacture another live branch");
    const history = doc._revisions;
    return { rev: doc._rev, parent: history?.ids?.length > 1 ? `${history.start - 1}-${history.ids[1]}` : undefined };
}
async function stopHub(hub: Hub) {
    await Promise.all(hub.peers.map((peer) => peer.stop()));
}

for (const encrypted of [false, true]) {
    for (const useChokidar of [false, true]) {
        for (const caseSensitive of [false, true]) {
            watcherTest("standard", {
                name: `NFC round trip, spelling rename, restart, and deletion with ${useChokidar ? "Chokidar" : "Deno"}, encryption=${encrypted}, caseSensitive=${caseSensitive}`,
                sanitizeOps: false,
                sanitizeResources: false,
                async fn() {
                    const suffix = crypto.randomUUID().replaceAll("-", "");
                    const database = `bridge_nfc_${suffix}`;
                    const root = await Deno.makeTempDir({ prefix: "bridge-nfc-e2e-" });
                    const folder = "Café".normalize("NFD");
                    const leaf = "Résumé.md".normalize("NFD");
                    const native = join(root, folder, leaf);
                    const logical = caseSensitive ? "Café/Résumé.md" : "CAFÉ/RÉSUMÉ.MD";
                    const remote = config(`remote-${suffix}`, database, encrypted, caseSensitive);
                    const storage: PeerStorageConf = {
                        type: "storage",
                        name: `storage-${suffix}`,
                        baseDir: root,
                        group: "nfc",
                        pathNormalizationVersion: 1,
                        ...(caseSensitive ? { handleFilenameCaseSensitive: true } : {}),
                        scanOfflineChanges: true,
                        useChokidar,
                    };
                    let hub = new Hub({ peers: [remote, storage] });
                    let writer: DirectFileManipulator | undefined;
                    let created = false;
                    const notifications: { path: string; data: FileData | false }[] = [];
                    const observe = (current: Hub) => {
                        const dispatch = current.dispatch.bind(current);
                        current.dispatch = async (source, path, data) => {
                            if (source.config.type === "storage") notifications.push({ path, data });
                            await dispatch(source, path, data);
                        };
                    };
                    try {
                        const creation = await request(database, "", { method: "PUT" });
                        assert(creation.ok, `Could not create the isolated test database: ${creation.status}`);
                        await creation.body?.cancel();
                        created = true;
                        const milestone = await request(database, `/${MILESTONE_DOCID}`, {
                            method: "PUT",
                            body: JSON.stringify({
                                _id: MILESTONE_DOCID,
                                created: Date.now(),
                                tweak_values: {
                                    PREFERRED: {
                                        ...TweakValuesTemplate,
                                        pathNormalizationVersion: 1,
                                        handleFilenameCaseSensitive: caseSensitive,
                                        encrypt: encrypted,
                                        usePathObfuscation: encrypted,
                                    },
                                },
                            }),
                        });
                        assert(milestone.ok, "The remote milestone must be created");
                        await milestone.body?.cancel();
                        writer = new DirectFileManipulator(remote, {
                            fetch: (input, init) => globalThis.fetch(input, init),
                        });
                        await writer.ready.promise;
                        const id = await writer.path2id(logical as FilePathWithPrefix);
                        assert(
                            id === (await writer.path2id(`${folder}/${leaf}` as FilePathWithPrefix)),
                            "NFC and NFD must derive the same Metadata ID",
                        );
                        await Deno.mkdir(join(root, folder));
                        await Deno.writeTextFile(native, "local first");
                        observe(hub);
                        hub.start();
                        await waitFor(
                            () => hub.peers.length === 2 && hub.peers.every((peer) => peer.health().ok),
                            "Both peers must start",
                        );
                        await waitFor(
                            async () => (await remoteText(writer!, logical)) === "local first",
                            "The initial NFD file must reach CouchDB",
                        );
                        const initial = await revision(database, id);

                        await writeRemote(writer, logical, "remote second");
                        await waitFor(
                            () => fileEquals(native, "remote second"),
                            "A remote NFC request must update the native NFD file",
                        );
                        const second = await revision(database, id);
                        assert(second.parent === initial.rev, "The remote update must extend the original revision");
                        const names = [];
                        for await (const entry of Deno.readDir(join(root, folder))) names.push(entry.name);
                        assert(
                            names.length === 1 && names[0] === leaf,
                            "Ordinary updates must retain the native leaf spelling",
                        );

                        await Deno.writeTextFile(native, "local third with changed bytes");
                        await waitFor(
                            async () => (await remoteText(writer!, logical)) === "local third with changed bytes",
                            "The native watcher update must return to CouchDB",
                        );
                        const third = await revision(database, id);
                        assert(third.parent === second.rev, "The local update must extend the received revision");
                        const renameStart = notifications.length;
                        const renamedFolder = join(root, "Café");
                        await Deno.rename(join(root, folder), renamedFolder);
                        const renamed = join(renamedFolder, leaf);
                        await Deno.writeTextFile(renamed, "bytes after spelling rename");
                        await waitFor(
                            async () => (await remoteText(writer!, logical)) === "bytes after spelling rename",
                            "A spelling rename must retain the current content",
                        );
                        await sleep(750);
                        assert(
                            notifications.slice(renameStart).every((entry) => entry.data !== false),
                            "A live NFC-equivalent path must not become a logical deletion",
                        );
                        const renamedRevision = await revision(database, id);
                        assert(
                            renamedRevision.parent === third.rev,
                            "A spelling rename and edit must retain revision ancestry",
                        );
                        const oldRemote = hub.peers.find((peer): peer is PeerCouchDB => peer instanceof PeerCouchDB)!;
                        await waitFor(
                            () => !!oldRemote.getSetting("since"),
                            "The delivered feed position must be persisted",
                        );

                        await stopHub(hub);
                        hub = new Hub({ peers: [remote, storage] });
                        observe(hub);
                        hub.start();
                        await waitFor(
                            () => hub.peers.length === 2 && hub.peers.every((peer) => peer.health().ok),
                            "Both peers must restart",
                        );
                        await writeRemote(writer, logical, "remote bytes after restart");
                        await waitFor(
                            () => fileEquals(renamed, "remote bytes after restart"),
                            "A restarted peer must receive the next update",
                        );
                        const restarted = await revision(database, id);
                        assert(
                            restarted.parent === renamedRevision.rev,
                            "Restart must not introduce a duplicate content revision",
                        );

                        await Deno.remove(renamedFolder, { recursive: true });
                        await waitFor(
                            async () => (await remoteText(writer!, logical)) === false,
                            "The actual parent deletion must reach CouchDB",
                        );
                        assert(
                            notifications.some((entry) => entry.data === false),
                            "The real deletion must be delivered",
                        );
                    } finally {
                        await stopHub(hub);
                        await writer?.close();
                        await sleep(350);
                        if (created) {
                            const deletion = await request(database, "", { method: "DELETE" });
                            await deletion.body?.cancel();
                        }
                        await Deno.remove(root, { recursive: true });
                    }
                },
            });
        }
    }
}

watcherTest("standard", {
    name: "NFC direct access rejects populated Legacy identity without changing its declaration or content",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
        const suffix = crypto.randomUUID().replaceAll("-", "");
        const database = `bridge_nfc_admission_${suffix}`;
        let legacy: DirectFileManipulator | undefined;
        let nfc: DirectFileManipulator | undefined;
        let created = false;
        try {
            const creation = await request(database, "", { method: "PUT" });
            assert(creation.ok, "The isolated database must be created");
            await creation.body?.cancel();
            created = true;
            const legacyConfig = {
                ...config(`legacy-${suffix}`, database, false),
                pathNormalizationVersion: 0 as const,
            };
            legacy = new DirectFileManipulator(legacyConfig, { fetch: (input, init) => globalThis.fetch(input, init) });
            await legacy.ready.promise;
            const path = "Résumé.md".normalize("NFD");
            await writeRemote(legacy, path, "retained legacy bytes");
            const infoBeforeResponse = await request(database);
            const before = await infoBeforeResponse.json();
            nfc = new DirectFileManipulator(config(`nfc-${suffix}`, database, false), {
                fetch: (input, init) => globalThis.fetch(input, init),
            });
            let rejected = false;
            try {
                await nfc.ready.promise;
            } catch {
                rejected = true;
            }
            assert(rejected, "An NFC client must reject populated Legacy Metadata");
            const infoAfterResponse = await request(database);
            const after = await infoAfterResponse.json();
            assert(before.update_seq === after.update_seq, "Rejected admission must not mutate the database");
            assert(
                (await remoteText(legacy, path)) === "retained legacy bytes",
                "The existing Legacy content must remain readable",
            );
            const featureResponse = await request(database, `/${VERSIONING_DOCID}`);
            const features = await featureResponse.json();
            assert(
                !features.used_features?.includes("nfc-path-identity-v1"),
                "Rejected admission must not declare NFC over Legacy data",
            );
        } finally {
            await nfc?.close();
            await legacy?.close();
            if (created) {
                const deletion = await request(database, "", { method: "DELETE" });
                await deletion.body?.cancel();
            }
        }
    },
});

watcherTest("standard", {
    name: "Filename case mismatches reject before watching and the explicit override permits migration round trips",
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
        const suffix = crypto.randomUUID().replaceAll("-", "");
        const database = `bridge_case_${suffix}`;
        const root = await Deno.makeTempDir({ prefix: "bridge-case-e2e-" });
        const path = "Résumé.md";
        const remote = config(`remote-${suffix}`, database, false);
        const storage: PeerStorageConf = {
            type: "storage",
            name: `storage-${suffix}`,
            baseDir: root,
            group: "nfc",
            pathNormalizationVersion: 1,
            scanOfflineChanges: true,
        };
        let writer: DirectFileManipulator | undefined;
        let hub: Hub | undefined;
        let created = false;
        try {
            const creation = await request(database, "", { method: "PUT" });
            assert(creation.ok, "The isolated database must be created");
            await creation.body?.cancel();
            created = true;
            const milestone = await request(database, `/${MILESTONE_DOCID}`, {
                method: "PUT",
                body: JSON.stringify({
                    _id: MILESTONE_DOCID,
                    created: Date.now(),
                    tweak_values: {
                        PREFERRED: {
                            ...TweakValuesTemplate,
                            pathNormalizationVersion: 1,
                            handleFilenameCaseSensitive: true,
                        },
                    },
                }),
            });
            assert(milestone.ok, "The remote preferred settings must be created");
            await milestone.body?.cancel();
            writer = new DirectFileManipulator(remote, { fetch: (input, init) => globalThis.fetch(input, init) });
            await writer.ready.promise;
            await writeRemote(writer, path, "retained remote bytes");
            const id = await writer.path2id(path as FilePathWithPrefix);
            const initial = await revision(database, id);

            for (const adopt of [false, true]) {
                const probeConfig = {
                    ...remote,
                    name: `probe-${adopt}-${suffix}`,
                    handleFilenameCaseSensitive: false,
                    ...(adopt ? { useRemoteTweaks: true as const } : {}),
                };
                const probe = new PeerCouchDB(probeConfig, async () => {}, {
                    validateConfiguration: () => validatePeerPathIdentity({ peers: [probeConfig, storage] }),
                });
                probe.man = new DirectFileManipulator(probeConfig, {
                    fetch: (input, init) => globalThis.fetch(input, init),
                });
                try {
                    await probe.man.ready.promise;
                    const before = await (await request(database)).json();
                    let rejection = "";
                    try {
                        await (probe as unknown as { _connectAndWatch(): Promise<void> })._connectAndWatch();
                    } catch (error) {
                        rejection = String(error);
                    }
                    assert(
                        rejection.includes("handleFilenameCaseSensitive"),
                        "A remote or adopted group mismatch must reject for the case rule",
                    );
                    assert(!probe.man.watching, "Mismatch rejection must precede the changes feed");
                    const after = await (await request(database)).json();
                    assert(before.update_seq === after.update_seq, "Rejected mismatch must not mutate the remote");
                    assert(
                        (await remoteText(writer, path)) === "retained remote bytes",
                        "Rejected mismatch must retain the original content",
                    );
                } finally {
                    await probe.man.close();
                }
            }

            const adoptedRemote: PeerCouchDBConf = {
                ...remote,
                handleFilenameCaseSensitive: false,
                useRemoteTweaks: true,
            };
            hub = new Hub({ peers: [adoptedRemote, storage], disableCheckingConfigMismatch: true });
            hub.start();
            await waitFor(
                () => hub!.peers.length === 2 && hub!.peers.every((peer) => peer.health().ok),
                "The explicit override must allow the group to start",
            );
            await waitFor(
                () => fileEquals(join(root, path), "retained remote bytes"),
                "The remote content must reach storage with the override",
            );
            assert(
                adoptedRemote.handleFilenameCaseSensitive === true,
                "Explicit remote adoption must apply the preferred value",
            );
            assert(
                storage.handleFilenameCaseSensitive === undefined,
                "The override must not rewrite another peer's setting",
            );
            const effectiveRemote = hub.peers.find((peer) => peer instanceof PeerCouchDB) as PeerCouchDB;
            assert(
                (await effectiveRemote.man.path2id(path as FilePathWithPrefix)) === id,
                "Adopted settings must derive the original remote Metadata ID before the next write",
            );
            await Deno.writeTextFile(join(root, path), "local migration edit");
            await waitFor(
                async () => (await remoteText(writer!, path)) === "local migration edit",
                "A local update must reach the same remote file with the override",
            );
            const updated = await revision(database, id);
            assert(updated.parent === initial.rev, "The local update must preserve the original revision ancestry");
        } finally {
            if (hub) {
                await stopHub(hub);
                for (const peer of hub.peers) if (peer instanceof PeerCouchDB) await peer.man.close();
            }
            await writer?.close();
            await sleep(350);
            if (created) {
                const deletion = await request(database, "", { method: "DELETE" });
                await deletion.body?.cancel();
            }
            await Deno.remove(root, { recursive: true });
        }
    },
});
