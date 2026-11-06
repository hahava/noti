import assert from "node:assert/strict";
import test from "node:test";
import { LoginThrottle, parseAllowedOrigins, resolveAllowedOrigin } from "@noty/core/http-security";

test("CORS allows everything when unconfigured, otherwise only listed origins and Electron", () => {
  assert.equal(resolveAllowedOrigin("http://evil.example", []), "*");
  const allowed = parseAllowedOrigins(" https://noty.example.com/ , http://127.0.0.1:5173");
  assert.deepEqual(allowed, ["https://noty.example.com", "http://127.0.0.1:5173"]);
  assert.equal(resolveAllowedOrigin("https://noty.example.com", allowed), "https://noty.example.com");
  assert.equal(resolveAllowedOrigin("null", allowed), "null");
  assert.equal(resolveAllowedOrigin("http://evil.example", allowed), null);
  assert.equal(resolveAllowedOrigin(undefined, allowed), null);
});

test("login throttle blocks a username after repeated failures and resets on success", () => {
  const throttle = new LoginThrottle(3, 60_000, 60_000);
  const now = 1_000_000;
  throttle.recordFailure("Kalin", "1.1.1.1", now);
  throttle.recordFailure("kalin", "1.1.1.1", now);
  assert.equal(throttle.retryAfterSeconds("kalin", "2.2.2.2", now), 0);
  throttle.recordFailure("kalin", "1.1.1.1", now);
  assert.equal(throttle.retryAfterSeconds("kalin", "2.2.2.2", now), 60);
  assert.equal(throttle.retryAfterSeconds("other", "3.3.3.3", now), 0);
  assert.equal(throttle.retryAfterSeconds("kalin", "2.2.2.2", now + 61_000), 0);

  const fresh = new LoginThrottle(3, 60_000, 60_000);
  fresh.recordFailure("a", "9.9.9.9", now);
  fresh.recordFailure("a", "9.9.9.9", now);
  fresh.recordSuccess("a", "9.9.9.9");
  fresh.recordFailure("a", "9.9.9.9", now);
  assert.equal(fresh.retryAfterSeconds("a", "9.9.9.9", now), 0);
});

test("login throttle blocks an IP that tries many usernames", () => {
  const throttle = new LoginThrottle(2, 60_000, 60_000);
  for (let i = 0; i < 6; i += 1) throttle.recordFailure(`user${i}`, "5.5.5.5", 0);
  assert.ok(throttle.retryAfterSeconds("someone-else", "5.5.5.5", 0) > 0);
});
