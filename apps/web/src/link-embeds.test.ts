import assert from "node:assert/strict";
import test from "node:test";
import { safeHttpUrl, toEmbed } from "./link-embeds";

test("toEmbed: allowed providers become iframe URLs", () => {
  assert.equal(toEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42")?.src, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?start=42");
  assert.equal(toEmbed("https://youtu.be/dQw4w9WgXcQ")?.src, "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ");
  assert.equal(toEmbed("https://youtube.com/shorts/abc_123")?.src, "https://www.youtube-nocookie.com/embed/abc_123");
  assert.equal(toEmbed("https://vimeo.com/76979871")?.src, "https://player.vimeo.com/video/76979871");
  assert.equal(toEmbed("https://www.loom.com/share/abc123")?.src, "https://www.loom.com/embed/abc123");
  assert.match(toEmbed("https://www.figma.com/design/KEY/Name")!.src, /^https:\/\/www\.figma\.com\/embed\?embed_host=noty&url=https%3A/);
  assert.equal(toEmbed("https://docs.google.com/spreadsheets/d/AbC-1_2/edit#gid=0")?.src, "https://docs.google.com/spreadsheets/d/AbC-1_2/preview");
  assert.equal(toEmbed("https://docs.google.com/presentation/d/XyZ/edit")?.src, "https://docs.google.com/presentation/d/XyZ/embed");
  assert.equal(toEmbed("https://codepen.io/user/pen/abcd")?.src, "https://codepen.io/user/embed/abcd?default-tab=result");
  assert.equal(toEmbed("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC")?.height, 152);
});

test("toEmbed: anything else is not embedded", () => {
  assert.equal(toEmbed("https://example.com/video"), null);
  assert.equal(toEmbed("javascript:alert(1)"), null);
  assert.equal(toEmbed("https://www.youtube.com/watch?v=bad\"id"), null);
  assert.equal(toEmbed("https://www.google.com/maps/place/Seoul"), null);
  assert.equal(toEmbed("not a url"), null);
});

test("safeHttpUrl", () => {
  assert.equal(safeHttpUrl("https://a.com/x"), "https://a.com/x");
  assert.equal(safeHttpUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpUrl("data:image/png;base64,AA"), null);
  assert.equal(safeHttpUrl(undefined), null);
});
