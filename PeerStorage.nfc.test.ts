import { join } from "@std/path";
import { PeerStorage } from "./PeerStorage.ts";
import { AmbiguousNormalisedPathError } from "@vrtmrz/livesync-commonlib/storage";
import type { FileData, PeerStorageConf } from "./types.ts";

function assert(value: unknown, message: string): asserts value {
    if (!value) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${message}: expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`);
    }
}
async function rejects(operation: () => Promise<unknown>, kind: new (...args: never[]) => Error) {
    try {
        await operation();
    } catch (error) {
        assert(error instanceof kind, `Expected ${kind.name}, received ${String(error)}`);
        return;
    }
    throw new Error(`Expected ${kind.name}`);
}
const sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
async function waitFor(condition: () => boolean) {
    const deadline = Date.now() + 5000;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for the storage notification");
        await sleep(10);
    }
    await sleep(10);
}
function content(text: string): FileData {
    return { data: [text], size: new TextEncoder().encode(text).length, ctime: 1000, mtime: 1000 };
}
function makePeer(baseDir: string, overrides: Partial<PeerStorageConf> = {}) {
    const dispatched: { path: string; data: FileData | false }[] = [];
    const peer = new PeerStorage(
        {
            type: "storage",
            name: crypto.randomUUID(),
            baseDir,
            pathNormalizationVersion: 1,
            handleFilenameCaseSensitive: true,
            ...overrides,
        },
        (_source, path, data) => {
            dispatched.push({ path, data });
            return Promise.resolve();
        },
    );
    peer.normalLog = () => {};
    peer.receiveLog = () => {};
    peer.sendLog = () => {};
    return { peer, dispatched };
}

Deno.test("NFC storage reads, updates, and deletes NFD names without renaming them", async () => {
    const root = await Deno.makeTempDir();
    const { peer } = makePeer(root);
    const folder = "Café".normalize("NFD");
    const leaf = "Résumé.md".normalize("NFD");
    try {
        await Deno.mkdir(join(root, folder));
        await Deno.writeTextFile(join(root, folder, leaf), "before");
        const entry = await peer.get("Café/Résumé.md");
        assert(entry !== false, "The existing file must be readable");
        equal(entry.data, ["before"], "The actual NFD file must supply the content");
        assert(await peer.put("Café/Résumé.md", content("updated")), "The update must be saved");
        equal(await Deno.readTextFile(join(root, folder, leaf)), "updated", "The original file must be updated");
        const names = [];
        for await (const entry of Deno.readDir(join(root, folder))) names.push(entry.name);
        equal(names, [leaf], "Normal writes must retain the native spelling");
        assert(await peer.delete("Café/Résumé.md"), "The original file must be removed");
        await rejects(() => Deno.stat(join(root, folder, leaf)), Deno.errors.NotFound);
    } finally {
        await peer.stop();
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("NFC storage checks collisions before cached repeats and permits a later valid retry", async () => {
    const root = await Deno.makeTempDir();
    const { peer } = makePeer(root);
    const native = "Résumé.md".normalize("NFD");
    try {
        await Deno.writeTextFile(join(root, native), "before");
        await peer.put("Résumé.md", content("accepted"));
        await Deno.writeTextFile(join(root, "Résumé.md"), "external");
        await rejects(() => peer.put("Résumé.md", content("accepted")), AmbiguousNormalisedPathError);
        await rejects(() => peer.delete("Résumé.md"), AmbiguousNormalisedPathError);
        equal(await Deno.readTextFile(join(root, native)), "accepted", "The first alias must be preserved");
        equal(await Deno.readTextFile(join(root, "Résumé.md")), "external", "The second alias must be preserved");
        await Deno.remove(join(root, native));
        assert(
            await peer.put("Résumé.md", content("accepted")),
            "A failed attempt must not acknowledge the later retry",
        );
        equal(await Deno.readTextFile(join(root, "Résumé.md")), "accepted", "The retry must update the remaining file");
    } finally {
        await peer.stop();
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("concurrent NFC-equivalent writes share one physical target", async () => {
    const root = await Deno.makeTempDir();
    const { peer } = makePeer(root);
    try {
        const native = "Résumé.md".normalize("NFD");
        const results = await Promise.all([
            peer.put("Résumé.md", content("first")),
            peer.put(native, content("second")),
        ]);
        equal(results, [true, true], "Both ordered writes must finish");
        const files = [];
        for await (const entry of Deno.readDir(root)) files.push(entry.name);
        equal(files.length, 1, "Equivalent requests must not create two aliases");
        equal(
            await Deno.readTextFile(join(root, files[0])),
            "second",
            "The later write must reach the existing target",
        );
    } finally {
        await peer.stop();
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("a spelling rename does not emit a logical deletion and retains the new deletion inventory", async () => {
    const root = await Deno.makeTempDir();
    const { peer, dispatched } = makePeer(root);
    const folder = "Café".normalize("NFD");
    const oldPath = join(root, folder, "note.md");
    const newFolder = join(root, "Café");
    try {
        await Deno.mkdir(join(root, folder));
        await Deno.writeTextFile(oldPath, "before");
        await peer.writeFileStat(`${folder}/note.md`);
        await Deno.rename(join(root, folder), newFolder);
        await Deno.writeTextFile(join(newFolder, "note.md"), "after rename");
        await peer.dispatchDeleted(oldPath);
        await waitFor(() => dispatched.some((entry) => entry.data !== false));
        assert(
            dispatched.every((entry) => entry.data !== false),
            "An equivalent live path must suppress the stale deletion",
        );
        const update = dispatched.find((entry) => entry.data !== false)?.data;
        assert(update !== false && update !== undefined, "The remaining file must be sent");
        equal(update.data, ["after rename"], "The renamed file's current bytes must be retained");
        dispatched.length = 0;
        await Deno.remove(newFolder, { recursive: true });
        peer.processFile({ kind: "remove", paths: [newFolder] });
        await waitFor(() => dispatched.some((entry) => entry.data === false));
        equal(
            dispatched.filter((entry) => entry.data === false).length,
            1,
            "The later parent deletion must still reach the hub",
        );
    } finally {
        await peer.stop();
        await sleep(300);
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("NFC file statistics survive restart without reusing Legacy observations", async () => {
    const root = await Deno.makeTempDir();
    const settings = new Map<string, string>();
    const peers: PeerStorage[] = [];
    const create = (version: 0 | 1) => {
        const { peer } = makePeer(root, { name: "observations", pathNormalizationVersion: version });
        peer.setSetting = (key, value) => {
            settings.set(peer._getKey(key), value);
        };
        peer.getSetting = (key) => settings.get(peer._getKey(key)) ?? null;
        peers.push(peer);
        return peer;
    };
    const native = "Résumé.md".normalize("NFD");
    try {
        await Deno.writeTextFile(join(root, native), "retained");
        const legacy = create(0);
        await legacy.writeFileStat(native);
        const nfc = create(1);
        assert(await nfc.isChanged("Résumé.md"), "Legacy statistics must not suppress a new NFC inventory");
        await nfc.writeFileStat(native);
        assert(!(await nfc.isChanged("Résumé.md")), "Equivalent NFC spelling must find the same observation");
        assert(!(await create(1).isChanged(native)), "A restarted NFC peer must retain its own statistics");
        assert(!(await create(0).isChanged(native)), "Legacy statistics must remain available");
    } finally {
        for (const peer of peers) await peer.stop();
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("NFC write failures propagate and do not acknowledge an unsaved retry", async () => {
    const root = await Deno.makeTempDir();
    const { peer } = makePeer(root);
    const path = join(root, "note.md");
    const originalOpen = Deno.open;
    try {
        await Deno.writeTextFile(path, "before");
        Deno.open = ((target: string | URL, options: Deno.OpenOptions) => {
            if (target === path) return Promise.reject(new Deno.errors.PermissionDenied("controlled write denial"));
            return originalOpen(target, options);
        }) as typeof Deno.open;
        await rejects(() => peer.put("note.md", content("after")), Deno.errors.PermissionDenied);
        equal(await Deno.readTextFile(path), "before", "A rejected open must preserve the existing bytes");
        Deno.open = originalOpen;
        assert(await peer.put("note.md", content("after")), "The same update must remain retryable");
        equal(await Deno.readTextFile(path), "after", "The retry must actually save the bytes");
    } finally {
        Deno.open = originalOpen;
        await peer.stop();
        await Deno.remove(root, { recursive: true });
    }
});

for (const useChokidar of [false, true]) {
    Deno.test(`NFC startup rejects existing aliases with ${useChokidar ? "Chokidar" : "Deno"}`, async () => {
        const root = await Deno.makeTempDir();
        const { peer } = makePeer(root, { useChokidar });
        try {
            await Deno.writeTextFile(join(root, "Résumé.md"), "first");
            await Deno.writeTextFile(join(root, "Résumé.md".normalize("NFD")), "second");
            await rejects(() => peer.start(), AmbiguousNormalisedPathError);
            assert(!peer.health().ok, "A rejected inventory must not report a healthy watcher");
            equal(await Deno.readTextFile(join(root, "Résumé.md")), "first", "The first alias must remain");
        } finally {
            await peer.stop();
            await Deno.remove(root, { recursive: true });
        }
    });
}

Deno.test("Legacy storage keeps exact spelling lookups", async () => {
    const root = await Deno.makeTempDir();
    const { peer } = makePeer(root, { pathNormalizationVersion: 0 });
    try {
        await Deno.writeTextFile(join(root, "Résumé.md".normalize("NFD")), "legacy");
        await rejects(() => peer.get("Résumé.md"), Deno.errors.NotFound);
    } finally {
        await peer.stop();
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("stopping an NFC watcher discards its queued file notification", async () => {
    const root = await Deno.makeTempDir();
    const { peer, dispatched } = makePeer(root);
    try {
        const path = join(root, "note.md");
        await Deno.writeTextFile(path, "retained");
        peer.watcherDeno = { close() {} } as unknown as Deno.FsWatcher;
        peer.processFile({ kind: "modify", paths: [path] });
        await peer.stop();
        await sleep(750);
        equal(dispatched, [], "A stopped watcher must not deliver its queued observation into a replacement owner");
        equal(await Deno.readTextFile(path), "retained", "Retiring the notification must preserve the file");
    } finally {
        await peer.stop();
        await sleep(300);
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("initial NFC Chokidar inventory is not reported as a healthy watcher", async () => {
    const root = await Deno.makeTempDir();
    const { peer } = makePeer(root, { useChokidar: true });
    const originalReadDir = Deno.readDir;
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    Deno.readDir = ((path: string | URL) => {
        if (path !== root) return originalReadDir(path);
        return {
            async *[Symbol.asyncIterator]() {
                started.resolve();
                await release.promise;
                yield* originalReadDir(path);
            },
        };
    }) as typeof Deno.readDir;
    let pending: Promise<void> | undefined;
    try {
        pending = peer.start();
        await started.promise;
        const duringInventory = peer.health().ok;
        release.resolve();
        await pending;
        assert(!duringInventory, "The initial inventory must complete before the watcher is healthy");
        assert(peer.health().ok, "A completed inventory must permit normal watcher health");
    } finally {
        release.resolve();
        Deno.readDir = originalReadDir;
        await pending?.catch(() => {});
        await peer.stop();
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("stopping an NFC Chokidar watcher discards an in-flight change callback", async () => {
    const root = await Deno.makeTempDir();
    const { peer, dispatched } = makePeer(root, { useChokidar: true });
    try {
        const path = join(root, "note.md");
        await Deno.writeTextFile(path, "retained");
        await peer.start();
        assert(peer.watcher, "The Chokidar watcher must be installed");
        peer.watcher.emit("change", path);
        await peer.stop();
        await sleep(750);
        equal(dispatched, [], "A stopped callback must not notify a replacement owner");
        equal(await Deno.readTextFile(path), "retained", "The local content must remain");
    } finally {
        await peer.stop();
        await sleep(300);
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("NFC notifications retain peer-relative folders which match the configured base directory name", async () => {
    const root = await Deno.makeTempDir();
    const previousDirectory = Deno.cwd();
    Deno.chdir(root);
    const { peer, dispatched } = makePeer("vault");
    try {
        const path = join(root, "vault", "vault", "note.md");
        await Deno.mkdir(join(root, "vault", "vault"), { recursive: true });
        await Deno.writeTextFile(path, "retained");
        await peer.dispatch(path);
        await waitFor(() => dispatched.length === 1);
        equal(dispatched[0].path, "vault/note.md", "A path which is already relative must not lose another prefix");
    } finally {
        await peer.stop();
        await sleep(300);
        Deno.chdir(previousDirectory);
        await Deno.remove(root, { recursive: true });
    }
});

Deno.test("an already absent NFC deletion permits the same bytes to be recreated", async () => {
    const root = await Deno.makeTempDir();
    const { peer, dispatched } = makePeer(root);
    try {
        const path = join(root, "note.md");
        await peer.put("note.md", content("retained"));
        await Deno.remove(path);
        await peer.delete("note.md");
        await Deno.writeTextFile(path, "retained");
        await peer.dispatch(path);
        await waitFor(() => dispatched.some((entry) => entry.data !== false));
        const update = dispatched.find((entry) => entry.data !== false)?.data;
        assert(update !== false && update !== undefined, "The recreated file must be sent");
        equal(update.data, ["retained"], "Old cache contents must not suppress a new creation");
    } finally {
        await peer.stop();
        await sleep(300);
        await Deno.remove(root, { recursive: true });
    }
});
