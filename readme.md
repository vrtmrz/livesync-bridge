# LiveSync Bridge

![screenshot](https://github.com/vrtmrz/livesync-bridge/assets/45774780/457f8909-14e4-4d86-bcf9-24fad7d3342a)

## What is this?

This is a custom replicator between Self-hosted LiveSync remote vaults and
storage. **The Unified Version of filesystem-livesync and livesync-classroom**.

A Vault or storage can be synchronised with vaults or storage. You can even combine them. Of course, different passphrases for each vault could be used.
And, you can synchronize documents under the specified folder on the vault, to another vault's specified one.

Of course, it is multi-directional!

# How to use

## Prerequisites

- [Deno](https://deno.com/) is required.

### Path identity compatibility

Unicode NFC support is an unreleased addition which requires the Commonlib
package containing the `/storage` entry and the direct-file path identity
option. Published Commonlib `0.3.0` still requires Legacy identity for Bridge.

Publish and validate the required immutable Commonlib package before releasing
this Bridge integration. Then replace the provisional package version in every
Commonlib import and regenerate `deno.lock` from the registry. Follow the
[Commonlib and application release order](https://github.com/vrtmrz/livesync-commonlib/blob/main/docs/releasing.md#coordinating-package-and-application-releases);
a local package overlay does not establish registry installation readiness.

Each peer selects `pathNormalizationVersion`:

- omitted or `0` retains **Legacy path identity**;
- `1` selects **Unicode NFC path identity**; and
- any other value is rejected.

Peers with the same `group` must select the same version before they start.
An omitted group is the shared empty group. Independent groups can select
different versions. The CouchDB database and its participating LiveSync clients
must use the selected version too. The bridge does not adopt another identity
silently from remote tweaks.

`handleFilenameCaseSensitive` remains separate from Unicode normalisation.
On storage peers it controls NFC name comparison; Legacy keeps its existing
native path behaviour. On CouchDB peers it controls the existing document-ID
case rule. Choose the same case rule as the participating LiveSync clients.
The default is `false`. Legacy and NFC groups are checked for agreement before
startup and before transfers. A CouchDB peer also compares its effective case
rule with the remote preferred setting before watching. An omitted remote case
value means `false`.

`useRemoteTweaks: true` explicitly adopts the remote settings, preferring the
`PREFERRED` entry and retaining the first entry as a fallback for older
milestones. The adopted case rule is checked against the group before the
changes feed starts. Adoption updates that CouchDB peer; it does not rewrite
storage peers or migrate document IDs.

Document-ID admission runs before remote tweaks are read. For a database with
obfuscated document IDs, set `handleFilenameCaseSensitive` to the database's
existing value in the initial peer configuration: `useRemoteTweaks` cannot
correct an initial case rule which fails that admission check. The mismatch
override below also retains this prerequisite.

For migration compatibility, the top-level `disableCheckingConfigMismatch`
option defaults to `false`. Set it to `true` to permit filename-case differences
within groups and against remote settings:

```jsonc
{
  "disableCheckingConfigMismatch": true,
  "peers": [ /* Existing peer configuration */ ]
}
```

This override preserves each peer's effective case rule. It does not align
names, migrate data, bypass alias checks, or permit different
`pathNormalizationVersion` values in one group or against the database. Keep
case rules consistent for normal operation. Bridge currently uses this option
for filename-case checks; existing document-ID admission, encryption, and
compression checks retain their behaviour.

For example, an NFC group with case-sensitive names can use:

```jsonc
{
  "peers": [
    {
      "name": "notes-files",
      "type": "storage",
      "group": "notes",
      "baseDir": "./vault",
      "pathNormalizationVersion": 1,
      "handleFilenameCaseSensitive": true
    },
    {
      "name": "notes-database",
      "type": "couchdb",
      "group": "notes",
      "baseDir": "",
      "url": "https://couchdb.example.com",
      "database": "notes",
      "username": "<username>",
      "password": "<password>",
      "passphrase": "",
      "obfuscatePassphrase": "",
      "pathNormalizationVersion": 1,
      "handleFilenameCaseSensitive": true
    }
  ]
}
```

NFC storage resolves each existing file and parent using its actual directory
name. Ordinary writes preserve those physical names; missing components retain
the requested spelling. Multiple names which have the same NFC and case
comparison key are ambiguous, including an exact-match request. Reads, writes,
and deletions reject the ambiguity before changing a file. Symbolic-link
components are not followed in NFC mode. Permission and I/O failures remain
failed operations rather than evidence of absence or successful delivery.

Both Deno and Chokidar watchers retain event paths. An old deletion event does
not remove a database entry while an equivalent live spelling remains. NFC
inventories validate aliases before reporting the watcher healthy, and queued
notifications from a stopped watcher are discarded. NFC file observations and
CouchDB resume positions include the selected identity policy, so a Legacy
observation or checkpoint cannot suppress the initial NFC read. Existing Legacy
state remains available under its existing keys.

Changing this setting alone does not migrate an existing database. Preserve a
complete, authoritative Vault, unique local edits, and required history, stop
synchronisation on all clients, and use LiveSync's coordinated Rebuild and Fetch
procedure before reconnecting Bridge with the matching mode. The bridge does
not rewrite document IDs or merge histories in place. The existing
`scanOfflineChanges` option still controls whether the initial storage inventory
uploads local content.

## Simply run

1. Clone the GitHub Repository

```git
git clone https://github.com/vrtmrz/livesync-bridge
```

2. Open the config file dat/config.sample.json, edit and save to
   dat/config.json. (You do not have to worry, the sample is in the following
   section).
3. Simply run like this.

```bash
$ deno install
$ deno task run
```

Note: If you want to scan all storage and databases from the beginning, please run with `--reset`.

CouchDB resume positions are saved separately for each peer name, `baseDir`,
server URL (including any proxy path), and database name. Credentials are not
part of this identity. Existing checkpoints without a remote identity are not
reused, so the first connection after upgrading reads remote changes from the
beginning. Keep the Deno `localStorage` data to retain resume positions across
restarts.

CouchDB changes with unavailable chunks are retried from the source database, while
failed deliveries are retried with capped backoff and other files continue. A newer
change for the same document supersedes its pending read so a stale result cannot
restore older content. The resume position advances through completed changes only;
later changes can be replayed after restart if an earlier one keeps failing. Retries
keep pending change metadata in memory and read file content from CouchDB as needed.

# Docker Instructions

1. Clone the GitHub Repository

```git
git clone https://github.com/vrtmrz/livesync-bridge
```

2. Open the config file dat/config.sample.json, edit and save to
   dat/config.json. (The storage folder has to start with "data/" to be in the volume)

3. Simply run like this.
```bash
docker compose up -d
```

The Compose configuration stores Deno's `localStorage` data, which offline
scans use to identify changed files, in the named volume
`bridge_local_storage`. Keep this volume when recreating containers. Running
`docker compose down --volumes` removes it, so the next offline scan must
rebuild this data.

### Choosing where scan state is stored

The named volume is the default because it preserves the scan state across
container recreation without requiring a host path. You can replace it with a
bind mount if you prefer to manage this data on the host. Create a
`docker-compose.local.yml` file containing:

```yaml
services:
  bridge:
    volumes:
      - type: bind
        source: ./dat/location_data
        target: /deno-dir/location_data
        bind:
          create_host_path: false
```

Create the source directory before starting the bridge:

```bash
mkdir -p dat/location_data
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
```

On Linux, ensure that the directory is writable by UID and GID `1993:1993`,
which the current image uses for the `deno` user. Files below `dat/` are
already excluded from this repository by `.gitignore`.

For host-managed temporary storage, use a path below `/tmp` instead, for
example:

```yaml
source: /tmp/livesync-bridge-location_data
```

Create this directory and give the `deno` user write access before starting
the bridge. Its lifetime depends on the host's `/tmp` clean-up policy; it can
remain after the container is removed.

For state which should last only as long as the container, replace the bind
mount above with a memory-backed `tmpfs` mount:

```yaml
services:
  bridge:
    volumes:
      - type: tmpfs
        target: /deno-dir/location_data
        tmpfs:
          mode: 0o1777
```

The contents of this mount are lost when the container stops or is recreated,
so the next offline scan must rebuild the state.


# Configuration

The configuration file consists of the following structure. The basic example
below leaves hidden-file synchronisation disabled. To opt in, see
[Synchronising internal/hidden files](#synchronising-internalhidden-files).

```jsonc
{
  "peers": [
    {
      "type": "couchdb", // Type should be `couchdb or storage`
      "name": "test1", // Should be unique
      "group": "main", // we can omit this.
      "database": "test",
      "username": "admin",
      "password": "password",
      "url": "http://localhost:5984",
      "customChunkSize": 100,
      "minimumChunkSize": 20,
      "passphrase": "passphrase", // E2EE passphrase, if you do not enabled, leave it blank.
      "obfuscatePassphrase": "passphrase", // Path obfuscation passphrase. Leave blank to disable it; this may differ from passphrase.
      "idDerivationKey": "sls-id-v1:...", // ID key of the vault, if it uses one (see below). Omit it otherwise.
      "baseDir": "blog/", // Sharing folder
      "useRemoteTweaks":true // Overwrite customChunkSize or minimumChunkSize, and check configuration matches
    },
    {
      "type": "couchdb",
      "name": "test2", // We can even synchronise the same databases as long as they have different names in here.
      "group": "main", // we can omit this.
      "database": "test2",
      "username": "admin",
      "passphrase": "passphrase",
      "password": "password",
      "url": "http://localhost:5984",
      "customChunkSize": 100,
      "minimumChunkSize": 20,
      "obfuscatePassphrase": "passphrase",
      "baseDir": "xxxx/",
    },
    {
      "type": "storage",
      "name": "storage-test1",
      "group": "main", // we can omit this.
      "baseDir": "./vault/", // The folder which have been synchronised.
      "processor": { // The processor configuration. You can omit this.
        "cmd": "script/test.sh",  // The programme which run at file modification or deletion.
        "args": [ "$filename", "$mode" ] 
        // The modified file is set to $filename. The mode is set to `deleted` or `modified`. 
        // $filename and $mode have been set also in environment variables.
      },
      "scanOfflineChanges": true,
      "ignore": ["**/.git/**", "node_modules/**"], // Glob patterns which are never synchronised. Omit to synchronise everything.
      "useChokidar":false, // Use Chokidar instead of Deno.watchFs; see filesystem watcher limitations.
    }
  ]
}
```

## Filesystem watcher limitations

Storage peers use `Deno.watchFs` by default. Setting `useChokidar` to `true`
selects Chokidar instead.

On Windows, renaming a watched directory containing subdirectories can fail
with an access-denied error when Chokidar uses its default event-based watching.
This includes changing only the letter case of a directory name and moving it
to another name in the same parent directory. This restriction affects normal use while the bridge is
running, including filesystem operations initiated outside the bridge.
Treat these directory-tree renames as unsupported with Chokidar's default
watching mode on Windows.

Chokidar also offers polling through the `CHOKIDAR_USEPOLLING=true` environment
variable. This periodically checks filesystem state and can increase CPU use.
Its behaviour for these directory renames has not been verified in the bridge
on Windows. See the [Chokidar 3.6 options](https://github.com/paulmillr/chokidar/blob/3.6.0/README.md#performance)
for the polling intervals and other trade-offs.

See the [upstream Chokidar report](https://github.com/paulmillr/chokidar/issues/1380)
and Microsoft's [directory rename constraints](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information).
The default `Deno.watchFs` backend can report a directory being created or
renamed without reporting changes to files inside it. A file written
immediately after its directory is created, or a child file at its new path
after an ordinary or case-only directory rename, can therefore be missed while the
bridge is running. These behaviours were reproducible on Linux before the
internal-file synchronisation change. Switching to Chokidar does not guarantee
that all child-event gaps are resolved; its Windows directory-rename
restriction is described above.

## Vaults with an ID key

Recent versions of Self-hosted LiveSync derive chunk IDs and obfuscated document IDs from a separate ID key. New vaults with E2EE get a random ID key by default. The bridge needs the same key, or the plugin cannot read the files the bridge writes. It then reports that not all files could be synchronised.

Copy the key on any device with **Show current recovery code** in the plugin settings, and set it as `idDerivationKey`:

```jsonc
{
  "type": "couchdb",
  "name": "test1",
  // ...
  "passphrase": "passphrase",
  "obfuscatePassphrase": "passphrase",
  "idDerivationKey": "sls-id-v1:0123...cdef", // The recovery code, or the 64-character hex key on its own
  "useRemoteTweaks": true
}
```

With a key configured, the bridge uses ID derivation version 1 unless `idDerivationVersion` says otherwise. Keep the key private, like the passphrase.

## Synchronising internal/hidden files

This bidirectional routing change remains unreleased.

Hidden-file synchronisation is optional and disabled by default. For each
CouchDB peer, `includeInternal` enables synchronisation only for matching hidden
files, in both directions. Omit the field or use `[]` to keep it disabled.

Self-hosted LiveSync stores internal documents with an `i:` prefix. The bridge
supports hidden files whose first Vault-root path component begins with a dot,
such as `.claude/settings.json` or `.settings.json`.

Set `includeInternal` to an array of
[minimatch](https://github.com/isaacs/minimatch) glob patterns matched against the
complete Vault-root path after removing the `i:` prefix. The following example
enables synchronisation for `.claude/` only:

```jsonc
{
  "type": "couchdb",
  "name": "test1",
  // ...
  "baseDir": "blog/",
  "includeInternal": [".claude/**"] // Share selected .claude files in both directions
}
```

A hidden file is included when its path matches any pattern. Patterns use the
`dot` option, so hidden subdirectories are matched too. A broad pattern such as
`**` still leaves ordinary notes on their ordinary route. Other internal paths,
such as `i:note.md`, are outside this feature.

Internal paths are relative to the Vault root, independently of `baseDir`.
The example selects ordinary documents below `blog/` and internal files below
`.claude/` at the Vault root. The internal document
`i:.claude/settings.json` maps to `.claude/settings.json` below the storage
peer's root. Local creation, edits, and deletion use that same internal document
on the return route, including after restart.

Each CouchDB peer applies its own `includeInternal` patterns in both directions.
Opting one peer in does not enable another peer. Each Obsidian client that
should synchronise these files also needs hidden-file synchronisation enabled
in its own LiveSync settings. An excluded hidden file has no ordinary fallback
route. Storage peers' sending exclusions remain separate; see
[Excluding paths from a storage peer](#excluding-paths-from-a-storage-peer).

On CouchDB peers, shared paths beginning with a dot are reserved for this
internal route. Ordinary documents such as `blog/.claude/settings.json` are
excluded, and a hidden Vault-root folder cannot serve as an ordinary sharing
folder. Before using an internal path, the bridge checks for a live ordinary
document at `baseDir` joined with that shared path. If one exists, the bridge
reports both paths and blocks the internal operation, preserving both documents
and any existing storage file. A failed collision check also blocks the
operation. A deleted ordinary document does not block it. The bridge does not
merge, migrate, or delete conflicting documents automatically.

Changing `includeInternal` or resolving a collision does not replay previously
skipped changes. A later source change can trigger synchronisation. To rescan
existing files, restart with `--reset`; this clears the stored scan and resume
state for all peers.

> [!CAUTION]
> This synchronises files that are normally hidden and internal. Such folders often hold tool configuration that can contain machine-specific paths, local settings, or secrets. Only include patterns you genuinely intend to share, and review what they match before enabling. The option is opt-in: leave it out to keep the default behaviour, where all internal/hidden files are skipped.

## Excluding paths from a storage peer

By default a storage peer synchronises every file below its `baseDir`. The
optional `ignore` field on a storage peer excludes paths from that. It takes an
array of [minimatch](https://github.com/isaacs/minimatch) glob patterns which
are matched against the path relative to `baseDir`:

```jsonc
{
  "type": "storage",
  "name": "storage-test1",
  "baseDir": "./vault/",
  "ignore": ["**/.git/**", "node_modules/**", "**/*.tmp"]
}
```

A path is excluded when it, or any directory containing it, matches any one of
the patterns. Patterns are matched with the `dot` option, so leading-dot folders
such as `.git/` are matched as expected. A pattern ending in `/**` also covers
the directory itself, so `**/.git/**` excludes `.git` as well as everything
inside it. Likewise, a pattern which matches a directory's name excludes
everything below that directory: `private` excludes `private/note.md`, and
`**/*.tmp` excludes the contents of a directory named `cache.tmp`.

Excluded directories are pruned while scanning: they are not descended into, and
nothing inside them is inspected or read. This matters for `scanOfflineChanges`,
because a repository such as `.git/` can hold tens of thousands of files which
would otherwise all be examined at every start. Excluded paths are also skipped
for live additions, changes and deletions.

Note that `ignore` only stops a storage peer from *sending* its own changes.
Incoming changes from other peers are still accepted: a file which another peer
sends is still written, and a deletion which another peer sends is still
applied, even at an excluded path.

## Realistic example

| name                       | database_uri / path                       | CouchDB username | CouchDB password | vault E2EE passphrase | baseDir  |
| -------------------------- | ----------------------------------------- | ---------------- | ---------------- | --------------------- | -------- |
| private vault of Cornbread | http://localhost:5984/classroom_cornbread | cornbread        | tackle           | glucose               | shared/  |
| shared vault               | http://localhost:5984/classroom_shared    | common_user      | resu_nommoc      | cocoa                 |          |
| private vault of Vanilla   | http://localhost:5984/classroom_vanilla   | vanilla          | liberty          | smock                 | kyouyuu/ |
| storage                    | ./vault/                                  |                  |                  |                       |          |

Cornbread's every document under "shared" is synchronized with the top of the
shared vault:

| Cornbread          | shared            |
| ------------------ | ----------------- |
| document1          | _Not transferred_ |
| document2          | _Not transferred_ |
| shared/shared_doc1 | shared_doc1       |
| shared/sub/sub_doc | sub/sub_doc       |

Vanilla's every document under "kyouyuu" is synchronized with the top of the
shared vault:

| Vanilla                  | shared            |
| ------------------------ | ----------------- |
| documentA                | _Not transferred_ |
| documentB                | _Not transferred_ |
| kyouyuu/some_doc         | some_doc          |
| kyouyuu/sub/some_sub_doc | sub/some_sub_doc  |

Totally, all files are synchronized like this:

| Cornbread               | shared            | Vanilla                  |
| ----------------------- | ----------------- | ------------------------ |
| document1               | _Not transferred_ |                          |
| document2               | _Not transferred_ |                          |
|                         | _Not transferred_ | documentA                |
|                         | _Not transferred_ | documentB                |
| shared/shared_doc1      | shared_doc1       | kyouyuu/shared_doc1      |
| shared/some_doc         | some_doc          | kyouyuu/some_doc         |
| shared/sub/some_sub_doc | sub/some_sub_doc  | kyouyuu/sub/some_sub_doc |
| shared/sub/sub_doc      | sub/sub_doc       | kyouyuu/sub/sub_doc      |

... with the configuration below:

````jsonc
{
  "peers": [
    {
      "type": "couchdb", // Type should be `couchdb or storage`
      "name": "cornbread", // Should be unique
      "url": "http://localhost:5984",
      "database": "classroom_cornbread",
      "username": "cornbread",
      "password": "tackle",
      "passphrase": "glucose", // E2EE passphrase, if you do not enabled, leave it blank.
      "obfuscatePassphrase": "glucose", // Path obfuscation passphrase. Leave blank to disable it; this may differ from passphrase.
      "customChunkSize": 100,
      "minimumChunkSize": 20,
      "baseDir": "shared/" // Sharing folder
    },
    {
      "type": "couchdb", // Type should be `couchdb or storage`
      "name": "shared", // Should be unique
      "url": "http://localhost:5984",
      "database": "classroom_shared",
      "username": "common_user",
      "password": "resu_nommoc",
      "passphrase": "cocoa", // E2EE passphrase, if you do not enabled, leave it blank.
      "obfuscatePassphrase": "cocoa", // Path obfuscation passphrase. Leave blank to disable it; this may differ from passphrase.
      "customChunkSize": 100,
      "minimumChunkSize": 20,
      "baseDir": "" // Sharing folder
    },
    {
      "type": "couchdb",
      "name": "vanilla", // We can even synchronise the same databases as long as they have different names in here.
      "url": "http://localhost:5984",
      "database": "classroom_vanilla",
      "username": "vanilla",
      "password": "liberty",
      "passphrase": "smock",
      "obfuscatePassphrase": "smock",
      "customChunkSize": 100,
      "minimumChunkSize": 20,
      "baseDir": "kyouyuu/"
    },
    {
      "type": "storage",
      "name": "storage-test1",
      "baseDir": "./vault/" // The folder which have been synchronised.
    }
  ]
}
````

## Developer documentation

- [Internal-file synchronisation design](docs/design_docs/internal_file_synchronisation.md): accepted path, selection, and verification contract; implementation remains unreleased.
- [Internal-file synchronisation ADR](docs/adr/2026_10_internal_file_synchronisation.md): rationale, alternatives, and compatibility effects.
