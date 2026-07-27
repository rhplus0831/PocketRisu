import { Buffer as BrowserBuffer } from "buffer";
import { Buffer as NodeBuffer } from "node:buffer";
import { describe, expect, test } from "vitest";
import { encodeBase64UrlBytes, encodeUtf8Base64Url } from "./base64Url";

describe("browser-safe base64url encoding", () => {
    test("runs against the npm Buffer polyfill used by the browser bundle", () => {
        expect(BrowserBuffer).not.toBe(NodeBuffer);
        expect(() => BrowserBuffer.from("compatibility-check").toString("base64url"))
            .toThrow("Unknown encoding: base64url");
    });

    test("does not require the Node-only base64url Buffer alias", () => {
        const value = "☸에로스 타워";
        expect(encodeUtf8Base64Url(value))
            .toBe(NodeBuffer.from(value, "utf8").toString("base64url"));
    });

    test("uses the URL-safe alphabet without padding for arbitrary bytes", () => {
        expect(encodeBase64UrlBytes(new Uint8Array([0xfb, 0xff, 0xef])))
            .toBe("-__v");
        expect(encodeBase64UrlBytes(new Uint8Array([0])))
            .toBe("AA");
    });
});
