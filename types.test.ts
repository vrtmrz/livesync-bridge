import { isCouchDBPeer, isStoragePeer, type PeerConf } from "./types.ts";

function assert(condition: unknown, message: string) {
    if (!condition) throw new Error(message);
}

Deno.test("peer type guards identify storage and CouchDB peers", () => {
    const storage: PeerConf = {
        type: "storage",
        name: "files",
        baseDir: "vault",
    };
    const couchdb: PeerConf = {
        type: "couchdb",
        name: "remote",
        database: "db",
        username: "user",
        password: "pass",
        url: "http://localhost:5984",
        passphrase: "",
        obfuscatePassphrase: "",
        baseDir: "",
    };

    assert(isStoragePeer(storage), "storage peer should match storage guard");
    assert(!isCouchDBPeer(storage), "storage peer should not match CouchDB guard");
    assert(isCouchDBPeer(couchdb), "CouchDB peer should match CouchDB guard");
    assert(!isStoragePeer(couchdb), "CouchDB peer should not match storage guard");
});
