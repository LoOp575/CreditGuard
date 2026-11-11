import test from "node:test";
import assert from "node:assert/strict";
import { createProviderAdapters } from "./provider-adapters.js";
test("provider adapter registry exposes only supported fixed providers",()=>{
  assert.deepEqual(Object.keys(createProviderAdapters()).sort(),["anthropic","google","openai"]);
});
