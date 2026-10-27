import { join } from "@std/path";
import { PeerStorage } from "./PeerStorage.ts";
import type { FileChangeContext } from "./Peer.ts";
import type { FileData } from "./types.ts";

for (const failure of ["none", "save", "read"] as const) {
    const failSave = failure === "save";
    Deno.test(`A paired rename precedes accompanying removal hints, failure ${failure}`, async () => {
        const root = await Deno.makeTempDir({ prefix: "bridge-rename-order-" });
        const delivered: { path: string; data: FileData | false; context?: FileChangeContext }[] = [];
        const peer = new PeerStorage({ type: "storage", name: crypto.randomUUID(), baseDir: root },
            (_source, path, data, context) => {
                if (failSave && data !== false && path.startsWith("after/")) throw new Error("Simulated target save failure");
                delivered.push({ path, data, context });
                return Promise.resolve();
            });
        peer.normalLog = peer.sendLog = () => {};
        peer.setSetting = () => {};
        const get = peer.get.bind(peer);
        peer.get = path => failure === "read" && path.startsWith("after/")
            ? Promise.reject(new Deno.errors.PermissionDenied("Simulated target read failure")) : get(path);
        try {
            const previous = join(root, "before");
            const current = join(root, "after");
            await Deno.mkdir(join(previous, "deep"), { recursive: true });
            await Deno.writeTextFile(join(previous, "deep", "note.md"), "body");
            await peer.writeFileStat("before/deep/note.md");
            await Deno.rename(previous, current);
            peer.processFile({ kind: "remove", paths: [previous] });
            peer.processFile({ kind: "rename", paths: [current] });
            peer.processFile({ kind: "rename", paths: [previous, current] });
            await Deno.writeTextFile(join(root, "independent.md"), "independent");
            peer.processFile({ kind: "create", paths: [join(root, "independent.md")] });
            await peer.stop();
            if (!delivered.some(event => event.path === "independent.md" && event.data !== false)) {
                throw new Error("An accepted independent file must still be delivered after a rename failure");
            }
            if (failure !== "none") {
                if (delivered.some(event => event.data === false)) {
                    throw new Error("A failed confirmed target save must preserve the source despite removal hints");
                }
            } else {
                const first = delivered[0];
                if (first?.path !== "after/deep/note.md" || first.data === false ||
                    first.context?.previousPath !== "before/deep/note.md") {
                    throw new Error(`The confirmed target must be delivered before deletion: ${JSON.stringify(delivered)}`);
                }
                if (!delivered.some(event => event.path === "before/deep/note.md" && event.data === false)) {
                    throw new Error("The old path must be reconciled after successful target delivery");
                }
            }
        } finally {
            await peer.stop();
            await Deno.remove(root, { recursive: true });
        }
    });
}
