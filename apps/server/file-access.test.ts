import assert from "node:assert/strict";
import test from "node:test";

import { createSignedUploadUrl, parseUploadFileName, verifyUploadSignature } from "./file-access.js";

// DB 없이 돌도록 서명 키를 환경변수로 준다. (키는 첫 서명 때 읽는다)
process.env.FILE_URL_SECRET = "test-secret";

test("parseUploadFileName accepts only flat /uploads file names", () => {
  assert.equal(parseUploadFileName("/uploads/abc.png"), "abc.png");
  assert.equal(parseUploadFileName("http://127.0.0.1:4000/uploads/abc.png?x=1"), "abc.png");
  assert.equal(parseUploadFileName("/uploads/%2e%2e%2fsecret"), null);
  assert.equal(parseUploadFileName("/uploads/a/b.png"), null);
  assert.equal(parseUploadFileName("/uploads/"), null);
  assert.equal(parseUploadFileName("/api/pages"), null);
});

test("signed upload URLs verify, expire and are bound to the file", async () => {
  const now = Date.UTC(2026, 10, 5, 12, 30);
  const { url } = await createSignedUploadUrl("abc.png", now);
  const parsed = new URL(url, "http://local");
  const exp = parsed.searchParams.get("exp");
  const sig = parsed.searchParams.get("sig");

  assert.equal(await verifyUploadSignature("abc.png", exp, sig, now), true);
  assert.equal(await verifyUploadSignature("other.png", exp, sig, now), false);
  assert.equal(await verifyUploadSignature("abc.png", String(Number(exp) + 3600), sig, now), false);
  assert.equal(await verifyUploadSignature("abc.png", exp, `${sig}x`, now), false);
  assert.equal(await verifyUploadSignature("abc.png", exp, sig, now + 3 * 60 * 60 * 1000), false);
  assert.equal(await verifyUploadSignature("abc.png", null, null, now), false);

  // 같은 시간대에는 같은 주소 (브라우저 캐시 재사용)
  const again = await createSignedUploadUrl("abc.png", now + 10 * 60 * 1000);
  assert.equal(again.url, url);
});
