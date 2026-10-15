import { computeHash, computeHashUInt8Array, normaliseIdDerivationKey } from "./util.ts";

function assertEquals<T>(actual: T, expected: T, message: string) {
    if (actual !== expected) {
        throw new Error(`${message}\nactual=${actual}\nexpected=${expected}`);
    }
}

Deno.test("computeHash returns stable SHA-256 hex for bytes and text chunks", async () => {
    const expected = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

    assertEquals(await computeHashUInt8Array(new TextEncoder().encode("hello")), expected, "byte hash should match SHA-256");
    assertEquals(await computeHash(["hello"]), expected, "text chunk hash should match SHA-256");
});

Deno.test("computeHash accepts the ArrayBuffer-backed bytes used by file data", async () => {
    const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(5));
    bytes.set(new TextEncoder().encode("hello"));

    assertEquals(
        await computeHash(bytes),
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        "ArrayBuffer-backed byte hash should match SHA-256",
    );
});

const ID_KEY = "0123456789abcdef".repeat(4);

Deno.test("normaliseIdDerivationKey accepts a raw hex key and a recovery code", () => {
    assertEquals(normaliseIdDerivationKey(ID_KEY), ID_KEY, "raw key should be returned unchanged");
    assertEquals(normaliseIdDerivationKey(` sls-id-v1:${ID_KEY} `), ID_KEY, "recovery code should be reduced to the raw key");
});

Deno.test("normaliseIdDerivationKey returns undefined when no key is configured", () => {
    assertEquals(normaliseIdDerivationKey(undefined), undefined, "missing key should stay undefined");
    assertEquals(normaliseIdDerivationKey("  "), undefined, "blank key should be treated as missing");
});

Deno.test("normaliseIdDerivationKey rejects malformed keys", () => {
    for (const bad of ["not-a-key", ID_KEY.slice(1), `sls-id-v2:${ID_KEY}`, ID_KEY.toUpperCase()]) {
        let threw = false;
        try {
            normaliseIdDerivationKey(bad);
        } catch {
            threw = true;
        }
        assertEquals(threw, true, `"${bad}" should be rejected`);
    }
});
