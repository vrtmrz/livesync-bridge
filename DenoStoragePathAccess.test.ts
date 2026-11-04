import { resolve } from "@std/path";
import { parseFilePath, type StoragePath } from "@vrtmrz/livesync-commonlib/storage";
import { DenoStoragePathAccess } from "./DenoStoragePathAccess.ts";

function assertEquals<T>(actual: T, expected: T, message: string): void {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`${message}\nactual=${JSON.stringify(actual)}\nexpected=${JSON.stringify(expected)}`);
    }
}

async function assertRejects(
    operation: () => Promise<unknown>,
    matches: (error: unknown) => boolean,
    message: string,
): Promise<void> {
    try {
        await operation();
    } catch (error) {
        if (matches(error)) return;
        throw new Error(`${message}: unexpected rejection ${String(error)}`);
    }
    throw new Error(message);
}

async function readNames(path: string): Promise<string[]> {
    const names: string[] = [];
    for await (const entry of Deno.readDir(path)) names.push(entry.name);
    return names.sort();
}

async function withTempDir(run: (root: string) => Promise<void>): Promise<void> {
    const root = await Deno.makeTempDir();
    try {
        await run(root);
    } finally {
        await Deno.remove(root, { recursive: true });
    }
}

Deno.test("resolves NFC and case aliases to existing names and preserves missing suffix spelling", async () => {
    await withTempDir(async (root) => {
        const existingParent = "e\u0301Parent";
        await Deno.mkdir(`${root}/${existingParent}`);
        await Deno.writeTextFile(`${root}/${existingParent}/Sentinel.TXT`, "sentinel contents");
        const initialRootNames = await readNames(root);
        const initialParentNames = await readNames(`${root}/${existingParent}`);
        const access = new DenoStoragePathAccess(root, false);

        const existing = await access.resolveExisting(parseFilePath("\u00e9parent/sentinel.txt"));
        assertEquals(
            existing,
            parseFilePath(`${existingParent}/Sentinel.TXT`) as StoragePath,
            "existing aliases should retain physical names",
        );
        assertEquals(
            await access.resolveForWrite(parseFilePath("\u00e9parent/NewDir/MiXeD.md")),
            parseFilePath(`${existingParent}/NewDir/MiXeD.md`) as StoragePath,
            "a missing suffix should retain its requested spelling",
        );
        assertEquals(
            await Deno.readTextFile(`${root}/${existingParent}/Sentinel.TXT`),
            "sentinel contents",
            "resolution must not mutate sentinels",
        );
        assertEquals(await readNames(root), initialRootNames, "resolution must not create aliases or directories");
        assertEquals(
            await readNames(`${root}/${existingParent}`),
            initialParentNames,
            "resolution must not create the missing suffix",
        );
    });
});

Deno.test("rejects a file used as a requested path parent", async () => {
    await withTempDir(async (root) => {
        await Deno.writeTextFile(`${root}/file.txt`, "contents");
        const access = new DenoStoragePathAccess(root, true);
        await assertRejects(
            () => access.resolveExisting(parseFilePath("file.txt/child.txt")),
            (error) => error instanceof Error && error.message.includes("parent is not a directory"),
            "a file parent should be rejected",
        );
    });
});

Deno.test("observes external changes made after an earlier resolution", async () => {
    await withTempDir(async (root) => {
        await Deno.writeTextFile(`${root}/Before.txt`, "before");
        const access = new DenoStoragePathAccess(root, false);
        assertEquals(
            await access.resolveExisting(parseFilePath("before.txt")),
            parseFilePath("Before.txt") as StoragePath,
            "the initial physical name should resolve",
        );
        await Deno.remove(`${root}/Before.txt`);
        await Deno.writeTextFile(`${root}/AFTER.TXT`, "after");
        assertEquals(
            await access.resolveExisting(parseFilePath("after.txt")),
            parseFilePath("AFTER.TXT") as StoragePath,
            "a later call should observe the current directory entries",
        );
        assertEquals(
            await access.resolveExisting(parseFilePath("before.txt")),
            null,
            "removed paths should no longer resolve",
        );
    });
});

Deno.test("walks resolved entries once and prunes ignored directories before reading them", async () => {
    await withTempDir(async (root) => {
        await Deno.mkdir(`${root}/visible`, { recursive: true });
        await Deno.mkdir(`${root}/ignored/nested`, { recursive: true });
        await Deno.writeTextFile(`${root}/root.txt`, "root");
        await Deno.writeTextFile(`${root}/visible/child.txt`, "visible");
        await Deno.writeTextFile(`${root}/ignored/secret.txt`, "ignored");
        await Deno.writeTextFile(`${root}/ignored/nested/secret.txt`, "ignored");
        const reads = new Map<string, number>();
        const access = new DenoStoragePathAccess(root, true, (path) => {
            reads.set(path, (reads.get(path) ?? 0) + 1);
            return Deno.readDir(path);
        });

        const files: StoragePath[] = [];
        for await (const path of access.files((path) => path === "ignored" || path.startsWith("ignored/")))
            files.push(path);
        assertEquals(files.sort(), ["root.txt", "visible/child.txt"], "the scan should return only non-ignored files");
        assertEquals(reads.get(access.absolute("" as StoragePath)), 1, "the root should be inspected once");
        assertEquals(
            reads.get(access.absolute("visible" as StoragePath)),
            1,
            "each visible directory should be inspected once",
        );
        assertEquals(
            reads.has(access.absolute("ignored" as StoragePath)),
            false,
            "an ignored directory should be pruned before recursion",
        );
        assertEquals(
            reads.has(access.absolute("ignored/nested" as StoragePath)),
            false,
            "ignored descendants should not be read",
        );
    });
});

Deno.test("propagates PermissionDenied from a controlled directory reader", async () => {
    await withTempDir(async (root) => {
        const denied = Object.assign(new Error("controlled permission denial"), { name: "PermissionDenied" });
        const access = new DenoStoragePathAccess(root, true, () => ({
            [Symbol.asyncIterator](): AsyncIterator<Deno.DirEntry> {
                return { next: () => Promise.reject(denied) };
            },
        }));
        await assertRejects(
            () => access.resolveExisting(parseFilePath("file.txt")),
            (error) => error === denied,
            "PermissionDenied should propagate unchanged",
        );
    });
});

Deno.test("files rejects with the original reader error after yielding a root entry", async () => {
    await withTempDir(async (root) => {
        await Deno.mkdir(`${root}/z-child`);
        const denied = new Deno.errors.PermissionDenied("controlled inventory permission denial");
        const rootPath = resolve(root);
        const access = new DenoStoragePathAccess(root, true, (path) => {
            if (resolve(path) === rootPath) {
                return (async function* () {
                    yield { name: "0-root.txt", isFile: true, isDirectory: false, isSymlink: false } as Deno.DirEntry;
                    yield { name: "z-child", isFile: false, isDirectory: true, isSymlink: false } as Deno.DirEntry;
                })();
            }
            return {
                [Symbol.asyncIterator]() {
                    return { next: () => Promise.reject(denied) };
                },
            };
        });
        const files = access.files(() => false);

        assertEquals<unknown>(
            await files.next(),
            { value: "0-root.txt", done: false },
            "the root file should be yielded before the child directory is read",
        );
        await assertRejects(
            () => files.next(),
            (error) => error === denied,
            "a child reader PermissionDenied should reject the whole inventory unchanged",
        );
    });
});

Deno.test("rejects symlink components in requested paths when symlinks are supported", async () => {
    await withTempDir(async (root) => {
        const outside = await Deno.makeTempDir();
        try {
            await Deno.writeTextFile(`${outside}/outside.txt`, "outside");
            try {
                await Deno.symlink(`${outside}/outside.txt`, `${root}/link.txt`, { type: "file" });
            } catch (error) {
                if (
                    error instanceof Error &&
                    ["PermissionDenied", "NotSupported", "NotImplemented"].includes(error.name)
                )
                    return;
                throw error;
            }

            const access = new DenoStoragePathAccess(root, true);
            await assertRejects(
                () => access.resolveExisting(parseFilePath("link.txt")),
                (error) => error instanceof Error && error.name === "SymbolicLinkStoragePathError",
                "a requested symlink should be rejected before it is followed",
            );
        } finally {
            await Deno.remove(outside, { recursive: true });
        }
    });
});

Deno.test("rejects write paths through a symlinked parent when symlinks are supported", async () => {
    await withTempDir(async (root) => {
        const outside = await Deno.makeTempDir();
        const sentinel = new Uint8Array([0, 255, 10, 0, 195, 169]);
        try {
            await Deno.writeFile(`${outside}/sentinel.bin`, sentinel);
            try {
                await Deno.symlink(outside, `${root}/redirect`, { type: "dir" });
            } catch (error) {
                if (
                    error instanceof Error &&
                    ["PermissionDenied", "NotSupported", "NotImplemented"].includes(error.name)
                )
                    return;
                throw error;
            }

            const access = new DenoStoragePathAccess(root, true);
            await assertRejects(
                () => access.resolveForWrite(parseFilePath("redirect/sentinel.bin")),
                (error) => error instanceof Error && error.name === "SymbolicLinkStoragePathError",
                "a write through a symlinked parent should be rejected before following it",
            );
            assertEquals(
                Array.from(await Deno.readFile(`${outside}/sentinel.bin`)),
                Array.from(sentinel),
                "rejected resolution must preserve the outside sentinel bytes",
            );
        } finally {
            await Deno.remove(outside, { recursive: true });
        }
    });
});

Deno.test("returns null when the configured root disappears", async () => {
    const root = await Deno.makeTempDir();
    const access = new DenoStoragePathAccess(root, true);
    await Deno.remove(root, { recursive: true });
    assertEquals(
        await access.resolveExisting(parseFilePath("missing.txt")),
        null,
        "NotFound should be represented as null",
    );
});
