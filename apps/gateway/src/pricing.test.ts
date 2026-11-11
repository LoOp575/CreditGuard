import test from "node:test";
import assert from "node:assert/strict";
import { actualCostMicros, estimateCostMicros, resolveCheaperFallback } from "./pricing.js";
test("conservative estimate applies input heuristic and safety multiplier",()=>{
  assert.deepEqual(estimateCostMicros(300,100,{inputUsdPerMillion:2,outputUsdPerMillion:4},1.5),{inputTokens:100,costMicros:900});
});
test("actual usage is reconciled without estimate multiplier",()=>{
  assert.equal(actualCostMicros({inputTokens:100,outputTokens:50},{inputUsdPerMillion:2,outputUsdPerMillion:4}),400);
});

test("selects only a cheaper fallback that fits available credit",()=>{
  const pricing={"openai:expensive":{inputUsdPerMillion:5,outputUsdPerMillion:10},"openai:cheap":{inputUsdPerMillion:1,outputUsdPerMillion:2}};
  const args={provider:"openai",requestedModel:"expensive",fallbacks:{"openai:expensive":"cheap"},pricing,inputCharacters:300,maxOutputTokens:100,safetyMultiplier:1,requestedCostMicros:1500,availableMicros:500};
  assert.deepEqual(resolveCheaperFallback(args),{model:"cheap",rate:pricing["openai:cheap"],costMicros:300});
  assert.equal(resolveCheaperFallback({...args,availableMicros:200}),null);
});
