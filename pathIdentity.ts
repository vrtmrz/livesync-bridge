import type { Config, PeerConf } from "./types.ts";

/** Resolve an omitted path identity version to the legacy behaviour. */
export function getPeerPathNormalizationVersion(peer: PeerConf): 0 | 1 {
    const version: unknown = peer.pathNormalizationVersion;
    if (version === undefined) return 0;
    if (version === 0 || version === 1) return version;
    throw new Error(`Unsupported pathNormalizationVersion for peer "${peer.name}": ${String(version)}`);
}

/** Ensure peers which exchange paths agree on the path identity representation. */
export function validatePeerPathIdentity(config: Config): void {
    const groupVersions = new Map<string, 0 | 1>();
    for (const peer of config.peers) {
        const version = getPeerPathNormalizationVersion(peer);
        const group = peer.group ?? "";
        const previousVersion = groupVersions.get(group);
        if (previousVersion !== undefined && previousVersion !== version) {
            throw new Error(
                `Peers in group "${group}" must use the same pathNormalizationVersion (found ${previousVersion} and ${version})`,
            );
        }
        groupVersions.set(group, version);
    }
}
