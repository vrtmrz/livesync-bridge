import {
    createStoragePathResolver,
    parseFilePath,
    type DirectoryEntry,
    type FilePath,
    type ReadDirectory,
    type StoragePath,
    type StoragePathResolver,
} from "@vrtmrz/livesync-commonlib/storage";
import { join, resolve } from "@std/path";

type DenoReadDirectory = (path: string) => AsyncIterable<Deno.DirEntry>;

class SymbolicLinkStoragePathError extends Error {
    constructor(path: string) {
        super(`Storage paths must not contain symbolic links: ${path}`);
        this.name = "SymbolicLinkStoragePathError";
    }
}

function isNotFound(error: unknown): boolean {
    return error instanceof Deno.errors.NotFound;
}

/** Root-relative NFC path access for Deno-backed peer storage. */
export class DenoStoragePathAccess {
    private readonly rootPath: string;
    private readonly resolver: StoragePathResolver;

    constructor(
        rootPath: string,
        readonly handleFilenameCaseSensitive: boolean,
        readDir: DenoReadDirectory = (path) => Deno.readDir(path),
    ) {
        this.rootPath = resolve(rootPath);
        const policy = Object.freeze({
            pathNormalizationVersion: 1 as const,
            handleFilenameCaseSensitive,
        });
        const readDirectory: ReadDirectory = async (physicalDirectory) => {
            if (!(await this.assertNoSymbolicLinks(physicalDirectory))) return null;

            const directoryEntries: DirectoryEntry[] = [];
            try {
                for await (const entry of readDir(this.absolute(physicalDirectory))) {
                    if (entry.isDirectory) directoryEntries.push({ name: entry.name, kind: "directory" });
                    else if (entry.isFile) directoryEntries.push({ name: entry.name, kind: "file" });
                }
            } catch (error) {
                if (isNotFound(error)) return null;
                throw error;
            }
            return directoryEntries;
        };
        this.resolver = createStoragePathResolver({ readDirectory, policy });
    }

    async resolveExisting(path: FilePath): Promise<StoragePath | null> {
        const requested = parseFilePath(path);
        await this.assertNoSymbolicLinks(requested);
        const resolvedPath = await this.resolver.resolveExisting(requested);
        if (resolvedPath !== null) await this.assertNoSymbolicLinks(resolvedPath);
        return resolvedPath;
    }

    async resolveForWrite(path: FilePath): Promise<StoragePath> {
        const requested = parseFilePath(path);
        await this.assertNoSymbolicLinks(requested);
        const resolvedPath = await this.resolver.resolveForWrite(requested);
        await this.assertNoSymbolicLinks(resolvedPath);
        return resolvedPath;
    }

    absolute(path: StoragePath): string {
        return join(this.rootPath, path);
    }

    async *files(isIgnored: (path: StoragePath) => boolean): AsyncGenerator<StoragePath> {
        const visitedDirectories = new Set<StoragePath>();
        const walk = async function* (
            access: DenoStoragePathAccess,
            directory: StoragePath,
        ): AsyncGenerator<StoragePath> {
            if (visitedDirectories.has(directory)) return;
            visitedDirectories.add(directory);

            const entries = await access.resolver.listResolvedDirectory(directory);
            if (entries === null) return;
            for (const entry of entries) {
                if (isIgnored(entry.path)) continue;
                if (entry.kind === "file") yield entry.path;
                else yield* walk(access, entry.path);
            }
        };

        yield* walk(this, "" as StoragePath);
    }

    /** Return false only when a component is absent; callers then retain normal resolution behaviour. */
    private async assertNoSymbolicLinks(path: FilePath | StoragePath): Promise<boolean> {
        const segments = path.split("/").filter(Boolean);
        let currentPath = "" as StoragePath;
        for (let index = 0; index < segments.length; index++) {
            currentPath = (currentPath === "" ? segments[index] : `${currentPath}/${segments[index]}`) as StoragePath;
            let stat: Deno.FileInfo;
            try {
                stat = await Deno.lstat(this.absolute(currentPath));
            } catch (error) {
                if (isNotFound(error)) return false;
                throw error;
            }
            if (stat.isSymlink) throw new SymbolicLinkStoragePathError(this.absolute(currentPath));
            // Let the resolver report a regular file used as a parent with its own path context.
            if (index < segments.length - 1 && !stat.isDirectory) break;
        }
        return true;
    }
}
