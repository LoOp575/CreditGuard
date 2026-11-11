import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresCreditLedger, PostgresProjectStore } from "@credit-guard/guard-core";
import { createGatewayServer } from "./server.js";
import type { ProviderAdapter, ProviderName } from "./provider-adapters.js";

const url=process.env.TEST_DATABASE_URL;
test("Gateway authenticates, reserves, settles, falls back, and intervenes on repeated errors",{skip:!url},async()=>{
  const pool=new Pool({connectionString:url});
  const ids=["gw_normal_","gw_fallback_","gw_loop_"].map(x=>x+randomUUID());
  const token="gateway-test-token-0123456789abcdef";
  const calls:string[]=[];
  const adapter:ProviderAdapter={
    provider:"openai",
    async send(request){
      calls.push(request.model);
      if(request.model==="error-model")return {status:500,body:{error:"mock upstream"},usage:null};
      return {status:200,body:{id:"mock-response"},usage:{inputTokens:10,outputTokens:5}};
    }
  };
  const adapters:Record<ProviderName,ProviderAdapter>={openai:adapter,anthropic:{...adapter,provider:"anthropic"},google:{...adapter,provider:"google"}};
  const projectTokens=Object.fromEntries(ids.map(id=>[id,token]));
  const providerKeys=Object.fromEntries(ids.map(id=>["openai:"+id,"mock-provider-key"]));
  const pricing={
    "openai:normal-model":{inputUsdPerMillion:1,outputUsdPerMillion:2},
    "openai:expensive-model":{inputUsdPerMillion:10,outputUsdPerMillion:20},
    "openai:cheap-model":{inputUsdPerMillion:0.001,outputUsdPerMillion:0.001},
    "openai:error-model":{inputUsdPerMillion:1,outputUsdPerMillion:2}
  };
  const app=createGatewayServer({pool,projectTokens,providerKeys,pricing,
    modelFallbacks:{"openai:expensive-model":"cheap-model"},safetyMultiplier:1.5,adapters});
  const ledger=new PostgresCreditLedger(pool);
  const projects=new PostgresProjectStore(pool);
  try{
    for(const [i,id] of ids.entries()){
      await ledger.createProjectBudget({projectId:id,budgetMicros:i===1?1000:1_000_000});
      await projects.create({id,goal:"gateway integration"});
    }
    const headers=(id:string,auth=token,key=randomUUID())=>({"x-credit-guard-project":id,"x-credit-guard-token":auth,"x-credit-guard-provider":"openai","x-idempotency-key":key});
    const payload=(model:string)=>({model,messages:[{role:"user",content:"test"}],max_tokens:100});
    const denied=await app.inject({method:"POST",url:"/v1/chat/completions",headers:headers(ids[0],"wrong-token"),payload:payload("normal-model")});
    assert.equal(denied.statusCode,401);

    const successKey=randomUUID();
    const success=await app.inject({method:"POST",url:"/v1/chat/completions",headers:headers(ids[0],token,successKey),payload:payload("normal-model")});
    assert.equal(success.statusCode,200,success.body);
    assert.equal(success.json().creditGuard.settled,true);
    assert.equal((await ledger.getStatus(ids[0])).spentMicros,20);
    const replay=await app.inject({method:"POST",url:"/v1/chat/completions",headers:headers(ids[0],token,successKey),payload:payload("normal-model")});
    assert.equal(replay.statusCode,409);
    assert.equal(replay.json().error,"IDEMPOTENCY_REPLAY");
    assert.equal(calls.filter(x=>x==="normal-model").length,1);

    const fallback=await app.inject({method:"POST",url:"/v1/chat/completions",headers:headers(ids[1]),payload:payload("expensive-model")});
    assert.equal(fallback.statusCode,200);
    assert.equal(fallback.json().creditGuard.actualModel,"cheap-model");
    assert.equal(fallback.json().creditGuard.optimized,true);
    assert.equal(fallback.json().creditGuard.optimizationReason,"INSUFFICIENT_CREDIT_TRY_LOWER_COST");

    for(let i=0;i<2;i++){
      const failed=await app.inject({method:"POST",url:"/v1/chat/completions",headers:headers(ids[2]),payload:payload("error-model")});
      assert.equal(failed.statusCode,500);
    }
    const paused=await app.inject({method:"POST",url:"/v1/chat/completions",headers:headers(ids[2]),payload:payload("error-model")});
    assert.equal(paused.statusCode,409);
    assert.equal(paused.json().decision.action,"INTERVENE");
    assert.equal(calls.filter(x=>x==="error-model").length,2);
  }finally{
    await app.close();
    await pool.query("DELETE FROM cg_gateway_requests WHERE project_id = ANY($1::text[])",[ids]);
    await pool.query("DELETE FROM cg_reservations WHERE project_id = ANY($1::text[])",[ids]);
    await pool.query("DELETE FROM cg_projects WHERE project_id = ANY($1::text[])",[ids]);
    await pool.query("DELETE FROM cg_guard_projects WHERE project_id = ANY($1::text[])",[ids]);
    await pool.end();
  }
});
