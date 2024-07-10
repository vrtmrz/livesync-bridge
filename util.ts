import { uint8ArrayToHexString } from "./lib/src/string_and_binary/convert.ts";
import { createTextBlob } from "./lib/src/common/utils.ts";


export async function computeHashUInt8Array(key: Uint8Array) {
    const digest = await crypto.subtle.digest('SHA-256', key);
    return uint8ArrayToHexString(new Uint8Array(digest));
}

export const computeHash = async (key: string[] | Uint8Array) => {
    if (key instanceof Uint8Array) return computeHashUInt8Array(key);
    const dx = createTextBlob(key);
    const buf = await dx.arrayBuffer();
    return computeHashUInt8Array(new Uint8Array(buf));

}

export function makeUniqueString() {
    const randomStrSrc = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const temp = [...Array(30)]
        .map(() => Math.floor(Math.random() * randomStrSrc.length))
        .map((e) => randomStrSrc[e])
        .join("");
    return `${Date.now()}-${temp}`;
}