import { createTextBlob } from "@vrtmrz/livesync-commonlib/compat/common/utils";
import { uint8ArrayToHexString } from "@vrtmrz/livesync-commonlib/compat/string_and_binary/convert";


export async function computeHashUInt8Array(key: Uint8Array) {
    const digestInput = key.buffer instanceof ArrayBuffer
        ? new Uint8Array(key.buffer, key.byteOffset, key.byteLength)
        : new Uint8Array(key);
    const digest = await crypto.subtle.digest('SHA-256', digestInput);
    return uint8ArrayToHexString(new Uint8Array(digest));
}

export const computeHash = async (key: string[] | Uint8Array) => {
    if (key instanceof Uint8Array) return computeHashUInt8Array(key);
    const dx = createTextBlob(key);
    const buf = await dx.arrayBuffer();
    return computeHashUInt8Array(new Uint8Array(buf));

}

const ID_RECOVERY_CODE_PREFIX = "sls-id-v1:";

/**
 * Normalise a configured ID key to the raw 64-character hex key.
 * Accepts the raw key or the recovery code shown by Self-hosted LiveSync (`sls-id-v1:<key>`).
 * Returns `undefined` when no key is configured and throws when the value is malformed.
 */
export function normaliseIdDerivationKey(key: string | undefined): string | undefined {
    const trimmed = key?.trim();
    if (!trimmed) return undefined;
    const raw = trimmed.startsWith(ID_RECOVERY_CODE_PREFIX) ? trimmed.slice(ID_RECOVERY_CODE_PREFIX.length) : trimmed;
    if (!/^[0-9a-f]{64}$/.test(raw)) {
        throw new Error(`idDerivationKey must be a 64-character hex key or a ${ID_RECOVERY_CODE_PREFIX} recovery code.`);
    }
    return raw;
}

export function makeUniqueString() {
    const randomStrSrc = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const temp = [...Array(30)]
        .map(() => Math.floor(Math.random() * randomStrSrc.length))
        .map((e) => randomStrSrc[e])
        .join("");
    return `${Date.now()}-${temp}`;
}
