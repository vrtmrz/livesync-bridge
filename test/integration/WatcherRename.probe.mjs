import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";

const deno = globalThis.Deno;
const runtime = deno
  ? { name: "deno", version: deno.version.deno, renameApi: "Deno.rename" }
  : {
    name: "node",
    version: process.versions.node,
    renameApi: "node:fs/promises.rename",
  };
const renameDirectory = deno ? (from, to) => deno.rename(from, to) : rename;
const options = {
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 500 },
};
const progress = { stage: "setup" };
const deadline = setTimeout(() => {
  console.error(JSON.stringify({ type: "timeout", runtime, progress }));
  process.exit(2);
}, 60_000);

function errorDetails(error) {
  return {
    name: error?.name,
    message: error?.message ?? String(error),
    code: error?.code,
    errno: error?.errno,
    syscall: error?.syscall,
  };
}

async function withTimeout(promise, stage) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Timed out: " + stage)),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitForReady(watcher) {
  let onReady;
  let onError;
  try {
    await withTimeout(
      new Promise((resolve, reject) => {
        onReady = resolve;
        onError = reject;
        watcher.once("ready", onReady);
        watcher.once("error", onError);
      }),
      "watcher ready",
    );
  } finally {
    watcher.off("ready", onReady);
    watcher.off("error", onError);
  }
}

async function attemptRename(from, to, phase, startedAt) {
  const result = { phase, startedMs: Date.now() - startedAt };
  try {
    await renameDirectory(from, to);
    return { ...result, ok: true, finishedMs: Date.now() - startedAt };
  } catch (error) {
    return {
      ...result,
      ok: false,
      finishedMs: Date.now() - startedAt,
      error: errorDetails(error),
    };
  }
}

async function runCase(mode, scenario, chokidar) {
  const startedAt = Date.now();
  const root = await mkdtemp(join(process.cwd(), "watcher-rename-probe-"));
  const from = join(root, scenario.from);
  const to = join(root, scenario.to);
  const result = {
    mode,
    scenario: scenario.name,
    root,
    attempts: [],
    lifecycle: [],
    events: [],
    watcherErrors: [],
  };
  let watcher;
  let closed = false;
  const mark = (stage) => {
    Object.assign(progress, { mode, scenario: scenario.name, stage });
    result.lifecycle.push({ stage, elapsedMs: Date.now() - startedAt });
  };
  const close = async () => {
    mark("watcher-close-started");
    await withTimeout(watcher.close(), "watcher close");
    closed = true;
    mark("watcher-closed");
  };
  console.log(
    JSON.stringify({ type: "case-start", mode, scenario: scenario.name }),
  );
  try {
    mark("create-fixture");
    await mkdir(join(from, "deep"), { recursive: true });
    await writeFile(join(from, "one.md"), "one");
    await writeFile(join(from, "deep", "two.md"), "two");
    await writeFile(join(root, "control.md"), "untouched");
    if (mode === "chokidar") {
      mark("watcher-started");
      watcher = chokidar.watch(root, options);
      watcher.on(
        "error",
        (error) => result.watcherErrors.push(errorDetails(error)),
      );
      watcher.on("all", (kind, path) => {
        if (result.events.length < 100) {
          result.events.push({
            kind,
            path: relative(root, path).split(sep).join("/"),
            elapsedMs: Date.now() - startedAt,
          });
        }
      });
      await waitForReady(watcher);
      mark("watcher-ready");
      const watched = watcher.getWatched();
      result.watched = Object.entries(watched).map(([path, children]) => ({
        path: relative(root, path).split(sep).join("/"),
        children,
      }));
      const names = Object.values(watched).flat();
      if (
        !["one.md", "two.md", "control.md"].every((name) =>
          names.includes(name)
        )
      ) {
        throw new Error("The ready watcher did not register all fixture files");
      }
    }
    mark("initial-rename");
    result.attempts.push(
      await attemptRename(
        from,
        to,
        mode === "none" ? "unwatched" : "watching",
        startedAt,
      ),
    );
    if (watcher) {
      await close();
      // This is a separate observation; it never replaces a failed watched rename.
      if (!result.attempts[0].ok) {
        result.beforeStoppedRename = await readdir(root);
        mark("rename-after-close");
        result.attempts.push(
          await attemptRename(from, to, "after-close", startedAt),
        );
      }
    }
    mark("verify-fixture");
    result.rootEntries = await readdir(root);
    if (await readFile(join(root, "control.md"), "utf8") !== "untouched") {
      throw new Error("The control file changed");
    }
    if (result.attempts.some((attempt) => attempt.ok)) {
      if (
        !result.rootEntries.includes(scenario.to) ||
        result.rootEntries.includes(scenario.from)
      ) {
        throw new Error(
          "The directory entries did not preserve the requested rename casing",
        );
      }
      if (
        await readFile(join(to, "one.md"), "utf8") !== "one" ||
        await readFile(join(to, "deep", "two.md"), "utf8") !== "two"
      ) {
        throw new Error("The renamed children did not retain their contents");
      }
    }
  } catch (error) {
    result.probeError = { stage: progress.stage, error: errorDetails(error) };
  } finally {
    if (watcher && !closed) {
      try {
        await close();
      } catch (error) {
        result.closeError = errorDetails(error);
      }
    }
    mark("cleanup");
    try {
      await rm(root, { recursive: true, force: true });
      result.cleaned = true;
    } catch (error) {
      result.cleanupError = errorDetails(error);
    }
  }
  console.log(JSON.stringify({ type: "case-result", runtime, ...result }));
  return result;
}

try {
  const require = createRequire(import.meta.url);
  const metadata = JSON.parse(
    await readFile(require.resolve("chokidar/package.json"), "utf8"),
  );
  if (metadata.version !== "3.6.0") {
    throw new Error("This comparison requires Chokidar 3.6.0");
  }
  console.log(
    JSON.stringify({
      type: "runtime",
      runtime,
      platform: process.platform,
      arch: process.arch,
      chokidar: metadata.version,
      options,
    }),
  );
  const results = [];
  for (const mode of ["none", "chokidar"]) {
    const chokidar = mode === "chokidar"
      ? (await import("chokidar")).default
      : undefined;
    for (
      const scenario of [
        { name: "folder-move", from: "old-folder", to: "moved folder" },
        { name: "case-only", from: "CaseFolder", to: "casefolder" },
      ]
    ) {
      results.push(await runCase(mode, scenario, chokidar));
    }
  }
  const primaryFailures = results.filter((result) =>
    result.attempts[0]?.ok === false
  ).length;
  const probeFailures = results.filter((result) =>
    result.probeError || result.closeError || result.cleanupError ||
    result.watcherErrors.length > 0
  ).length;
  console.log(
    JSON.stringify({
      type: "summary",
      runtime,
      cases: results.length,
      primaryFailures,
      probeFailures,
    }),
  );
  process.exitCode = probeFailures > 0 ? 2 : primaryFailures > 0 ? 1 : 0;
} catch (error) {
  console.error(
    JSON.stringify({
      type: "probe-error",
      runtime,
      stage: progress.stage,
      error: errorDetails(error),
    }),
  );
  process.exitCode = 2;
} finally {
  deadline.unref();
}
