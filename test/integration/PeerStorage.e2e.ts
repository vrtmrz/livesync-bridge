import { join, resolve, SEPARATOR } from "@std/path";
import type { FilePathWithPrefix } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { Hub } from "../../Hub.ts";
import { PeerCouchDB } from "../../PeerCouchDB.ts";
import { PeerStorage } from "../../PeerStorage.ts";
import type { PeerCouchDBConf, PeerStorageConf } from "../../types.ts";

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
