import { join } from "@std/path";
import { defaultStateFile, PeerStateStore, setPeerStateStore } from "./PeerState.ts";
import { PeerStorage } from "./PeerStorage.ts";

function assertEquals<T>(actual: T, expected: T, message: string) {
    if (actual !== expected) {
        throw new Error(`${message}\nactual=${String(actual)}\nexpected=${String(expected)}`);
    }
}

class MapSource {
    constructor(private map: Map<string, string>) {}
    get length() {
        return this.map.size;
    }
    key(index: number) {
        return [...this.map.keys()][index] ?? null;
    }
    getItem(key: string) {
        return this.map.get(key) ?? null;
    }
}

Deno.test("state file follows LSB_STATE_FILE, then DENO_DIR, then dat/", () => {
    const env = (values: Record<string, string>) => (key: string) => values[key];
    assertEquals(defaultStateFile(env({ LSB_STATE_FILE: "/x/state.sqlite", DENO_DIR: "/deno-dir" })), "/x/state.sqlite", "explicit path");
    assertEquals(
        defaultStateFile(env({ DENO_DIR: "/deno-dir" })),
        join("/deno-dir", "location_data", "livesync-bridge-state.sqlite"),
        "the Docker volume used for localStorage",
    );
    assertEquals(defaultStateFile(env({})), join("dat", "livesync-bridge-state.sqlite"), "fallback");
});

Deno.test("peer state keeps more than localStorage's 10 MB limit and survives reopening", async () => {
    const dir = await Deno.makeTempDir();
    try {
        const path = join(dir, "state.sqlite");
        const value = "x".repeat(200);
        let store = new PeerStateStore(path);
        // 70,000 entries of about 300 bytes: well above 10 MB.
        for (let i = 0; i < 70_000; i++) store.setItem(`storage-peer-./vault/-file-stat-folder/${i}.md`, `${i}-${value}`);
        store.close();
        store = new PeerStateStore(path);
        assertEquals(store.size, 70_000, "all entries must be kept");
        assertEquals(store.getItem("storage-peer-./vault/-file-stat-folder/69999.md"), `69999-${value}`, "the last entry must be readable");
        assertEquals(store.getItem("missing"), null, "a missing key reads as null like localStorage");
        store.setItem("storage-peer-./vault/-file-stat-folder/1.md", "updated");
        assertEquals(store.getItem("storage-peer-./vault/-file-stat-folder/1.md"), "updated", "a write replaces the value");
        store.close();
    } finally {
        await Deno.remove(dir, { recursive: true });
    }
});

Deno.test("entries from localStorage are copied once without overwriting newer state", () => {
    const store = new PeerStateStore(":memory:");
    try {
        store.setItem("since", "newer");
        const source = new Map([["since", "older"], ["file-stat-a.md", "1-2"]]);
        assertEquals(store.importOnce(new MapSource(source)), 2, "both legacy entries are read");
        assertEquals(store.getItem("since"), "newer", "existing state must win");
        assertEquals(store.getItem("file-stat-a.md"), "1-2", "missing state must be copied");
        source.set("file-stat-b.md", "3-4");
        assertEquals(store.importOnce(new MapSource(source)), 0, "the copy must happen only once");
        assertEquals(store.getItem("file-stat-b.md"), null, "later legacy writes must not be imported");
        store.clear();
        assertEquals(store.size, 0, "clear removes every entry");
    } finally {
        store.close();
    }
});

// Regression: with localStorage, a vault of this size stopped being synchronised
// once the quota was reached, because the per-file state write failed before
// the file was dispatched.
Deno.test("an offline scan of a large vault dispatches every file", async () => {
    const N = 40_000;
    const dir = await Deno.makeTempDir();
    setPeerStateStore(new PeerStateStore(":memory:"));
    let dispatched = 0;
    const peer = new PeerStorage({
        type: "storage",
        name: `state-peer-${crypto.randomUUID()}`,
        // A long base directory makes every key long, as in real deployments.
        baseDir: `${dir}/${"long-vault-folder-name-".repeat(4)}/`,
        scanOfflineChanges: true,
        useChokidar: false,
    }, () => {
        dispatched++;
        return Promise.resolve();
    });
    try {
        const base = `${dir}/${"long-vault-folder-name-".repeat(4)}`;
        for (let d = 0; d < 40; d++) {
            await Deno.mkdir(join(base, `folder-${d}`), { recursive: true });
        }
        for (let i = 0; i < N; i++) {
            await Deno.writeTextFile(join(base, `folder-${i % 40}`, `${i} ${"a note with a fairly long title ".repeat(3)}.md`), `${i}`);
        }
        // start() keeps running while the watcher is open.
        const running = peer.start();
        const deadline = Date.now() + 180_000;
        let last = -1;
        let idleSince = Date.now();
        while (dispatched < N && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 500));
            if (dispatched !== last) {
                last = dispatched;
                idleSince = Date.now();
            } else if (Date.now() - idleSince > 20_000) {
                break;
            }
        }
        await peer.stop();
        await running;
        assertEquals(dispatched, N, "every file must reach the hub");
    } finally {
        await peer.stop();
        setPeerStateStore(undefined);
        await Deno.remove(dir, { recursive: true });
    }
});
