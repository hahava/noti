import assert from "node:assert/strict";
import test from "node:test";
import { collectionIdFromDocumentName, pageIdFromDocumentName } from "./collaboration-store.js";

test("accepts the page room naming contract", () => {
  assert.equal(pageIdFromDocumentName("page:welcome"), "welcome");
  assert.equal(pageIdFromDocumentName("page:page-ab12_CD"), "page-ab12_CD");
});

test("rejects arbitrary or unsafe room names", () => {
  assert.equal(pageIdFromDocumentName("welcome"), null);
  assert.equal(pageIdFromDocumentName("page:"), null);
  assert.equal(pageIdFromDocumentName("page:../welcome"), null);
  assert.equal(pageIdFromDocumentName("workspace:anything"), null);
});

test("accepts only safe collection room names", () => {
  assert.equal(collectionIdFromDocumentName("collection:collection-abc_123"), "collection-abc_123");
  assert.equal(collectionIdFromDocumentName("collection:../secret"), null);
  assert.equal(collectionIdFromDocumentName("collection:abc"), null);
  assert.equal(collectionIdFromDocumentName("page:collection-abc"), null);
});
