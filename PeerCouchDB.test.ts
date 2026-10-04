import { LOG_LEVEL_NOTICE } from "octagonal-wheels/common/logger";
import type { DispatchFun } from "./Peer.ts";
import { PeerCouchDB } from "./PeerCouchDB.ts";
import { PeerStorage } from "./PeerStorage.ts";
import type { FileData, PeerCouchDBConf, PeerStorageConf } from "./types.ts";

function assertEquals<T>(actual: T, expected: T, message: string) {
    if (actual !== expected) {
        throw new Error(`${message}\nactual=${String(actual)}\nexpected=${String(expected)}`);
    }
}

function assert(condition: unknown, message: string) {
    if (!condition) throw new Error(message);
}

function makeSource(dispatcher: DispatchFun) {
    const config: PeerCouchDBConf = {
        type: "couchdb",
        name: `test-source-${crypto.randomUUID()}`,
        baseDir: "",
        url: "http://127.0.0.1:1",
        database: "unused",
        username: "",
        password: "",
        passphrase: "",
        obfuscatePassphrase: "",
    };
    const peer = new PeerCouchDB(config, dispatcher);
    const notices: string[] = [];
    peer.normalLog = (message, level) => {
        if (level === LOG_LEVEL_NOTICE) notices.push(message);
    };
    return { peer, notices };
}

function makeDestination(baseDir: string) {
    const config: PeerStorageConf = {
        type: "storage",
        name: `test-destination-${crypto.randomUUID()}`,
        baseDir,
        scanOfflineChanges: false,
    };
    const peer = new PeerStorage(config, async () => {});
    const settings = new Map<string, string>();
    peer.setSetting = (key, value) => {
        settings.set(key, value);
    };
    peer.getSetting = (key) => settings.get(key) ?? null;
    return peer;
}

function emptyFileData(data: FileData["data"], size = 0): FileData {
    return { ctime: 1_700_000_000_000, mtime: 1_700_000_002_000, size, data };
}

const emptyFormats = [
    { name: "text", filename: "note.md", empty: () => [""] },
    { name: "text with no chunks", filename: "note.md", empty: () => [] },
    { name: "binary", filename: "attachment.docx", empty: () => new Uint8Array(0) },
];

for (const format of emptyFormats) {
    Deno.test(`PeerCouchDB rejects each empty ${format.name} payload with nonzero metadata before dispatch`, async () => {
        let dispatched = 0;
        const { peer, notices } = makeSource(() => {
            dispatched += 1;
            return Promise.resolve();
        });
        const data = emptyFileData(format.empty(), 16);

        await peer.dispatch(format.filename, data);
        await peer.dispatch(format.filename, data);

        assertEquals(dispatched, 0, "An inconsistent empty payload should not be delivered to any destination");
        assertEquals(notices.length, 2, "Each rejected input should produce a notice");
        assert(notices.every((message) => message.includes(format.filename) && message.includes("16 bytes reported")),
            "Notices should identify the path and reported size");
    });

    Deno.test(`PeerCouchDB delivers valid empty and subsequent ${format.name} edits after rejecting an inconsistent payload`, async () => {
        const tempDir = await Deno.makeTempDir({ prefix: "peer-couchdb-empty-recovery-" });
        try {
            const destination = makeDestination(tempDir);
            const writes: boolean[] = [];
            const { peer, notices } = makeSource(async (_source, path, data) => {
                if (data === false) throw new Error("Unexpected deletion");
                writes.push(await destination.put(path, data));
            });
            const path = `${tempDir}/${format.filename}`;
            await Deno.writeTextFile(path, "previous content");
            const originalMtime = (await Deno.stat(path)).mtime?.getTime();

            const bad = emptyFileData(format.empty(), 16);
            await peer.dispatch(format.filename, bad);
            assertEquals(await Deno.readTextFile(path), "previous content", "The rejected input should preserve the existing content");
            assertEquals((await Deno.stat(path)).mtime?.getTime(), originalMtime, "The rejected input should preserve the modification time");

            const emptyEdit: FileData = { ...bad, size: 0, mtime: bad.mtime + 2000 };
            await peer.dispatch(format.filename, emptyEdit);

            assertEquals((await Deno.stat(path)).size, 0, "The later valid empty edit should reach storage");
            assertEquals((await Deno.stat(path)).mtime?.getTime(), emptyEdit.mtime, "The valid empty edit should update the modification time");
            assertEquals(writes.length, 1, "Only the valid empty edit should have reached storage");
            assertEquals(writes[0], true, "The valid empty edit should be saved");
            assertEquals(notices.length, 1, "Only the inconsistent input should produce a notice");

            const replacement: FileData = {
                ...emptyEdit,
                size: 3,
                mtime: emptyEdit.mtime + 2000,
                data: format.name === "binary" ? new TextEncoder().encode("new") : ["new"],
            };
            await peer.dispatch(format.filename, replacement);
            assertEquals(await Deno.readTextFile(path), "new", "A subsequent non-empty edit should also reach storage");
            assertEquals(writes.length, 2, "Both valid edits should reach storage");
            assertEquals(writes[1], true, "The subsequent edit should be saved");
        } finally {
            await Deno.remove(tempDir, { recursive: true });
        }
    });
}

for (const format of ["text", "binary"] as const) {
    Deno.test(`PeerCouchDB dispatches a non-empty ${format} update and suppresses its repeat`, async () => {
        const deliveries: { path: string; data: FileData | false }[] = [];
        const { peer, notices } = makeSource((_source, path, data) => {
            deliveries.push({ path, data });
            return Promise.resolve();
        });
        const filename = format === "text" ? "note.md" : "attachment.docx";
        const data: FileData = {
            ...emptyFileData([], 3),
            data: format === "text" ? ["", "new"] : new TextEncoder().encode("new"),
        };

        await peer.dispatch(filename, data);
        await peer.dispatch(filename, data);

        assertEquals(deliveries.length, 1, "A normal update should be delivered once");
        assertEquals(deliveries[0].path, filename, "The destination should receive the original path");
        assertEquals(deliveries[0].data, data, "The destination should receive the original data");
        assertEquals(notices.length, 0, "A non-empty update should not be blocked");
    });
}
