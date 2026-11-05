import assert from "node:assert/strict";
import test from "node:test";
import { isSealed, mapSettingSecrets, openSecret, resetSecretKeyCache, sealSecret } from "./secret-box.js";

process.env.NOTY_SECRET_KEY = "test-key-1";
resetSecretKeyCache();

test("seals and opens secrets, keeps legacy plaintext readable", () => {
  const sealed = sealSecret("sk-live-abcdef");
  assert.ok(isSealed(sealed));
  assert.ok(!sealed.includes("sk-live"));
  assert.notEqual(sealSecret("sk-live-abcdef"), sealed, "random IV per seal");
  assert.equal(openSecret(sealed), "sk-live-abcdef");
  assert.equal(openSecret("plain-old-key"), "plain-old-key");
  assert.equal(sealSecret(""), "");
  assert.equal(sealSecret(sealed), sealed, "already sealed values are not sealed twice");
});

test("a different key or tampered value cannot be opened", () => {
  const sealed = sealSecret("secret-value");
  const tampered = sealed.slice(0, -2) + (sealed.endsWith("A") ? "BB" : "AA");
  assert.equal(openSecret(tampered), "");
  process.env.NOTY_SECRET_KEY = "another-key";
  resetSecretKeyCache();
  assert.equal(openSecret(sealed), "");
  process.env.NOTY_SECRET_KEY = "test-key-1";
  resetSecretKeyCache();
  assert.equal(openSecret(sealed), "secret-value");
});

test("maps only secret fields of settings rows", () => {
  const upper = (v: string) => v.toUpperCase();
  assert.deepEqual(
    mapSettingSecrets("ai", { provider: "openai", apiKey: "a", model: "m", profiles: { openai: { apiKey: "b", model: "x" }, ollama: null } }, upper),
    { provider: "openai", apiKey: "A", model: "m", profiles: { openai: { apiKey: "B", model: "x" }, ollama: null } },
  );
  assert.deepEqual(mapSettingSecrets("database", { host: "h", password: "p" }, upper), { host: "h", password: "P" });
  assert.deepEqual(mapSettingSecrets("storage", { localPath: "/x" }, upper), { localPath: "/x" });
});
