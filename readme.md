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

## Simply run

1. Clone the GitHub Repository

```git
git clone --recursive https://github.com/vrtmrz/livesync-bridge
```

2. Open the config file dat/config.sample.json, edit and save to
   dat/config.json. (You do not have to worry, the sample is in the following
   section).
3. Simply run like this.

```bash
$ deno run -A main.ts
```

Note: If you want to scan all storage and databases from the beginning, please run with `--reset`.

# Docker Instructions

1. Clone the GitHub Repository

```git
git clone https://github.com/vrtmrz/livesync-bridge
```

2. Open the config file dat/config.sample.json, edit and save to
   dat/config.json. (storage folder have to start with "data/" to be in the volume)

3. Simply run like this.
```bash
docker compose up -d
```


# Configuration

The configuration file consists of the following structure.

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
      "obfuscatePassphrase": "passphrase", // Path obfuscation passphrase, if you do not enabled, leave it blank. if enabled, set the same value of passphrase.
      "baseDir": "blog/" // Sharing folder
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
      "usePolling": false // Optional. Use polling instead of inotify to watch file changes.
    }
  ]
}
```

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
      "obfuscatePassphrase": "glucose", // Path obfuscation passphrase, if you do not enabled, leave it blank. if enabled, set the same value of passphrase.
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
      "obfuscatePassphrase": "cocoa", // Path obfuscation passphrase, if you do not enabled, leave it blank. if enabled, set the same value of passphrase.
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
