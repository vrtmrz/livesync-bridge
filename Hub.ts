import { Config, FileData } from "./types.ts";
import { Peer } from "./Peer.ts";
import { PeerStorage } from "./PeerStorage.ts";
import { PeerCouchDB } from "./PeerCouchDB.ts";

export class Hub {
  conf: Config;
  peers = [] as Peer[];
  constructor(conf: Config) {
    this.conf = conf;
  }
  start() {
    for (const p of this.peers) {
      p.stop();
    }
    this.peers = [];
    for (const peer of this.conf.peers) {
      if (peer.type == "couchdb") {
        const p = new PeerCouchDB(peer, this.dispatch.bind(this));
        this.peers.push(p);
      } else if (peer.type == "storage") {
        const p = new PeerStorage(peer, this.dispatch.bind(this));
        this.peers.push(p);
      } else {
        throw new Error(
          `Unexpected Peer type: ${(peer as any)?.name} - ${
            (peer as any)?.type
          }`,
        );
      }
    }
    for (const p of this.peers) {
      p.start();
    }
  }

  async dispatch(source: Peer, path: string, data: FileData | false) {
    for (const peer of this.peers) {
      if (
        peer !== source &&
        (source.config.group ?? "") === (peer.config.group ?? "")
      ) {
        let ret = false;
        try {
          ret = await this.runWithRetry(
            () => (data === false ? peer.delete(path) : peer.put(path, data)),
            `${data === false ? "delete" : "put"} ${peer.config.name} ${path}`,
          );
        } catch (err) {
          // Final failure after retries — log and continue. Dropping the
          // event in memory is better than crashing the dispatcher and
          // losing every other in-flight event in the batch. The next
          // chokidar tick or offline scan will re-discover the change.
          console.error(
            `[Hub] dispatch failed after retries for ${peer.config.name} ${path}:`,
            err,
          );
        }
        if (ret) {
          // Logger(`  ${data === false ? "-x->" : "--->"} ${peer.config.name} ${path} `)
        } else {
          // Logger(`        ${peer.config.name} ignored ${path} `)
        }
      }
    }
  }

  // Retry a peer operation with exponential backoff. Targets the known transient
  // failures from pouchdb-adapter-http (node-fetch socket-handle races under
  // concurrent HTTP requests). Most retries succeed on the first attempt because
  // the underlying socket is fresh.
  private async runWithRetry<T>(
    fn: () => Promise<T>,
    label: string,
    attempts = 4,
  ): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        const message = err instanceof Error ? err.message : String(err);
        const isTransient = message.includes("expected AsyncWrap") ||
          message.includes("socket hang up") ||
          message.includes("ECONNRESET") ||
          message.includes("ETIMEDOUT");
        if (!isTransient) throw err;
        const delayMs = 100 * 2 ** i; // 100, 200, 400, 800 ms
        console.warn(
          `[Hub] transient error on ${label} (attempt ${
            i + 1
          }/${attempts}, retry in ${delayMs}ms): ${message}`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastErr;
  }
}
