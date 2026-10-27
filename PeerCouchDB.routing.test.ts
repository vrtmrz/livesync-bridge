import { DirectFileManipulator } from "@vrtmrz/livesync-commonlib";
import type { FilePathWithPrefix } from "@vrtmrz/livesync-commonlib/compat/common/types";
import { Hub } from "./Hub.ts";
import { PeerCouchDB } from "./PeerCouchDB.ts";
import type { FileData, PeerCouchDBConf } from "./types.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function equal(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected=${JSON.stringify(expected)}, actual=${
        JSON.stringify(actual)
      }`,
    );
  }
}

type Doc = {
  _id: string;
  path: string;
  type: "plain";
  data: string[];
  ctime: number;
  mtime: number;
  size: number;
  deleted?: boolean;
  _deleted?: boolean;
};
type InternalPeer = {
  _started: { resolve(): void };
  _connectAndWatch(): Promise<void>;
};
function doc(path: string, text = "remote"): Doc {
  return {
    _id: `id:${path}`,
    path,
    type: "plain",
    data: [text],
    ctime: 1,
    mtime: 2,
    size: text.length,
  };
}
function data(text = "edited"): FileData {
  return { data: [text], ctime: 1, mtime: 6000, size: text.length };
}

function fixture(
  overrides: Partial<PeerCouchDBConf> = {},
  documents = new Map<string, Doc>(),
) {
  const delivered: { path: string; data: FileData | false }[] = [];
  const notices: string[] = [];
  const mutations: string[] = [];
  const loaded: string[] = [];
  let aliasFailure = false;
  let onChange!: (change: { seq: string; doc: Doc }) => Promise<void>;
  const peer = new PeerCouchDB({
    type: "couchdb",
    name: "routing-peer",
    baseDir: "",
    includeInternal: [".claude/**"],
    url: "https://example.test",
    database: "unused",
    username: "",
    password: "",
    passphrase: "",
    obfuscatePassphrase: "",
    ...overrides,
  }, (_source, path, value) => {
    delivered.push({ path, data: value });
    return Promise.resolve();
  });
  peer.getSetting = () => null;
  peer.setSetting = () => {};
  peer.normalLog = (message) => notices.push(message);
  peer.receiveLog = () => {};
  peer.sendLog = () => {};
  const feed = {
    on(event: string, callback: unknown) {
      if (event === "change") onChange = callback as typeof onChange;
      return feed;
    },
    cancel() {},
  };
  peer.man = {
    ready: { promise: Promise.resolve() },
    since: "",
    watching: false,
    path2id: (path: string) => Promise.resolve(`id:${path}`),
    rawGet: (id: string) => {
      if (!id.startsWith("id:")) return Promise.resolve({ created: 1 });
      if (aliasFailure) {
        return Promise.reject(new Error("Simulated alias inspection failure"));
      }
      return Promise.resolve(documents.get(id.substring(3)) ?? false);
    },
    get: (path: string) => {
      const entry = documents.get(path);
      return Promise.resolve(
        entry && !entry.deleted && !entry._deleted ? entry : false,
      );
    },
    getById: (id: string) => Promise.resolve(documents.get(id.substring(3)) ?? false),
    getByMeta: (entry: Doc) => {
      loaded.push(entry.path);
      return Promise.resolve(entry);
    },
    put: async (path: string, blob: Blob) => {
      mutations.push(`put:${path}`);
      documents.set(path, doc(path, await blob.text()));
      return true;
    },
    delete: (path: string) => {
      mutations.push(`delete:${path}`);
      const entry = documents.get(path);
      if (!entry) return Promise.resolve(false);
      documents.set(path, { ...entry, deleted: true });
      return Promise.resolve(true);
    },
    liveSyncLocalDB: { localDatabase: { changes: () => feed } },
    beginWatch: DirectFileManipulator.prototype.beginWatch,
  } as unknown as DirectFileManipulator;
  (peer as unknown as InternalPeer)._started.resolve();
  return {
    peer,
    documents,
    delivered,
    notices,
    mutations,
    loaded,
    failAlias() {
      aliasFailure = true;
    },
    async watch() {
      await (peer as unknown as InternalPeer)._connectAndWatch();
    },
    emit(path: string, deleted = false) {
      return onChange({ seq: "1", doc: { ...doc(path), deleted } });
    },
  };
}
const shared = ".claude/settings.json";
const internal = `i:${shared}`;
const operations = ["get", "getMeta", "put", "delete"] as const;
async function operate(
  peer: PeerCouchDB,
  operation: typeof operations[number],
  path = shared,
) {
  if (operation === "put") return await peer.put(path, data());
  if (operation === "delete") return await peer.delete(path);
  return await peer[operation](path as FilePathWithPrefix);
}

for (const baseDir of ["", "blog", "blog/"]) {
  Deno.test(`internal receive preserves the complete path below baseDir=${JSON.stringify(baseDir)}`, async () => {
    const f = fixture({ baseDir });
    await f.watch();
    await f.emit(internal);
    await f.emit(internal, true);
    equal(f.delivered.map((x) => [x.path, x.data === false]), [
      [shared, false],
      [shared, true],
    ], "Internal create and deletion must use the Vault-root shared path");
  });
}
for (
  const [baseDir, path, expected] of [
    ["blog/", "blog/note.md", "note.md"],
    ["blog", "blog/note.md", "note.md"],
    ["blog/", "blog/blog/note.md", "blog/note.md"],
    ["blog", "blogger/note.md", false],
  ] as const
) {
  Deno.test(`ordinary receive respects one folder boundary: ${baseDir} -> ${path}`, async () => {
    const f = fixture({ baseDir });
    await f.watch();
    await f.emit(path);
    equal(
      f.delivered.map((x) => x.path),
      expected === false ? [] : [expected],
      "Ordinary projection must trim its sharing folder once and exclude siblings",
    );
  });
}
for (
  const [baseDir, path] of [
    ["", ".obsidian/app.json"],
    ["blog/", "blog/.claude/settings.json"],
    [".claude/", ".claude/settings.json"],
    ["", "i:note.md"],
    ["", "i:.claude//settings.json"],
    ["", "i:.claude/../settings.json"],
    ["", "ix:.claude/settings.json"],
    ["", "ps:.claude/settings.json"],
  ] as const
) {
  Deno.test(`receive excludes non-canonical or ordinary hidden path: ${baseDir} -> ${path}`, async () => {
    const f = fixture({ baseDir, includeInternal: ["**"] });
    await f.watch();
    await f.emit(path);
    equal(f.loaded, [], "Excluded content must be rejected before loading");
    equal(f.delivered, [], "Excluded content must not reach the Hub");
  });
}

for (const baseDir of ["", "blog/"]) {
  for (const operation of operations) {
    Deno.test(`${operation} resolves the internal identity below baseDir=${JSON.stringify(baseDir)}`, async () => {
      const f = fixture({ baseDir });
      f.documents.set(internal, doc(internal));
      const result = await operate(f.peer, operation);
      assert(result !== false, "A selected internal operation should succeed");
      if (operation === "get") {
        equal(
          (result as FileData).data,
          ["remote"],
          "Read the internal content",
        );
      }
      if (operation === "getMeta") {
        equal((result as FileData).size, 6, "Read the internal Metadata");
      }
      if (operation === "put") {
        equal(
          f.documents.get(internal)?.data,
          ["edited"],
          "Update the internal document",
        );
      }
      if (operation === "delete") {
        equal(
          f.documents.get(internal)?.deleted,
          true,
          "Delete the internal document",
        );
      }
      equal(
        f.documents.has(`${baseDir}${shared}`),
        false,
        "Do not create an ordinary alias",
      );
    });
  }
  Deno.test(`new hidden file and fresh peer retain i: identity below baseDir=${JSON.stringify(baseDir)}`, async () => {
    const first = fixture({ baseDir });
    assert(
      await first.peer.put(shared, data("created")),
      "Create a new selected hidden file",
    );
    equal(
      first.documents.get(internal)?.data,
      ["created"],
      "New local files must create an internal document",
    );
    const restored = fixture({ baseDir }, first.documents);
    assert(
      await restored.peer.put(shared, data("after restart")),
      "Edit through a peer with no repeat history",
    );
    equal(
      restored.documents.get(internal)?.data,
      ["after restart"],
      "The fresh peer must keep the identity",
    );
    assert(await restored.peer.delete(shared), "Delete through the fresh peer");
    equal(
      restored.documents.get(internal)?.deleted,
      true,
      "Delete the same internal document",
    );
    equal(
      restored.documents.has(`${baseDir}${shared}`),
      false,
      "Never create a legacy ordinary alias",
    );
  });
  for (const includeInternal of [undefined, [], [".claude/**"]]) {
    Deno.test(`excluded hidden operations have no effects: ${baseDir}, ${JSON.stringify(includeInternal)}`, async () => {
      const f = fixture({ baseDir, includeInternal, syncInternalFiles: true });
      for (const operation of operations) {
        equal(
          await operate(f.peer, operation, ".obsidian/app.json"),
          false,
          "Reject every excluded operation",
        );
      }
      equal(f.mutations, [], "Do not mutate hidden aliases");
      equal(
        f.peer.cache.has(".obsidian/app.json"),
        false,
        "Do not cache an excluded change as a repeat",
      );
    });
  }
}
for (const operation of operations) {
  Deno.test(`${operation} refuses a live ordinary alias without changing either document`, async () => {
    const f = fixture({ baseDir: "blog/" });
    const alias = `blog/${shared}`;
    f.documents.set(internal, doc(internal));
    f.documents.set(alias, doc(alias, "legacy"));
    equal(
      await operate(f.peer, operation),
      false,
      "A live alias must block internal access",
    );
    equal(
      f.documents.get(internal),
      doc(internal),
      "Keep the internal document unchanged",
    );
    equal(
      f.documents.get(alias),
      doc(alias, "legacy"),
      "Keep the ordinary document unchanged",
    );
    equal(f.mutations, [], "Do not mutate either identity");
    equal(
      f.peer.cache.has(shared),
      false,
      "Do not suppress a later valid operation",
    );
    assert(
      f.notices.some((s) => s.includes(internal) && s.includes(alias)),
      "Report both conflicting paths",
    );
  });
  Deno.test(`${operation} refuses access when alias inspection fails`, async () => {
    const f = fixture();
    f.documents.set(internal, doc(internal));
    f.failAlias();
    equal(
      await operate(f.peer, operation),
      false,
      "Failed inspection must not authorise access",
    );
    equal(f.mutations, [], "Keep data unchanged on inspection failure");
    equal(f.peer.cache.has(shared), false, "Do not cache a rejected operation");
    assert(
      f.notices.some((s) => s.includes(internal) && s.includes(shared)),
      "Report failed alias inspection",
    );
  });
}
for (const deleted of [false, true]) {
  Deno.test(`watch refuses a colliding internal ${deleted ? "deletion" : "write"} without recording a repeat`, async () => {
    const f = fixture({ baseDir: "blog/" });
    const alias = `blog/${shared}`;
    f.documents.set(alias, doc(alias, "legacy"));
    await f.watch();
    await f.emit(internal, deleted);
    equal(f.delivered, [], "Do not deliver a colliding write or deletion");
    equal(
      f.peer.cache.has(shared),
      false,
      "A rejected event must not become a repeat",
    );
    f.documents.set(alias, { ...doc(alias), deleted: true });
    await f.emit(internal, deleted);
    equal(f.delivered.map((x) => [x.path, x.data === false]), [[
      shared,
      deleted,
    ]], "A new event after removing the live alias must be deliverable");
  });
}
for (const flag of ["deleted", "_deleted"] as const) {
  Deno.test(`a deleted ordinary alias (${flag}) does not block a new internal file`, async () => {
    const f = fixture({ baseDir: "blog/" });
    const alias = `blog/${shared}`;
    f.documents.set(alias, { ...doc(alias), [flag]: true });
    assert(
      await f.peer.put(shared, data()),
      "A deleted alias must not block internal creation",
    );
    equal(
      f.documents.get(internal)?.data,
      ["edited"],
      "Create the internal document",
    );
    equal(f.documents.get(alias)?.[flag], true, "Keep the alias deleted");
  });
}
Deno.test("ordinary notes stay ordinary under a broad internal pattern", async () => {
  const f = fixture({ baseDir: "blog/", includeInternal: ["**"] });
  assert(
    await f.peer.put("note.md", data()),
    "Ordinary note creation must remain available",
  );
  equal(
    f.documents.get("blog/note.md")?.data,
    ["edited"],
    "Use the ordinary sharing folder",
  );
  equal(
    f.documents.has("i:note.md"),
    false,
    "Do not redirect ordinary notes into i:",
  );
});
Deno.test("raw namespace and invalid relative paths cannot bypass outgoing routing", async () => {
  const f = fixture({ baseDir: "blog/", includeInternal: ["**"] });
  for (
    const path of [
      "i:.claude/x",
      "ix:.claude/x",
      "../x",
      "/.claude/x",
      ".claude//x",
      ".claude/../x",
    ]
  ) {
    for (const operation of operations) {
      equal(
        await operate(f.peer, operation, path),
        false,
        "Reject invalid shared paths",
      );
    }
  }
  equal(
    f.mutations,
    [],
    "Never mutate a path reached by bypassing the shared-path contract",
  );
});
Deno.test("each CouchDB destination enforces its own hidden-file selection", async () => {
  const source = fixture();
  const excluded = fixture({ baseDir: "blog/", includeInternal: undefined });
  const included = fixture({ baseDir: "archive/" });
  const hub = new Hub({ peers: [] });
  hub.peers = [source.peer, excluded.peer, included.peer];
  source.peer.dispatchToHub = (peer, path, value) =>
    hub.dispatch(peer, path, value);
  await source.watch();
  await source.emit(internal);
  equal(
    excluded.mutations,
    [],
    "A source opt-in must not authorise the other destination",
  );
  equal(
    included.documents.get(internal)?.data,
    ["remote"],
    "An opted-in destination writes the same internal identity",
  );
  equal(
    included.documents.has(`archive/${shared}`),
    false,
    "Do not fall back to an ordinary destination path",
  );
});

Deno.test("a hidden sharing folder cannot create ordinary hidden Metadata", async () => {
  const f = fixture({ baseDir: ".claude/" });
  for (const operation of operations) {
    equal(
      await operate(f.peer, operation, "note.md"),
      false,
      "Reject the hidden ordinary Vault path",
    );
  }
  equal(
    f.mutations,
    [],
    "Do not bypass the internal namespace through baseDir",
  );
});
for (const includeInternal of [undefined, []]) {
  Deno.test(`incoming internals remain opt-in: ${JSON.stringify(includeInternal)}`, async () => {
    const f = fixture({ includeInternal, syncInternalFiles: true });
    await f.watch();
    await f.emit(internal);
    equal(f.loaded, [], "A raw permission must not bypass incoming selection");
    equal(
      f.delivered,
      [],
      "Missing and empty lists must not deliver internal files",
    );
  });
}
Deno.test("watch does not deliver an internal file after alias inspection failure", async () => {
  const f = fixture();
  f.failAlias();
  await f.watch();
  await f.emit(internal);
  equal(f.delivered, [], "Failed alias inspection must block incoming content");
  equal(
    f.peer.cache.has(shared),
    false,
    "Keep a rejected event out of repeat suppression",
  );
  assert(f.notices.length > 0, "Report failed inspection");
});
Deno.test("dot matching includes hidden subdirectories in a selected internal path", async () => {
  const f = fixture({ includeInternal: ["**"] });
  await f.watch();
  await f.emit("i:.claude/.nested/settings.json");
  equal(
    f.delivered.map((x) => x.path),
    [".claude/.nested/settings.json"],
    "Match the full hidden path with dot enabled",
  );
});
