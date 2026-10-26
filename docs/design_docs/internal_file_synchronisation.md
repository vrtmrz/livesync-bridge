---
date: 2026-10-22
accepted: 2026-10-23
status: unreleased
---

# Internal-file synchronisation

## Purpose and baseline

This document defines the accepted bridge contract for synchronising selected
Self-hosted LiveSync hidden files in both directions. The rationale and
alternatives are in the [ADR](../adr/2026_10_internal_file_synchronisation.md).
The bridge implementation remains unreleased. It pins published Commonlib
`0.2.0` and has passed normal consumer installation and validation with that
version.

The baseline is bridge revision `fc0e028d33b3a12ddee1322951375e05107edc55`,
which pins Commonlib `0.1.39`. Its `includeInternal` option selects incoming
`i:` paths, but Commonlib's direct client does not expose the internal-file
permission. Published Commonlib `0.2.0` exposes `syncInternalFiles` and
propagates it to the effective database settings. The bridge's imports and
lockfile now select that exact version.

## Scope

| Area                  | Contract                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ordinary files        | Retain the documented mapping between each peer's sharing folder and shared relative paths.                                                      |
| Internal files        | Support `i:` Metadata for paths with a dot-prefixed first component, selected independently for each CouchDB peer.                               |
| Directions            | Apply the same eligibility and identity to received changes and local create, read, update, and delete operations.                               |
| Storage peers         | Use paths relative to the storage root. Storage-to-storage synchronisation and the existing sending-only `ignore` policy remain unchanged.       |
| Other namespaces      | Keep `ix:`, `ps:`, Chunks, and other non-file protocol records out of this feature. Non-hidden `i:` paths are outside this routing contract.     |
| Protocol and recovery | Preserve existing IDs, content encoding, encryption, checkpoints, and retry mechanisms. Add no persistent origin mapping or automatic migration. |

## Path identity and selection

A **shared path** is the relative POSIX path exchanged through the Hub, such as
`note.md` or `.claude/settings.json`. It contains no LiveSync namespace prefix.
A **logical Metadata path** is the decoded path supplied to Commonlib, such as
`blog/note.md` or `i:.claude/settings.json`. It is distinct from an obfuscated
CouchDB document ID.

Only canonical relative file paths participate: the path is non-empty, has no
leading slash, and contains no empty, `.` or `..` component. Reject invalid
internal paths before mapping or delivering them; do not normalise them into
another file's identity. Existing host restrictions on physical filenames still
apply. This design does not introduce Unicode normalisation, case conversion, or
broader support for ordinary filenames containing colons.

A shared path is internal for a CouchDB peer when its first component begins
with `.`. This classification is independent of the globs and `baseDir`.
Consequently, `includeInternal: ["**"]` still treats `note.md` as ordinary. A
hidden component later in an otherwise ordinary path does not, by itself, change
that path to `i:`.

An internal path is eligible only when at least one `includeInternal` pattern
matches the complete Vault-root path after removing exactly one `i:` prefix. Use
the existing `minimatch` behaviour with `dot: true` and any-pattern matching. Do
not reinterpret the list as an ordered set of include and exclude rules. Missing
and empty lists select no internal files.

Both the source and destination CouchDB peers apply their own selection. A
source peer opting into `.claude/**` does not opt any other peer into it.
Excluded paths produce no content delivery or file mutation, and are rejected
before recording repeat-suppression entries. Metadata reads needed to detect an
identity collision are permitted; they do not make an excluded document eligible
for delivery.

## Mapping contract

For a CouchDB peer with `baseDir: "blog/"` and
`includeInternal: [".claude/**"]`, and a storage peer rooted at `mirror/`:

| Logical Metadata path              | Shared path             | Storage path                   | Return route                                   |
| ---------------------------------- | ----------------------- | ------------------------------ | ---------------------------------------------- |
| `blog/note.md`                     | `note.md`               | `mirror/note.md`               | `blog/note.md`                                 |
| `i:.claude/settings.json`          | `.claude/settings.json` | `mirror/.claude/settings.json` | `i:.claude/settings.json`                      |
| `other/note.md`                    | Excluded                | No delivery                    | No route from this source                      |
| `i:.obsidian/app.json`             | Excluded                | No delivery                    | Local `.obsidian/app.json` is also excluded    |
| `.claude/settings.json`            | Excluded                | No delivery                    | No ordinary fallback or automatic conversion   |
| `blog/.claude/settings.json`       | Reserved-path rejection | No delivery                    | A live document here blocks the internal route |
| `i:note.md`, `ix:...`, or `ps:...` | Excluded                | No delivery                    | Outside this feature                           |

For ordinary documents, remove the configured folder once and only at its path
boundary. `blog/` and `blog` identify the same folder; `blogger/note.md` is
outside it. For internal documents, remove `i:` only. Do not trim `baseDir` from
that result. The destination storage root is applied once.

For outgoing operations, resolve an eligible dot-prefixed shared path to `i:`
plus that exact shared path, independently of `baseDir`. Resolve an ordinary
shared path below `baseDir`. Both the shared path and the resulting ordinary
Vault path must have a non-dot-prefixed first component. A hidden Vault-root
folder therefore cannot serve as an ordinary sharing folder; use
`includeInternal` for its internal files. An unmatched dot-prefixed shared path
has no CouchDB route, including when `baseDir` is non-empty.

On receipt, reject non-prefixed, Vault-root hidden documents before applying
`baseDir`, and reject ordinary documents whose projected shared path is hidden.
For example, a non-prefixed `.claude/x` stays excluded even with
`baseDir: ".claude/"`. Peer file operations accept shared paths; a caller cannot
supply an `i:` prefix as a shared path to bypass this mapping.

Use this mapping for `get`, `getMeta`, `put`, and `delete`, as well as the watch
callback. A new local hidden file must create an internal document without
requiring an earlier received event. Restarting a peer or expiring its repeat
cache must not change the document it reads, updates, or deletes.

## Collisions and existing documents

An ordinary Metadata document and an internal Metadata document can have
different IDs but project to the same storage path. For an internal shared path
`p`, its ordinary alias in a CouchDB peer is `baseDir` joined with `p`. For
example, `i:.claude/x` and `blog/.claude/x` would both map to `mirror/.claude/x`
without the reserved-path rule.

Ordinary aliases of dot-prefixed shared paths are never forwarded. In addition,
before reading or applying an eligible internal operation, inspect the alias's
Metadata. A live ordinary document blocks that operation, even if the internal
document does not yet exist. A deleted alias does not establish a second live
owner. If alias inspection fails, leave the operation unapplied and report the
failure; an unsuccessful lookup is not evidence that the alias is absent.

Report both logical paths and the peer when blocking a collision. Do not modify
either document, deliver a write or deletion to storage, or record the change as
a repeat. Return the existing declined-operation result (`false`) for an
observed collision, or omit the watch dispatch. A watch may already have loaded
its selected content before this check; the check must precede dispatch and
every mutation.

This rule prevents automatic adoption of a document created by an older,
incorrect ordinary write. It does not merge histories, rename documents, or
choose the newest copy. An operator must resolve the conflicting document
outside this feature before a later source change can use the internal route.
Already skipped changes are not automatically replayed. The existing `--reset`
option can request a full rescan; it retains its existing effect on all peers'
stored scan and resume state.

The check covers visible Metadata in the peer's database at the time of the
operation. It is not atomic with another client's independent writes, and it
does not claim to detect every filesystem case or Unicode alias.

Changing `includeInternal` does not change the existing checkpoint identity. New
patterns affect subsequent changes; already skipped files require a source
change or a full rescan with the existing `--reset` option. Do not add a saved
selection history or change checkpoint keys to replay them automatically.

## Ownership and integration

Commonlib owns path-to-ID derivation, Metadata access, encryption, Chunks, and
content reconstruction. Its direct-client `syncInternalFiles` option grants
library access and defaults to false. It does not implement bridge globs or
folder projection.

`PeerCouchDB` owns selection, path mapping, alias checks, and the derived
permission. Derive `syncInternalFiles` from a non-empty `includeInternal` list.
A raw boolean does not override that policy. Keep the value when rebuilding the
manipulator or applying remote tweaks. Apply selection before loading excluded
incoming file content and before outgoing operations; perform collision checks
before dispatch or mutation. Use one path-resolution policy for these entry
points so their mappings cannot diverge.

The Hub continues to exchange shared paths and file data. The root hidden-path
restriction makes these paths sufficient to identify the intended CouchDB route.
Supporting arbitrary internal namespaces would need a different routing
contract, including new local files and changes after restart.

`PeerStorage` applies its own filesystem root. Its `ignore` patterns continue to
stop sending local changes, while incoming writes and deletions remain accepted.
They do not replace a CouchDB peer's `includeInternal` selection.
Storage-to-storage changes do not acquire a CouchDB policy.

A delayed storage write reads the current file content after waiting in the
outgoing queue and its notification delay. An incoming update or deletion
completed during that wait supersedes the earlier notification. The existing
repeat check suppresses received content; a later local edit can still be sent.
Skip files that disappear before the read, and report other read failures
without changing repeat-suppression state or sending a replacement. Record
modification time and size for offline change detection only after a successful
read, so a failed read leaves the local edit eligible for a later offline scan.
This applies to ordinary and hidden files. The filesystem read and Hub delivery
remain separate operations, with no transaction against concurrent writers.

Internal Metadata encryption changes representation, not eligibility or
identity. Use Commonlib's decoded logical path; keep its existing encryption,
path obfuscation, and ID-derivation checks. This feature must work with
`encryptInternalMetadata` enabled or disabled when the remote's prerequisites
are met. Do not disable encryption to make routing succeed.

## Compatibility and implementation status

The original receive-side option remains the baseline for selection and the
Vault-root interpretation. Symmetric outgoing routing, root hidden-path
reservation, and alias rejection are accepted additions. They are implemented
and validated with published Commonlib `0.2.0` through the normal project
configuration. This completes the published-dependency requirement; the bridge
change itself remains unreleased.

The library permission must not expand access to unmatched or non-prefixed
hidden paths. Validation must cover bidirectional identity and a non-empty
`baseDir`; selected incoming-file cases alone are insufficient.

Keep the imports and lockfile pinned to an exact published Commonlib version.
Validation of a locally modified library build does not substitute for normal
consumer installation and checks of the published artefact.

## Verification contract and limits

Add focused regression tests before changing production behaviour. Confirm that
each test fails for its expected behavioural reason against the previous
implementation, then rerun it after the change. The required cases are:

| Case                                                     | Required observation                                                                                                               |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Missing or empty patterns, including raw permission true | No hidden-file delivery, creation, update, or deletion for empty and non-empty `baseDir`.                                          |
| Selected internal create, update, and deletion           | Reach the expected storage path with empty and non-empty `baseDir`; retain an ordinary note as a control.                          |
| Unmatched and non-prefixed hidden documents              | Remain excluded after library permission is enabled, including with a hidden CouchDB `baseDir`.                                    |
| New local selected hidden file                           | Creates only the `i:` document; no ordinary alias is created.                                                                      |
| Local update, read, Metadata lookup, and deletion        | Address the same internal identity and preserve unrelated documents.                                                               |
| Fresh peer with an empty repeat cache                    | Uses the same internal identity for a local edit and deletion.                                                                     |
| Two CouchDB peers with different selections              | Each enforces its own opt-in; no ordinary fallback at the destination.                                                             |
| Broad pattern and invalid internal path                  | `**` leaves ordinary notes ordinary; non-hidden `i:` paths, traversal components, and other namespaces are excluded.               |
| Folder mapping                                           | Trim `baseDir` once, respect its boundary, and preserve the complete internal path.                                                |
| Live ordinary alias                                      | Reject internal operations without modifying either document or storage; identify the collision.                                   |
| Deleted ordinary alias                                   | Does not block an otherwise eligible internal operation.                                                                           |
| Alias inspection failure                                 | No internal mutation or delivery; report the failed check instead of treating it as an absent alias.                               |
| Rebuild and remote tweaks                                | Preserve the derived library permission without widening selection.                                                                |
| Internal Metadata encryption off and on                  | Equivalent selected create, update, and delete behaviour through real CouchDB and storage.                                         |
| Incoming change while a storage write waits              | Preserve the received update or deletion, suppress its echo, and deliver a later local edit.                                       |
| File missing or unreadable during an outgoing write      | Skip a missing file; report other read failures and preserve file content, repeat-suppression state, and offline change detection. |

Use focused in-memory tests for routing and identity, and real CouchDB to check
representation and delivery through the Hub and storage peer. Fresh fixtures do
not establish compatibility with the reporter's existing database or prove that
an Obsidian client applies every bridge-produced hidden-file update. Record
those limits separately from a passing bridge test suite.

### Validation on 2026-10-24

Initial consumer validation with published Commonlib `0.2.0` and Deno `2.9.7`
passed normal frozen installation and type checks for both the baseline with
only its dependency updated and the implementation described here. Lint, 156
unit tests, and 10 integration and E2E tests also passed with the normal project
configuration, without local package links or a replacement configuration.

The real CouchDB `3.5.0` cases cover empty and `blog/` sharing folders with
`encryptInternalMetadata` both disabled and enabled. They verify selected remote
and local create, update, and delete operations through the Hub and storage
peer, shared-path reads and Metadata lookup, preservation of excluded files, and
blocking and recovery after deletion of an ordinary alias. In-memory tests cover
fresh-peer identity, per-peer selection, invalid paths, alias lookup failures,
selection before content loading, and rejection before repeat suppression.

Additional native-watcher tests exposed an outgoing write that retained stale
content across its delay and recreated a selected CouchDB document after an
incoming deletion. Before the storage fix, focused regressions failed for
ordinary and hidden files, and all eight native-watcher conditions failed the
check that the selected document stayed deleted after queued work finished.
After reading content following the delay, all six focused regressions and all
18 local CouchDB integration and E2E tests passed. Those include eight
native-watcher conditions: empty and `blog/` sharing folders, internal Metadata
encryption off and on, and a selected directory created before or after watcher
startup. The tests retain immediate directory creation followed by file
creation, check deletion persistence, and record native events and Hub routes on
failure.

Repeat validation with Deno `2.9.8` passed all 163 unit tests and all 18 CouchDB
integration and E2E tests. An exploratory case supplied only a parent-directory
creation event while child files were already present. It did not deliver those
files, but it did not reproduce the CI failure or establish an additional
acceptance criterion. Subtree enumeration on directory creation is outside this
change. The child-file-event control remains in the unit suite.

[CI run 45](https://github.com/vrtmrz/livesync-bridge/actions/runs/40094079892)
also timed out while waiting for the first newly created selected file with
`baseDir: "blog/"` and internal Metadata encryption disabled. Its raw filesystem
events were not captured. CI used Deno `2.9.8` on x86_64, whereas the initial
local validation used Deno `2.9.7` on aarch64. A later CI run captured the
parent-only event pattern described below, but the missing trace means the
specific cause of run 45 remains unproven. Failure diagnostics include the Deno
version and build target as well as native events and Hub routes.

### Native watcher evidence and diagnostic coverage on 2026-10-25

[CI run 50](https://github.com/vrtmrz/livesync-bridge/actions/runs/40163967310)
confirmed that native directory-rename operations themselves succeed on both
Windows and Linux. The raw `Deno.watchFs` streams reported directory
paths but no moved-child event at the new path. On Windows, both ordinary and
case-only renames failed their synchronisation assertions. After the ordinary
rename, the bridge dispatched deletions for the old child paths but no content
at the new paths. The case-only rename produced no child dispatches after the
startup baseline. Linux dispatched old-child deletions for both rename cases
but no content at the new paths. Linux comparisons using the same storage
location before and after the internal-file change reproduced the parent-only
result, confirming that
this watcher limitation predates the change.

The failed CouchDB end-to-end case used the native watcher, `baseDir: "blog/"`,
`encryptInternalMetadata: true`, and a directory created after watcher startup.
After an ordinary note had synchronised, the raw stream reported creation of
`.claude`, with no event for `settings.json` beneath it and no Hub route for
the selected file. The test then timed out waiting for
`i:.claude/settings.json`. This establishes the parent-only event pattern for
that CI run. Earlier runs without captured raw events remain unproven at the
individual-run level.

The known native cases remain available as manual diagnostics with their
original operations and assertions. `deno task test:watcher` retains stable
native cases, Chokidar coverage, and independent recursive-removal coverage.
`deno task test:watcher:diagnostic` runs native first writes in newly created
directories, including deep paths, and ordinary and case-only directory renames.
`deno task test:integration` runs the standard CouchDB integration suite, while
`deno task test:e2e:diagnostic` runs the native end-to-end cases
that create a selected directory after watcher startup across the configured
base-directory and encryption conditions. The diagnostic tasks execute these
tests and return a non-zero exit status when assertions fail. The standard
tasks report the diagnostic cases as ignored.

The manual workflow at
[`.github/workflows/watcher-native-diagnostics.yml`](../../.github/workflows/watcher-native-diagnostics.yml)
runs native watcher diagnostics on Windows and Linux and the CouchDB
end-to-end diagnostics on Linux. GitHub can dispatch it after the workflow is
present on the default branch. The existing manual
[watcher rename probe](../../.github/workflows/watcher-rename-probe.yml)
remains available for its focused check.

The reporter's existing Vault and a real Obsidian client's application of
bridge-produced hidden-file changes remain unverified. The collision check is
not atomic with independent writers, and skipped changes are not automatically
replayed; these are the limits described above.

## References

- [Internal-file synchronisation ADR](../adr/2026_10_internal_file_synchronisation.md)
- [Bridge issue #86](https://github.com/vrtmrz/livesync-bridge/issues/86)
- [Original `includeInternal` change](https://github.com/vrtmrz/livesync-bridge/pull/39)
- [Self-hosted LiveSync Hidden File Sync](https://github.com/vrtmrz/obsidian-livesync/blob/ce0524d49f4e1c840689d83d3f8f18fce383effb/src/features/HiddenFileSync/CmdHiddenFileSync.ts)
- [Commonlib path and document namespaces](https://github.com/vrtmrz/livesync-commonlib/blob/b435ba3270d76c6ddd67ff0269c334434a2e029e/src/string_and_binary/path.ts)
