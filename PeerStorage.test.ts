import chokidar from "chokidar";
import { basename, join } from "@std/path";
import { LOG_LEVEL_NOTICE } from "octagonal-wheels/common/logger";
import { serialized } from "octagonal-wheels/concurrency/lock";
import { PeerStorage } from "./PeerStorage.ts";
import type { FileData, PeerStorageConf } from "./types.ts";

function assertEquals<T>(actual: T, expected: T, message: string) {
    if (actual !== expected) {
        throw new Error(`${message}\nactual=${String(actual)}\nexpected=${String(expected)}`);
    }
}

function assert(condition: unknown, message: string) {
    if (!condition) throw new Error(message);
}

function makePeer(baseDir: string, useChokidar = false) {
    const config: PeerStorageConf = {
        type: "storage",
        name: `test-peer-${crypto.randomUUID()}`,
        baseDir,
        scanOfflineChanges: false,
        useChokidar,
    };
    return new PeerStorage(config, async () => {});
}

// A peer which records everything it hands to the hub, so a test can tell an
// ignored path (never dispatched) from a synchronised one.
function makeRecordingPeer(baseDir: string, extra: Partial<PeerStorageConf> = {}) {
    const dispatched: { path: string, data: FileData | false }[] = [];
    const config: PeerStorageConf = {
        type: "storage",
        name: `test-peer-${crypto.randomUUID()}`,
        baseDir,
        scanOfflineChanges: false,
        useChokidar: false,
        ...extra,
    };
    const peer = new PeerStorage(config, (_source, path, data) => {
        dispatched.push({ path, data });
        return Promise.resolve();
    });
    return { peer, dispatched };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The dispatch path debounces and delays, so the assertions have to wait for it.
async function waitFor(condition: () => boolean, message: string, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`Timed out while waiting: ${message}`);
        await sleep(10);
    }
}

// Records every path which is stat()ed, to prove that ignored trees are pruned
// before anything touches the files in them.
function recordStatPaths() {
    const originalStat = Deno.stat;
    const paths: string[] = [];
    Deno.stat = ((path: string | URL, ...rest: unknown[]) => {
        paths.push((typeof path === "string" ? path : path.pathname).replaceAll("\\", "/"));
        return (originalStat as (...args: unknown[]) => Promise<Deno.FileInfo>)(path, ...rest);
    }) as typeof Deno.stat;
    return {
        paths,
        restore() {
            Deno.stat = originalStat;
        },
    };
}

async function makeVaultWithIgnorableTrees(tempDir: string) {
    await Deno.mkdir(join(tempDir, ".git", "objects", "aa"), { recursive: true });
    await Deno.writeTextFile(join(tempDir, ".git", "objects", "aa", "deadbeef"), "object");
    await Deno.writeTextFile(join(tempDir, ".git", "config"), "[core]");
    await Deno.mkdir(join(tempDir, "node_modules", "pkg"), { recursive: true });
    await Deno.writeTextFile(join(tempDir, "node_modules", "pkg", "index.js"), "module");
    await Deno.mkdir(join(tempDir, "notes"), { recursive: true });
    await Deno.writeTextFile(join(tempDir, "notes", "keep.md"), "keep");
    // Not ignored by `**/.git/**`: guards against the pattern over-matching.
    await Deno.writeTextFile(join(tempDir, ".gitignore"), "node_modules");
}

const IGNORE_PATTERNS = ["**/.git/**", "node_modules/**"];

function assertNothingTouchedIn(statPaths: string[], message: string) {
    const touched = statPaths.filter((path) => path.includes("/.git/") || path.includes("/node_modules/"));
    assertEquals(touched.join(","), "", message);
}

class ControlledDenoWatcher implements AsyncIterator<Deno.FsEvent>, AsyncIterable<Deno.FsEvent> {
    private readonly result: Promise<IteratorResult<Deno.FsEvent>>;
    private resolveResult!: (result: IteratorResult<Deno.FsEvent>) => void;
    private rejectResult!: (reason: unknown) => void;
    closeCalls = 0;

    constructor() {
        this.result = new Promise((resolve, reject) => {
            this.resolveResult = resolve;
            this.rejectResult = reject;
        });
    }

    next() {
        return this.result;
    }

    [Symbol.asyncIterator]() {
        return this;
    }

    finish() {
        this.resolveResult({ done: true, value: undefined });
    }

    fail(error: unknown) {
        this.rejectResult(error);
    }

    close() {
        this.closeCalls += 1;
        this.finish();
    }

    [Symbol.dispose]() {
        this.close();
    }
}

Deno.test("PeerStorage Deno watcher clears health after normal end and error", async () => {
    const originalWatchFs = Deno.watchFs;
    const watchers: ControlledDenoWatcher[] = [];
    Deno.watchFs = (() => {
        const watcher = new ControlledDenoWatcher();
        watchers.push(watcher);
        return watcher as unknown as Deno.FsWatcher;
    }) as typeof Deno.watchFs;

    const tempDir = await Deno.makeTempDir({ prefix: "peer-storage-test-" });
    try {
        const endedPeer = makePeer(tempDir);
        const ended = endedPeer.startDenoFsWatch();
        assertEquals(watchers.length, 1, "Deno watcher should be created");
        await waitForDenoWatch(endedPeer);
        assert(endedPeer.health().ok, "Deno watcher should be healthy while running");

        watchers[0].finish();
        await ended;
        assert(!endedPeer.health().ok, "normal Deno watcher end should make health false");

        const failedPeer = makePeer(tempDir);
        const failed = failedPeer.startDenoFsWatch().catch(() => undefined);
        assertEquals(watchers.length, 2, "second Deno watcher should be created");
        await waitForDenoWatch(failedPeer);
        watchers[1].fail(new Error("controlled watcher failure"));
        await failed;
        assert(!failedPeer.health().ok, "Deno watcher error should make health false");
    } finally {
        Deno.watchFs = originalWatchFs;
        await Deno.remove(tempDir, { recursive: true });
    }
});

Deno.test("PeerStorage Deno watcher does not clear a newer concurrent watcher", async () => {
    const originalWatchFs = Deno.watchFs;
    const watchers: ControlledDenoWatcher[] = [];
    Deno.watchFs = (() => {
        const watcher = new ControlledDenoWatcher();
        watchers.push(watcher);
        return watcher as unknown as Deno.FsWatcher;
    }) as typeof Deno.watchFs;

    const tempDir = await Deno.makeTempDir({ prefix: "peer-storage-test-" });
    try {
        const peer = makePeer(tempDir);
        const first = peer.startDenoFsWatch().catch(() => undefined);
        const second = peer.startDenoFsWatch().catch(() => undefined);
        await waitFor(() => watchers.length === 2, "Restart should create a new watcher after draining the old one");
        assertEquals(watchers.length, 2, "concurrent start should create two Deno watchers");

        await waitForDenoWatch(peer);
        watchers[0].finish();
        await first;
        assertEquals(peer.watcherDeno, watchers[1], "old watcher completion must not clear the newer watcher");
        assert(peer.health().ok, "newer Deno watcher should remain healthy");

        watchers[1].finish();
        await second;
        assert(!peer.health().ok, "health should be false after the current watcher ends");
    } finally {
        Deno.watchFs = originalWatchFs;
        await Deno.remove(tempDir, { recursive: true });
    }
});


Deno.test("PeerStorage opens only the newest Deno watcher when a restart is superseded during delivery drain", async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "peer-storage-restart-supersede-" });
    const originalWatchFs = Deno.watchFs;
    const watchers: ControlledDenoWatcher[] = [];
    const peer = makePeer(tempDir);
    const releaseDispatch = Promise.withResolvers<void>();
    const startTasks: Promise<void>[] = [];
    const stopTasks: Promise<void>[] = [];
    const startErrors: unknown[] = [];
    let pendingStarts = 0;
    let dispatchEntered = false;
    let dispatchCompleted = false;
    let supersededStartDone = false;
    let newestStartDone = false;
    peer.dispatchToHub = async () => {
        dispatchEntered = true;
        await releaseDispatch.promise;
        dispatchCompleted = true;
    };

    const beginStart = (onSettled: () => void) => {
        pendingStarts++;
        const task = peer.startDenoFsWatch().then(
            () => { pendingStarts--; onSettled(); },
            (error) => { pendingStarts--; startErrors.push(error); onSettled(); },
        );
        startTasks.push(task);
        return task;
    };
    const beginStop = (onSettled: () => void) => {
        const task = peer.stop().then(
            () => { onSettled(); },
            (error) => { startErrors.push(error); onSettled(); },
        );
        stopTasks.push(task);
        return task;
    };

    try {
        Deno.watchFs = (() => {
            const watcher = new ControlledDenoWatcher();
            watchers.push(watcher);
            return watcher as unknown as Deno.FsWatcher;
        }) as typeof Deno.watchFs;

        const initialStartDone = { value: false };
        const initialStart = beginStart(() => { initialStartDone.value = true; });
        await waitFor(() => watchers.length === 1, "the initial Deno watcher should be created");
        await waitForDenoWatch(peer);

        const path = join(tempDir, "accepted.md");
        await Deno.writeTextFile(path, "held delivery");
        await peer.dispatch(path);
        await waitFor(() => dispatchEntered, "the real file dispatch should enter the held Hub callback");

        const supersededStart = beginStart(() => { supersededStartDone = true; });
        await waitFor(() => watchers[0].closeCalls > 0 && peer.watcherDeno === undefined,
            "the older restart should close the current watcher before waiting for delivery");
        await initialStart;
        assert(initialStartDone.value, "the initial watcher start should finish after its watcher closes");
        assert(!supersededStartDone, "the older restart should remain pending while delivery is held");

        const newestStart = beginStart(() => { newestStartDone = true; });
        await sleep(20);
        assertEquals(watchers.length, 1, "no restart should reopen a watcher before the accepted delivery drains");

        releaseDispatch.resolve();
        await waitFor(() => supersededStartDone, "the superseded restart should settle without opening a watcher");
        await waitFor(() => watchers.length === 2 && peer.watcherDeno === watchers[1] && peer.health().ok,
            "only the newest start request should open the live watcher");
        assertEquals(watchers.length, 2, "the initial and newest watcher should be the only watchers created");
        assertEquals(peer.watcherDeno, watchers[1], "the newest request should own the only live watcher");
        assert(dispatchCompleted, "the accepted file delivery should finish before the newest watcher starts");
        assert(!newestStartDone, "the newest start should remain active while its watcher is live");
        assertEquals(startErrors.length, 0, "all watcher start requests should finish without errors");

        watchers[1].close();
        await Promise.all([initialStart, supersededStart, newestStart]);
        assert(newestStartDone, "closing the newest watcher should finish its start request");
    } finally {
        releaseDispatch.resolve();
        // A failed assertion can leave a superseded request opening a watcher during cleanup.
        while (pendingStarts > 0) {
            for (const watcher of watchers) watcher.close();
            await sleep(10);
        }
        for (const watcher of watchers) watcher.close();
        const cleanupStop = beginStop(() => {});
        await Promise.allSettled([...startTasks, ...stopTasks, cleanupStop]);
        Deno.watchFs = originalWatchFs;
        await Deno.remove(tempDir, { recursive: true });
    }
});

Deno.test("PeerStorage stop cancels a Deno watcher restart that is waiting for delivery drain", async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "peer-storage-restart-stop-" });
    const originalWatchFs = Deno.watchFs;
    const watchers: ControlledDenoWatcher[] = [];
    const peer = makePeer(tempDir);
    const releaseDispatch = Promise.withResolvers<void>();
    const startTasks: Promise<void>[] = [];
    const stopTasks: Promise<void>[] = [];
    const startErrors: unknown[] = [];
    let pendingStarts = 0;
    let dispatchEntered = false;
    let dispatchCompleted = false;
    let restartDone = false;
    let stopDone = false;
    peer.dispatchToHub = async () => {
        dispatchEntered = true;
        await releaseDispatch.promise;
        dispatchCompleted = true;
    };

    const beginStart = (onSettled: () => void) => {
        pendingStarts++;
        const task = peer.startDenoFsWatch().then(
            () => { pendingStarts--; onSettled(); },
            (error) => { pendingStarts--; startErrors.push(error); onSettled(); },
        );
        startTasks.push(task);
        return task;
    };
    const beginStop = (onSettled: () => void) => {
        const task = peer.stop().then(
            () => { onSettled(); },
            (error) => { startErrors.push(error); onSettled(); },
        );
        stopTasks.push(task);
        return task;
    };

    try {
        Deno.watchFs = (() => {
            const watcher = new ControlledDenoWatcher();
            watchers.push(watcher);
            return watcher as unknown as Deno.FsWatcher;
        }) as typeof Deno.watchFs;

        const initialStart = beginStart(() => {});
        await waitFor(() => watchers.length === 1, "the initial Deno watcher should be created");
        await waitForDenoWatch(peer);

        const path = join(tempDir, "accepted.md");
        await Deno.writeTextFile(path, "held delivery");
        await peer.dispatch(path);
        await waitFor(() => dispatchEntered, "the real file dispatch should enter the held Hub callback");

        const restart = beginStart(() => { restartDone = true; });
        await waitFor(() => watchers[0].closeCalls > 0 && peer.watcherDeno === undefined,
            "the restart should close the current watcher before waiting for delivery");
        await initialStart;
        assert(!restartDone, "the restart should remain pending while delivery is held");

        const stopping = beginStop(() => { stopDone = true; });
        await sleep(20);
        assert(!stopDone, "stop() should wait for the accepted delivery");
        assertEquals(watchers.length, 1, "stop during the pending restart should not open another watcher");

        releaseDispatch.resolve();
        await waitFor(() => restartDone && stopDone,
            "stop should invalidate the pending restart after the accepted delivery drains");
        await Promise.all([initialStart, restart, stopping]);
        assert(dispatchCompleted, "the accepted file delivery should complete before stop resolves");
        assertEquals(watchers.length, 1, "the cancelled restart must not create another watcher");
        assertEquals(peer.watcherDeno, undefined, "stop must leave no Deno watcher open");
        assert(!peer.health().ok, "the stopped peer should remain unhealthy after the restart drains");
        assertEquals(startErrors.length, 0, "the start and stop requests should finish without errors");
    } finally {
        releaseDispatch.resolve();
        while (pendingStarts > 0) {
            for (const watcher of watchers) watcher.close();
            await sleep(10);
        }
        for (const watcher of watchers) watcher.close();
        const cleanupStop = beginStop(() => {});
        await Promise.allSettled([...startTasks, ...stopTasks, cleanupStop]);
        Deno.watchFs = originalWatchFs;
        await Deno.remove(tempDir, { recursive: true });
    }
});

type ChokidarHandler = (...args: unknown[]) => unknown;

class ControlledChokidarWatcher {
    private readonly handlers = new Map<string, ChokidarHandler[]>();
    private readonly closePromise: Promise<void>;
    private resolveClose!: () => void;
    closeCalls = 0;
    closeResolved = false;
    unhandledErrors: unknown[] = [];

    constructor() {
        this.closePromise = new Promise((resolve) => {
            this.resolveClose = () => {
                this.closeResolved = true;
                resolve();
            };
        });
    }

    on(event: string, handler: ChokidarHandler) {
        const handlers = this.handlers.get(event) ?? [];
        handlers.push(handler);
        this.handlers.set(event, handlers);
        return this;
    }

    emit(event: string, ...args: unknown[]) {
        const handlers = this.handlers.get(event) ?? [];
        if (event === "error" && handlers.length === 0) {
            this.unhandledErrors.push(args[0]);
            return;
        }
        for (const handler of handlers) {
            handler(...args);
        }
    }

    async emitAsync(event: string, ...args: unknown[]) {
        const handlers = this.handlers.get(event) ?? [];
        assert(handlers.length > 0, `${event} handler should be registered`);
        for (const handler of handlers) {
            await handler(...args);
        }
    }

    close() {
        this.closeCalls += 1;
        return this.closePromise;
    }

    finishClose() {
        this.resolveClose();
    }
}

Deno.test("PeerStorage Chokidar error clears health and stop waits for close", async () => {
    const originalWatch = chokidar.watch;
    const watchers: ControlledChokidarWatcher[] = [];
    chokidar.watch = (() => {
        const watcher = new ControlledChokidarWatcher();
        watchers.push(watcher);
        return watcher as unknown as ReturnType<typeof chokidar.watch>;
    }) as typeof chokidar.watch;

    const tempDir = await Deno.makeTempDir({ prefix: "peer-storage-test-" });
    try {
        const failedPeer = makePeer(tempDir, true);
        await failedPeer.start();
        assertEquals(watchers.length, 1, "Chokidar watcher should be created");
        watchers[0].emit("error", new Error("controlled watcher failure"));
        assert(!failedPeer.health().ok, "Chokidar watcher error should make health false");
        assertEquals(watchers[0].unhandledErrors.length, 0, "Chokidar watcher error must be handled");
        assertEquals(watchers[0].closeCalls, 1, "Chokidar watcher error should close the failed watcher");
        watchers[0].finishClose();
        await Promise.resolve();
        assert(watchers[0].closeResolved, "failed Chokidar watcher cleanup should complete");

        const stoppedPeer = makePeer(tempDir, true);
        await stoppedPeer.start();
        assertEquals(watchers.length, 2, "second Chokidar watcher should be created");
        const stopping = stoppedPeer.stop();
        assert(!stoppedPeer.health().ok, "stop should clear Chokidar health immediately");
        assertEquals(watchers[1].closeCalls, 1, "stop should close the Chokidar watcher");
        assert(!watchers[1].closeResolved, "stop should wait for Chokidar close to complete");

        watchers[1].finishClose();
        await stopping;
        assert(watchers[1].closeResolved, "stop should resolve after Chokidar close completes");
        await stoppedPeer.stop();
        assertEquals(watchers[1].closeCalls, 1, "stopping twice should not close an already released watcher");
    } finally {
        chokidar.watch = originalWatch;
        await Deno.remove(tempDir, { recursive: true });
    }
});

function makeWritePeer(baseDir: string) {
    const peer = makePeer(baseDir);
    const settings = new Map<string, string>();
    peer.setSetting = (key, value) => {
        settings.set(key, value);
    };
    peer.getSetting = (key) => settings.get(key) ?? null;
    const notices: string[] = [];
    peer.normalLog = (message, level) => {
        if (level === LOG_LEVEL_NOTICE) notices.push(message);
    };
    return { peer, notices };
}

function emptyFileData(data: FileData["data"], size = 0): FileData {
    return { ctime: 1_700_000_000_000, mtime: 1_700_000_002_000, size, data };
}

function textFileData(text: string): FileData {
    return { ctime: 1_700_000_000_000, mtime: 1_700_000_002_000, size: text.length, data: [text] };
}

const emptyFormats = [
    { name: "text", filename: "note.md", empty: () => [""] },
    { name: "text with no chunks", filename: "note.md", empty: () => [] },
    { name: "binary", filename: "attachment.docx", empty: () => new Uint8Array(0) },
];

for (const format of emptyFormats) {
    Deno.test(`PeerStorage accepts an intentional empty ${format.name} edit`, async () => {
        const tempDir = await Deno.makeTempDir({ prefix: "peer-storage-empty-edit-" });
        try {
            const { peer, notices } = makeWritePeer(tempDir);
            const path = `${tempDir}/${format.filename}`;
            await Deno.writeTextFile(path, "previous content");

            const data = emptyFileData(format.empty());
            const saved = await peer.put(format.filename, data);

            assertEquals((await Deno.stat(path)).size, 0, "The destination should contain the empty edit");
            assertEquals(saved, true, "A valid edit to an empty file should be saved");
            assertEquals((await Deno.stat(path)).mtime?.getTime(), data.mtime, "The empty edit should update the modification time");
            assertEquals(notices.length, 0, "A valid empty edit should not be blocked");
        } finally {
            await Deno.remove(tempDir, { recursive: true });
        }
    });

    Deno.test(`PeerStorage creates a new empty ${format.name} file`, async () => {
        const tempDir = await Deno.makeTempDir({ prefix: "peer-storage-empty-new-" });
        try {
            const { peer } = makeWritePeer(tempDir);
            const saved = await peer.put(format.filename, emptyFileData(format.empty()));
            assertEquals(saved, true, "A new empty file should be created");
            assertEquals((await Deno.stat(`${tempDir}/${format.filename}`)).size, 0, "The new file should be empty");
        } finally {
            await Deno.remove(tempDir, { recursive: true });
        }
    });

    Deno.test(`PeerStorage preserves existing content for an empty ${format.name} payload with nonzero metadata`, async () => {
        const tempDir = await Deno.makeTempDir({ prefix: "peer-storage-empty-mismatch-" });
        try {
            const { peer, notices } = makeWritePeer(tempDir);
            const path = `${tempDir}/${format.filename}`;
            await Deno.writeTextFile(path, "previous content");
            const originalMtime = (await Deno.stat(path)).mtime?.getTime();

            const saved = await peer.put(format.filename, emptyFileData(format.empty(), 16));

            assertEquals(saved, false, "An empty payload should be rejected when non-empty content is expected");
            assertEquals(await Deno.readTextFile(path), "previous content", "The previous content should be preserved");
            assertEquals((await Deno.stat(path)).mtime?.getTime(), originalMtime, "A blocked write should preserve the modification time");
            assertEquals(notices.length, 1, "A rejected write should produce a notice");
        } finally {
            await Deno.remove(tempDir, { recursive: true });
        }
    });

    Deno.test(`PeerStorage accepts an intentional empty ${format.name} edit after a mismatched empty payload`, async () => {
        const tempDir = await Deno.makeTempDir({ prefix: "peer-storage-empty-recovery-" });
        try {
            const { peer } = makeWritePeer(tempDir);
            const path = `${tempDir}/${format.filename}`;
            await Deno.writeTextFile(path, "previous content");

            const blocked = await peer.put(format.filename, emptyFileData(format.empty(), 16));
            assertEquals(blocked, false, "The mismatched payload should be blocked first");
            const intentionalEdit = emptyFileData(format.empty());
            intentionalEdit.mtime += 2000;
            const saved = await peer.put(format.filename, intentionalEdit);

            assertEquals((await Deno.stat(path)).size, 0, "A later valid empty edit should reach the destination");
            assertEquals(saved, true, "The valid edit should not be mistaken for a repeated blocked write");
        } finally {
            await Deno.remove(tempDir, { recursive: true });
        }
    });
}

Deno.test("PeerStorage accepts a non-empty replacement", async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "peer-storage-replacement-" });
    try {
        const { peer } = makeWritePeer(tempDir);
        const path = `${tempDir}/note.md`;
        await Deno.writeTextFile(path, "previous content");
        const saved = await peer.put("note.md", {
            ctime: 1_700_000_000_000,
            mtime: 1_700_000_002_000,
            size: 3,
            data: ["new"],
        });
        assertEquals(saved, true, "A non-empty replacement should be saved");
        assertEquals(await Deno.readTextFile(path), "new", "The previous content should be replaced exactly");
    } finally {
        await Deno.remove(tempDir, { recursive: true });
    }
});

Deno.test("PeerStorage logs each rejected empty write with its reported size", async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "peer-storage-empty-notices-" });
    try {
        const { peer, notices } = makeWritePeer(tempDir);
        const path = `${tempDir}/note.md`;
        await Deno.writeTextFile(path, "previous content");
        const data = emptyFileData([], 16);

        assertEquals(await peer.put("note.md", data), false, "The first empty write should be blocked");
        assertEquals(await peer.put("note.md", data), false, "The second empty write should be blocked");
        assertEquals(notices.length, 2, "Each rejected input should produce a notice");
        assert(notices.every((message) => message.includes("16 bytes reported")), "Notices should include the reported size");
        assertEquals(await Deno.readTextFile(path), "previous content", "Repeated blocked writes should preserve the content");
    } finally {
        await Deno.remove(tempDir, { recursive: true });
    }
});

for (const [name, toBaseDir] of [
    ["an absolute base directory", (dir: string) => `${dir}/`],
    ["a ./ base directory", (dir: string) => `./${basename(dir)}/`],
] as const) {
    Deno.test(`PeerStorage does not send its own writes and deletions back to the hub with ${name}`, async () => {
        const tempDir = await Deno.makeTempDir({ dir: Deno.cwd(), prefix: "peer-storage-echo-" });
        try {
            const { peer } = makeWritePeer(toBaseDir(tempDir));
            const dispatched: string[] = [];
            peer.dispatchToHub = (_source, path) => {
                dispatched.push(path);
                return Promise.resolve();
            };
            const paths = ["note.md", "a/b/note.md", "_templates/note.md"];
            // The watcher reports paths with the platform separator.
            const watchedPath = (path: string) => join(tempDir, ...path.split("/"));

            for (const path of paths) {
                assertEquals(await peer.put(path, textFileData("text")), true, `${path} should be saved`);
                await peer.dispatch(watchedPath(path));
            }
            // dispatch() checks for repeats after 250 ms.
            await new Promise((resolve) => setTimeout(resolve, 400));
            for (const path of paths) {
                assertEquals(await peer.delete(path), true, `${path} should be deleted`);
                await peer.dispatchDeleted(watchedPath(path));
            }

            assertEquals(dispatched.join(", "), "", "Received changes should not be sent back to the hub");
        } finally {
            await Deno.remove(tempDir, { recursive: true });
        }
    });
}

Deno.test("PeerStorage forwards local edits after suppressing a received nested write", async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "peer-storage-local-edit-" });
    try {
        const { peer } = makeWritePeer(tempDir);
        const filename = "_templates/a/note.md";
        const path = join(tempDir, ...filename.split("/"));
        const dispatched: string[] = [];
        peer.dispatchToHub = (_source, path) => {
            dispatched.push(path);
            return Promise.resolve();
        };

        assertEquals(await peer.put(filename, textFileData("text")), true, "The received file should be saved");
        await peer.dispatch(path);
        await new Promise((resolve) => setTimeout(resolve, 400));
        assertEquals(dispatched.length, 0, "The received write should be suppressed");

        await Deno.writeTextFile(path, "local edit");
        await peer.dispatch(path);
        await new Promise((resolve) => setTimeout(resolve, 400));
        assertEquals(dispatched.join(", "), filename, "A later local edit should reach the hub");
    } finally {
        await Deno.remove(tempDir, { recursive: true });
    }
});

type ChokidarUnlinkFixture = {
    path: string;
    watcher: ControlledChokidarWatcher;
    dispatched: { path: string; data: FileData | false }[];
    messages: string[];
};

async function withChokidarUnlinkFixture(check: (fixture: ChokidarUnlinkFixture) => Promise<void>) {
    const originalWatch = chokidar.watch;
    const originalStat = Deno.stat;
    const tempDir = await Deno.makeTempDir({ prefix: "peer-storage-unlink-test-" });
    const path = `${tempDir}/note.md`;
    const watcher = new ControlledChokidarWatcher();
    const dispatched: ChokidarUnlinkFixture["dispatched"] = [];
    const messages: string[] = [];
    const peer = makePeer(tempDir, true);
    peer.dispatchToHub = (_source, path, data) => {
        dispatched.push({ path, data });
        return Promise.resolve();
    };
    peer.normalLog = (message) => { messages.push(message); };
    chokidar.watch = (() => watcher as unknown as ReturnType<typeof chokidar.watch>) as typeof chokidar.watch;
    try {
        await Deno.writeTextFile(path, "still present");
        await peer.start();
        messages.length = 0;
        await check({ path, watcher, dispatched, messages });
    } finally {
        Deno.stat = originalStat;
        chokidar.watch = originalWatch;
        watcher.finishClose();
        await peer.stop();
        await Deno.remove(tempDir, { recursive: true });
    }
}

Deno.test("PeerStorage Chokidar unlink preserves an existing file", async () => {
    await withChokidarUnlinkFixture(async ({ path, watcher, dispatched }) => {
        await watcher.emitAsync("unlink", path);
        assertEquals(await Deno.readTextFile(path), "still present", "source file should remain present");
        assertEquals(dispatched.length, 0, "an existing file should not cause a hub deletion");
    });
});

Deno.test("PeerStorage Chokidar unlink dispatches a confirmed deletion", async () => {
    await withChokidarUnlinkFixture(async ({ path, watcher, dispatched }) => {
        await Deno.remove(path);
        await watcher.emitAsync("unlink", path);
        assertEquals(dispatched.length, 1, "a real deletion should reach the hub once");
        assertEquals(dispatched[0].path, "note.md", "deletion should use the global path");
        assertEquals(dispatched[0].data, false, "hub notification should carry the deletion marker");
    });
});

for (const [name, error] of [
    ["permission", new Deno.errors.PermissionDenied("controlled permission failure")],
    ["I/O", new Error("controlled I/O failure")],
] as const) {
    Deno.test(`PeerStorage Chokidar unlink preserves files after a stat ${name} error`, async () => {
        await withChokidarUnlinkFixture(async ({ path, watcher, dispatched, messages }) => {
            const originalStat = Deno.stat;
            let statCalls = 0;
            Deno.stat = ((statPath: string | URL) => {
                if (statPath === path) {
                    statCalls += 1;
                    return Promise.reject(error);
                }
                return originalStat(statPath);
            }) as typeof Deno.stat;
            await watcher.emitAsync("unlink", path);
            Deno.stat = originalStat;
            assertEquals(await Deno.readTextFile(path), "still present", "a stat error should leave the source file present");
            assertEquals(dispatched.length, 0, "a stat error should not cause a hub deletion");
            assertEquals(statCalls, 1, "the handler should check the event path");
            assert(messages.some((message) => message.includes("note.md")), "the failed check should be logged with its path");
        });
    });
}

Deno.test("PeerStorage converts every Windows separator to a vault path", () => {
    const peer = makePeer("vault/");
    peer.pathSeparator = "\\";
    assertEquals(peer.toPosixPath("note.md"), "note.md", "A top-level file should stay as it is");
    assertEquals(peer.toPosixPath("a\\note.md"), "a/note.md", "One folder should be converted");
    assertEquals(peer.toPosixPath("a\\b\\c\\note.md"), "a/b/c/note.md",
        "Every separator should be converted, not only the last one");
    assertEquals(peer.toPosixPath("_attachments\\a\\image.png"), "_attachments/a/image.png",
        "A leading underscore should be preserved");
});

Deno.test("PeerStorage keeps POSIX paths unchanged", () => {
    const peer = makePeer("vault/");
    peer.pathSeparator = "/";
    for (const path of ["note.md", "a/b/c/note.md", "_attachments/a/image.png"]) {
        assertEquals(peer.toPosixPath(path), path, `${path} should stay as it is`);
        assertEquals(peer.isUnsafeVaultPath(path), false, `${path} should be accepted`);
    }
    assertEquals(peer.isUnsafeVaultPath("a\\b.md"), false, "A backslash in a file name should be accepted");
});

Deno.test("PeerStorage on Windows skips writes and deletions of paths with a backslash", async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "peer-storage-windows-path-" });
    try {
        const { peer, notices } = makeWritePeer(tempDir);
        peer.pathSeparator = "\\";
        await Deno.mkdir(`${tempDir}/a/b`, { recursive: true });
        await Deno.writeTextFile(`${tempDir}/a/b/note.md`, "real note");

        const deleted = await peer.delete("a\\b/note.md");
        const saved = await peer.put("a\\b/other.md", textFileData("text"));

        assertEquals(deleted, false, "A deletion of a path with a backslash should be skipped");
        assertEquals(saved, false, "A write of a path with a backslash should be skipped");
        assertEquals(await Deno.readTextFile(`${tempDir}/a/b/note.md`), "real note", "The real note should stay");
        assertEquals(notices.length, 2, "Each skipped path should produce a notice");
        assert(notices[0].startsWith("Delete skipped: "), "The deletion should be skipped by the path check");
        assert(notices[1].startsWith("Write skipped: "), "The write should be skipped by the path check");
    } finally {
        await Deno.remove(tempDir, { recursive: true });
    }
});

Deno.test("PeerStorage ignores changes outside its base directory", async () => {
    const vaultDir = await Deno.makeTempDir({ prefix: "peer-storage-outside-" });
    try {
        await Deno.mkdir(`${vaultDir}/Daily`);
        await Deno.mkdir(`${vaultDir}/Other`);
        await Deno.writeTextFile(`${vaultDir}/Other/present.md`, "text");
        const { peer } = makeWritePeer(`${vaultDir}/Daily/`);
        const dispatched: string[] = [];
        peer.dispatchToHub = (_source, path) => {
            dispatched.push(path);
            return Promise.resolve();
        };

        // what a watcher of another folder reports, e.g. Deno 2.6.9 handing on a remove event
        await peer.dispatchDeleted(`${vaultDir}/Other/gone.md`);
        await peer.dispatch(`${vaultDir}/Other/present.md`);
        // dispatch() checks for repeats after 250 ms
        await new Promise((resolve) => setTimeout(resolve, 400));

        assertEquals(dispatched.join(", "), "", "A change outside the base directory should not reach the hub");
    } finally {
        await Deno.remove(vaultDir, { recursive: true });
    }
});

for (const kind of ["change", "deletion"] as const) {
    Deno.test({
        name: `PeerStorage dispatches a POSIX backslash filename on ${kind}`,
        ignore: Deno.build.os === "windows",
        async fn() {
            const tempDir = await Deno.makeTempDir({ prefix: "peer-storage-posix-backslash-" });
            try {
                const filename = "..\\draft.md";
                const path = join(tempDir, filename);
                const { peer } = makeWritePeer(tempDir);
                const dispatched: { path: string; deleted: boolean }[] = [];
                peer.dispatchToHub = (_source, path, data) => {
                    dispatched.push({ path, deleted: data === false });
                    return Promise.resolve();
                };
                await Deno.writeTextFile(path, "draft");

                if (kind === "deletion") {
                    await Deno.remove(path);
                    await peer.dispatchDeleted(path);
                } else {
                    await peer.dispatch(path);
                    // dispatch() checks for repeats after 250 ms.
                    await new Promise((resolve) => setTimeout(resolve, 400));
                }

                assertEquals(dispatched.length, 1, "A filename inside baseDir should reach the hub");
                assertEquals(dispatched[0].path, filename, "A POSIX backslash should stay part of the filename");
                assertEquals(dispatched[0].deleted, kind === "deletion", "The event should keep its change or deletion kind");
            } finally {
                await Deno.remove(tempDir, { recursive: true });
            }
        },
    });
}

Deno.test("PeerStorage ignores sibling events with a similar base directory prefix", async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "peer-storage-prefix-" });
    try {
        const baseDir = join(tempDir, "vault");
        const siblingDir = join(tempDir, "vault-old");
        await Deno.mkdir(baseDir);
        await Deno.mkdir(siblingDir);
        const { peer } = makeWritePeer(baseDir);
        const dispatched: string[] = [];
        peer.dispatchToHub = (_source, path) => {
            dispatched.push(path);
            return Promise.resolve();
        };
        const present = join(siblingDir, "present.md");
        await Deno.writeTextFile(present, "text");

        await peer.dispatch(present);
        await peer.dispatchDeleted(join(siblingDir, "gone.md"));
        await new Promise((resolve) => setTimeout(resolve, 400));

        assertEquals(dispatched.length, 0, "A similarly named sibling directory should stay outside baseDir");
    } finally {
        await Deno.remove(tempDir, { recursive: true });
    }
});

for (const childEvent of [false, true]) {
    Deno.test(`PeerStorage Deno directory removal deletes synced children with ${childEvent ? "a child event" : "only a parent event"}`, async () => {
        const tempDir = await Deno.makeTempDir({ prefix: "peer-storage-directory-removal-" });
        const directory = join(tempDir, "removed");
        const child = join(directory, "note.md");
        const { peer } = makeWritePeer(`${tempDir}/`);
        const dispatched: { path: string; data: FileData | false }[] = [];
        peer.dispatchToHub = (_source, path, data) => {
            dispatched.push({ path, data });
            return Promise.resolve();
        };
        try {
            await Deno.mkdir(directory);
            await Deno.writeTextFile(child, "already synced");
            await peer.dispatch(child);
            await new Promise((resolve) => setTimeout(resolve, 400));
            assertEquals(dispatched.length, 1, "The child should be synced before removing its directory");
            assertEquals(dispatched[0].path, "removed/note.md", "The child should use its vault path");
            assert(dispatched[0].data !== false, "The initial sync should carry the file contents");
            dispatched.length = 0;

            await Deno.remove(directory, { recursive: true });
            peer.processFile({ kind: "remove", paths: childEvent ? [child, directory] : [directory] });
            await new Promise((resolve) => setTimeout(resolve, 600));

            const childDeletions = dispatched.filter((entry) => entry.path === "removed/note.md" && entry.data === false);
            assertEquals(childDeletions.length, 1, "The synced child deletion should reach the hub exactly once");
            assertEquals(dispatched.length, 1, "Only file deletions should reach the hub");
        } finally {
            await Deno.remove(tempDir, { recursive: true });
        }
    });
}


type DenoRemovalFixture = {
    peer: PeerStorage;
    baseDir: string;
    directory: string;
    children: string[];
    dispatched: { path: string; data: FileData | false }[];
    notices: string[];
};

async function settleDenoEvents() {
    await new Promise((resolve) => setTimeout(resolve, 700));
}

async function waitForDenoWatch(peer: PeerStorage) {
    const deadline = Date.now() + 5000;
    while (!peer.health().ok && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(peer.health().ok, "The Deno watcher should finish its initial inventory");
}

async function withDenoRemovalFixture(
    check: (fixture: DenoRemovalFixture) => Promise<void>,
    inventory: "dispatch" | "put" | "startup" = "dispatch",
    scanOfflineChanges = false,
) {
    const baseDir = await Deno.makeTempDir({ prefix: "peer-storage-deno-removal-" });
    const directory = join(baseDir, "removed");
    const children = [join(directory, "note.md"), join(directory, "deep", "other.md")];
    const { peer, notices } = makeWritePeer(`${baseDir}/`);
    const dispatched: DenoRemovalFixture["dispatched"] = [];
    peer.dispatchToHub = (_source, path, data) => {
        dispatched.push({ path, data });
        return Promise.resolve();
    };
    const originalWatchFs = Deno.watchFs;
    let watching: Promise<void> | undefined;
    try {
        await Deno.mkdir(join(directory, "deep"), { recursive: true });
        await Deno.mkdir(join(baseDir, "removed-other"));
        const files = [...children, join(baseDir, "removed-other", "stay.md")];
        for (const file of files) {
            const vaultPath = peer.toPosixPath(file.slice(baseDir.length + 1));
            if (inventory === "put") {
                assert(await peer.put(vaultPath, textFileData("synced")), "An incoming file should be written");
            } else {
                await Deno.writeTextFile(file, "synced");
                if (inventory === "dispatch") {
                    await peer.dispatch(file);
                } else {
                    // Seed offline scan state directly: writeFileStat would also seed the new inventory.
                    const stat = await Deno.stat(file);
                    peer.setSetting(`file-stat-${peer.toLocalPath(vaultPath)}`, `${stat.mtime?.getTime() ?? 0}-${stat.size}`);
                }
            }
        }
        if (inventory === "startup") {
            Deno.watchFs = (() => new ControlledDenoWatcher() as unknown as Deno.FsWatcher) as typeof Deno.watchFs;
            peer.config.scanOfflineChanges = scanOfflineChanges;
            watching = peer.startDenoFsWatch();
            await waitForDenoWatch(peer);
            await settleDenoEvents();
            assertEquals(dispatched.length, 0, "Unchanged startup files should not be synchronised again");
        } else {
            await settleDenoEvents();
        }
        dispatched.length = 0;
        await check({ peer, baseDir, directory, children, dispatched, notices });
    } finally {
        Deno.watchFs = originalWatchFs;
        await peer.stop();
        await watching;
        await Deno.remove(baseDir, { recursive: true });
    }
}

function assertChildDeletions(fixture: DenoRemovalFixture, expected = "removed/deep/other.md,removed/note.md") {
    assert(fixture.dispatched.every((entry) => entry.data === false), "Every notification should be a deletion");
    assertEquals(fixture.dispatched.map((entry) => entry.path).sort().join(","), expected,
        "Only missing child files should be deleted, each exactly once");
}

for (const inventory of ["dispatch", "put", "startup"] as const) {
    for (const scanOfflineChanges of inventory === "startup" ? [false, true] : [false]) {
        Deno.test(`PeerStorage Deno parent removal recovers nested files from ${inventory}, offline scan ${scanOfflineChanges}`, async () => {
            await withDenoRemovalFixture(async (fixture) => {
                await Deno.remove(fixture.directory, { recursive: true });
                fixture.peer.processFile({ kind: "remove", paths: [fixture.directory] });
                await settleDenoEvents();
                assertChildDeletions(fixture);
                assertEquals(await Deno.readTextFile(join(fixture.baseDir, "removed-other", "stay.md")), "synced",
                    "A similarly named sibling should remain intact");
            }, inventory, scanOfflineChanges);
        });
    }
}

Deno.test("PeerStorage Deno parent and repeated child events emit file deletions once", async () => {
    await withDenoRemovalFixture(async (fixture) => {
        await Deno.remove(fixture.directory, { recursive: true });
        const paths = [fixture.directory, ...fixture.children, fixture.directory];
        fixture.peer.processFile({ kind: "remove", paths });
        fixture.peer.processFile({ kind: "modify", paths });
        await settleDenoEvents();
        assertChildDeletions(fixture);
        fixture.peer.processFile({ kind: "remove", paths });
        await settleDenoEvents();
        assertChildDeletions(fixture);
    });
});

Deno.test("PeerStorage Deno deletion rechecks a child recreated during the dispatch delay", async () => {
    await withDenoRemovalFixture(async (fixture) => {
        await Deno.remove(fixture.directory, { recursive: true });
        fixture.peer.processFile({ kind: "remove", paths: [fixture.directory] });
        await new Promise((resolve) => setTimeout(resolve, 150));
        await Deno.mkdir(fixture.directory);
        await Deno.writeTextFile(fixture.children[0], "recreated");
        await settleDenoEvents();
        assertChildDeletions(fixture, "removed/deep/other.md");
        assertEquals(await Deno.readTextFile(fixture.children[0]), "recreated", "The recreated file should remain intact");
    });
});

Deno.test("PeerStorage Deno parent removal checks children even if the parent was recreated", async () => {
    await withDenoRemovalFixture(async (fixture) => {
        await Deno.remove(fixture.directory, { recursive: true });
        await Deno.mkdir(fixture.directory);
        await Deno.writeTextFile(fixture.children[0], "recreated");
        fixture.peer.processFile({ kind: "remove", paths: [fixture.directory] });
        await settleDenoEvents();
        assertChildDeletions(fixture, "removed/deep/other.md");
    });
});

for (const target of ["parent", "child"] as const) {
    for (const [name, error] of [
        ["permission", new Deno.errors.PermissionDenied("controlled permission failure")],
        ["I/O", new Error("controlled I/O failure")],
    ] as const) {
        Deno.test(`PeerStorage Deno deletion preserves inventory after a ${target} stat ${name} error`, async () => {
            await withDenoRemovalFixture(async (fixture) => {
                await Deno.remove(fixture.directory, { recursive: true });
                const originalStat = Deno.stat;
                const failedPath = target === "parent" ? fixture.directory : fixture.children[0];
                try {
                    Deno.stat = ((path: string | URL) => path === failedPath
                        ? Promise.reject(error) : originalStat(path)) as typeof Deno.stat;
                    fixture.peer.processFile({ kind: "remove", paths: [fixture.directory] });
                    await settleDenoEvents();
                    assertChildDeletions(fixture, target === "parent" ? "" : "removed/deep/other.md");
                    assert(fixture.notices.some((notice) => notice.includes(failedPath)), "The failed check should be logged");
                } finally {
                    Deno.stat = originalStat;
                }
                fixture.peer.processFile({ kind: "remove", paths: [fixture.directory] });
                await settleDenoEvents();
                assertChildDeletions(fixture);
            });
        });
    }
}

Deno.test("PeerStorage Deno ancestor events outside baseDir cannot delete known children", async () => {
    await withDenoRemovalFixture(async (fixture) => {
        await Deno.remove(fixture.directory, { recursive: true });
        fixture.peer.processFile({ kind: "remove", paths: [join(fixture.baseDir, "..")] });
        await settleDenoEvents();
        assertChildDeletions(fixture, "");
        fixture.peer.processFile({ kind: "remove", paths: [fixture.directory] });
        await settleDenoEvents();
        assertChildDeletions(fixture);
    });
});

Deno.test("PeerStorage Deno ignores removed empty folders and unknown paths", async () => {
    await withDenoRemovalFixture(async (fixture) => {
        const empty = join(fixture.baseDir, "empty");
        await Deno.mkdir(empty);
        fixture.peer.processFile({ kind: "create", paths: [empty] });
        await settleDenoEvents();
        await Deno.remove(empty);
        fixture.peer.processFile({ kind: "remove", paths: [empty, join(fixture.baseDir, "unknown")] });
        await settleDenoEvents();
        assertChildDeletions(fixture, "");
    });
});

Deno.test("PeerStorage Deno real watcher propagates recursive removal as file deletions", async () => {
    const baseDir = await Deno.makeTempDir({ prefix: "peer-storage-native-removal-" });
    const directory = join(baseDir, "removed");
    const { peer } = makeWritePeer(`${baseDir}/`);
    const deleted: string[] = [];
    peer.dispatchToHub = (_source, path, data) => {
        assertEquals(data, false, "The inventory should produce only file deletions");
        deleted.push(path);
        return Promise.resolve();
    };
    let watching: Promise<void> | undefined;
    try {
        await Deno.mkdir(join(directory, "deep"), { recursive: true });
        await Deno.writeTextFile(join(directory, "note.md"), "synced");
        await Deno.writeTextFile(join(directory, "deep", "other.md"), "synced");
        watching = peer.startDenoFsWatch();
        await waitForDenoWatch(peer);
        await Deno.remove(directory, { recursive: true });
        const deadline = Date.now() + 5000;
        while (deleted.length < 2 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await settleDenoEvents();
        assertEquals(deleted.sort().join(","), "removed/deep/other.md,removed/note.md",
            "The native watcher should delete each child exactly once and skip directories");
    } finally {
        await peer.stop();
        await watching;
        await Deno.remove(baseDir, { recursive: true });
    }
});

Deno.test("PeerStorage Deno watcher stops during the initial inventory", async () => {
    const baseDir = await Deno.makeTempDir({ prefix: "peer-storage-inventory-stop-" });
    const peer = makePeer(baseDir);
    const originalWatchFs = Deno.watchFs;
    const originalReadDir = Deno.readDir;
    let scanned!: () => void;
    let release!: () => void;
    const scanning = new Promise<void>((resolve) => { scanned = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    Deno.watchFs = (() => new ControlledDenoWatcher() as unknown as Deno.FsWatcher) as typeof Deno.watchFs;
    Deno.readDir = (async function* (path) {
        if (path === baseDir) {
            scanned();
            await released;
        }
        yield* originalReadDir(path);
    }) as typeof Deno.readDir;
    let watching: Promise<void> | undefined;
    try {
        watching = peer.startDenoFsWatch();
        await scanning;
        assert(!peer.health().ok, "An unfinished inventory should remain in the starting state");
        await peer.stop();
        release();
        await watching;
        assert(!peer.health().ok, "Finishing the scan must not restart a stopped watcher");
        assertEquals(peer.watcherDeno, undefined, "The stopped watcher should remain cleared");
    } finally {
        release();
        Deno.readDir = originalReadDir;
        Deno.watchFs = originalWatchFs;
        await peer.stop();
        await watching;
        await Deno.remove(baseDir, { recursive: true });
    }
});

for (const scanOfflineChanges of [false, true]) {
    Deno.test(`PeerStorage Deno inventory continues after a subdirectory disappears, offline scan ${scanOfflineChanges}`, async () => {
        const baseDir = await Deno.makeTempDir({ prefix: "peer-storage-vanishing-inventory-" });
        const vanishing = join(baseDir, "vanishing");
        const remaining = join(baseDir, "remaining");
        const { peer } = makeWritePeer(`${baseDir}/`);
        peer.config.scanOfflineChanges = scanOfflineChanges;
        const dispatched: { path: string; data: FileData | false }[] = [];
        peer.dispatchToHub = (_source, path, data) => {
            dispatched.push({ path, data });
            return Promise.resolve();
        };
        const originalWatchFs = Deno.watchFs;
        const originalReadDir = Deno.readDir;
        Deno.watchFs = (() => new ControlledDenoWatcher() as unknown as Deno.FsWatcher) as typeof Deno.watchFs;
        let removed = false;
        Deno.readDir = (async function* (path) {
            if (path === vanishing) {
                await Deno.remove(vanishing, { recursive: true });
                removed = true;
            }
            yield* originalReadDir(path);
        }) as typeof Deno.readDir;
        let watching: Promise<void> | undefined;
        let startError: unknown;
        try {
            await Deno.mkdir(vanishing);
            await Deno.mkdir(remaining);
            await Deno.writeTextFile(join(remaining, "note.md"), "synced");
            watching = peer.startDenoFsWatch().catch((error) => { startError = error; });
            const deadline = Date.now() + 5000;
            while (!peer.health().ok && startError === undefined && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert(removed, "The subdirectory should disappear during the inventory");
            assert(startError === undefined, `A vanished subdirectory must not abort the watcher: ${startError}`);
            assert(peer.health().ok, "The remaining inventory should finish and the watcher should become healthy");
            await settleDenoEvents();
            dispatched.length = 0;
            await Deno.remove(remaining, { recursive: true });
            peer.processFile({ kind: "remove", paths: [remaining] });
            await settleDenoEvents();
            assertEquals(dispatched.length, 1, "The remaining file should be known despite the interrupted subtree");
            assertEquals(dispatched[0].path, "remaining/note.md", "The remaining file deletion should reach the hub");
            assertEquals(dispatched[0].data, false, "The remaining file should carry a deletion marker");
        } finally {
            Deno.readDir = originalReadDir;
            Deno.watchFs = originalWatchFs;
            await peer.stop();
            await watching;
            await Deno.remove(baseDir, { recursive: true });
        }
    });
}

Deno.test("PeerStorage offline scan never enters an ignored directory", async () => {
    const originalWatchFs = Deno.watchFs;
    const watchers: ControlledDenoWatcher[] = [];
    Deno.watchFs = (() => {
        const watcher = new ControlledDenoWatcher();
        watchers.push(watcher);
        return watcher as unknown as Deno.FsWatcher;
    }) as typeof Deno.watchFs;

    const tempDir = await Deno.makeTempDir({ prefix: "peer-storage-test-" });
    await makeVaultWithIgnorableTrees(tempDir);
    const stats = recordStatPaths();
    try {
        const { peer, dispatched } = makeRecordingPeer(tempDir, {
            scanOfflineChanges: true,
            ignore: IGNORE_PATTERNS,
        });

        const running = peer.startDenoFsWatch();
        await waitFor(() => watchers.length === 1, "the offline scan should complete and start a watcher");
        await waitFor(() => dispatched.length === 2, "both files outside the ignored trees should be dispatched");

        watchers[0].finish();
        await running;

        const paths = dispatched.map((entry) => entry.path).sort().join(",");
        assertEquals(paths, ".gitignore,notes/keep.md", "only files outside the ignored trees should be dispatched");
        assertNothingTouchedIn(stats.paths, "the offline scan must not stat anything inside an ignored tree");
    } finally {
        stats.restore();
        Deno.watchFs = originalWatchFs;
        await Deno.remove(tempDir, { recursive: true });
    }
});

Deno.test("PeerStorage drops live change events inside an ignored directory", async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "peer-storage-test-" });
    await makeVaultWithIgnorableTrees(tempDir);
    const stats = recordStatPaths();
    try {
        const { peer, dispatched } = makeRecordingPeer(tempDir, { ignore: IGNORE_PATTERNS });

        peer.processFile({
            kind: "modify",
            paths: [
                join(tempDir, ".git", "config"),
                join(tempDir, "node_modules", "pkg", "index.js"),
                join(tempDir, "notes", "keep.md"),
            ],
        } as Deno.FsEvent);

        await waitFor(() => dispatched.length === 1, "the changed file outside the ignored trees should be dispatched");
        // Long enough for a leaked ignored event to have arrived as well.
        await sleep(500);

        assertEquals(dispatched.length, 1, "changes inside an ignored tree must not be dispatched");
        assertEquals(dispatched[0].path, "notes/keep.md", "the dispatched change should be the non-ignored file");
        assertNothingTouchedIn(stats.paths, "a live change event inside an ignored tree must not stat the path");
    } finally {
        stats.restore();
        await Deno.remove(tempDir, { recursive: true });
    }
});

Deno.test("PeerStorage drops live delete events inside an ignored directory", async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "peer-storage-test-" });
    await makeVaultWithIgnorableTrees(tempDir);
    const stats = recordStatPaths();
    try {
        const { peer, dispatched } = makeRecordingPeer(tempDir, { ignore: IGNORE_PATTERNS });
        await peer.writeFileStat("notes/keep.md");
        await Deno.remove(join(tempDir, ".git", "config"));
        await Deno.remove(join(tempDir, "notes", "keep.md"));

        peer.processFile({
            kind: "remove",
            paths: [join(tempDir, ".git", "config"), join(tempDir, "notes", "keep.md")],
        } as Deno.FsEvent);

        await waitFor(() => dispatched.length === 1, "the deleted file outside the ignored trees should be dispatched");
        await sleep(500);

        assertEquals(dispatched.length, 1, "deletions inside an ignored tree must not be dispatched");
        assertEquals(dispatched[0].path, "notes/keep.md", "the dispatched deletion should be the non-ignored file");
        assertEquals(dispatched[0].data, false, "a deletion should be dispatched as `false`");
        assertNothingTouchedIn(stats.paths, "a live delete event inside an ignored tree must not stat the path");
    } finally {
        stats.restore();
        await Deno.remove(tempDir, { recursive: true });
    }
});

Deno.test("PeerStorage Chokidar watch prunes ignored paths and drops their events", async () => {
    const originalWatch = chokidar.watch;
    const watchers: ControlledChokidarWatcher[] = [];
    const options: chokidar.WatchOptions[] = [];
    chokidar.watch = ((_path: string, watchOptions: chokidar.WatchOptions) => {
        options.push(watchOptions);
        const watcher = new ControlledChokidarWatcher();
        watchers.push(watcher);
        return watcher as unknown as ReturnType<typeof chokidar.watch>;
    }) as typeof chokidar.watch;

    const tempDir = await Deno.makeTempDir({ prefix: "peer-storage-test-" });
    await makeVaultWithIgnorableTrees(tempDir);
    const stats = recordStatPaths();
    try {
        const { peer, dispatched } = makeRecordingPeer(tempDir, {
            useChokidar: true,
            ignore: IGNORE_PATTERNS,
        });
        await peer.start();
        assertEquals(watchers.length, 1, "Chokidar watcher should be created");

        // The watch itself has to prune, so an ignored tree is never watched.
        const ignored = options[0].ignored as (path: string) => boolean;
        assert(ignored(join(tempDir, ".git")), "the ignored directory itself should be pruned from the watch");
        assert(ignored(join(tempDir, ".git", "config")), "files in an ignored directory should be pruned from the watch");
        assert(!ignored(join(tempDir, "notes", "keep.md")), "a file outside the ignored trees should stay watched");

        // And the handlers filter as well, for events reported before that applies.
        watchers[0].emit("add", join(tempDir, ".git", "config"));
        watchers[0].emit("change", join(tempDir, "node_modules", "pkg", "index.js"));
        watchers[0].emit("unlink", join(tempDir, ".git", "objects", "aa", "deadbeef"));
        watchers[0].emit("change", join(tempDir, "notes", "keep.md"));

        await waitFor(() => dispatched.length === 1, "the changed file outside the ignored trees should be dispatched");
        await sleep(500);

        assertEquals(dispatched.length, 1, "Chokidar events inside an ignored tree must not be dispatched");
        assertEquals(dispatched[0].path, "notes/keep.md", "the dispatched change should be the non-ignored file");
        assertNothingTouchedIn(stats.paths, "Chokidar events inside an ignored tree must not stat the path");

        const stopping = peer.stop();
        watchers[0].finishClose();
        await stopping;
    } finally {
        stats.restore();
        chokidar.watch = originalWatch;
        await Deno.remove(tempDir, { recursive: true });
    }
});

Deno.test("PeerStorage ignore patterns match paths, directories and nothing when unset", () => {
    const withoutPatterns = makePeer("/vault");
    assert(!withoutPatterns.isIgnored(".git/config"), "without patterns nothing should be ignored");

    const { peer } = makeRecordingPeer("/vault", { ignore: IGNORE_PATTERNS });
    assert(peer.isIgnored(".git/config"), "a file in an ignored directory should be ignored");
    assert(peer.isIgnored("notes/sub/.git/config"), "a nested ignored directory should be ignored");
    assert(peer.isIgnored(".git"), "a trailing /** should also cover the directory itself");
    assert(peer.isIgnored("notes/sub/.git"), "a nested ignored directory itself should be ignored");
    assert(peer.isIgnored("node_modules/pkg/index.js"), "a file in an ignored top-level directory should be ignored");
    assert(!peer.isIgnored(".gitignore"), "a pattern must not match a similarly named file");
    assert(!peer.isIgnored("notes/keep.md"), "an unrelated file should not be ignored");
    assert(!peer.isIgnored("notes/node_modules/pkg/index.js"), "a top-level-only pattern should not match nested paths");
    assert(!peer.isIgnored(""), "the peer root itself should never be ignored");
});

// Records every path which is read, alongside recordStatPaths(), to prove that
// descendants of an ignored directory are dropped before their contents are read.
function recordReadPaths() {
    const originalReadTextFile = Deno.readTextFile;
    const originalReadFile = Deno.readFile;
    const paths: string[] = [];
    const record = (path: string | URL) => paths.push((typeof path === "string" ? path : path.pathname).replaceAll("\\", "/"));
    Deno.readTextFile = ((path: string | URL, ...rest: unknown[]) => {
        record(path);
        return (originalReadTextFile as (...args: unknown[]) => Promise<string>)(path, ...rest);
    }) as typeof Deno.readTextFile;
    Deno.readFile = ((path: string | URL, ...rest: unknown[]) => {
        record(path);
        return (originalReadFile as (...args: unknown[]) => Promise<Uint8Array>)(path, ...rest);
    }) as typeof Deno.readFile;
    return {
        paths,
        restore() {
            Deno.readTextFile = originalReadTextFile;
            Deno.readFile = originalReadFile;
        },
    };
}

// Patterns which match only a directory's own name, not the paths below it.
const DIRECTORY_NAME_PATTERNS = ["private", "*.tmp"];

async function makeVaultWithDirectoryNameMatches(tempDir: string) {
    await Deno.mkdir(join(tempDir, "private", "nested"), { recursive: true });
    await Deno.writeTextFile(join(tempDir, "private", "note.md"), "secret");
    await Deno.writeTextFile(join(tempDir, "private", "nested", "deep.md"), "secret");
    await Deno.mkdir(join(tempDir, "cache.tmp"), { recursive: true });
    await Deno.writeTextFile(join(tempDir, "cache.tmp", "entry.md"), "cached");
    await Deno.mkdir(join(tempDir, "notes"), { recursive: true });
    await Deno.writeTextFile(join(tempDir, "notes", "keep.md"), "keep");
}

function assertNothingTouchedBelowMatchedDirectories(paths: string[], message: string) {
    const touched = paths.filter((path) => path.includes("/private/") || path.includes("/cache.tmp/"));
    assertEquals(touched.join(","), "", message);
}

Deno.test("PeerStorage ignores descendants of a directory matched only by its name", () => {
    const { peer } = makeRecordingPeer("/vault", { ignore: DIRECTORY_NAME_PATTERNS });
    assert(peer.isIgnored("private"), "the matched directory itself should be ignored");
    assert(peer.isIgnored("private/note.md"), "a file in a matched directory should be ignored");
    assert(peer.isIgnored("private/nested/deep.md"), "a deeper descendant of a matched directory should be ignored");
    assert(peer.isIgnored("cache.tmp/entry.md"), "a file in a directory matched by a wildcard should be ignored");
    assert(!peer.isIgnored("notes/keep.md"), "an unrelated file should not be ignored");
    assert(!peer.isIgnored("notes/private.md"), "a file merely named like the pattern should not be ignored");
});

Deno.test("PeerStorage offline scan and live events agree on descendants of an ignored directory", async () => {
    const originalWatchFs = Deno.watchFs;
    const watchers: ControlledDenoWatcher[] = [];
    Deno.watchFs = (() => {
        const watcher = new ControlledDenoWatcher();
        watchers.push(watcher);
        return watcher as unknown as Deno.FsWatcher;
    }) as typeof Deno.watchFs;

    const tempDir = await Deno.makeTempDir({ prefix: "peer-storage-test-" });
    await makeVaultWithDirectoryNameMatches(tempDir);
    const stats = recordStatPaths();
    const reads = recordReadPaths();
    try {
        const { peer, dispatched } = makeRecordingPeer(tempDir, {
            scanOfflineChanges: true,
            ignore: DIRECTORY_NAME_PATTERNS,
        });

        const running = peer.startDenoFsWatch();
        await waitFor(() => watchers.length === 1, "the offline scan should complete and start a watcher");
        await waitFor(() => dispatched.length === 1, "the file outside the ignored directories should be dispatched");
        assertEquals(dispatched[0].path, "notes/keep.md", "the offline scan should skip the ignored directories");

        // The same files reported by the live watcher must be dropped as well.
        peer.processFile({
            kind: "modify",
            paths: [
                join(tempDir, "private", "note.md"),
                join(tempDir, "private", "nested", "deep.md"),
                join(tempDir, "cache.tmp", "entry.md"),
            ],
        } as Deno.FsEvent);
        await sleep(500);

        watchers[0].finish();
        await running;

        assertEquals(dispatched.length, 1, "live changes below an ignored directory must not be dispatched");
        assertNothingTouchedBelowMatchedDirectories(stats.paths, "descendants of an ignored directory must not be stat()ed");
        assertNothingTouchedBelowMatchedDirectories(reads.paths, "descendants of an ignored directory must not be read");
    } finally {
        reads.restore();
        stats.restore();
        Deno.watchFs = originalWatchFs;
        await Deno.remove(tempDir, { recursive: true });
    }
});

Deno.test("PeerStorage drops live delete events below a directory matched only by its name", async () => {
    const tempDir = await Deno.makeTempDir({ prefix: "peer-storage-test-" });
    await makeVaultWithDirectoryNameMatches(tempDir);
    const stats = recordStatPaths();
    const reads = recordReadPaths();
    try {
        const { peer, dispatched } = makeRecordingPeer(tempDir, { ignore: DIRECTORY_NAME_PATTERNS });
        await peer.writeFileStat("notes/keep.md");
        await Deno.remove(join(tempDir, "private", "note.md"));
        await Deno.remove(join(tempDir, "cache.tmp", "entry.md"));
        await Deno.remove(join(tempDir, "notes", "keep.md"));

        peer.processFile({
            kind: "remove",
            paths: [
                join(tempDir, "private", "note.md"),
                join(tempDir, "cache.tmp", "entry.md"),
                join(tempDir, "notes", "keep.md"),
            ],
        } as Deno.FsEvent);

        await waitFor(() => dispatched.length === 1, "the deleted file outside the ignored directories should be dispatched");
        await sleep(500);

        assertEquals(dispatched.length, 1, "deletions below an ignored directory must not be dispatched");
        assertEquals(dispatched[0].path, "notes/keep.md", "the dispatched deletion should be the non-ignored file");
        assertEquals(dispatched[0].data, false, "a deletion should be dispatched as `false`");
        assertNothingTouchedBelowMatchedDirectories(stats.paths, "deleted descendants of an ignored directory must not be stat()ed");
        assertNothingTouchedBelowMatchedDirectories(reads.paths, "deleted descendants of an ignored directory must not be read");
    } finally {
        reads.restore();
        stats.restore();
        await Deno.remove(tempDir, { recursive: true });
    }
});

for (const scanOfflineChanges of [false, true]) {
    Deno.test(`PeerStorage ignored startup inventory prunes directories, offline scan ${scanOfflineChanges}`, async () => {
        const baseDir = await Deno.makeTempDir({ prefix: "peer-storage-ignored-inventory-" });
        await makeVaultWithDirectoryNameMatches(baseDir);
        const { peer, dispatched } = makeRecordingPeer(baseDir, {
            ignore: DIRECTORY_NAME_PATTERNS,
            scanOfflineChanges,
        });
        const originalWatchFs = Deno.watchFs;
        const originalReadDir = Deno.readDir;
        const directories: string[] = [];
        const stats = recordStatPaths();
        const reads = recordReadPaths();
        Deno.watchFs = (() => new ControlledDenoWatcher() as unknown as Deno.FsWatcher) as typeof Deno.watchFs;
        Deno.readDir = (async function* (path) {
            if (typeof path === "string") directories.push(peer.toRelativePath(path));
            yield* originalReadDir(path);
        }) as typeof Deno.readDir;
        let watching: Promise<void> | undefined;
        try {
            watching = peer.startDenoFsWatch();
            await waitForDenoWatch(peer);
            if (scanOfflineChanges) {
                await waitFor(() => dispatched.length === 1, "the non-ignored startup file should be sent");
                assertEquals(dispatched[0].path, "notes/keep.md", "Only the non-ignored file should be sent");
            }
            assert(!directories.some((path) => path === "private" || path === "cache.tmp"),
                "The startup inventory must not enter ignored directories");
            assertNothingTouchedBelowMatchedDirectories(stats.paths, "The inventory must not stat ignored descendants");
            assertNothingTouchedBelowMatchedDirectories(reads.paths, "The inventory must not read ignored descendants");
            assertEquals(dispatched.length, scanOfflineChanges ? 1 : 0,
                "Disabling offline syncing should still inventory files without sending their contents");

            dispatched.length = 0;
            await Deno.remove(join(baseDir, "notes"), { recursive: true });
            peer.processFile({ kind: "remove", paths: [join(baseDir, "notes")] });
            await settleDenoEvents();
            assertEquals(dispatched.length, 1, "The inventory should retain the non-ignored child for parent removal");
            assertEquals(dispatched[0].path, "notes/keep.md", "The missing child should use its vault path");
            assertEquals(dispatched[0].data, false, "The missing child should carry a deletion marker");
        } finally {
            Deno.readDir = originalReadDir;
            Deno.watchFs = originalWatchFs;
            reads.restore();
            stats.restore();
            await peer.stop();
            await watching;
            await Deno.remove(baseDir, { recursive: true });
        }
    });
}

Deno.test("PeerStorage parent removal excludes ignored children received from another peer", async () => {
    const baseDir = await Deno.makeTempDir({ prefix: "peer-storage-ignored-parent-removal-" });
    const directory = join(baseDir, "removed");
    const { peer, dispatched } = makeRecordingPeer(baseDir, { ignore: ["**/private"] });
    const originalWatchFs = Deno.watchFs;
    let watching: Promise<void> | undefined;
    try {
        await Deno.mkdir(join(directory, "private"), { recursive: true });
        await Deno.writeTextFile(join(directory, "keep.md"), "already synced");
        await Deno.writeTextFile(join(directory, "private", "local.md"), "excluded");
        Deno.watchFs = (() => new ControlledDenoWatcher() as unknown as Deno.FsWatcher) as typeof Deno.watchFs;
        watching = peer.startDenoFsWatch();
        await waitForDenoWatch(peer);
        assert(await peer.put("removed/private/incoming.md", textFileData("received")),
            "Incoming writes at ignored paths should still be accepted");
        assertEquals(await Deno.readTextFile(join(directory, "private", "incoming.md")), "received",
            "The incoming contents should be written at the ignored path");
        assert(await peer.put("removed/private/deleted.md", textFileData("received")),
            "An ignored file should be available for an incoming deletion");
        assert(await peer.delete("removed/private/deleted.md"), "Incoming deletions at ignored paths should still be accepted");

        const stats = recordStatPaths();
        const reads = recordReadPaths();
        try {
            await Deno.remove(directory, { recursive: true });
            peer.processFile({ kind: "remove", paths: [directory] });
            await settleDenoEvents();
            assertEquals(dispatched.length, 1, "Only the non-ignored child deletion should be sent");
            assertEquals(dispatched[0].path, "removed/keep.md", "The non-ignored child should be deleted");
            assertEquals(dispatched[0].data, false, "The child should carry a deletion marker");
            assertNothingTouchedBelowMatchedDirectories(stats.paths, "Parent removal must not stat ignored children");
            assertNothingTouchedBelowMatchedDirectories(reads.paths, "Parent removal must not read ignored children");
        } finally {
            reads.restore();
            stats.restore();
        }
    } finally {
        Deno.watchFs = originalWatchFs;
        await peer.stop();
        await watching;
        await Deno.remove(baseDir, { recursive: true });
    }
});

Deno.test("PeerStorage imports new directory contents from child-file events", async () => {
    const baseDir = await Deno.makeTempDir({ prefix: "peer-storage-directory-create-" });
    const directory = join(baseDir, ".claude");
    const { peer } = makeWritePeer(baseDir);
    peer.config.ignore = ["**/private"];
    const dispatched: { path: string; data: FileData | false }[] = [];
    peer.dispatchToHub = (_source, path, data) => {
        dispatched.push({ path, data });
        return Promise.resolve();
    };
    try {
        await Deno.mkdir(join(directory, "deep"), { recursive: true });
        await Deno.mkdir(join(directory, "private"));
        await Deno.mkdir(join(baseDir, ".claude-other"));
        await Deno.writeTextFile(join(directory, "settings.json"), "selected settings");
        await Deno.writeTextFile(join(directory, "deep", "other.json"), "nested settings");
        await Deno.writeTextFile(join(directory, "private", "secret.json"), "ignored");
        await Deno.writeTextFile(join(baseDir, ".claude-other", "control.json"), "unrelated");

        // Directory and child-file notifications can arrive together.
        peer.processFile({
            kind: "create",
            paths: [directory, join(directory, "settings.json"), join(directory, "deep", "other.json"),
                join(directory, "private", "secret.json")],
        });
        await settleDenoEvents();

        assertEquals(dispatched.map((event) => event.path).sort().join(","),
            ".claude/deep/other.json,.claude/settings.json",
            "A newly created subtree should send its files without ignored children, directories, or siblings");
        const contents = dispatched.map((event) => {
            assert(event.data !== false, "New files should carry content rather than deletions");
            const data = event.data as FileData;
            return data.data instanceof Uint8Array ? new TextDecoder().decode(data.data) : data.data.join("");
        }).sort().join(",");
        assertEquals(contents, "nested settings,selected settings", "Each new file should retain its content");
        assertEquals(await Deno.readTextFile(join(directory, "private", "secret.json")), "ignored",
            "The ignored file should remain unchanged");
        assertEquals(await Deno.readTextFile(join(baseDir, ".claude-other", "control.json")), "unrelated",
            "The neighbouring directory should remain unchanged");
    } finally {
        await Deno.remove(baseDir, { recursive: true });
    }
});

for (const filename of ["note.md", ".claude/settings.json"]) {
    for (const incomingChange of ["deletion", "update"] as const) {
        Deno.test(`PeerStorage preserves an incoming ${incomingChange} while an earlier write waits | ${filename}`, async () => {
            const baseDir = await Deno.makeTempDir({ prefix: "peer-storage-pending-write-" });
            const path = join(baseDir, ...filename.split("/"));
            const { peer } = makeWritePeer(baseDir);
            const dispatched: { path: string; data: FileData | false }[] = [];
            peer.dispatchToHub = (_source, path, data) => {
                dispatched.push({ path, data });
                return Promise.resolve();
            };
            const originalSetTimeout = globalThis.setTimeout;
            const released = Promise.withResolvers<void>();
            let delayEntered = false;
            let holdNextDelay = true;
            try {
                assertEquals(await peer.put(filename, textFileData("received content")), true,
                    "The incoming write should reach disk before its watcher event");
                globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
                    const [handler, timeout, ...handlerArgs] = args;
                    if (holdNextDelay && timeout === 250) {
                        holdNextDelay = false;
                        return originalSetTimeout(async () => {
                            delayEntered = true;
                            await released.promise;
                            originalSetTimeout(handler, 0, ...handlerArgs);
                        }, timeout);
                    }
                    return originalSetTimeout(...args);
                }) as typeof setTimeout;

                // Hold completion of the real outgoing delay. The original implementation
                // already has its content snapshot; the incoming change completes while
                // the task still waits. All later timers run normally.
                await peer.dispatch(path);
                await waitFor(() => delayEntered, "The outgoing task should enter its notification delay");
                if (incomingChange === "deletion") {
                    assertEquals(await peer.delete(filename), true,
                        "The incoming deletion should complete while the write waits");
                } else {
                    assertEquals(await peer.put(filename, textFileData("newer received content")), true,
                        "The newer incoming update should complete while the earlier write waits");
                }
                released.resolve();
                await serialized(path, () => Promise.resolve());

                if (incomingChange === "deletion") {
                    let missing = false;
                    try {
                        await Deno.stat(path);
                    } catch (error) {
                        if (!(error instanceof Deno.errors.NotFound)) throw error;
                        missing = true;
                    }
                    assert(missing, "The received deletion should leave the local file absent");
                } else {
                    assertEquals(await Deno.readTextFile(path), "newer received content",
                        "The newer received content should remain on disk");
                }
                assertEquals(JSON.stringify(outgoingContents(dispatched)), "[]",
                    "A queued echo must not overwrite a later received " + incomingChange);

                await Deno.writeTextFile(path, "later local edit");
                await peer.dispatch(path);
                await serialized(path, () => Promise.resolve());
                assertEquals(JSON.stringify(outgoingContents(dispatched)),
                    JSON.stringify([{ path: filename, content: "later local edit" }]),
                    "A later local edit should still reach the Hub exactly once");
            } finally {
                released.resolve();
                await serialized(path, () => Promise.resolve());
                globalThis.setTimeout = originalSetTimeout;
                await Deno.remove(baseDir, { recursive: true });
            }
        });
    }
}

function outgoingContents(events: { path: string; data: FileData | false }[]) {
    return events.map((event) => ({
        path: event.path,
        content: event.data === false ? false : event.data.data instanceof Uint8Array
            ? new TextDecoder().decode(event.data.data) : event.data.data.join(""),
    }));
}

Deno.test("PeerStorage skips a missing file when an outgoing write starts", async () => {
    const baseDir = await Deno.makeTempDir({ prefix: "peer-storage-missing-write-" });
    const path = join(baseDir, "gone.md");
    const { peer, notices } = makeWritePeer(baseDir);
    const dispatched: { path: string; data: FileData | false }[] = [];
    peer.dispatchToHub = (_source, path, data) => {
        dispatched.push({ path, data });
        return Promise.resolve();
    };
    try {
        await peer.dispatch(path);
        await serialized(path, () => Promise.resolve());
        assertEquals(dispatched.length, 0, "A missing file must not produce an outgoing write or deletion");
        assertEquals(notices.length, 0, "A file removed before its write task starts is an expected watcher race");
    } finally {
        await Deno.remove(baseDir, { recursive: true });
    }
});

Deno.test("PeerStorage preserves data after an outgoing read fails", async () => {
    const baseDir = await Deno.makeTempDir({ prefix: "peer-storage-failed-write-" });
    const filename = "note.md";
    const path = join(baseDir, filename);
    const { peer, notices } = makeWritePeer(baseDir);
    const dispatched: { path: string; data: FileData | false }[] = [];
    peer.dispatchToHub = (_source, path, data) => {
        dispatched.push({ path, data });
        return Promise.resolve();
    };
    const originalGet = peer.get.bind(peer);
    try {
        assertEquals(await peer.put(filename, textFileData("received content")), true,
            "The received content should exist before the simulated read failure");
        const repeatHash = peer.cache.get(filename);
        await Deno.writeTextFile(path, "unreadable local edit with more content");
        assertEquals(await peer.isChanged(filename), true, "The local edit should need synchronisation before the failed read");
        peer.get = () => Promise.reject(new Deno.errors.PermissionDenied("Simulated outgoing read failure"));
        await peer.dispatch(path);
        await serialized(path, () => Promise.resolve());
        assertEquals(dispatched.length, 0, "A failed read must not send empty content or a deletion");
        assertEquals(await Deno.readTextFile(path), "unreadable local edit with more content", "A failed read should preserve the local file");
        assertEquals(peer.cache.get(filename), repeatHash, "A failed read should preserve the repeat cache");
        assertEquals(await peer.isChanged(filename), true, "A failed read must leave the local edit eligible for a later offline scan");
        assert(notices.some((message) => message.includes(filename)), "The failed read should identify its file in a notice");

        peer.get = originalGet;
        await Deno.writeTextFile(path, "later readable local edit");
        await peer.dispatch(path);
        await serialized(path, () => Promise.resolve());
        assertEquals(JSON.stringify(outgoingContents(dispatched)),
            JSON.stringify([{ path: filename, content: "later readable local edit" }]),
            "A later readable local change should still reach the Hub");
    } finally {
        peer.get = originalGet;
        await serialized(path, () => Promise.resolve());
        await Deno.remove(baseDir, { recursive: true });
    }
});
