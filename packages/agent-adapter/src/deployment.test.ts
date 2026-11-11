import test from "node:test";
import assert from "node:assert/strict";
import { GuardedDeploymentAdapter } from "./deployment.js";

test("deployment cannot run without exact production approval", async () => {
  let dispatched = false;
  const adapter = new GuardedDeploymentAdapter({
    projectId: "p1",
    authorize: async (request) => {
      assert.equal(request.action, "DEPLOY");
      return { allowed: false, reason: "APPROVAL_REQUIRED" };
    },
    targets: { staging: async () => { dispatched = true; return { deploymentId: "d1", status: "ok" }; } },
  });
  const result = await adapter.deploy("staging", "artifact:abc");
  assert.equal(result.executed, false);
  assert.equal(dispatched, false);
});

test("deployment dispatches through trusted target after approval", async () => {
  const adapter = new GuardedDeploymentAdapter({
    projectId: "p1",
    authorize: async () => ({ allowed: true, reason: "APPROVED" }),
    targets: { staging: async ({ artifactRef }) => ({ deploymentId: artifactRef, url: "https://staging.example", status: "ready" }) },
  });
  const result = await adapter.deploy("staging", "sha256:abc");
  assert.equal(result.executed, true);
  assert.equal(result.deploymentId, "sha256:abc");
});

test("deployment target cannot be invented by the Agent", async () => {
  const adapter = new GuardedDeploymentAdapter({
    projectId: "p1", authorize: async () => ({ allowed: true, reason: "APPROVED" }),
    targets: { staging: async () => ({ deploymentId: "d1", status: "ok" }) },
  });
  await assert.rejects(() => adapter.deploy("production", "artifact:abc"), /DEPLOYMENT_TARGET_NOT_ALLOWED/);
});
