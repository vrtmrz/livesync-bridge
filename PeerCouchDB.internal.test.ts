import { DirectFileManipulator } from "@vrtmrz/livesync-commonlib";
import { PeerCouchDB } from "./PeerCouchDB.ts";
import type { PeerCouchDBConf } from "./types.ts";

function assertEquals(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}: expected=${expected}, actual=${actual}`);
  }
}

type InternalPeer = {
  _buildManipulator(): void;
  _connectAndWatch(): Promise<void>;
};

function makePeer(
  overrides: Partial<PeerCouchDBConf> & { syncInternalFiles?: boolean } = {},
) {
  const peer = new PeerCouchDB({
    type: "couchdb",
    name: "internal-peer",
    baseDir: "",
    url: "https://example.test",
    database: "notes",
    username: "",
    password: "",
    passphrase: "",
    obfuscatePassphrase: "",
    ...overrides,
  }, async () => {});
  const settings = new Map<string, string>();
  peer.getSetting = (key) => settings.get(key) ?? null;
  peer.setSetting = (key, value) => {
    settings.set(key, value);
  };
  peer.normalLog = () => {};
  return peer;
}

async function withManipulator(
  overrides: Partial<PeerCouchDBConf> & { syncInternalFiles?: boolean },
  check: (peer: PeerCouchDB) => Promise<void> | void,
) {
  const init = DirectFileManipulator.prototype.init;
  DirectFileManipulator.prototype.init = function () {
    this.ready.resolve();
    return Promise.resolve();
  };
  const peer = makePeer(overrides);
  try {
    (peer as unknown as InternalPeer)._buildManipulator();
    await peer.man.ready.promise;
    await check(peer);
  } finally {
    DirectFileManipulator.prototype.init = init;
    await peer.man?.close();
  }
}

for (
  const { description, includeInternal, syncInternalFiles, expected } of [
    {
      description: "a configured pattern",
      includeInternal: [".claude/**"],
      syncInternalFiles: undefined,
      expected: true,
    },
    {
      description: "an omitted includeInternal",
      includeInternal: undefined,
      syncInternalFiles: undefined,
      expected: false,
    },
    {
      description: "an empty includeInternal",
      includeInternal: [],
      syncInternalFiles: undefined,
      expected: false,
    },
    {
      description: "a raw flag without patterns",
      includeInternal: undefined,
      syncInternalFiles: true,
      expected: false,
    },
    {
      description: "patterns with a false raw flag",
      includeInternal: [".claude/**"],
      syncInternalFiles: false,
      expected: true,
    },
  ]
) {
  Deno.test(`PeerCouchDB derives internal-file access from ${description}`, async () => {
    await withManipulator({ includeInternal, syncInternalFiles }, (peer) => {
      assertEquals(
        peer.man.settings.syncInternalFiles,
        expected,
        "The library must allow hidden-file reads only when includeInternal has patterns",
      );
      assertEquals(
        peer.man.services.setting.currentSettings().syncInternalFiles,
        expected,
        "The database services must receive the same internal-file permission",
      );
    });
  });
}

Deno.test("PeerCouchDB retains internal-file access after remote tweaks and a rebuild", async () => {
  await withManipulator({
    includeInternal: [".claude/**"],
    useRemoteTweaks: true,
  }, async (peer) => {
    const man = peer.man;
    man.rawGet = (() =>
      Promise.resolve({
        created: 1,
        tweak_values: { PREFERRED: {} },
      })) as typeof man.rawGet;
    let initialised = false;
    man.liveSyncLocalDB.initializeDatabase = () => {
      initialised = true;
      assertEquals(
        man.settings.syncInternalFiles,
        true,
        "Remote tweaks must preserve the permission before reinitialising the database",
      );
      return Promise.resolve(true);
    };
    man.beginWatch = () => false;
    await (peer as unknown as InternalPeer)._connectAndWatch();
    assertEquals(
      initialised,
      true,
      "The remote-tweak path must reinitialise the database",
    );
    (peer as unknown as InternalPeer)._buildManipulator();
    assertEquals(
      peer.man.settings.syncInternalFiles,
      true,
      "A replacement manipulator must preserve the includeInternal permission",
    );
  });
});
