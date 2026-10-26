type WatcherTestSuite = "standard" | "diagnostic";

const selectedSuite = Deno.env.get("BRIDGE_WATCHER_TEST_SUITE") ?? "standard";
if (selectedSuite !== "standard" && selectedSuite !== "diagnostic") {
  throw new Error("Unknown BRIDGE_WATCHER_TEST_SUITE: " + selectedSuite);
}

// Keep the original operations and assertions in both suites. Diagnostic
// failures remain failures; selecting a suite only changes which tests run.
export function watcherTest(
  suite: WatcherTestSuite,
  definition: Deno.TestDefinition,
): void;
export function watcherTest(
  suite: WatcherTestSuite,
  name: string,
  fn: Deno.TestDefinition["fn"],
): void;
export function watcherTest(
  suite: WatcherTestSuite,
  nameOrDefinition: string | Deno.TestDefinition,
  fn?: Deno.TestDefinition["fn"],
): void {
  let definition: Deno.TestDefinition;
  if (typeof nameOrDefinition === "string") {
    if (!fn) {
      throw new Error("Missing watcher test function: " + nameOrDefinition);
    }
    definition = { name: nameOrDefinition, fn };
  } else {
    definition = nameOrDefinition;
  }
  Deno.test({
    ...definition,
    name: suite === "diagnostic"
      ? "[diagnostic] " + definition.name
      : definition.name,
    ignore: definition.ignore || suite !== selectedSuite,
  });
}
