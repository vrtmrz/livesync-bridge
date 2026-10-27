import { dirname, join, resolve } from "@std/path";
import { PeerStorage } from "./PeerStorage.ts";
import { PeerCouchDB } from "./PeerCouchDB.ts";
import { Hub } from "./Hub.ts";
import type { FileData } from "./types.ts";

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string) {
    assert(JSON.stringify(actual) === JSON.stringify(expected),
        `${message}: expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`);
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate: () => boolean, message: string) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(message);
        await sleep(10);
    }
}
function contents(text: string): FileData {
    return { data: [text], ctime: 1000, mtime: 2000, size: text.length };
}
function storage(baseDir: string) {
    const events: { path: string; data: FileData | false }[] = [];
    const peer = new PeerStorage({ type: "storage", name: crypto.randomUUID(), baseDir, ignore: ["**/private"] },
        (_source, path, data) => { events.push({ path, data }); return Promise.resolve(); });
    const settings = new Map<string, string>();
    peer.getSetting = (key) => settings.get(key) ?? null;
    peer.setSetting = (key, value) => { settings.set(key, value); };
    peer.normalLog = peer.receiveLog = peer.sendLog = () => {};
    return { peer, events };
}

for (const kind of ["create", "rename"] as const) {
    Deno.test(`Parent-only ${kind} imports a nested subtree once and skips ignored and symlinked descendants`, async () => {
        const root = await Deno.makeTempDir({ prefix: "bridge-parent-event-" });
        const outside = await Deno.makeTempDir({ prefix: "bridge-parent-outside-" });
        const { peer, events } = storage(root);
        const externalPath = join(outside, "external.md");
        const externalLink = join(root, ".claude", "deep", "outside-link");
        try {
            await Deno.mkdir(join(root, ".claude", "deep"), { recursive: true });
            await Deno.mkdir(join(root, ".claude", "private"));
            await Deno.mkdir(join(root, ".claude-other"));
            await Deno.writeTextFile(join(root, ".claude", "settings.json"), "settings");
            await Deno.writeTextFile(join(root, ".claude", "deep", "note.md"), "nested");
            await Deno.writeTextFile(join(root, ".claude", "private", "secret.md"), "secret");
            await Deno.writeTextFile(join(root, ".claude-other", "control.md"), "unrelated");
            await Deno.writeTextFile(externalPath, "outside");
            await Deno.symlink(outside, externalLink);

            const event = { kind, paths: [join(root, ".claude")] };
            peer.processFile(event);
            peer.processFile(event);
            await sleep(1000);
            equal(events.map((event) => event.path).sort(), [".claude/deep/note.md", ".claude/settings.json"],
                "Duplicate parent notifications must import each selected child only once");
            equal(events.map((event) => event.data === false ? false : event.data.data instanceof Uint8Array
                ? new TextDecoder().decode(event.data.data) : event.data.data.join("")).sort(), ["nested", "settings"],
                "Recovered files must carry their actual contents");

            await Deno.remove(join(root, ".claude"), { recursive: true });
            peer.processFile({ kind: "remove", paths: [join(root, ".claude")] });
            await sleep(700);
            equal(events.filter((event) => event.data === false).map((event) => event.path).sort(),
                [".claude/deep/note.md", ".claude/settings.json"], "Recovered paths must also be known for parent removal");
            assert(await Deno.readTextFile(externalPath) === "outside",
                "Scanning and removing the symlink must not follow or change its outside target");
        } finally {
            await peer.stop();
            await Deno.remove(root, { recursive: true });
            await Deno.remove(outside, { recursive: true });
        }
    });
}

Deno.test("Storage stop waits for an accepted outgoing save", async () => {
    const root = await Deno.makeTempDir({ prefix: "bridge-stop-save-" });
    const { peer } = storage(root);
    const release = Promise.withResolvers<void>();
    let entered = false;
    let stopped = false;
    let stopping: Promise<void> | undefined;
    let sending: Promise<void> | undefined;
    peer.dispatchToHub = async () => { entered = true; await release.promise; };
    try {
        const path = join(root, "note.md");
        await Deno.writeTextFile(path, "latest content");
        sending = peer.dispatch(path);
        await waitFor(() => entered, "The outgoing save did not start");
        stopping = peer.stop().then(() => { stopped = true; });
        await sleep(20);
        assert(!stopped, "Stopping must wait for actual delivery, not just close the watcher");
        release.resolve();
        await stopping;
        assert(stopped, "Stop must finish once the accepted save finishes");
    } finally {
        release.resolve();
        await sending;
        await stopping;
        await sleep(20);
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test({
    name: "A parent notification scans its exact spelling without importing a case-distinct sibling",
    ignore: Deno.build.os === "windows",
    fn: async () => {
        const root = await Deno.makeTempDir({ prefix: "bridge-case-sibling-" });
        const { peer, events } = storage(root);
        try {
            await Deno.mkdir(join(root, "Folder"));
            await Deno.mkdir(join(root, "folder"));
            await Deno.writeTextFile(join(root, "Folder", "selected.md"), "selected");
            await Deno.writeTextFile(join(root, "folder", "other.md"), "other");
            peer.processFile({ kind: "create", paths: [join(root, "Folder")] });
            await peer.stop();
            equal(events.map(event => event.path), ["Folder/selected.md"],
                "An existing exact directory must limit the scan to its own subtree");
        } finally {
            await peer.stop();
            await Deno.remove(root, { recursive: true });
        }
    },
});

Deno.test("Storage stop closes event admission and drains an accepted parent scan and delivery", async () => {
    const root = await Deno.makeTempDir({ prefix: "bridge-stop-scan-" });
    const parent = join(root, "parent");
    const lateParent = join(root, "after-stop");
    const heldDirectory = resolve(parent);
    const lateDirectory = resolve(lateParent);
    const { peer } = storage(root);
    const releaseRead = Promise.withResolvers<void>();
    const releaseDelivery = Promise.withResolvers<void>();
    const deliveries: { path: string; content: string | false }[] = [];
    const order: string[] = [];
    const originalReadDir = Deno.readDir;
    let heldRead = false;
    let heldDirectoryRead = false;
    let lateDirectoryReads = 0;
    let deliveryStarted = false;
    let deliveryCompleted = false;
    let stopResolved = false;
    let stopping: Promise<void> | undefined;

    peer.dispatchToHub = async (_source, path, data) => {
        deliveryStarted = true;
        order.push("delivery-started");
        deliveries.push({
            path,
            content: data === false ? false : data.data instanceof Uint8Array
                ? new TextDecoder().decode(data.data) : data.data.join(""),
        });
        await releaseDelivery.promise;
        deliveryCompleted = true;
        order.push("delivery-completed");
    };

    try {
        await Deno.mkdir(join(parent, "deep"), { recursive: true });
        await Deno.writeTextFile(join(parent, "deep", "note.md"), "accepted");
        await Deno.mkdir(join(lateParent, "deep"), { recursive: true });
        await Deno.writeTextFile(join(lateParent, "deep", "note.md"), "after stop");

        Deno.readDir = ((path: string | URL) => {
            const entries = originalReadDir(path);
            const absolute = resolve(path instanceof URL ? path.pathname : path);
            if (absolute === lateDirectory) lateDirectoryReads++;
            if (absolute !== heldDirectory || heldRead) return entries;
            heldRead = true;
            return (async function* () {
                let first = true;
                for await (const entry of entries) {
                    if (first) {
                        first = false;
                        heldDirectoryRead = true;
                        await releaseRead.promise;
                    }
                    yield entry;
                }
            })();
        }) as typeof Deno.readDir;

        peer.processFile({ kind: "create", paths: [parent] });
        await waitFor(() => heldDirectoryRead, "The accepted parent event did not enter the held readDir iterator");

        stopping = peer.stop().then(() => {
            stopResolved = true;
            order.push("stop-resolved");
        });
        await sleep(20);
        assert(!stopResolved, "stop() must wait for the accepted parent scan");
        peer.processFile({ kind: "create", paths: [lateParent] });

        releaseRead.resolve();
        await waitFor(() => deliveryStarted, "The accepted parent scan did not reach dispatchToHub");
        assert(!stopResolved, "stop() must wait for the accepted dispatchToHub call to finish");
        releaseDelivery.resolve();
        await stopping;

        assert(deliveryCompleted, "The accepted delivery must complete before stop() resolves");
        equal(order, ["delivery-started", "delivery-completed", "stop-resolved"],
            "Stop resolution must follow completion of the accepted delivery");
        equal(deliveries, [{ path: "parent/deep/note.md", content: "accepted" }],
            "An event admitted after stop() must not dispatch");
        equal(lateDirectoryReads, 0, "An event admitted after stop() must not begin a filesystem scan");
    } finally {
        releaseRead.resolve();
        releaseDelivery.resolve();
        Deno.readDir = originalReadDir;
        if (!stopping) stopping = peer.stop();
        await stopping;
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("Confirmed paired rename events forward previousPath, while separate single-path events do not", async () => {
    const root = await Deno.makeTempDir({ prefix: "bridge-rename-context-" });
    const { peer } = storage(root);
    const dispatched: { path: string; content: string | false; previousPath?: string }[] = [];
    peer.dispatchToHub = (_source, path, data, context) => {
        dispatched.push({
            path,
            content: data === false ? false : data.data instanceof Uint8Array
                ? new TextDecoder().decode(data.data) : data.data.join(""),
            ...(context?.previousPath === undefined ? {} : { previousPath: context.previousPath }),
        });
        return Promise.resolve();
    };

    try {
        const pairedOld = join(root, "paired-old", "deep", "note.md");
        const pairedNew = join(root, "paired-new", "deep", "note.md");
        await Deno.mkdir(dirname(pairedOld), { recursive: true });
        await Deno.mkdir(dirname(pairedNew), { recursive: true });
        await Deno.writeTextFile(pairedOld, "paired content");
        await peer.writeFileStat("paired-old/deep/note.md");
        await Deno.rename(pairedOld, pairedNew);
        peer.processFile({ kind: "rename", paths: [pairedOld, pairedNew] });
        await waitFor(() => dispatched.some((event) => event.path === "paired-new/deep/note.md"),
            "The paired rename should dispatch its new nested file");
        const paired = dispatched.find((event) => event.path === "paired-new/deep/note.md");
        assert(paired?.content === "paired content", "The paired rename should deliver the current file contents");
        equal(paired?.previousPath, "paired-old/deep/note.md",
            "A confirmed two-path rename should forward its known old path");

        const singleOld = join(root, "single-old", "deep", "note.md");
        const singleNew = join(root, "single-new", "deep", "note.md");
        await Deno.mkdir(dirname(singleOld), { recursive: true });
        await Deno.mkdir(dirname(singleNew), { recursive: true });
        await Deno.writeTextFile(singleOld, "single-path content");
        await peer.writeFileStat("single-old/deep/note.md");
        await Deno.rename(singleOld, singleNew);
        peer.processFile({ kind: "rename", paths: [singleOld] });
        peer.processFile({ kind: "rename", paths: [singleNew] });
        await waitFor(() => dispatched.some((event) => event.path === "single-new/deep/note.md"),
            "The separate single-path rename event should dispatch its new nested file");
        const unpaired = dispatched.find((event) => event.path === "single-new/deep/note.md");
        assert(unpaired?.content === "single-path content", "The unpaired event should deliver the current file contents");
        assert(unpaired?.previousPath === undefined, "Separate single-path events must not invent a previousPath");
    } finally {
        await peer.stop();
        await Deno.remove(root, { recursive: true });
    }
});

type Document = { path: string; data: string[]; type: "plain"; ctime: number; mtime: number; size: number; deleted?: boolean };
function couch() {
    const documents = new Map<string, Document>();
    const operations: string[] = [];
    let failNextSave = false;
    const peer = new PeerCouchDB({ type: "couchdb", name: crypto.randomUUID(), baseDir: "", database: "unused",
        url: "https://example.test", username: "", password: "", passphrase: "", obfuscatePassphrase: "",
        handleFilenameCaseSensitive: false }, async () => {});
    peer.normalLog = peer.receiveLog = peer.sendLog = () => {};
    const key = (path: string) => path.toLowerCase();
    peer.man = {
        path2id: (path: string) => Promise.resolve(key(path)),
        get: (path: string) => {
            const doc = documents.get(key(path));
            return Promise.resolve(doc && !doc.deleted ? doc : false);
        },
        getById: (id: string) => Promise.resolve(documents.get(id) ?? false),
        getByMeta: (doc: Document) => Promise.resolve(doc),
        put: async (path: string, blob: Blob, info: FileData) => {
            operations.push(`put:${path}`);
            if (failNextSave) { failNextSave = false; return false; }
            documents.set(key(path), { ...info, path, type: "plain", data: [await blob.text()] });
            return true;
        },
        delete: (path: string) => {
            operations.push(`delete:${path}`);
            const doc = documents.get(key(path));
            if (!doc) return Promise.resolve(false);
            documents.set(key(path), { ...doc, deleted: true });
            return Promise.resolve(true);
        },
    } as unknown as PeerCouchDB["man"];
    (peer as unknown as { _started: { resolve(): void } })._started.resolve();
    return { peer, documents, operations, failSave() { failNextSave = true; } };
}

Deno.test("CouchDB updates the stored path when unchanged content changes case", async () => {
    const { peer, documents } = couch();
    await peer.put("Folder/note.md", contents("unchanged"));
    await peer.put("folder/note.md", contents("unchanged"));
    equal(documents.get("folder/note.md")?.path, "folder/note.md",
        "An identical body must not suppress a Metadata path change");
});

Deno.test("CouchDB retries a later notification after a failed save", async () => {
    const { peer, operations, failSave } = couch();
    failSave();
    await peer.put("note.md", contents("retry")).catch(() => false);
    assert(await peer.put("note.md", contents("retry")), "A failed save must not acknowledge this content as a repeat");
    equal(operations, ["put:note.md", "put:note.md"], "The repeated notification must reach the database again");
});

Deno.test("A confirmed same-ID rename reaches CouchDB without a deletion", async () => {
    const root = await Deno.makeTempDir({ prefix: "bridge-rename-contract-" });
    const { peer: source } = storage(root);
    const { peer: destination, documents, operations } = couch();
    const hub = new Hub({ peers: [] });
    hub.peers = [source, destination];
    try {
        await destination.put("Folder/note.md", contents("unchanged"));
        operations.length = 0;
        await Deno.mkdir(join(root, "folder"));
        await Deno.writeTextFile(join(root, "folder", "note.md"), "unchanged");
        const dispatch = hub.dispatch.bind(hub) as unknown as (
            source: PeerStorage, path: string, data: FileData, context: { previousPath: string }
        ) => Promise<void>;
        await dispatch(source, "folder/note.md", contents("unchanged"), { previousPath: "Folder/note.md" });
        equal(documents.get("folder/note.md")?.path, "folder/note.md", "Rename must update the stored spelling");
        assert(!documents.get("folder/note.md")?.deleted, "The shared document must remain live");
        assert(!operations.some((operation) => operation.startsWith("delete:")), "Same-ID rename must not issue a tombstone");
    } finally {
        await source.stop();
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("An unpaired old-path deletion preserves a live document with the same ID", async () => {
    const root = await Deno.makeTempDir({ prefix: "bridge-delete-alias-" });
    const { peer: source } = storage(root);
    const { peer: destination, documents, operations } = couch();
    const hub = new Hub({ peers: [] });
    hub.peers = [source, destination];
    try {
        await destination.put("Folder/note.md", contents("unchanged"));
        await Deno.mkdir(join(root, "folder"));
        await Deno.writeTextFile(join(root, "folder", "note.md"), "unchanged");
        operations.length = 0;
        await hub.dispatch(source, "Folder/note.md", false);
        assert(!documents.get("folder/note.md")?.deleted, "A current same-ID file must prevent a tombstone");
        equal(documents.get("folder/note.md")?.path, "folder/note.md", "The surviving path must be recorded");
        assert(!operations.some((operation) => operation.startsWith("delete:")), "No transient deletion is allowed");
    } finally {
        await source.stop();
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("Deletion verification does not descend into an ignored case alias", async () => {
    const root = await Deno.makeTempDir({ prefix: "bridge-ignored-alias-" });
    const { peer: source } = storage(root);
    source.config.ignore = ["folder"];
    const { peer: destination, documents } = couch();
    const hub = new Hub({ peers: [] });
    hub.peers = [source, destination];
    const originalReadDir = Deno.readDir;
    let ignoredReads = 0;
    try {
        await destination.put("Folder/deep/note.md", contents("body"));
        await Deno.mkdir(join(root, "folder", "deep"), { recursive: true });
        await Deno.writeTextFile(join(root, "folder", "deep", "note.md"), "private");
        Deno.readDir = ((path: string | URL) => {
            if (String(path).startsWith(join(root, "folder"))) ignoredReads++;
            return originalReadDir(path);
        }) as typeof Deno.readDir;
        await hub.dispatch(source, "Folder/deep/note.md", false).catch(() => {});
        equal(ignoredReads, 0, "Alias discovery must stop at an ignored directory boundary");
        assert(!documents.get("folder/deep/note.md")?.deleted,
            "An uninspectable current alias must preserve the old document");
    } finally {
        Deno.readDir = originalReadDir;
        await source.stop();
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("A confirmed different-ID rename saves its target before deleting the source", async () => {
    const root = await Deno.makeTempDir({ prefix: "bridge-rename-order-" });
    const { peer: source } = storage(root);
    const { peer: destination, documents, operations, failSave } = couch();
    const hub = new Hub({ peers: [] });
    hub.peers = [source, destination];
    const dispatch = hub.dispatch.bind(hub) as unknown as (
        source: PeerStorage, path: string, data: FileData, context: { previousPath: string }
    ) => Promise<void>;
    try {
        await destination.put("old.md", contents("body"));
        operations.length = 0;
        failSave();
        await dispatch(source, "new.md", contents("body"), { previousPath: "old.md" }).catch(() => {});
        assert(!documents.get("old.md")?.deleted, "Failed target save must preserve the old document");
        await dispatch(source, "new.md", contents("body"), { previousPath: "old.md" });
        assert(documents.get("old.md")?.deleted, "Successful rename must remove the old document");
        equal(operations, ["put:new.md", "put:new.md", "delete:old.md"], "Save must precede deletion, including after failure");
    } finally {
        await source.stop();
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("A later destination can retry a rename already completed by an earlier destination", async () => {
    const root = await Deno.makeTempDir({ prefix: "bridge-rename-destinations-" });
    const { peer: source } = storage(root);
    const first = couch();
    const second = couch();
    const hub = new Hub({ peers: [] });
    hub.peers = [source, first.peer, second.peer];
    try {
        await first.peer.put("old.md", contents("body"));
        await second.peer.put("old.md", contents("body"));
        second.failSave();
        await hub.dispatch(source, "new.md", contents("body"), { previousPath: "old.md" }).catch(() => {});
        assert(first.documents.get("old.md")?.deleted, "The first destination should have completed its rename");
        assert(!second.documents.get("old.md")?.deleted, "The failed destination must preserve its source");
        await hub.dispatch(source, "new.md", contents("body"), { previousPath: "old.md" });
        assert(second.documents.get("old.md")?.deleted && second.documents.has("new.md"),
            "An already completed destination must allow a later destination to retry");
    } finally {
        await source.stop();
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("Storage retries a later notification after delivery fails", async () => {
    const root = await Deno.makeTempDir({ prefix: "bridge-delivery-retry-" });
    const { peer } = storage(root);
    let attempts = 0;
    peer.dispatchToHub = () => {
        attempts++;
        if (attempts === 1) throw new Error("Simulated delivery failure");
        return Promise.resolve();
    };
    try {
        const path = join(root, "note.md");
        await Deno.writeTextFile(path, "body");
        await peer.dispatch(path);
        await sleep(400);
        await peer.dispatch(path);
        await sleep(400);
        equal(attempts, 2, "Failed delivery must leave the content eligible for another notification");
    } finally {
        await peer.stop();
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("An overlapping incoming save waits for an earlier failed save of the same content", async () => {
    const root = await Deno.makeTempDir({ prefix: "bridge-overlapping-save-" });
    const { peer } = storage(root);
    const path = join(root, "note.md");
    const originalOpen = Deno.open;
    const release = Promise.withResolvers<void>();
    let entered = false;
    let first: Promise<boolean> | undefined;
    let second: Promise<boolean> | undefined;
    try {
        Deno.open = (async (...args: Parameters<typeof Deno.open>) => {
            if (String(args[0]) === path && !entered) {
                entered = true;
                await release.promise;
                throw new Deno.errors.PermissionDenied("Simulated first save failure");
            }
            return await originalOpen(...args);
        }) as typeof Deno.open;
        first = peer.put("note.md", contents("body")).catch(() => false);
        await waitFor(() => entered, "The first save should reach the held file open");
        second = peer.put("note.md", contents("body"));
        await sleep(20);
        release.resolve();
        assert(!await first, "The first save should fail at its injected write boundary");
        assert(await second, "The overlapping request must save after the earlier request fails");
        equal(await Deno.readTextFile(path), "body", "The accepted content must reach storage");
    } finally {
        release.resolve();
        await Promise.allSettled([first, second]);
        Deno.open = originalOpen;
        await peer.stop();
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("A received echo of existing content does not wait for the outgoing delivery", async () => {
    const root = await Deno.makeTempDir({ prefix: "bridge-outgoing-echo-" });
    const { peer } = storage(root);
    const release = Promise.withResolvers<void>();
    let entered = false;
    let echoCompleted = false;
    let incoming: Promise<boolean> | undefined;
    peer.dispatchToHub = async () => { entered = true; await release.promise; };
    try {
        await Deno.writeTextFile(join(root, "note.md"), "body");
        await peer.dispatch(join(root, "note.md"));
        await waitFor(() => entered, "The existing file should enter outgoing delivery");
        incoming = peer.put("note.md", contents("body")).then(result => {
            echoCompleted = true;
            return result;
        });
        await waitFor(() => echoCompleted,
            "An incoming echo must complete while the original delivery waits, avoiding a cycle between peers");
        equal(await Deno.readTextFile(join(root, "note.md")), "body", "The received echo must preserve existing contents");
    } finally {
        release.resolve();
        await incoming;
        await peer.stop();
        await Deno.remove(root, { recursive: true });
    }
});
