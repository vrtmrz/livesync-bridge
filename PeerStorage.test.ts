import chokidar from "chokidar";
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
        assert(endedPeer.health().ok, "Deno watcher should be healthy while running");

        watchers[0].finish();
        await ended;
        assert(!endedPeer.health().ok, "normal Deno watcher end should make health false");

        const failedPeer = makePeer(tempDir);
        const failed = failedPeer.startDenoFsWatch().catch(() => undefined);
        assertEquals(watchers.length, 2, "second Deno watcher should be created");
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
        assertEquals(watchers.length, 2, "concurrent start should create two Deno watchers");

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
