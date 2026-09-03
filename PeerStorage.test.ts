import chokidar from "chokidar";
import { join } from "@std/path";
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
