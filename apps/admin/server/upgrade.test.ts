import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReplacementBody, compareVersions, parseImageRef } from "./upgrade.js";

test("parseImageRef: 레지스트리 이미지만 인식한다", () => {
  assert.deepEqual(parseImageRef("ghcr.io/hahava/noty:latest"), { registry: "ghcr.io", repo: "hahava/noty", tag: "latest" });
  assert.deepEqual(parseImageRef("ghcr.io/hahava/noty"), { registry: "ghcr.io", repo: "hahava/noty", tag: "latest" });
  assert.deepEqual(parseImageRef("localhost:5000/noty:1.2.0"), { registry: "localhost:5000", repo: "noty", tag: "1.2.0" });
  assert.equal(parseImageRef("noty-app:latest"), null);
});

test("compareVersions", () => {
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
  assert.equal(compareVersions("1.2.0", "1.2.0"), 0);
  assert.ok(compareVersions("0.9.0", "1.0.0") < 0);
});

test("buildReplacementBody: 이전 이미지에서 온 값은 빼고 컨테이너 고유 설정은 유지한다", () => {
  const oldImage = {
    Config: {
      Env: ["PATH=/usr/bin", "NODE_VERSION=22.1.0"],
      Labels: { "org.opencontainers.image.version": "1.1.0" },
      Cmd: ["npx", "tsx", "apps/admin/server/index.ts"],
      User: "node",
      WorkingDir: "/app",
    },
  };
  const container = {
    Config: {
      Env: ["PATH=/usr/bin", "NODE_VERSION=22.1.0", "PORT=4000", "NOTY_APP_IMAGE=ghcr.io/x/noty:1.1.0"],
      Labels: { "org.opencontainers.image.version": "1.1.0", "dev.noty.managed": "true" },
      Cmd: ["npx", "tsx", "apps/server/index.ts"],
      User: "node",
      WorkingDir: "/app",
      ExposedPorts: { "4000/tcp": {} },
    },
    HostConfig: { NetworkMode: "host", RestartPolicy: { Name: "unless-stopped" } },
  };
  const body = buildReplacementBody(container, oldImage, "ghcr.io/x/noty:1.2.0", { NOTY_APP_IMAGE: "ghcr.io/x/noty:1.2.0" }) as any;
  assert.equal(body.Image, "ghcr.io/x/noty:1.2.0");
  assert.deepEqual(body.Env, ["PORT=4000", "NOTY_APP_IMAGE=ghcr.io/x/noty:1.2.0"]);
  assert.deepEqual(body.Labels, { "dev.noty.managed": "true" });
  assert.deepEqual(body.Cmd, ["npx", "tsx", "apps/server/index.ts"]);
  assert.equal(body.User, undefined);
  assert.equal(body.WorkingDir, undefined);
  assert.equal(body.HostConfig.NetworkMode, "host");
});
