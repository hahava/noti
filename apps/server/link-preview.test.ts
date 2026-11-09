import assert from "node:assert/strict";
import test from "node:test";
import { fetchLinkPreview, isBlockedAddress, parseLinkPreview } from "./link-preview.js";

test("isBlockedAddress: internal ranges are blocked, public ones are not", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::"]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"]) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test("fetchLinkPreview refuses internal and odd addresses without connecting", async () => {
  for (const url of ["http://127.0.0.1/", "http://localhost/", "http://[::1]/", "http://169.254.169.254/latest/meta-data", "ftp://example.com/", "http://user:pw@example.com/", "http://example.com:8080/", "file:///etc/passwd"]) {
    await assert.rejects(fetchLinkPreview(url), url);
  }
});

test("parseLinkPreview: Open Graph first, falls back to title and favicon", () => {
  const html = `<html><head>
    <title>Fallback &amp; title</title>
    <meta property="og:title" content="OG &quot;Title&quot;">
    <meta name="description" content='Plain description'>
    <meta property="og:image" content="/img/cover.png">
    <link rel="shortcut icon" href="/fav.png">
  </head></html>`;
  const p = parseLinkPreview(html, "https://www.example.com/post/1");
  assert.equal(p.title, 'OG "Title"');
  assert.equal(p.description, "Plain description");
  assert.equal(p.image, "https://www.example.com/img/cover.png");
  assert.equal(p.icon, "https://www.example.com/fav.png");
  assert.equal(p.siteName, "example.com");
  const bare = parseLinkPreview("<title>Only</title>", "https://a.com/");
  assert.equal(bare.title, "Only");
  assert.equal(bare.icon, "https://a.com/favicon.ico");
  assert.equal(parseLinkPreview('<meta property="og:image" content="javascript:alert(1)">', "https://a.com/").image, "");
});
