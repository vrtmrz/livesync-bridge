import { join, relative } from "@std/path";
import { PeerStorage } from "../../PeerStorage.ts";
import type { FileData, PeerStorageConf } from "../../types.ts";
import { watcherTest } from "./watcherTest.ts";

type Dispatch = {
  path: string;
  data: FileData | false;
};

type TraceEvent =
  | { type: "stage" }
  | { type: "native"; kind: string; paths: string[]; relativePaths: string[] }
  | { type: "dispatch"; path: string; content: string | false };

type WatcherTrace = {
  startedAt: number;
  stage: string;
  events: Array<TraceEvent & { elapsedMs: number; stage: string }>;
};

type Harness = {
  peer: PeerStorage;
  useChokidar: boolean;
  dispatches: Dispatch[];
  startFailures: unknown[];
  startPromises: Promise<void>[];
  trace?: WatcherTrace;
};

type HarnessOptions = {
  scanOfflineChanges?: boolean;
  ignore?: string[];
  traceNativeEvents?: boolean;
};

const WATCHERS = [
  { useChokidar: false, name: "Deno.watchFs" },
  { useChokidar: true, name: "Chokidar" },
] as const;
const WAIT_TIMEOUT_MS = 12_000;
const QUIET_WINDOW_MS = 1_100;
const POLL_INTERVAL_MS = 25;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function contentOf(data: FileData | false): string | false {
  if (data === false) return false;
  return data.data instanceof Uint8Array
    ? new TextDecoder().decode(data.data)
    : data.data.join("");
}

function bytesOf(data: FileData | false): number[] | false {
  if (data === false) return false;
  if (data.data instanceof Uint8Array) return Array.from(data.data);
  return Array.from(new TextEncoder().encode(data.data.join("")));
}

function bytesEqual(actual: number[] | false, expected: number[]): boolean {
  return actual !== false && actual.length === expected.length &&
    actual.every((byte, index) => byte === expected[index]);
}

function errorText(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function recordTrace(trace: WatcherTrace | undefined, event: TraceEvent): void {
  if (!trace) return;
  trace.events.push({
    ...event,
    elapsedMs: Math.round(performance.now() - trace.startedAt),
    stage: trace.stage,
  });
}

function traceStage(harness: Harness, stage: string): void {
  if (!harness.trace) return;
  harness.trace.stage = stage;
  recordTrace(harness.trace, { type: "stage" });
}

function observeNativeWatcher(
  baseDir: string,
  trace: WatcherTrace | undefined,
): () => void {
  if (!trace) return () => {};
  const originalWatchFs = Deno.watchFs;
  // Observe the iterator consumed by PeerStorage, preserving its events and options.
  // A second watcher could affect event delivery and the behaviour under test.
  Deno.watchFs = ((...args: Parameters<typeof Deno.watchFs>) => {
    const watcher = originalWatchFs(...args);
    const iterator = watcher[Symbol.asyncIterator]();
    return {
      async next() {
        const result = await iterator.next();
        if (!result.done) {
          recordTrace(trace, {
            type: "native",
            kind: result.value.kind,
            paths: [...result.value.paths],
            relativePaths: result.value.paths.map((path) =>
              relative(baseDir, path).replaceAll("\\", "/")
            ),
          });
        }
        return result;
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      close: () => watcher.close(),
      [Symbol.dispose]: () => watcher.close(),
    } as unknown as Deno.FsWatcher;
  }) as typeof Deno.watchFs;
  return () => {
    Deno.watchFs = originalWatchFs;
  };
}

function diagnostics(harness: Harness, stage: string): string {
  const events = harness.dispatches.map(({ path, data }) => ({
    path,
    content: contentOf(data),
    bytes: bytesOf(data),
  }));
  const failures = harness.startFailures.map(errorText);
  return [
    `backend=${harness.useChokidar ? "Chokidar" : "Deno.watchFs"}`,
    `Deno=${Deno.version.deno}, os=${Deno.build.os}, arch=${Deno.build.arch}`,
    `stage=${stage}`,
    `start failures=${JSON.stringify(failures)}`,
    `dispatches=${JSON.stringify(events)}`,
    ...(harness.trace
      ? [`watcher trace=${JSON.stringify(harness.trace.events)}`]
      : []),
  ].join("\n");
}

function assertNoStartFailures(harness: Harness, stage: string): void {
  if (harness.startFailures.length > 0) {
    throw new Error(`Watcher start failed.\n${diagnostics(harness, stage)}`);
  }
}

async function waitFor(
  harness: Harness,
  condition: () => boolean,
  stage: string,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertNoStartFailures(harness, stage);
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(
    `Timed out waiting for watcher state.\n${diagnostics(harness, stage)}`,
  );
}

function dispatchCount(
  harness: Harness,
  path: string,
  content: string | false,
): number {
  return harness.dispatches.filter((dispatch) =>
    dispatch.path === path && contentOf(dispatch.data) === content
  ).length;
}

async function expectDispatchesOnce(
  harness: Harness,
  expected: Dispatch[],
  stage: string,
): Promise<void> {
  await waitFor(
    harness,
    () =>
      expected.every(({ path, data }) =>
        dispatchCount(harness, path, contentOf(data)) > 0
      ),
    stage,
  );
  const quietStart = harness.dispatches.length;
  await expectQuiet(
    harness,
    stage,
    expected.map(({ path }) => path),
    quietStart,
  );
  for (const { path, data } of expected) {
    const content = contentOf(data);
    const count = dispatchCount(harness, path, content);
    assert(
      count === 1,
      `Expected one semantic dispatch for ${path} with content ${
        JSON.stringify(content)
      }, got ${count}.\n${diagnostics(harness, stage)}`,
    );
  }
}

function binaryDispatchCount(
  harness: Harness,
  path: string,
  bytes: number[],
): number {
  return harness.dispatches.filter((dispatch) =>
    dispatch.path === path && bytesEqual(bytesOf(dispatch.data), bytes)
  ).length;
}

async function expectBinaryDispatchesOnce(
  harness: Harness,
  expected: Array<{ path: string; bytes: number[] }>,
  stage: string,
): Promise<void> {
  await waitFor(
    harness,
    () =>
      expected.every(({ path, bytes }) =>
        binaryDispatchCount(harness, path, bytes) > 0
      ),
    stage,
  );
  const quietStart = harness.dispatches.length;
  await expectQuiet(
    harness,
    stage,
    expected.map(({ path }) => path),
    quietStart,
  );
  for (const { path, bytes } of expected) {
    const count = binaryDispatchCount(harness, path, bytes);
    assert(
      count === 1,
      "Expected one byte-exact dispatch for " + path + " with bytes " +
        JSON.stringify(bytes) + ", got " + count + ".\n" +
        diagnostics(harness, stage),
    );
  }
}

async function expectQuiet(
  harness: Harness,
  stage: string,
  paths: string[],
  since = 0,
): Promise<void> {
  const watched = new Set(paths);
  const deadline = Date.now() + QUIET_WINDOW_MS;
  while (Date.now() < deadline) {
    assertNoStartFailures(harness, stage);
    const unexpected = harness.dispatches.slice(since).filter(({ path }) =>
      watched.has(path)
    );
    assert(
      unexpected.length === 0,
      `Unexpected dispatch for ${
        unexpected.map(({ path }) => path).join(", ")
      }.\n${diagnostics(harness, stage)}`,
    );
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

function makeHarness(
  baseDir: string,
  useChokidar: boolean,
  options: HarnessOptions,
): Harness {
  const config: PeerStorageConf = {
    type: "storage",
    name: `watcher-${crypto.randomUUID()}`,
    baseDir,
    scanOfflineChanges: options.scanOfflineChanges ?? false,
    useChokidar,
    ...(options.ignore ? { ignore: options.ignore } : {}),
  };
  const trace: WatcherTrace | undefined =
    !useChokidar && options.traceNativeEvents
      ? { startedAt: performance.now(), stage: "setup", events: [] }
      : undefined;
  const dispatches: Dispatch[] = [];
  const peer = new PeerStorage(config, (_source, path, data) => {
    dispatches.push({ path, data });
    recordTrace(trace, { type: "dispatch", path, content: contentOf(data) });
    return Promise.resolve();
  });
  return {
    peer,
    useChokidar,
    dispatches,
    startFailures: [],
    startPromises: [],
    trace,
  };
}

async function startAndWait(harness: Harness): Promise<void> {
  traceStage(harness, "watcher start");
  const start = harness.peer.start();
  harness.startPromises.push(start.catch((error: unknown) => {
    harness.startFailures.push(error);
  }));

  if (!harness.useChokidar) {
    await waitFor(
      harness,
      () => harness.peer.health().ok,
      "Deno watcher inventory ready",
    );
    traceStage(harness, "watcher ready");
    return;
  }

  // PeerStorage.health() reports Chokidar as watching before its initial crawl
  // emits 'ready', so wait for Chokidar's own readiness event before touching disk.
  const watcher = harness.peer.watcher;
  assert(
    watcher,
    `Chokidar watcher was not created.\n${
      diagnostics(harness, "Chokidar start")
    }`,
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for Chokidar ready.\n${
            diagnostics(harness, "Chokidar ready")
          }`,
        ),
      );
    }, WAIT_TIMEOUT_MS);
    const onError = (error: unknown) => {
      harness.startFailures.push(error);
      clearTimeout(timer);
      reject(
        new Error(
          `Chokidar watcher failed.\n${diagnostics(harness, "Chokidar ready")}`,
        ),
      );
    };
    watcher.on("error", onError);
    watcher.once("ready", () => {
      clearTimeout(timer);
      try {
        assertNoStartFailures(harness, "Chokidar ready");
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function stopAndWait(harness: Harness): Promise<void> {
  let stopFailure: unknown;
  try {
    await harness.peer.stop();
  } catch (error) {
    stopFailure = error;
  }
  await Promise.allSettled(harness.startPromises);
  // Let scheduled dispatch tasks finish after the underlying watcher has closed.
  await new Promise((resolve) => setTimeout(resolve, QUIET_WINDOW_MS));
  if (stopFailure !== undefined) {
    throw new Error(
      `Watcher stop failed: ${errorText(stopFailure)}\n${
        diagnostics(harness, "watcher stop")
      }`,
    );
  }
  assertNoStartFailures(harness, "watcher stop");
}

function clearPeerSettings(harness: Harness): void {
  const prefix = `${harness.peer.config.name}-storage-`;
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) localStorage.removeItem(key);
  }
}

async function withHarness(
  useChokidar: boolean,
  options: HarnessOptions,
  run: (harness: Harness, absoluteBaseDir: string) => Promise<void>,
  relativeBaseDir = false,
): Promise<void> {
  const absoluteBaseDir = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "peer-storage-watcher-",
  });
  const relativePath = relative(Deno.cwd(), absoluteBaseDir).replaceAll(
    "\\",
    "/",
  );
  const baseDir = relativeBaseDir ? `./${relativePath}` : absoluteBaseDir;
  const harness = makeHarness(baseDir, useChokidar, options);
  const restoreWatchFs = observeNativeWatcher(absoluteBaseDir, harness.trace);
  let runFailure: unknown;
  let hasRunFailure = false;
  try {
    await run(harness, absoluteBaseDir);
    assertNoStartFailures(harness, "test completion");
  } catch (error) {
    runFailure = error;
    hasRunFailure = true;
  }

  const cleanupFailures: unknown[] = [];
  try {
    traceStage(harness, "watcher stop requested");
    await stopAndWait(harness);
    traceStage(harness, "watcher stopped");
  } catch (error) {
    cleanupFailures.push(error);
  } finally {
    restoreWatchFs();
  }
  if (harness.trace) {
    console.log(diagnostics(harness, "watcher trace after stop"));
  }
  try {
    clearPeerSettings(harness);
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    await Deno.remove(absoluteBaseDir, { recursive: true });
  } catch (error) {
    cleanupFailures.push(error);
  }

  if (hasRunFailure) {
    if (cleanupFailures.length > 0) {
      throw new Error(
        `Test failed: ${errorText(runFailure)}\nCleanup failed: ${
          cleanupFailures.map(errorText).join("; ")
        }`,
      );
    }
    throw runFailure;
  }
  if (cleanupFailures.length > 0) {
    throw new Error(
      `Cleanup failed: ${cleanupFailures.map(errorText).join("; ")}`,
    );
  }
}

function textFileData(content: string): FileData {
  return {
    ctime: Date.now(),
    mtime: Date.now(),
    size: new TextEncoder().encode(content).byteLength,
    data: [content],
  };
}

for (const backend of WATCHERS) {
  // Windows rejects these renames with Chokidar's default event-based watching.
  // Keep polling opt-ins testable; this follows Chokidar 3.6's environment override.
  // See readme.md#filesystem-watcher-limitations and
  // https://github.com/paulmillr/chokidar/issues/1380.
  const pollingOverride = Deno.env.get("CHOKIDAR_USEPOLLING")?.toLowerCase();
  const useChokidarPolling = ![undefined, "", "0", "false"].includes(
    pollingOverride,
  );
  const skipFolderRename = Deno.build.os === "windows" && backend.useChokidar &&
    !useChokidarPolling;

  for (const preExistingDirectory of [false, true]) {
    watcherTest(
      !backend.useChokidar && !preExistingDirectory ? "both" : "standard",
      `PeerStorage ${backend.name} sees a first child write in a ${
        preExistingDirectory ? "pre-existing" : "new"
      } .claude directory`,
      async () => {
        await withHarness(
          backend.useChokidar,
          {
            scanOfflineChanges: false,
            traceNativeEvents: !preExistingDirectory,
          },
          async (harness, baseDir) => {
            const directory = join(baseDir, ".claude");
            if (preExistingDirectory) {
              await Deno.mkdir(directory, { recursive: true });
            }
            await startAndWait(harness);

            if (!preExistingDirectory) {
              await Deno.mkdir(directory, { recursive: true });
            }
            // Keep this write immediately after mkdir: this reproduces the
            // native watcher case where only the new parent event may arrive.
            await Deno.writeTextFile(
              join(directory, "settings.json"),
              "theme: dark",
            );
            await expectDispatchesOnce(
              harness,
              [{
                path: ".claude/settings.json",
                data: textFileData("theme: dark"),
              }],
              "first child write",
            );
          },
        );
      },
    );
  }

  watcherTest(
    "standard",
    `PeerStorage ${backend.name} dispatches edits, empty content, deletion, and ignores its subtree`,
    async () => {
      await withHarness(
        backend.useChokidar,
        { scanOfflineChanges: false, ignore: ["ignored/**"] },
        async (harness, baseDir) => {
          const path = join(baseDir, "note.md");
          const ignoredDirectory = join(baseDir, "ignored");
          await Deno.mkdir(ignoredDirectory, { recursive: true });
          await startAndWait(harness);

          await Deno.writeTextFile(path, "first");
          await expectDispatchesOnce(harness, [{
            path: "note.md",
            data: textFileData("first"),
          }], "initial local write");

          await Deno.writeTextFile(path, "modified");
          await expectDispatchesOnce(harness, [{
            path: "note.md",
            data: textFileData("modified"),
          }], "file modification");

          const duplicateStart = harness.dispatches.length;
          await Deno.writeTextFile(path, "modified");
          await expectQuiet(
            harness,
            "duplicate content write",
            ["note.md"],
            duplicateStart,
          );

          await Deno.writeTextFile(path, "");
          await expectDispatchesOnce(harness, [{
            path: "note.md",
            data: textFileData(""),
          }], "intentional empty update");

          await Deno.remove(path);
          await expectDispatchesOnce(
            harness,
            [{ path: "note.md", data: false }],
            "file deletion",
          );

          const ignoredStart = harness.dispatches.length;
          await Deno.writeTextFile(
            join(ignoredDirectory, "secret.md"),
            "local only",
          );
          await expectQuiet(harness, "ignored subtree write", [
            "ignored/secret.md",
          ], ignoredStart);
        },
      );
    },
  );

  watcherTest(
    "standard",
    "PeerStorage " + backend.name + " dispatches binary payloads byte-for-byte",
    async () => {
      await withHarness(
        backend.useChokidar,
        { scanOfflineChanges: false },
        async (harness, baseDir) => {
          const path = join(baseDir, "image.png");
          const initial = [0x00, 0xff, 0x81, 0x7f, 0x00];
          const replacement = [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10];
          await startAndWait(harness);

          await Deno.writeFile(path, new Uint8Array(initial));
          await expectBinaryDispatchesOnce(
            harness,
            [{ path: "image.png", bytes: initial }],
            "binary file creation",
          );

          await Deno.writeFile(path, new Uint8Array(replacement));
          await expectBinaryDispatchesOnce(
            harness,
            [{ path: "image.png", bytes: replacement }],
            "binary file replacement",
          );
        },
      );
    },
  );

  watcherTest(
    "standard",
    "PeerStorage " + backend.name +
      " reports an atomic replacement as a final file update",
    async () => {
      await withHarness(
        backend.useChokidar,
        { scanOfflineChanges: true },
        async (harness, baseDir) => {
          const watchedPath = join(baseDir, "atomic.md");
          await Deno.writeTextFile(watchedPath, "before replacement");
          await startAndWait(harness);
          await expectDispatchesOnce(
            harness,
            [{ path: "atomic.md", data: textFileData("before replacement") }],
            "atomic replacement baseline",
          );

          const checkpoint = harness.dispatches.length;
          const replacementDirectory = await Deno.makeTempDir({
            dir: Deno.cwd(),
            prefix: "peer-storage-atomic-source-",
          });
          try {
            const replacementPath = join(
              replacementDirectory,
              "replacement.md",
            );
            await Deno.writeTextFile(replacementPath, "after replacement");
            await Deno.rename(replacementPath, watchedPath);

            await waitFor(
              harness,
              () =>
                harness.dispatches.slice(checkpoint).some((dispatch) =>
                  dispatch.path === "atomic.md" &&
                  contentOf(dispatch.data) === "after replacement"
                ),
              "atomic replacement payload",
            );
            const quietStart = harness.dispatches.length;
            await expectQuiet(harness, "atomic replacement settled", [
              "atomic.md",
            ], quietStart);

            const replacementEvents = harness.dispatches.slice(checkpoint)
              .filter((dispatch) => dispatch.path === "atomic.md");
            assert(
              replacementEvents.length === 1 &&
                replacementEvents[0].data !== false &&
                contentOf(replacementEvents[0].data) === "after replacement",
              "Atomic replacement should dispatch only its final payload, without a deletion.\n" +
                diagnostics(harness, "atomic replacement"),
            );
            assert(
              await Deno.readTextFile(watchedPath) === "after replacement",
              "The watched file should contain the replacement payload",
            );
          } finally {
            await Deno.remove(replacementDirectory, { recursive: true });
          }
        },
      );
    },
  );

  watcherTest(
    "standard",
    `PeerStorage ${backend.name} suppresses received changes and resumes after restart`,
    async () => {
      await withHarness(
        backend.useChokidar,
        { scanOfflineChanges: false },
        async (harness, baseDir) => {
          await startAndWait(harness);

          const receivedPath = "remote.md";
          const putStart = harness.dispatches.length;
          assert(
            await harness.peer.put(receivedPath, textFileData("from peer")),
            "Received put should write the file",
          );
          await expectQuiet(
            harness,
            "received put echo",
            [receivedPath],
            putStart,
          );

          const deleteStart = harness.dispatches.length;
          assert(
            await harness.peer.delete(receivedPath),
            "Received delete should remove the file",
          );
          await expectQuiet(
            harness,
            "received delete echo",
            [receivedPath],
            deleteStart,
          );

          await Deno.writeTextFile(
            join(baseDir, receivedPath),
            "edited locally",
          );
          await expectDispatchesOnce(
            harness,
            [{ path: receivedPath, data: textFileData("edited locally") }],
            "local edit after received changes",
          );

          await stopAndWait(harness);
          const restartPath = join(baseDir, "restart.md");
          await Deno.writeTextFile(restartPath, "written while stopped");
          await startAndWait(harness);
          const restartStart = harness.dispatches.length;
          await expectQuiet(harness, "restart with offline scan disabled", [
            "restart.md",
          ], restartStart);

          await Deno.writeTextFile(restartPath, "edited after restart");
          await expectDispatchesOnce(
            harness,
            [{
              path: "restart.md",
              data: textFileData("edited after restart"),
            }],
            "local edit after restart",
          );
        },
      );
    },
  );

  watcherTest(
    "standard",
    `PeerStorage ${backend.name} emits startup files only when offline scanning is enabled`,
    async () => {
      for (const scanOfflineChanges of [false, true]) {
        await withHarness(
          backend.useChokidar,
          { scanOfflineChanges },
          async (harness, baseDir) => {
            await Deno.writeTextFile(
              join(baseDir, "offline.md"),
              "already present",
            );
            await startAndWait(harness);
            if (scanOfflineChanges) {
              await expectDispatchesOnce(
                harness,
                [{ path: "offline.md", data: textFileData("already present") }],
                "offline scan enabled",
              );
            } else {
              await expectQuiet(harness, "offline scan disabled", [
                "offline.md",
              ]);
            }
          },
        );
      }
    },
  );

  watcherTest(
    backend.useChokidar ? "standard" : "both",
    `PeerStorage ${backend.name} preserves deep paths with spaces and Japanese names for both baseDir forms`,
    async () => {
      for (const relativeBaseDir of [false, true]) {
        await withHarness(
          backend.useChokidar,
          { scanOfflineChanges: false, traceNativeEvents: true },
          async (harness, baseDir) => {
            await startAndWait(harness);
            const directory = join(
              baseDir,
              "deep path",
              "日本語",
              "さらに深く",
            );
            traceStage(harness, "deep directory creation requested");
            await Deno.mkdir(directory, { recursive: true });
            traceStage(harness, "deep directory creation completed");
            const filename = "note with spaces_日本語.md";
            const path =
              "deep path/日本語/さらに深く/note with spaces_日本語.md";
            traceStage(harness, "first deep file write requested");
            await Deno.writeTextFile(join(directory, filename), "日本語の内容");
            traceStage(harness, "first deep file write completed");
            await expectDispatchesOnce(
              harness,
              [{ path, data: textFileData("日本語の内容") }],
              relativeBaseDir
                ? "deep path with relative baseDir"
                : "deep path with absolute baseDir",
            );
          },
          relativeBaseDir,
        );
      }
    },
  );

  watcherTest(backend.useChokidar ? "standard" : "both", {
    name: "PeerStorage " + backend.name +
      " reports case-only folder renames with exact paths",
    ignore: skipFolderRename,
    fn: async () => {
      await withHarness(
        backend.useChokidar,
        { scanOfflineChanges: true, traceNativeEvents: true },
        async (harness, baseDir) => {
          const oldDirectory = join(baseDir, "CaseFolder");
          const newDirectory = join(baseDir, "casefolder");
          const files = [
            {
              oldPath: "CaseFolder/one.md",
              newPath: "casefolder/one.md",
              content: "one",
            },
            {
              oldPath: "CaseFolder/deep/two.md",
              newPath: "casefolder/deep/two.md",
              content: "two",
            },
          ];
          const unrelatedPath = "control.md";
          await Deno.mkdir(join(oldDirectory, "deep"), { recursive: true });
          for (const file of files) {
            await Deno.writeTextFile(join(baseDir, file.oldPath), file.content);
          }
          await Deno.writeTextFile(join(baseDir, unrelatedPath), "untouched");
          await startAndWait(harness);
          await expectDispatchesOnce(
            harness,
            [
              ...files.map(({ oldPath, content }) => ({
                path: oldPath,
                data: textFileData(content),
              })),
              { path: unrelatedPath, data: textFileData("untouched") },
            ],
            "case-only rename baseline",
          );

          const checkpoint = harness.dispatches.length;
          // Keep this as one direct case-only rename on Windows; a second temporary
          // rename would change the filesystem operation being measured.
          traceStage(harness, "case-only rename requested");
          await Deno.rename(oldDirectory, newDirectory);
          traceStage(harness, "case-only rename completed");
          const expected = [
            ...files.map(({ oldPath }) => ({
              path: oldPath,
              content: false as string | false,
            })),
            ...files.map(({ newPath, content }) => ({
              path: newPath,
              content,
            })),
          ];
          await waitFor(
            harness,
            () =>
              expected.every(({ path, content }) =>
                harness.dispatches.slice(checkpoint).some((dispatch) =>
                  dispatch.path === path && contentOf(dispatch.data) === content
                )
              ),
            "case-only folder rename dispatches",
          );
          const quietStart = harness.dispatches.length;
          await expectQuiet(
            harness,
            "case-only folder rename settled",
            [...expected.map(({ path }) => path), unrelatedPath],
            quietStart,
          );

          const renameEvents = harness.dispatches.slice(checkpoint);
          for (const { path, content } of expected) {
            const count = renameEvents.filter((dispatch) =>
              dispatch.path === path && contentOf(dispatch.data) === content
            ).length;
            assert(
              count === 1,
              "Expected one case-only rename dispatch for " + path + ".\n" +
                diagnostics(harness, "case-only folder rename"),
            );
          }
          assert(
            renameEvents.length === expected.length &&
              !renameEvents.some((dispatch) => dispatch.path === unrelatedPath),
            "A case-only rename should leave unrelated files untouched.\n" +
              diagnostics(harness, "case-only folder rename"),
          );
          for (const file of files) {
            assert(
              await Deno.readTextFile(
                join(newDirectory, file.newPath.slice("casefolder/".length)),
              ) === file.content,
              "The renamed child should retain its content at the exact-cased path " +
                file.newPath,
            );
          }
          assert(
            await Deno.readTextFile(join(baseDir, unrelatedPath)) ===
              "untouched",
            "An unrelated file should remain unchanged",
          );
        },
      );
    },
  });

  watcherTest(backend.useChokidar ? "standard" : "both", {
    name:
      `PeerStorage ${backend.name} tracks a moved folder and recursively removed children`,
    ignore: skipFolderRename,
    fn: async () => {
      await withHarness(
        backend.useChokidar,
        { scanOfflineChanges: false, traceNativeEvents: true },
        async (harness, baseDir) => {
          const oldDirectory = join(baseDir, "old-folder");
          const movedDirectory = join(baseDir, "moved folder");
          const originalFiles = [
            { path: "old-folder/one.md", content: "one" },
            { path: "old-folder/deep/two.md", content: "two" },
          ];
          const movedFiles = [
            { path: "moved folder/one.md", content: "one" },
            { path: "moved folder/deep/two.md", content: "two" },
          ];
          await Deno.mkdir(join(oldDirectory, "deep"), { recursive: true });
          for (const file of originalFiles) {
            await Deno.writeTextFile(join(baseDir, file.path), file.content);
          }
          await startAndWait(harness);

          const failures: string[] = [];
          traceStage(harness, "folder move requested");
          await Deno.rename(oldDirectory, movedDirectory);
          traceStage(harness, "folder move completed");
          try {
            await expectDispatchesOnce(
              harness,
              [
                ...originalFiles.map(({ path }) => ({
                  path,
                  data: false as const,
                })),
                ...movedFiles.map(({ path, content }) => ({
                  path,
                  data: textFileData(content),
                })),
              ],
              "folder move",
            );
          } catch (error) {
            failures.push(errorText(error));
          }

          traceStage(harness, "recursive removal requested");
          await Deno.remove(movedDirectory, { recursive: true });
          traceStage(harness, "recursive removal completed");
          try {
            await expectDispatchesOnce(
              harness,
              movedFiles.map(({ path }) => ({ path, data: false })),
              "recursive removal after folder move",
            );
          } catch (error) {
            failures.push(errorText(error));
          }

          assert(
            failures.length === 0,
            `Folder move or recursive removal did not produce the expected dispatches.\n${
              failures.join("\n\n")
            }\n${diagnostics(harness, "folder move and recursive removal")}`,
          );
        },
      );
    },
  });

  watcherTest(
    "standard",
    `PeerStorage ${backend.name} reports recursively removed children without a folder rename`,
    async () => {
      await withHarness(
        backend.useChokidar,
        { scanOfflineChanges: false },
        async (harness, baseDir) => {
          const directory = join(baseDir, "remove-folder");
          const files = [
            { path: "remove-folder/one.md", content: "one" },
            { path: "remove-folder/deep/two.md", content: "two" },
          ];
          await Deno.mkdir(join(directory, "deep"), { recursive: true });
          for (const file of files) {
            await Deno.writeTextFile(join(baseDir, file.path), file.content);
          }
          await Deno.writeTextFile(join(baseDir, "control.md"), "untouched");
          await startAndWait(harness);

          await Deno.remove(directory, { recursive: true });
          await expectDispatchesOnce(
            harness,
            files.map(({ path }) => ({ path, data: false })),
            "recursive removal without a folder rename",
          );
          assert(
            harness.dispatches.length === files.length,
            "Recursive removal should only dispatch the removed children.\n" +
              diagnostics(harness, "recursive removal without a folder rename"),
          );
          assert(
            await Deno.readTextFile(join(baseDir, "control.md")) ===
              "untouched",
            "Recursive removal should preserve an unrelated file",
          );
        },
      );
    },
  );
}
