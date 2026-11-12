import assert from "node:assert/strict";
import test from "node:test";
import { withEditSelection } from "./ai-chat.js";

test("withEditSelection puts the selection and output format into the last user turn", () => {
  const plain = [{ role: "user" as const, content: "안녕" }];
  assert.equal(withEditSelection(plain, ""), plain);
  const [message] = withEditSelection(plain, "고칠 글");
  assert.equal(message.role, "user");
  assert.match(message.content, /^요청: 안녕/);
  assert.match(message.content, /<selection>\n고칠 글\n<\/selection>/);
  assert.match(message.content, /<result>/);
});
