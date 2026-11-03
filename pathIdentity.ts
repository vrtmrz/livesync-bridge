import type { TweakValues } from "@vrtmrz/livesync-commonlib/compat/common/types";
import type { Config, PeerConf } from "./types.ts";

/** Resolve an omitted path identity version to the legacy behaviour. */
export function getPeerPathNormalizationVersion(peer: PeerConf): 0 | 1 {
    const version: unknown = peer.pathNormalizationVersion;
    if (version === undefined) return 0;
    if (version === 0 || version === 1) return version;
    throw new Error(`Unsupported pathNormalizationVersion for peer "${peer.name}": ${String(version)}`);
}

function filenameCaseSensitive(value: unknown, owner: string): boolean {
    if (value === undefined) return false;
    if (typeof value === "boolean") return value;
    throw new Error(`Unsupported handleFilenameCaseSensitive for ${owner}: ${String(value)}`);
}

/** Compare the effective remote case rule after any explicitly requested tweak adoption. */
export function assertPeerMatchesRemoteCase(
    peer: PeerConf,
    tweaks: Pick<TweakValues, "handleFilenameCaseSensitive">,
    disableCheckingConfigMismatch = false,
): void {
    const local = filenameCaseSensitive(peer.handleFilenameCaseSensitive, `peer "${peer.name}"`);
    const remote = filenameCaseSensitive(tweaks.handleFilenameCaseSensitive, `remote of peer "${peer.name}"`);
    if (!disableCheckingConfigMismatch && local !== remote) {
        throw new Error(
            `handleFilenameCaseSensitive differs for peer "${peer.name}" (configured ${local}, remote ${remote}). ` +
                "Use matching settings, or set disableCheckingConfigMismatch: true to ignore filename-case mismatches.",
        );
    }
}

/** Ensure peers which exchange paths agree on their effective identity rules. */
export function validatePeerPathIdentity(config: Config): void {
    const groupVersions = new Map<string, 0 | 1>();
    const groupCaseRules = new Map<string, boolean>();
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
        const caseSensitive = filenameCaseSensitive(peer.handleFilenameCaseSensitive, `peer "${peer.name}"`);
        const previousCase = groupCaseRules.get(group);
        if (
            config.disableCheckingConfigMismatch !== true &&
            previousCase !== undefined &&
            previousCase !== caseSensitive
        ) {
            throw new Error(
                `Peers in group "${group}" must use the same handleFilenameCaseSensitive (found ${previousCase} and ${caseSensitive}). ` +
                    "Use matching settings, or set disableCheckingConfigMismatch: true to ignore filename-case mismatches.",
            );
        }
        groupCaseRules.set(group, caseSensitive);
    }
}
