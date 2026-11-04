# Bridge integration verification

Run the type, lint, and root unit checks from the repository root:

```sh
deno task check
deno task lint
deno test -A ./*.test.ts
```

The integration suites use the isolated CouchDB fixture on port 5989. Start only
that service, then run the suites sequentially:

```sh
docker compose -f test/integration/compose.yml up -d --wait couchdb
COUCHDB_URL=http://127.0.0.1:5989 COUCHDB_USERNAME=admin COUCHDB_PASSWORD=testpassword deno task test:integration
deno task test:watcher
```

`test:integration` includes direct CouchDB checks, the existing storage round
trips, and the NFC scenarios. The NFC matrix uses Deno and Chokidar, encryption
on and off, and both filename case policies. It checks NFD names, remote NFC
requests, native edits, explicit spelling renames, exact revision ancestry,
restart delivery, and parent deletion. A separate case requires NFC admission
over populated Legacy Metadata to fail without changing the database or its
readable content. The migration scenario checks rejection before the changes
feed for both direct remote mismatch and mismatch introduced by explicit tweak
adoption. The top-level mismatch override then permits a real round trip while
retaining each peer's case setting and the original Metadata revision ancestry.

Root unit tests cover default Legacy settings, invalid versions, group
agreement, cache and checkpoint identity, aliases after earlier cache hits,
permission failures, stopped notifications, and incomplete initial inventories.
The Deno storage boundary also checks missing suffixes, ignored trees, physical
spelling, and observed symbolic links.

The standard watcher suites retain their existing scenario selection. The
`test:watcher:diagnostic` and `test:e2e:diagnostic` tasks select the additional
native-watcher diagnostic cases; a diagnostic failure remains a failure.

If this run started the fixture, stop its service and task-owned data after the
checks finish:

```sh
docker compose -f test/integration/compose.yml down --volumes
```

Current NFC runtime evidence is from Linux ARM64 with Deno and CouchDB 3.5.0.
Native Windows and macOS filesystem behaviour needs its own verification. This
does not establish that every shutdown or concurrent external-filesystem
interleaving is covered.

Integration checks use the published registry package
`@vrtmrz/livesync-commonlib@0.3.1`, pinned by the import map and `deno.lock`.
Run `deno install --frozen` from the repository root before the checks to
install from that lockfile. The Commonlib package is published; this Bridge
implementation remains unreleased.
