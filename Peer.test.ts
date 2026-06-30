import { Peer } from "./Peer.ts";
import type { FileData, PeerStorageConf } from "./types.ts";

function assertEquals<T>(actual: T, expected: T, message: string) {
    if (actual !== expected) {
        throw new Error(`${message}\nactual=${actual}\nexpected=${expected}`);
    }
}

function assert(condition: unknown, message: string) {
    if (!condition) throw new Error(message);
}

class TestPeer extends Peer {
    constructor(baseDir = "") {
        const config: PeerStorageConf = {
            type: "storage",
            name: "test-peer",
            baseDir,
        };
        super(config, async () => {});
    }

    delete(): Promise<boolean> {
        return Promise.resolve(true);
    }

    put(): Promise<boolean> {
        return Promise.resolve(true);
    }

    get(): Promise<false | FileData> {
        return Promise.resolve(false);
    }

    start(): Promise<void> {
        return Promise.resolve();
    }

    stop(): Promise<void> {
        return Promise.resolve();
    }
}

Deno.test("Peer path conversion preserves top-level underscore paths", () => {
    const peer = new TestPeer("");

    assertEquals(peer.toLocalPath("_attachments/file.md"), "_attachments/file.md", "toLocalPath must preserve leading underscore");
    assertEquals(peer.toGlobalPath("_attachments/file.md"), "_attachments/file.md", "toGlobalPath must preserve leading underscore");
});

Deno.test("Peer path conversion applies and removes baseDir without mangling underscores", () => {
    const peer = new TestPeer("vault");

    assertEquals(peer.toLocalPath("_internal/config.json"), "vault/_internal/config.json", "toLocalPath should join baseDir and path");
    assertEquals(peer.toGlobalPath("vault/_internal/config.json"), "/_internal/config.json", "toGlobalPath should remove baseDir only");
});

Deno.test("Peer repetition cache distinguishes first and repeated data", async () => {
    const peer = new TestPeer("");
    const data: FileData = {
        ctime: 1,
        mtime: 1,
        size: 5,
        data: ["hello"],
    };

    assert(!(await peer.isRepeating("note.md", data)), "first observation should not be repeating");
    assert(await peer.isRepeating("note.md", data), "same data on the same path should be repeating");
    assert(!(await peer.isRepeating("other.md", data)), "same data on a different path should not be repeating");
});
