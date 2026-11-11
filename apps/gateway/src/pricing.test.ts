import test from "node:test";
import assert from "node:assert/strict";
import { actualCostMicros, estimateCostMicros } from "./pricing.js";
test("conservative estimate applies input heuristic and safety multiplier",()=>{
  assert.deepEqual(estimateCostMicros(300,100,{inputUsdPerMillion:2,outputUsdPerMillion:4},1.5),{inputTokens:100,costMicros:900});
});
test("actual usage is reconciled without estimate multiplier",()=>{
  assert.equal(actualCostMicros({inputTokens:100,outputTokens:50},{inputUsdPerMillion:2,outputUsdPerMillion:4}),400);
});
