import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "@std/path";
import { Logger, LOG_LEVEL_INFO } from "octagonal-wheels/common/logger";

// Deno's localStorage is limited to 10 MB per origin. Storage peers keep one
// entry per file, so a vault with tens of thousands of files fills it and every
// later write throws QuotaExceededError. Peer state is therefore kept in a
// SQLite key-value table instead, which has no such limit.

export interface KeyValueSource {
    readonly length: number;
    key(index: number): string | null;
    getItem(key: string): string | null;
}

// Docker images set DENO_DIR, and the Compose file persists
// $DENO_DIR/location_data, where localStorage used to live. Keep the state in
// that same directory so existing volumes and bind mounts continue to apply.
export function defaultStateFile(env: (key: string) => string | undefined = (key) => Deno.env.get(key)): string {
    const explicit = env("LSB_STATE_FILE");
    if (explicit) return explicit;
    const denoDir = env("DENO_DIR");
    if (denoDir) return join(denoDir, "location_data", "livesync-bridge-state.sqlite");
    return join("dat", "livesync-bridge-state.sqlite");
}

export class PeerStateStore {
    private db: DatabaseSync;
    private getStmt;
    private setStmt;
    constructor(readonly path: string) {
        if (path !== ":memory:") Deno.mkdirSync(dirname(path), { recursive: true });
        this.db = new DatabaseSync(path);
        // WAL with NORMAL synchronisation keeps one-row writes fast (70,000
        // writes take seconds rather than minutes) while staying crash-safe.
        this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;");
        this.db.exec("CREATE TABLE IF NOT EXISTS peer_state (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
        this.db.exec("CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
        this.getStmt = this.db.prepare("SELECT value FROM peer_state WHERE key = ?");
        this.setStmt = this.db.prepare(
            "INSERT INTO peer_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        );
    }
    getItem(key: string): string | null {
        const row = this.getStmt.get(key) as { value: string } | undefined;
        return row ? row.value : null;
    }
    setItem(key: string, value: string): void {
        this.setStmt.run(key, `${value}`);
    }
    clear(): void {
        this.db.exec("DELETE FROM peer_state");
    }
    get size(): number {
        return (this.db.prepare("SELECT count(*) AS n FROM peer_state").get() as { n: number }).n;
    }
    // Copy entries written by earlier versions once, so offline scans and CouchDB
    // checkpoints continue where they were. The source is left untouched.
    importOnce(source: KeyValueSource | undefined): number {
        if (!source) return 0;
        const done = this.db.prepare("SELECT value FROM store_meta WHERE key = 'imported-local-storage'").get();
        if (done) return 0;
        let copied = 0;
        this.db.exec("BEGIN");
        try {
            const insert = this.db.prepare("INSERT OR IGNORE INTO peer_state (key, value) VALUES (?, ?)");
            for (let i = 0; i < source.length; i++) {
                const key = source.key(i);
                if (key === null) continue;
                const value = source.getItem(key);
                if (value === null) continue;
                insert.run(key, value);
                copied++;
            }
            this.db.prepare("INSERT INTO store_meta (key, value) VALUES ('imported-local-storage', ?)").run(`${Date.now()}`);
            this.db.exec("COMMIT");
        } catch (ex) {
            this.db.exec("ROLLBACK");
            throw ex;
        }
        return copied;
    }
    close() {
        this.db.close();
    }
}

let store: PeerStateStore | undefined;

function legacyLocalStorage(): KeyValueSource | undefined {
    try {
        return globalThis.localStorage;
    } catch {
        // localStorage is unavailable when no storage location can be derived.
        return undefined;
    }
}

export function getPeerStateStore(): PeerStateStore {
    if (!store) {
        const next = new PeerStateStore(defaultStateFile());
        const copied = next.importOnce(legacyLocalStorage());
        if (copied > 0) Logger(`Copied ${copied} entries from localStorage to ${next.path}`, LOG_LEVEL_INFO);
        store = next;
    }
    return store;
}

// For tests: use a specific store, or reopen the default one on next use.
export function setPeerStateStore(next: PeerStateStore | undefined) {
    store?.close();
    store = next;
}
