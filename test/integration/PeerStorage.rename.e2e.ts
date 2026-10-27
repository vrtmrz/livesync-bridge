import { dirname, join } from "@std/path";
import type { FilePathWithPrefix } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { Hub } from "../../Hub.ts";
import { PeerCouchDB } from "../../PeerCouchDB.ts";
import { PeerStorage } from "../../PeerStorage.ts";
import type { PeerCouchDBConf, PeerStorageConf } from "../../types.ts";
import { watcherTest } from "./watcherTest.ts";

const couchDbUrl = Deno.env.get("COUCHDB_URL") ?? "http://127.0.0.1:5989";
const couchDbUsername = Deno.env.get("COUCHDB_USERNAME") ?? "admin";
const couchDbPassword = Deno.env.get("COUCHDB_PASSWORD") ?? "testpassword";
const authorization = `Basic ${btoa(`${couchDbUsername}:${couchDbPassword}`)}`;
const TEST_TIMEOUT_MS = 15_000;
const WAIT_TIMEOUT_MS = 10_000;

type DocumentRow = {
    id?: string;
    error?: string;
    value?: { rev: string; deleted?: boolean };
    doc?: { _rev?: string; deleted?: boolean; _deleted?: boolean };
};

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

async function waitFor(
    condition: () => boolean | Promise<boolean>,
    message: string,
): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
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

async function readDocuments(database: string, ids: string[]): Promise<DocumentRow[]> {
    const response = await request(database, "/_all_docs?include_docs=true", {
        method: "POST",
        body: JSON.stringify({ keys: ids }),
    });
    assert(response.ok, `Could not read test documents: HTTP ${response.status} ${await response.clone().text()}`);
    return (await response.json()).rows as DocumentRow[];
}

async function readStoredMetadataPath(remote: PeerCouchDB, id: string): Promise<string | false> {
    // get(path, true) builds path from its argument; getById reads stored metadata through the database decode transform.
    const metadata = await remote.man.getById(id, true) as false | { path?: unknown };
    if (metadata === false) return false;
    return typeof metadata.path === "string" ? metadata.path : false;
}

function isDeleted(row: DocumentRow): boolean {
    return !!(row.value?.deleted || row.doc?.deleted || row.doc?._deleted);
}

function isLive(row: DocumentRow | undefined): boolean {
    return !!row?.doc && !isDeleted(row);
}

async function readText(remote: PeerCouchDB, path: string): Promise<string | false> {
    const data = await remote.get(path as FilePathWithPrefix);
    if (data === false) return false;
    return data.data instanceof Uint8Array ? new TextDecoder().decode(data.data) : data.data.join("");
}

function couchConfig(
    name: string,
    database: string,
    options: {
        baseDir: string;
        includeInternal?: string[];
        handleFilenameCaseSensitive?: boolean;
    },
): PeerCouchDBConf {
    return {
        type: "couchdb",
        name,
        database,
        url: couchDbUrl,
        baseDir: options.baseDir,
        username: couchDbUsername,
        password: couchDbPassword,
        passphrase: "content-encryption-passphrase",
        obfuscatePassphrase: "path-obfuscation-passphrase",
        ...(options.includeInternal ? { includeInternal: options.includeInternal } : {}),
        ...(options.handleFilenameCaseSensitive === undefined
            ? {}
            : { handleFilenameCaseSensitive: options.handleFilenameCaseSensitive }),
    };
}

type FixtureOptions = {
    files: Record<string, string>;
    remoteBaseDir?: string;
    includeInternal?: string[];
    handleFilenameCaseSensitive?: boolean;
};

type FixtureContext = {
    database: string;
    baseDir: string;
    remoteBaseDir: string;
    remote: PeerCouchDB;
    storage: PeerStorage;
    localPath: (path: string) => string;
    databasePath: (path: string) => FilePathWithPrefix;
    idFor: (path: string) => Promise<string>;
};

async function withFixture(
    options: FixtureOptions,
    run: (context: FixtureContext) => Promise<void>,
): Promise<void> {
    const suffix = crypto.randomUUID().replaceAll("-", "");
    const database = `livesync_bridge_rename_${suffix}`;
    const baseDir = await Deno.makeTempDir({ prefix: "bridge-rename-e2e-" });
    const remoteBaseDir = options.remoteBaseDir ?? "vault/";
    const remoteConfig = couchConfig(`rename-remote-${suffix}`, database, {
        baseDir: remoteBaseDir,
        includeInternal: options.includeInternal,
        handleFilenameCaseSensitive: options.handleFilenameCaseSensitive,
    });
    const storageConfig: PeerStorageConf = {
        type: "storage",
        name: `rename-storage-${suffix}`,
        baseDir: `${baseDir}/`,
        scanOfflineChanges: true,
        useChokidar: false,
    };
    const hub = new Hub({ peers: [remoteConfig, storageConfig] });
    let databaseCreated = false;

    try {
        for (const [path, contents] of Object.entries(options.files)) {
            const localPath = join(baseDir, path);
            await Deno.mkdir(dirname(localPath), { recursive: true });
            await Deno.writeTextFile(localPath, contents);
        }

        const created = await request(database, "", { method: "PUT" });
        const creationBody = await created.text();
        assert(created.ok, `Could not create rename E2E database: HTTP ${created.status} ${creationBody}`);
        databaseCreated = true;

        hub.start();
        const remote = hub.peers.find((peer): peer is PeerCouchDB => peer instanceof PeerCouchDB);
        const storage = hub.peers.find((peer): peer is PeerStorage => peer instanceof PeerStorage);
        assert(remote && storage, "The Hub should construct real CouchDB and storage peers");
        await waitFor(
            () => hub.peers.length === 2 && hub.peers.every((peer) => peer.health().ok) &&
                storage.watcherDeno !== undefined,
            "The real CouchDB peer and native Deno watcher should become ready",
        );
        assert(storage.config.useChokidar === false, "The rename fixture should use Deno.watchFs");

        const databasePath = (path: string): FilePathWithPrefix => path.startsWith(".")
            ? `i:${path}` as FilePathWithPrefix
            : `${remoteBaseDir}${path}` as FilePathWithPrefix;
        const idFor = (path: string) => remote.man.path2id(databasePath(path));
        const sourcePaths = Object.keys(options.files);
        const ids = await Promise.all(sourcePaths.map(idFor));
        await waitFor(async () => {
            const rows = await readDocuments(database, ids);
            for (let index = 0; index < sourcePaths.length; index++) {
                if (!isLive(rows[index]) || await readText(remote, sourcePaths[index]) !== options.files[sourcePaths[index]]) {
                    return false;
                }
            }
            return true;
        }, "The native storage watcher should upload every initial file through Hub and CouchDB");

        await run({
            database,
            baseDir,
            remoteBaseDir,
            remote,
            storage,
            localPath: (path) => join(baseDir, path),
            databasePath,
            idFor,
        });
    } finally {
        await Promise.allSettled(hub.peers.map((peer) => peer.stop()));
        await Promise.allSettled(
            hub.peers
                .filter((peer): peer is PeerCouchDB => peer instanceof PeerCouchDB)
                .map((peer) => peer.man?.close()),
        );
        const names = [remoteConfig.name, storageConfig.name];
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
}

function observeDeleteCalls(remote: PeerCouchDB): { calls: string[]; restore: () => void } {
    const calls: string[] = [];
    const originalDelete = remote.man.delete;
    remote.man.delete = (async (...args: Parameters<typeof remote.man.delete>) => {
        calls.push(String(args[0]));
        return await originalDelete.apply(remote.man, args);
    }) as typeof remote.man.delete;
    return {
        calls,
        restore: () => { remote.man.delete = originalDelete; },
    };
}

async function readRow(database: string, id: string): Promise<DocumentRow> {
    const [row] = await readDocuments(database, [id]);
    assert(row, `CouchDB should return a row for ${id}`);
    return row;
}

async function readRawDocument(database: string, id: string): Promise<Record<string, unknown>> {
    const response = await request(database, `/${encodeURIComponent(id)}`);
    assert(response.ok, `Could not read raw CouchDB document ${id}: HTTP ${response.status}`);
    return await response.json() as Record<string, unknown>;
}

watcherTest("standard", {
    name: "Native watcher syncs nested files across an ordinary directory rename and later deletion",
    timeout: TEST_TIMEOUT_MS,
    fn: async () => {
        const childContents = "nested child content";
        const retainedContents = "nested sibling content";
        const unrelatedContents = "unrelated sibling content";
        await withFixture({
            files: {
                "before/deep/child.md": childContents,
                "before/deep/retained.md": retainedContents,
                "unrelated.md": unrelatedContents,
            },
        }, async ({ database, localPath, remote, databasePath, idFor }) => {
            const oldChildId = await idFor("before/deep/child.md");
            const oldRetainedId = await idFor("before/deep/retained.md");
            const newChildId = await idFor("after/deep/child.md");
            const newRetainedId = await idFor("after/deep/retained.md");
            const unrelatedId = await idFor("unrelated.md");
            const initialUnrelated = await readRow(database, unrelatedId);
            const unrelatedRevision = initialUnrelated.value?.rev;
            assert(oldChildId !== newChildId && oldRetainedId !== newRetainedId,
                "An ordinary directory rename should select new document identities");

            await Deno.rename(localPath("before"), localPath("after"));
            await waitFor(async () => {
                const [oldChild, oldRetained, newChild, newRetained] = await readDocuments(database, [
                    oldChildId,
                    oldRetainedId,
                    newChildId,
                    newRetainedId,
                ]);
                return isDeleted(oldChild) && isDeleted(oldRetained) && isLive(newChild) && isLive(newRetained) &&
                    await readText(remote, "after/deep/child.md") === childContents &&
                    await readText(remote, "after/deep/retained.md") === retainedContents;
            }, "A directory rename should tombstone old nested paths and create live documents at new paths");

            assert(await readStoredMetadataPath(remote, newChildId) === databasePath("after/deep/child.md"),
                "The new child Metadata.path should name its renamed path");
            assert(await readStoredMetadataPath(remote, newRetainedId) === databasePath("after/deep/retained.md"),
                "The retained nested Metadata.path should name its renamed path");

            await Deno.remove(localPath("after/deep/child.md"));
            await waitFor(async () => isDeleted(await readRow(database, newChildId)),
                "Deleting the renamed child should tombstone the new path identity");
            assert(isDeleted(await readRow(database, oldChildId)), "The old child identity should remain deleted");
            assert(isLive(await readRow(database, newRetainedId)), "A sibling inside the renamed directory should remain live");
            assert(await readText(remote, "after/deep/retained.md") === retainedContents,
                "A sibling inside the renamed directory should retain its contents");
            const unrelated = await readRow(database, unrelatedId);
            assert(isLive(unrelated) && unrelated.value?.rev === unrelatedRevision,
                "An unrelated sibling document should retain its original live revision");
            assert(await readText(remote, "unrelated.md") === unrelatedContents,
                "An unrelated sibling should retain its contents");
        });
    },
});

watcherTest("standard", {
    name: "Native watcher preserves one document identity for an identical-content case-only parent-directory rename",
    timeout: TEST_TIMEOUT_MS,
    fn: async () => {
        const contents = "case-only content stays identical";
        const siblingContents = "sibling is unchanged";
        const oldPath = "Notes/Topic/deep/child.md";
        const newPath = "notes/Topic/deep/child.md";
        await withFixture({
            files: { [oldPath]: contents, "sibling.md": siblingContents },
            handleFilenameCaseSensitive: false,
        }, async ({ database, localPath, remote, databasePath, idFor }) => {
            const oldId = await idFor(oldPath);
            const newId = await idFor(newPath);
            const siblingId = await idFor("sibling.md");
            assert(oldId === newId, "Case-insensitive filename identity should map both spellings to one ID");
            assert(await readStoredMetadataPath(remote, newId) === databasePath(oldPath),
                "Before rename, the new spelling should still resolve to the old persisted Metadata.path");
            const siblingRevision = (await readRow(database, siblingId)).value?.rev;
            const deleteObserver = observeDeleteCalls(remote);

            try {
                await Deno.rename(localPath("Notes"), localPath("notes"));
                await waitFor(async () => {
                    const row = await readRow(database, oldId);
                    const metadataPath = await readStoredMetadataPath(remote, newId);
                    return isLive(row) && metadataPath === databasePath(newPath) &&
                        await readText(remote, newPath) === contents;
                }, "The shared case-insensitive document should remain live with the new Metadata.path");
                await new Promise((resolve) => setTimeout(resolve, 1000));
                assert(await readStoredMetadataPath(remote, newId) === databasePath(newPath),
                    "The stored Metadata.path should remain at the renamed path after queued notifications settle");
                assert(await readText(remote, newPath) === contents,
                    "The unchanged file contents should remain available after queued notifications settle");
                assert(isLive(await readRow(database, newId)),
                    "The same-ID document should remain live after queued notifications settle");
                assert(!deleteObserver.calls.includes(String(databasePath(oldPath))),
                    "A same-ID case-only rename must not call man.delete for the old path");

                await Deno.remove(localPath(newPath));
                await waitFor(async () => isDeleted(await readRow(database, newId)),
                    "Deleting the renamed nested child should tombstone its shared document ID");
                const sibling = await readRow(database, siblingId);
                assert(isLive(sibling) && sibling.value?.rev === siblingRevision,
                    "The unrelated sibling document should retain its live revision");
                assert(await readText(remote, "sibling.md") === siblingContents,
                    "The unrelated sibling should retain its contents");
            } finally {
                deleteObserver.restore();
            }
        });
    },
});

watcherTest("standard", {
    name: "Native watcher gives a case-sensitive case-only rename a new ID and deletes that ID later",
    timeout: TEST_TIMEOUT_MS,
    fn: async () => {
        const contents = "case-sensitive identity content";
        const siblingContents = "sibling is unchanged";
        await withFixture({
            files: { "nested/Note.md": contents, "sibling.md": siblingContents },
            handleFilenameCaseSensitive: true,
        }, async ({ database, localPath, remote, databasePath, idFor }) => {
            const oldPath = "nested/Note.md";
            const newPath = "nested/note.md";
            const oldId = await idFor(oldPath);
            const newId = await idFor(newPath);
            const siblingId = await idFor("sibling.md");
            assert(oldId !== newId, "Case-sensitive filename identity should map each spelling to a distinct ID");
            const siblingRevision = (await readRow(database, siblingId)).value?.rev;

            await Deno.rename(localPath(oldPath), localPath(newPath));
            await waitFor(async () => {
                const [oldRow, newRow] = await readDocuments(database, [oldId, newId]);
                return isDeleted(oldRow) && isLive(newRow) &&
                    await readText(remote, newPath) === contents;
            }, "A case-sensitive rename should tombstone the old ID and create a live new ID");
            assert(await readStoredMetadataPath(remote, newId) === databasePath(newPath),
                "The new document Metadata.path should use the new spelling");

            await Deno.remove(localPath(newPath));
            await waitFor(async () => isDeleted(await readRow(database, newId)),
                "Deleting the renamed file should tombstone its new case-sensitive ID");
            assert(isDeleted(await readRow(database, oldId)), "The old case-sensitive ID should remain deleted");
            const sibling = await readRow(database, siblingId);
            assert(isLive(sibling) && sibling.value?.rev === siblingRevision,
                "The unrelated sibling document should retain its live revision");
            assert(await readText(remote, "sibling.md") === siblingContents,
                "The unrelated sibling should retain its contents");
        });
    },
});

watcherTest("standard", {
    name: "Native watcher preserves internal metadata identity across a selected hidden directory rename",
    timeout: TEST_TIMEOUT_MS,
    fn: async () => {
        const contents = "identical internal content";
        const siblingContents = "ordinary sibling is unchanged";
        await withFixture({
            files: { ".claude/deep/settings.json": contents, "sibling.md": siblingContents },
            remoteBaseDir: "vault/",
            includeInternal: [".claude/**", ".CLAUDE/**"],
            handleFilenameCaseSensitive: false,
        }, async ({ database, localPath, remote, databasePath, idFor }) => {
            const oldPath = ".claude/deep/settings.json";
            const newPath = ".CLAUDE/deep/settings.json";
            const oldId = await idFor(oldPath);
            const newId = await idFor(newPath);
            const siblingId = await idFor("sibling.md");
            assert(oldId === newId, "Case-insensitive internal paths should share one document ID");
            assert(await readStoredMetadataPath(remote, newId) === databasePath(oldPath),
                "Before the hidden-directory rename, the new spelling should still resolve to the old persisted Metadata.path");
            const siblingRevision = (await readRow(database, siblingId)).value?.rev;
            const deleteObserver = observeDeleteCalls(remote);

            try {
                await Deno.rename(localPath(".claude"), localPath(".CLAUDE"));
                await waitFor(async () => {
                    const row = await readRow(database, oldId);
                    const metadataPath = await readStoredMetadataPath(remote, newId);
                    return isLive(row) && metadataPath === databasePath(newPath) &&
                        await readText(remote, newPath) === contents;
                }, "The selected internal document should stay live and update its Metadata.path after rename");
                await new Promise((resolve) => setTimeout(resolve, 1000));
                assert(await readStoredMetadataPath(remote, newId) === databasePath(newPath),
                    "The internal Metadata.path should remain at the renamed path after queued notifications settle");
                assert(await readText(remote, newPath) === contents,
                    "The unchanged internal contents should remain available after queued notifications settle");
                assert(isLive(await readRow(database, newId)),
                    "The same-ID internal document should remain live after queued notifications settle");
                assert(!deleteObserver.calls.includes(String(databasePath(oldPath))),
                    "A same-ID internal case-only rename must not call man.delete for the old path");

                await Deno.remove(localPath(newPath));
                await waitFor(async () => isDeleted(await readRow(database, newId)),
                    "Deleting the renamed internal file should tombstone its shared ID");
                const sibling = await readRow(database, siblingId);
                assert(isLive(sibling) && sibling.value?.rev === siblingRevision,
                    "The unrelated sibling document should retain its live revision");
                assert(await readText(remote, "sibling.md") === siblingContents,
                    "The unrelated sibling should retain its contents");
            } finally {
                deleteObserver.restore();
            }
        });
    },
});

watcherTest("standard", {
    name: "Encrypted CouchDB rename preserves the source when the target save fails",
    timeout: TEST_TIMEOUT_MS,
    fn: async () => {
        const contents = "encrypted rename source contents";
        const oldPath = "before/deep/source.md";
        const newPath = "after/deep/source.md";
        await withFixture({ files: { [oldPath]: contents } }, async ({ database, remote, databasePath, idFor }) => {
            const oldId = await idFor(oldPath);
            const newId = await idFor(newPath);
            const oldDatabasePath = databasePath(oldPath);
            const newDatabasePath = databasePath(newPath);
            assert(oldId !== newId, "The rename should target a different CouchDB document identity");
            assert(remote.man.settings.encrypt && remote.man.settings.usePathObfuscation,
                "The fixture should encrypt content and obfuscate CouchDB paths");

            const sourceData = await remote.get(oldPath as FilePathWithPrefix);
            assert(sourceData !== false, "The encrypted source document should be readable through PeerCouchDB");
            const initialOldRow = await readRow(database, oldId);
            assert(isLive(initialOldRow), "The source CouchDB row should be live before rename");
            const initialRevision = initialOldRow.value?.rev;
            assert(initialRevision, "The source CouchDB row should have a revision before rename");
            const initialRawOldDocument = await readRawDocument(database, oldId);
            assert(initialRawOldDocument._rev === initialRevision,
                "The raw CouchDB source revision should match its all-docs revision");
            assert(await readStoredMetadataPath(remote, oldId) === oldDatabasePath,
                "The source Metadata.path should point at its original path before rename");
            assert(await readText(remote, oldPath) === contents,
                "The encrypted source body should be readable before rename");
            const initialTargetRow = await readRow(database, newId);
            assert(initialTargetRow.error === "not_found" && !initialTargetRow.doc,
                "The destination CouchDB row should be absent before rename");

            const originalPut = remote.man.put;
            let failedDestinationSave = false;
            remote.man.put = (async (...args: Parameters<typeof remote.man.put>) => {
                if (!failedDestinationSave && String(args[0]) === String(newDatabasePath)) {
                    failedDestinationSave = true;
                    return false;
                }
                return await originalPut.apply(remote.man, args);
            }) as typeof remote.man.put;

            try {
                let renameError: unknown;
                try {
                    await remote.rename(oldPath, newPath, sourceData);
                } catch (error) {
                    renameError = error;
                }
                assert(failedDestinationSave, "The test should reject the first save to the destination database path");
                assert(renameError instanceof Error && renameError.message === `Save failed: ${newDatabasePath}`,
                    "The rename should reject when saving the destination document fails");

                const [oldAfterFailure, targetAfterFailure] = await readDocuments(database, [oldId, newId]);
                assert(isLive(oldAfterFailure) && oldAfterFailure.value?.rev === initialRevision &&
                    oldAfterFailure.doc?._rev === initialRevision,
                    "The actual CouchDB source row should remain live at its original revision after target save failure");
                const rawOldAfterFailure = await readRawDocument(database, oldId);
                assert(rawOldAfterFailure._rev === initialRawOldDocument._rev &&
                    rawOldAfterFailure.path === initialRawOldDocument.path &&
                    JSON.stringify(rawOldAfterFailure.data) === JSON.stringify(initialRawOldDocument.data) &&
                    JSON.stringify(rawOldAfterFailure.children) === JSON.stringify(initialRawOldDocument.children),
                    "The actual CouchDB source revision, stored path, and encrypted body references should remain unchanged");
                assert(targetAfterFailure.error === "not_found" && !targetAfterFailure.doc,
                    "A failed target save should leave no destination CouchDB row");
                assert(await readStoredMetadataPath(remote, oldId) === oldDatabasePath,
                    "The failed rename should preserve the source Metadata.path");
                assert(await readText(remote, oldPath) === contents,
                    "The failed rename should preserve the source body");
            } finally {
                remote.man.put = originalPut;
            }

            assert(await remote.rename(oldPath, newPath, sourceData),
                "The same rename should succeed after restoring the real CouchDB save method");
            await waitFor(async () => {
                const [oldRow, newRow] = await readDocuments(database, [oldId, newId]);
                return isDeleted(oldRow) && isLive(newRow) &&
                    await readStoredMetadataPath(remote, newId) === newDatabasePath &&
                    await readText(remote, newPath) === contents;
            }, "The successful retry should save the encrypted destination before tombstoning the source");

            const [oldAfterSuccess, newAfterSuccess] = await readDocuments(database, [oldId, newId]);
            assert(isDeleted(oldAfterSuccess) && isLive(newAfterSuccess),
                "The successful retry should tombstone the old row and leave the target row live");
            assert(await readStoredMetadataPath(remote, newId) === newDatabasePath,
                "The destination Metadata.path should point at its saved path");
            assert(await readText(remote, newPath) === contents,
                "The destination document should retain the encrypted source body");
        });
    },
});
