---
date: 2026-10-22
accepted: 2026-10-23
status: unreleased
---

# Architectural Decision Record: Internal-file synchronisation in the bridge

## Status

Accepted on 2026-10-23. The bridge implementation remains unreleased. It now
pins published Commonlib `0.2.0`, which exposes and propagates the required
`syncInternalFiles` option. Normal installation, type checks, lint, unit tests,
and real CouchDB integration and storage E2E tests passed on 2026-10-24. The
companion [design document](../design_docs/internal_file_synchronisation.md)
defines the path rules, compatibility effects, verification, and remaining
runtime limits.

## Context

The bridge maps a folder in each CouchDB Vault to paths shared with the other
peers in its group. Self-hosted LiveSync stores hidden files separately, using
an `i:` namespace in the logical Metadata path. An internal file and an ordinary
document with the same unprefixed path have different document IDs.

[PR #39](https://github.com/vrtmrz/livesync-bridge/pull/39) added
`includeInternal` to select incoming `i:` documents. It removes the prefix
before delivering a file to storage. Its description does not define how a local
edit, a new hidden file, or a deletion returns to the internal document. The
bridge is described as multi-directional, so this missing contract matters.

The existing example combines `baseDir: "blog/"` with
`includeInternal: [".claude/**"]`. The incoming filter evaluates the internal
path independently of `baseDir`. Applying the ordinary folder mapping to an
internal path either discards that file or removes unrelated characters.

Commonlib also requires `syncInternalFiles` before it loads dot-prefixed paths.
That boolean enables library access; it does not enforce the bridge's globs.
Enabling it without a bridge policy can admit previously excluded hidden files.

## Decision

Synchronise selected, Vault-root hidden files in both directions, with these
boundaries:

- Ordinary files use the CouchDB peer's `baseDir`. Internal files use their
  Vault-root path after removing exactly one `i:` prefix. Their selection and
  mapping are independent of that `baseDir`.
- A shared path whose first component begins with a dot is reserved for
  internal-file routing on CouchDB peers. Every CouchDB peer applies its own
  `includeInternal` patterns in both directions. Missing and empty lists allow
  no internal files. A broad glob does not turn ordinary notes into internals.
- The supported internal paths are valid relative paths with a dot-prefixed
  first component. Other `i:` paths and other protocol namespaces remain
  excluded. This matches the path category handled by Hidden File Sync without
  importing the Obsidian host's separate ignore defaults.
- Create, read, Metadata lookup, update, deletion, and received changes use the
  same mapping. A selected local file returns to `i:` even after restart and
  when no remote internal document exists yet.
- Reject non-prefixed Vault-root hidden documents and ordinary documents which
  project into the reserved shared paths. Before an internal operation, check
  its ordinary alias in that CouchDB peer. A live ordinary alias blocks that
  operation and is reported as a collision. Preserve both documents and the
  destination file. Do not migrate or delete the alias automatically.
- Enable Commonlib's `syncInternalFiles` only from a non-empty `includeInternal`
  list, and retain that derived value across remote tweaks and reconnects. The
  list remains the authority for file selection.

The shared path is sufficient to select the route within this support boundary.
This decision introduces no persistent origin inventory, Hub event type,
database format, encryption mode, or automatic recovery mechanism.

## Alternatives considered

### Keep the option receive-only

This is a valid smaller fix for the original delivery failure. It requires
blocking hidden-file writes and documenting the limitation. It does not provide
the proposed bidirectional contract. This decision extends the scope beyond that
smaller fix.

### Apply `baseDir` to every internal path

This would make the existing `blog/` and `.claude/**` example stop selecting
Vault-root configuration. A dedicated internal root setting could express a
different mapping later, but is unnecessary for the current use case.

### Treat every glob match as an internal file

A pattern such as `**` would then redirect ordinary notes into `i:` documents.
Patterns select eligible hidden paths; they do not define their namespace.

### Preserve arbitrary internal namespaces through the Hub

An explicit namespace in every event could preserve more document kinds between
CouchDB peers. New local files and edits after restart would still need an
unambiguous mapping from storage paths. Supporting arbitrary namespaces would
require a broader routing design; it is not needed for Vault-root hidden files.

## Consequences

The selection is explicit and symmetric. An unmatched hidden file never falls
back to an ordinary write. A raw `syncInternalFiles: true` cannot bypass the
selection. Immediate echo suppression remains useful, but it does not establish
file identity.

Reserving dot-prefixed shared paths narrows accidental ordinary-file behaviour:
for example, `blog/.claude/x` can no longer be projected as an ordinary shared
`.claude/x`. Databases containing such documents need manual review. Existing
non-prefixed documents and their histories are retained.

Collision checks are limited to Metadata visible in that CouchDB peer. They are
not a transaction with independent clients or a general filesystem alias check.
Clearing a collision does not promise replay of an already skipped change. A
later source change or an explicitly requested full rescan with the existing
`--reset` option is required. No new retry state is introduced.

## References

- [Internal-file synchronisation design](../design_docs/internal_file_synchronisation.md)
- [Bridge issue #86](https://github.com/vrtmrz/livesync-bridge/issues/86)
- [Original `includeInternal` change](https://github.com/vrtmrz/livesync-bridge/pull/39)
- [Self-hosted LiveSync hidden-file handling](https://github.com/vrtmrz/obsidian-livesync/blob/ce0524d49f4e1c840689d83d3f8f18fce383effb/src/features/HiddenFileSync/CmdHiddenFileSync.ts)
