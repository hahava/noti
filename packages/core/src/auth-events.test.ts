import assert from "node:assert/strict";
import test from "node:test";
import { buildAuthEventQuery } from "./auth-events";

test("auth events: filters become parameters, never SQL text", () => {
  const evil = "x'; DROP TABLE users; --";
  const q = buildAuthEventQuery({ result: "failure", username: ` ${evil} `, ip: evil, source: "admin", days: 999, limit: 10_000, before: 42 });
  assert.ok(!q.where.includes("DROP"), "user input stays out of the SQL");
  assert.deepEqual(q.params, [90, "admin", evil.toLowerCase(), evil, 42]);
  assert.match(q.where, /result <> 'success'/);
  assert.equal(q.limit, 500);
});

test("auth events: defaults and unknown values are ignored", () => {
  const q = buildAuthEventQuery({ result: "nope" as never, source: "other" as never, days: 0 });
  assert.deepEqual(q.params, [1]);
  assert.equal(q.where, "at > NOW() - ($1::int * INTERVAL '1 day')");
  assert.equal(q.limit, 100);
  assert.deepEqual(buildAuthEventQuery({ result: "throttled" }).params, [7, "throttled"]);
});
