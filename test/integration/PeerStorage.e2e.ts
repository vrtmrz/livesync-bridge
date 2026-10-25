import { join, relative, resolve, SEPARATOR } from "@std/path";
import chokidar from "chokidar";
import {
    MILESTONE_DOCID,
    TweakValuesTemplate,
    type FilePathWithPrefix,
} from "@vrtmrz/livesync-commonlib/compat/common/types";
import { Hub } from "../../Hub.ts";
import { PeerCouchDB } from "../../PeerCouchDB.ts";
import { PeerStorage } from "../../PeerStorage.ts";
import type { FileData, PeerCouchDBConf, PeerStorageConf } from "../../types.ts";
import { DirectFileManipulator } from "@vrtmrz/livesync-commonlib";
import { getDocData } from "@vrtmrz/livesync-commonlib/compat/common/utils";
import { decodeBinary } from "@vrtmrz/livesync-commonlib/compat/string_and_binary/convert";
import { isLockAcquired } from "octagonal-wheels/concurrency/lock";

const couchDbUrl = Deno.env.get("COUCHDB_URL") ?? "http://127.0.0.1:5989";
const authorization = `Basic ${btoa(`${Deno.env.get("COUCHDB_USERNAME") ?? "admin"}:${Deno.env.get("COUCHDB_PASSWORD") ?? "testpassword"}`)}`;

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

async function waitFor(condition: () => boolean | Promise<boolean>, message: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        if (await condition()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(message);
}

async function request(database: string, path: string, init: RequestInit = {}): Promise<Response> {
    return await fetch(`${couchDbUrl}/${database}${path}`, {
        ...init,
        headers: { authorization, "content-type": "application/json" },
    });
}

type DocumentRow = {
    id?: string;
    error?: string;
    value?: { rev: string; deleted?: boolean };
    doc?: { deleted?: boolean; _deleted?: boolean };
};

async function readDocuments(database: string, ids: string[]): Promise<DocumentRow[]> {
    const response = await request(database, "/_all_docs?include_docs=true", {
        method: "POST",
        body: JSON.stringify({ keys: ids }),
    });
    assert(response.ok, `Could not read test documents: HTTP ${response.status} ${await response.clone().text()}`);
    return (await response.json()).rows as DocumentRow[];
}

function isDeleted(row: DocumentRow): boolean {
    return !!(row.value?.deleted || row.doc?.deleted || row.doc?._deleted);
}

function couchConfig(name: string, database: string): PeerCouchDBConf {
    return {
        type: "couchdb", name, database, url: couchDbUrl, baseDir: "",
        username: Deno.env.get("COUCHDB_USERNAME") ?? "admin",
        password: Deno.env.get("COUCHDB_PASSWORD") ?? "testpassword",
        passphrase: "content-encryption-passphrase",
        obfuscatePassphrase: "path-obfuscation-passphrase",
    };
}

for (const parentOnly of [false, true]) {
    Deno.test(`Storage deletion reaches CouchDB with ${parentOnly ? "parent-only" : "native"} watcher events`, async () => {
        const suffix = crypto.randomUUID().replaceAll("-", "");
        const database = `livesync_bridge_storage_${suffix}`;
        const baseDir = await Deno.makeTempDir({ prefix: "bridge-storage-e2e-" });
        const directory = join(baseDir, "removed");
        const children = ["removed/note.md", "removed/deep/other.md"];
        const ignoredChildren = ["removed/private/local.md"];
        const survivors = ["removed-other/stay.md", "root-control.md"];
        const files = [...children, ...survivors];
        const storageConfig: PeerStorageConf = {
            type: "storage", name: `e2e-storage-${suffix}`, baseDir: `${baseDir}/`,
            scanOfflineChanges: true, useChokidar: false,
            ignore: ["**/private"],
        };
        const remoteConfig = couchConfig(`e2e-remote-${suffix}`, database);
        const readerConfig = couchConfig(`e2e-reader-${suffix}`, database);
        const hub = new Hub({ peers: [remoteConfig, storageConfig] });
        const reader = new PeerCouchDB(readerConfig, () => Promise.resolve());
        const originalWatchFs = Deno.watchFs;
        const deliveredPaths: string[] = [];
        let removing = false;
        let databaseCreated = false;
        let readerStarted = false;

        // Fault injection is confined to the real watcher's output. Drop child paths
        // after removal starts, as in issue 82; retain the native parent event.
        // PeerStorage.processFile, Hub.dispatch, and CouchDB writes remain unchanged.
        Deno.watchFs = ((...args: Parameters<typeof Deno.watchFs>) => {
            const watcher = originalWatchFs(...args);
            const events = (async function* () {
                for await (const event of watcher) {
                    const paths = event.paths.filter((path) => !removing || !parentOnly ||
                        !resolve(path).startsWith(`${directory}${SEPARATOR}`));
                    if (removing) deliveredPaths.push(...paths.map((path) => resolve(path)));
                    if (paths.length > 0) yield { ...event, paths };
                }
            })();
            return {
                next: () => events.next(),
                [Symbol.asyncIterator]() { return this; },
                close: () => watcher.close(),
                [Symbol.dispose]: () => watcher.close(),
            } as unknown as Deno.FsWatcher;
        }) as typeof Deno.watchFs;

        try {
            const created = await request(database, "", { method: "PUT" });
            const creationBody = await created.text();
            assert(created.ok, `Could not create e2e database: HTTP ${created.status} ${creationBody}`);
            databaseCreated = true;
            // Pre-existing files are synced by the real offline scan, avoiding pending
            // creation events when child deletion notifications are deliberately dropped.
            await Deno.mkdir(join(directory, "deep"), { recursive: true });
            await Deno.mkdir(join(directory, "private"));
            await Deno.mkdir(join(baseDir, "removed-other"));
            for (const path of [...files, ...ignoredChildren]) await Deno.writeTextFile(join(baseDir, path), `Content of ${path}`);
            hub.start();
            await waitFor(() => hub.peers.length === 2 && hub.peers.every((peer) => peer.health().ok),
                "The storage watcher and CouchDB peer did not become ready");
            assert(hub.peers.some((peer) => peer instanceof PeerStorage), "The hub should run a real storage peer");
            const remote = hub.peers.find((peer): peer is PeerCouchDB => peer instanceof PeerCouchDB);
            assert(remote, "The hub should run a real CouchDB peer");

            const ids = await Promise.all(files.map((path) => remote.man.path2id(path as FilePathWithPrefix)));
            await waitFor(async () => (await readDocuments(database, ids)).every((row) => row.doc && !isDeleted(row)),
                "The storage peer did not upload all source files through the hub");
            const before = await readDocuments(database, ids);
            const ignoredIds = await Promise.all(ignoredChildren.map((path) => remote.man.path2id(path as FilePathWithPrefix)));
            assert((await readDocuments(database, ignoredIds)).every((row) => row.error === "not_found"),
                "Ignored children should not be uploaded during the startup inventory");
            for (const path of files) {
                const data = await remote.get(path as FilePathWithPrefix);
                assert(data !== false && Array.isArray(data.data) && data.data.join("") === `Content of ${path}`,
                    `The uploaded contents should match the source: ${path}`);
            }

            removing = true;
            await Deno.remove(directory, { recursive: true });
            await waitFor(async () => (await readDocuments(database, ids.slice(0, children.length))).every(isDeleted),
                "Missing child tombstones after recursive directory removal");
            assert((await readDocuments(database, ignoredIds)).every((row) => row.error === "not_found"),
                "Parent removal should not create deletion records for ignored children");
            assert(deliveredPaths.includes(directory), "The real watcher should deliver the removed parent path");
            if (parentOnly) {
                assert(!deliveredPaths.some((path) => path.startsWith(`${directory}${SEPARATOR}`)),
                    "The regression must succeed without receiving any child paths");
            }

            await reader.start();
            readerStarted = true;
            for (const path of children) {
                assert(await reader.get(path as FilePathWithPrefix) === false,
                    `An independent peer should observe the deleted child: ${path}`);
            }
            for (const path of survivors) {
                const data = await reader.get(path as FilePathWithPrefix);
                assert(data !== false && Array.isArray(data.data) && data.data.join("") === `Content of ${path}`,
                    `An unrelated file should remain readable: ${path}`);
                assert(await Deno.readTextFile(join(baseDir, path)) === `Content of ${path}`,
                    `An unrelated source file should remain intact: ${path}`);
            }
            const after = await readDocuments(database, ids);
            for (let index = 0; index < files.length; index++) {
                const oldRev = before[index].value?.rev;
                const newRev = after[index].value?.rev;
                assert(oldRev && newRev, `The document revision should remain available: ${files[index]}`);
                if (index < children.length) {
                    assert(isDeleted(after[index]) && parseInt(newRev) === parseInt(oldRev) + 1,
                        `The child should have one deletion revision: ${files[index]}`);
                } else {
                    assert(!isDeleted(after[index]) && newRev === oldRev,
                        `An unrelated document should retain its revision: ${files[index]}`);
                }
            }
        } finally {
            Deno.watchFs = originalWatchFs;
            await Promise.allSettled(hub.peers.map((peer) => peer.stop()));
            if (readerStarted) await reader.stop();
            await Promise.allSettled([
                ...hub.peers.filter((peer): peer is PeerCouchDB => peer instanceof PeerCouchDB).map((peer) => peer.man?.close()),
                reader.man?.close(),
            ]);
            const names = [storageConfig.name, remoteConfig.name, readerConfig.name];
            for (let index = localStorage.length - 1; index >= 0; index--) {
                const key = localStorage.key(index);
                if (key && names.some((name) => key.startsWith(`${name}-`))) localStorage.removeItem(key);
            }
            if (databaseCreated) {
                const deleted = await request(database, "", { method: "DELETE" });
                await deleted.body?.cancel();
            }
            await Deno.remove(baseDir, { recursive: true });
        }
    });
}
const watcherScenarios = [
    { encryptInternalMetadata: false, directoryExistsBeforeWatch: false },
    { encryptInternalMetadata: true, directoryExistsBeforeWatch: false },
    { encryptInternalMetadata: false, directoryExistsBeforeWatch: true },
    { encryptInternalMetadata: true, directoryExistsBeforeWatch: true },
].flatMap((scenario) => [false, true].map((useChokidar) => ({ ...scenario, useChokidar })));

for (const baseDir of ["", "blog/"]) {
    for (const { encryptInternalMetadata, directoryExistsBeforeWatch, useChokidar } of watcherScenarios) {
        const backend = useChokidar ? "Chokidar" : "Native";
        Deno.test(
            backend + " watcher synchronises selected hidden files | baseDir: " +
                (baseDir || "empty") + " | encrypted metadata: " + encryptInternalMetadata +
                " | directory: " + (directoryExistsBeforeWatch ? "pre-existing" : "newly created"),
            async () => {
                const suffix = crypto.randomUUID().replaceAll("-", "");
                const database = "livesync_bridge_watcher_" + suffix;
                const basePath = await Deno.makeTempDir({ prefix: "bridge-watcher-e2e-" });
                const remoteConfig: PeerCouchDBConf = {
                    ...couchConfig("watcher-remote-" + suffix, database),
                    baseDir,
                    includeInternal: [".claude/**"],
                    useRemoteTweaks: true,
                    encryptInternalMetadata,
                };
                const storageConfig: PeerStorageConf = {
                    type: "storage",
                    name: "watcher-storage-" + suffix,
                    baseDir: basePath + "/",
                    scanOfflineChanges: false,
                    useChokidar,
                };
                const hub = new Hub({ peers: [remoteConfig, storageConfig] });
                let writer: DirectFileManipulator | undefined;
                let databaseCreated = false;
                let changeFeed: {
                    on: (event: string, listener: (change: RemoteChange) => void) => unknown;
                    off?: (event: string, listener: (change: RemoteChange) => void) => unknown;
                    removeListener?: (event: string, listener: (change: RemoteChange) => void) => unknown;
                } | undefined;
                let remoteChangeListener: ((change: RemoteChange) => void) | undefined;
                const remoteChanges: RemoteChange[] = [];
                const hubDispatches: Array<{
                    sourceType: string;
                    path: string;
                    data: FileData | false;
                }> = [];
                const startedAt = Date.now();
                let stage = "setup";
                let pendingHubDispatches = 0;
                let lastWatcherEventAt = startedAt;
                const nativeEvents: Array<{ elapsedMs: number; kind: string; paths: string[] }> = [];
                const hubRoutes: Array<{
                    elapsedMs: number;
                    phase: string;
                    sourceType: string;
                    path: string;
                    content: string | false;
                }> = [];
                const originalChokidarWatch = chokidar.watch;
                let chokidarReady = false;
                const chokidarEvents: Array<{ elapsedMs: number; kind: string; path: string }> = [];
                if (useChokidar) {
                    // Observe the real backend without changing its event stream or options.
                    chokidar.watch = ((...args: Parameters<typeof chokidar.watch>) => {
                        const watcher = originalChokidarWatch(...args);
                        watcher.once("ready", () => { chokidarReady = true; });
                        watcher.on("all", (kind, path) => {
                            lastWatcherEventAt = Date.now();
                            chokidarEvents.push({
                                elapsedMs: lastWatcherEventAt - startedAt,
                                kind,
                                path: relative(basePath, path),
                            });
                        });
                        return watcher;
                    }) as typeof chokidar.watch;
                }
                const originalWatchFs = Deno.watchFs;
                if (!useChokidar) {
                    Deno.watchFs = ((...args: Parameters<typeof Deno.watchFs>) => {
                        const watcher = originalWatchFs(...args);
                        const iterator = watcher[Symbol.asyncIterator]();
                        return {
                            async next() {
                                const result = await iterator.next();
                                if (!result.done) {
                                    lastWatcherEventAt = Date.now();
                                    nativeEvents.push({
                                        elapsedMs: lastWatcherEventAt - startedAt,
                                        kind: result.value.kind,
                                        paths: result.value.paths.map((path) => relative(basePath, path)),
                                    });
                                }
                                return result;
                            },
                            [Symbol.asyncIterator]() { return this; },
                            close: () => watcher.close(),
                            [Symbol.dispose]: () => watcher.close(),
                        } as unknown as Deno.FsWatcher;
                    }) as typeof Deno.watchFs;
                }
                const originalDispatch = hub.dispatch.bind(hub);
                hub.dispatch = async (source, path, data) => {
                    const route = {
                        sourceType: source.config.type,
                        path,
                        content: data === false ? false as const : (data.data instanceof Uint8Array
                            ? new TextDecoder().decode(data.data) : data.data.join("")).slice(0, 240),
                    };
                    pendingHubDispatches++;
                    hubRoutes.push({ ...route, phase: "started", elapsedMs: Date.now() - startedAt });
                    try {
                        await originalDispatch(source, path, data);
                        hubDispatches.push({ sourceType: source.config.type, path, data });
                        hubRoutes.push({ ...route, phase: "completed", elapsedMs: Date.now() - startedAt });
                    } catch (error) {
                        hubRoutes.push({ ...route, phase: "failed", elapsedMs: Date.now() - startedAt });
                        throw error;
                    } finally {
                        pendingHubDispatches--;
                    }
                };
                const waitForWatcherWork = async () => {
                    await waitFor(
                        () => Date.now() - lastWatcherEventAt >= 500 && pendingHubDispatches === 0 &&
                            [".claude/settings.json", ".claude/remote.json", "note.md"].every((path) =>
                                !isLockAcquired(join(basePath, path))
                            ),
                        "Filesystem events, queued selected writes, and Hub dispatches should settle",
                    );
                };

                const localHiddenPath = join(basePath, ".claude", "settings.json");
                const excludedLocalPath = join(basePath, ".obsidian", "app.json");
                const localNotePath = join(basePath, "note.md");
                const readStorageFile = async (path: string): Promise<string | false> => {
                    try {
                        return await Deno.readTextFile(join(basePath, path));
                    } catch (error) {
                        if (error instanceof Deno.errors.NotFound) return false;
                        throw error;
                    }
                };
                const internalPath = "i:.claude/settings.json" as FilePathWithPrefix;
                const internalAlias = (baseDir + ".claude/settings.json") as FilePathWithPrefix;
                const remoteHiddenPath = "i:.claude/remote.json" as FilePathWithPrefix;
                const remoteHiddenAlias = (baseDir + ".claude/remote.json") as FilePathWithPrefix;
                const excludedPath = "i:.obsidian/app.json" as FilePathWithPrefix;
                const excludedAlias = (baseDir + ".obsidian/app.json") as FilePathWithPrefix;
                const ordinaryPath = (baseDir + "note.md") as FilePathWithPrefix;

                const writeRemote = async (
                    path: FilePathWithPrefix,
                    content: string,
                    type: "plain" | "newnote",
                ) => {
                    assert(writer, "The independent CouchDB writer should be ready");
                    const bytes = new TextEncoder().encode(content);
                    assert(await writer.put(path, new Blob([bytes]), {
                        ctime: 1_700_000_000_000,
                        mtime: Date.now(),
                        size: bytes.byteLength,
                    }, type), "The independent writer should write " + path);
                };
                const waitForRemoteChange = async (
                    after: number,
                    path: FilePathWithPrefix,
                    id: string,
                ) => {
                    await waitFor(
                        () => remoteChanges.slice(after).some((change) =>
                            change.id === id || change._id === id ||
                            change.doc?._id === id || change.path === path ||
                            change.doc?.path === path
                        ),
                        "CouchDB should emit the excluded change for " + path,
                    );
                };
                const waitForStorageText = async (path: string, expected: string | false) => {
                    await waitFor(
                        async () => await readStorageFile(path) === expected &&
                            hubDispatches.some((event) => event.sourceType === "couchdb" && event.path === path &&
                                (expected === false ? event.data === false : event.data !== false &&
                                    (event.data.data instanceof Uint8Array
                                        ? new TextDecoder().decode(event.data.data)
                                        : event.data.data.join("")) === expected)),
                        "The real watcher pipeline should finish putting " + path + " on disk as " + expected,
                    );
                };
                const waitForWriterText = async (
                    path: FilePathWithPrefix,
                    expected: string | false,
                ) => {
                    await waitFor(
                        async () => await readWriterText(writer!, path) === expected,
                        "The real storage watcher should write " + path + " to CouchDB as " + expected,
                    );
                };
                const writeRemoteControl = async (content: string) => {
                    await writeRemote(ordinaryPath, content, "plain");
                    await waitForStorageText("note.md", content);
                };
                const writeLocalControl = async (content: string) => {
                    await Deno.writeTextFile(localNotePath, content);
                    await waitForWriterText(ordinaryPath, content);
                };
                const assertNoAlias = async (path: FilePathWithPrefix, message: string) => {
                    const id = await writer!.path2id(path);
                    const [row] = await readDocuments(database, [id]);
                    assert(row.error === "not_found", message);
                };
                const assertRawMetadataMode = async (id: string) => {
                    const response = await request(database, "/" + encodeURIComponent(id));
                    assert(response.ok, "The selected internal Metadata should exist in CouchDB");
                    const raw = await response.json() as { path?: unknown; children?: unknown };
                    const encryptedPath = typeof raw.path === "string" && raw.path.startsWith("/\\:");
                    assert(
                        encryptedPath === encryptInternalMetadata,
                        "The raw internal Metadata should use the selected encryption mode",
                    );
                    assert(
                        Array.isArray(raw.children) && (raw.children.length === 0) === encryptInternalMetadata,
                        "The raw chunk references should match the selected Metadata encryption mode",
                    );
                };
                const assertSelectedState = async (
                    path: FilePathWithPrefix,
                    alias: FilePathWithPrefix,
                    expected: string | false,
                    deleted = false,
                ): Promise<string> => {
                    const id = await writer!.path2id(path);
                    const aliasId = await writer!.path2id(alias);
                    assert(id !== aliasId, "Internal and ordinary alias paths should have distinct IDs");
                    const rows = await readDocuments(database, [id, aliasId]);
                    assert(
                        await readWriterText(writer!, path) === expected,
                        "The selected internal document should contain the expected content: " + path,
                    );
                    assert(
                        rows[1].error === "not_found",
                        "No ordinary alias document should exist for " + alias,
                    );
                    if (expected === false) {
                        if (deleted) {
                            assert(isDeleted(rows[0]), "The selected internal document should have a tombstone: " + path);
                        } else {
                            assert(rows[0].error === "not_found", "The selected internal identity should be absent: " + path);
                        }
                    } else {
                        assert(rows[0].doc && !isDeleted(rows[0]), "The selected internal document should be live: " + path);
                    }
                    return id;
                };
                const assertExcludedState = async (expected: string | false, message: string) => {
                    assert(await readWriterText(writer!, excludedPath) === expected, message);
                    await assertNoAlias(excludedAlias, "An excluded file must not create an ordinary alias");
                };
                const writeLocalExcludedAndWait = async (content: string, after: number) => {
                    await Deno.writeTextFile(excludedLocalPath, content);
                    await waitFor(
                        () => hubDispatches.slice(after).some((event) =>
                            event.sourceType === "storage" &&
                            event.path === ".obsidian/app.json" &&
                            event.data !== false &&
                            (event.data.data instanceof Uint8Array
                                ? new TextDecoder().decode(event.data.data)
                                : event.data.data.join("")) === content
                        ),
                        "The filesystem watcher should finish routing the local excluded write",
                    );
                };
                const removeLocalExcludedAndWait = async (after: number) => {
                    await Deno.remove(excludedLocalPath);
                    await waitFor(
                        () => hubDispatches.slice(after).some((event) =>
                            event.sourceType === "storage" &&
                            event.path === ".obsidian/app.json" &&
                            event.data === false
                        ),
                        "The filesystem watcher should finish routing the local excluded deletion",
                    );
                };

                try {
                    const created = await request(database, "", { method: "PUT" });
                    const creationBody = await created.text();
                    assert(created.ok, "Could not create watcher E2E database: HTTP " + created.status + " " + creationBody);
                    databaseCreated = true;

                    await Deno.mkdir(join(basePath, ".obsidian"), { recursive: true });
                    await Deno.writeTextFile(excludedLocalPath, "local-existing");
                    if (directoryExistsBeforeWatch) {
                        await Deno.mkdir(join(basePath, ".claude"), { recursive: true });
                    }

                    writer = new DirectFileManipulator({
                        ...remoteConfig,
                        syncInternalFiles: true,
                    }, { fetch: globalThis.fetch });
                    await writer.ready.promise;
                    await writeRemote(ordinaryPath, "remote-note", "plain");
                    await writeRemote(excludedPath, "remote-existing", "newnote");
                    const excludedId = await writer.path2id(excludedPath);
                    const excludedAliasId = await writer.path2id(excludedAlias);
                    assert(excludedId !== excludedAliasId, "The excluded internal file should have a distinct ordinary alias ID");

                    const milestone = await request(database, "/" + MILESTONE_DOCID, {
                        method: "PUT",
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
                    });
                    const milestoneBody = await milestone.text();
                    assert(milestone.ok, "Could not create remote tweaks: HTTP " + milestone.status + " " + milestoneBody);

                    assert(await readWriterText(writer!, internalPath) === false, "The local selected path should have no remote identity yet");
                    const localInternalId = await writer.path2id(internalPath);
                    const localAliasId = await writer.path2id(internalAlias);
                    assert(localInternalId !== localAliasId, "The selected local path should have a separate ordinary alias ID");
                    const initiallyMissing = await readDocuments(database, [localInternalId, localAliasId]);
                    assert(
                        initiallyMissing[0].error === "not_found" && initiallyMissing[1].error === "not_found",
                        "Both selected identity and ordinary alias should be absent before local creation",
                    );

                    stage = "watcher startup";
                    hub.start();
                    const remote = hub.peers.find((peer): peer is PeerCouchDB => peer instanceof PeerCouchDB);
                    const storage = hub.peers.find((peer): peer is PeerStorage => peer instanceof PeerStorage);
                    assert(remote && storage, "The Hub should construct real CouchDB and storage peers");
                    for (const peer of hub.peers) {
                        const settings = new Map<string, string>();
                        peer.getSetting = (key) => settings.get(key) ?? null;
                        peer.setSetting = (key, value) => {
                            settings.set(key, value);
                        };
                    }

                    await waitFor(
                        () => hub.peers.length === 2 && hub.peers.every((peer) => peer.health().ok) &&
                            (!useChokidar || chokidarReady),
                        "The real CouchDB and filesystem watcher peers should become ready",
                    );
                    assert(
                        remote.config.encryptInternalMetadata === encryptInternalMetadata,
                        "The remote tweaks should select the expected internal Metadata encryption mode",
                    );
                    assert(remote.man, "The real CouchDB peer should own its direct manipulator");
                    const feed = (remote.man as unknown as {
                        changes?: {
                            on: (event: string, listener: (change: RemoteChange) => void) => unknown;
                            off?: (event: string, listener: (change: RemoteChange) => void) => unknown;
                            removeListener?: (event: string, listener: (change: RemoteChange) => void) => unknown;
                        };
                    }).changes;
                    assert(feed && typeof feed.on === "function", "The remote changes feed should expose its live events");
                    changeFeed = feed;
                    remoteChangeListener = (change) => {
                        remoteChanges.push(change);
                    };
                    feed.on("change", remoteChangeListener);

                    await waitForStorageText("note.md", "remote-note");
                    await writeRemoteControl("remote-startup-barrier");
                    assert(
                        await readStorageFile(".obsidian/app.json") === "local-existing",
                        "The initial excluded remote file should preserve the local counterpart",
                    );
                    await assertExcludedState("remote-existing", "The independent writer should retain the excluded remote file");

                    stage = "first local selected creation";
                    await Deno.mkdir(join(basePath, ".claude"), { recursive: true });
                    await Deno.writeTextFile(localHiddenPath, "local-created");
                    await waitForWriterText(internalPath, "local-created");
                    assert(
                        await assertSelectedState(internalPath, internalAlias, "local-created") === localInternalId,
                        "A new local hidden file should create the canonical i: document from a missing identity",
                    );
                    await assertRawMetadataMode(localInternalId);

                    stage = "selected round trip and local deletion";
                    await writeRemote(internalPath, "remote-round-trip-update", "newnote");
                    await waitForStorageText(".claude/settings.json", "remote-round-trip-update");
                    assert(
                        await assertSelectedState(internalPath, internalAlias, "remote-round-trip-update") === localInternalId,
                        "A remote edit of the locally-created file should return through the same internal identity",
                    );

                    await Deno.writeTextFile(localHiddenPath, "local-updated-with-more-content");
                    await waitForWriterText(internalPath, "local-updated-with-more-content");
                    assert(
                        await assertSelectedState(internalPath, internalAlias, "local-updated-with-more-content") === localInternalId,
                        "A local update should retain the selected internal document ID",
                    );

                    await Deno.remove(localHiddenPath);
                    await waitForWriterText(internalPath, false);
                    assert(
                        await assertSelectedState(internalPath, internalAlias, false, true) === localInternalId,
                        "A local deletion should tombstone the same selected internal document",
                    );

                    stage = "independent remote selected creation and update";
                    const remoteIdBeforeCreate = await writer.path2id(remoteHiddenPath);
                    assert(
                        await readWriterText(writer!, remoteHiddenPath) === false,
                        "The independent remote selected path should start absent",
                    );
                    await writeRemote(remoteHiddenPath, "remote-created", "newnote");
                    await waitForStorageText(".claude/remote.json", "remote-created");
                    assert(
                        await assertSelectedState(remoteHiddenPath, remoteHiddenAlias, "remote-created") === remoteIdBeforeCreate,
                        "A remote selected creation should use its canonical i: identity",
                    );
                    await assertRawMetadataMode(remoteIdBeforeCreate);

                    await writeRemote(remoteHiddenPath, "remote-updated-with-more-content", "newnote");
                    await waitForStorageText(".claude/remote.json", "remote-updated-with-more-content");
                    assert(
                        await assertSelectedState(remoteHiddenPath, remoteHiddenAlias, "remote-updated-with-more-content") === remoteIdBeforeCreate,
                        "A remote selected update should retain the same internal identity",
                    );
                    assert(
                        await readWriterText(writer!, ordinaryPath) === "remote-startup-barrier",
                        "The ordinary note control should remain mapped through baseDir",
                    );

                    stage = "independent remote selected deletion";
                    assert(await writer.delete(remoteHiddenPath), "The independent writer should delete its selected internal document");
                    await waitForStorageText(".claude/remote.json", false);
                    assert(
                        await assertSelectedState(remoteHiddenPath, remoteHiddenAlias, false, true) === remoteIdBeforeCreate,
                        "A remote selected deletion should tombstone the same internal document",
                    );

                    await waitForWatcherWork();
                    assert(await readStorageFile(".claude/remote.json") === false,
                        "The selected remote deletion should remain absent after queued watcher work");
                    await assertSelectedState(remoteHiddenPath, remoteHiddenAlias, false, true);

                    stage = "excluded files and ordinary controls";
                    const excludedChangeId = await writer.path2id(excludedPath);
                    let nextRemoteChange = remoteChanges.length;
                    await writeRemote(excludedPath, "remote-updated", "newnote");
                    await waitForRemoteChange(nextRemoteChange, excludedPath, excludedChangeId);
                    await writeRemoteControl("remote-barrier-after-excluded-update");
                    assert(
                        await readStorageFile(".obsidian/app.json") === "local-existing",
                        "An excluded remote update should preserve the existing local file",
                    );
                    await assertExcludedState("remote-updated", "The excluded remote update should remain at its internal identity");

                    nextRemoteChange = remoteChanges.length;
                    assert(await writer.delete(excludedPath), "The independent writer should delete its excluded internal document");
                    await waitForRemoteChange(nextRemoteChange, excludedPath, excludedChangeId);
                    await writeRemoteControl("remote-barrier-after-excluded-delete");
                    assert(
                        await readStorageFile(".obsidian/app.json") === "local-existing",
                        "An excluded remote deletion should preserve the existing local file",
                    );
                    await assertExcludedState(false, "The excluded remote deletion should leave no internal document or alias");

                    await removeLocalExcludedAndWait(hubDispatches.length);
                    const firstExcludedWrite = hubDispatches.length;
                    await writeLocalExcludedAndWait("local-created-after-remote-delete", firstExcludedWrite);
                    await writeLocalControl("local-barrier-after-excluded-create");
                    await assertExcludedState(false, "A local excluded creation should leave both remote identities absent");

                    nextRemoteChange = remoteChanges.length;
                    await writeRemote(excludedPath, "remote-recreated", "newnote");
                    await waitForRemoteChange(nextRemoteChange, excludedPath, excludedChangeId);
                    await writeRemoteControl("remote-barrier-after-excluded-create");
                    assert(
                        await readStorageFile(".obsidian/app.json") === "local-created-after-remote-delete",
                        "An excluded remote creation should preserve the local counterpart",
                    );
                    await assertExcludedState("remote-recreated", "The remote excluded creation should remain internal without an alias");

                    const secondExcludedWrite = hubDispatches.length;
                    await writeLocalExcludedAndWait("local-updated-with-remote-counterpart", secondExcludedWrite);
                    await writeLocalControl("local-barrier-after-excluded-update");
                    await assertExcludedState(
                        "remote-recreated",
                        "A local excluded update should preserve the remote internal counterpart",
                    );

                    const excludedDelete = hubDispatches.length;
                    await removeLocalExcludedAndWait(excludedDelete);
                    await writeLocalControl("local-barrier-after-excluded-delete");
                    await assertExcludedState(
                        "remote-recreated",
                        "A local excluded deletion should preserve the live remote internal counterpart",
                    );
                    assert(
                        await readStorageFile(".obsidian/app.json") === false,
                        "The local excluded deletion should leave its local path absent",
                    );
                    stage = "final selected deletion persistence";
                    await waitForWatcherWork();
                    for (const path of [".claude/settings.json", ".claude/remote.json"]) {
                        assert(await readStorageFile(path) === false,
                            "Selected deletions should remain absent on disk: " + path);
                    }
                    await assertSelectedState(internalPath, internalAlias, false, true);
                    await assertSelectedState(remoteHiddenPath, remoteHiddenAlias, false, true);
                } catch (error) {
                    const capture = async (read: () => Promise<unknown>) => {
                        try {
                            return await read();
                        } catch (snapshotError) {
                            return { error: String(snapshotError) };
                        }
                    };
                    console.error(backend + " watcher failure diagnostics " + JSON.stringify({
                        runtime: { version: Deno.version, build: Deno.build },
                        backend,
                        chokidarReady,
                        chokidarEvents: chokidarEvents.slice(-200),
                        baseDir,
                        encryptInternalMetadata,
                        directoryExistsBeforeWatch,
                        stage,
                        elapsedMs: Date.now() - startedAt,
                        error: String(error),
                        peers: hub.peers.map((peer) => ({ type: peer.config.type, health: peer.health() })),
                        pendingHubDispatches,
                        selectedWriteLocks: [".claude/settings.json", ".claude/remote.json"].map((path) => ({
                            path, locked: isLockAcquired(join(basePath, path)),
                        })),
                        nativeEvents: nativeEvents.slice(-200),
                        hubRoutes: hubRoutes.slice(-200),
                        remoteChanges: remoteChanges.slice(-100).map((change) => ({
                            id: change.id ?? change._id ?? change.doc?._id,
                            path: change.path ?? change.doc?.path,
                        })),
                        local: await capture(async () => ({
                            selected: await readStorageFile(".claude/settings.json"),
                            remoteSelected: await readStorageFile(".claude/remote.json"),
                            ordinary: await readStorageFile("note.md"),
                        })),
                        remote: await capture(async () => {
                            if (!writer) return "Writer not initialised";
                            const paths = [internalPath, remoteHiddenPath, internalAlias, remoteHiddenAlias];
                            const ids = await Promise.all(paths.map((path) => writer!.path2id(path)));
                            return {
                                paths,
                                ids,
                                rows: await readDocuments(database, ids),
                                selected: await readWriterText(writer, internalPath),
                                remoteSelected: await readWriterText(writer, remoteHiddenPath),
                            };
                        }),
                    }));
                    throw error;
                } finally {
                    chokidar.watch = originalChokidarWatch;
                    Deno.watchFs = originalWatchFs;
                    if (changeFeed && remoteChangeListener) {
                        if (changeFeed.off) {
                            changeFeed.off("change", remoteChangeListener);
                        } else {
                            changeFeed.removeListener?.("change", remoteChangeListener);
                        }
                    }
                    await Promise.allSettled(hub.peers.map((peer) => peer.stop()));
                    await Promise.allSettled([
                        ...hub.peers.filter((peer): peer is PeerCouchDB => peer instanceof PeerCouchDB).map((peer) => peer.man?.close()),
                        writer?.close(),
                    ]);
                    if (databaseCreated) {
                        const deleted = await request(database, "", { method: "DELETE" });
                        await deleted.body?.cancel();
                    }
                    await Deno.remove(basePath, { recursive: true });
                }
            },
        );
    }
}

type RemoteChange = {
    id?: string;
    _id?: string;
    path?: string;
    doc?: { _id?: string; path?: string };
};

async function readWriterText(
    writer: DirectFileManipulator,
    path: FilePathWithPrefix,
): Promise<string | false> {
    const result = await writer.get(path);
    if (result === false) return false;
    return result.type === "newnote"
        ? new TextDecoder().decode(decodeBinary(result.data))
        : getDocData(result.data);
}
