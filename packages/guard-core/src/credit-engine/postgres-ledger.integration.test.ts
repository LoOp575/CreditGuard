import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresCreditLedger } from "./postgres-ledger.js";
const url=process.env.TEST_DATABASE_URL;
test("PostgreSQL ledger coordinates independent pools and survives adapter recreation",{skip:!url},async()=>{
  const poolA=new Pool({connectionString:url,max:10});
  const poolB=new Pool({connectionString:url,max:10});
  const poolC=new Pool({connectionString:url,max:10});
  const ledgerA=new PostgresCreditLedger(poolA);
  const ledgerB=new PostgresCreditLedger(poolB);
  const ledgerC=new PostgresCreditLedger(poolC);
  const projectId="it_credit_"+randomUUID();
  try{
    await ledgerA.createProjectBudget({projectId,budgetMicros:1_000_000});
    const results=await Promise.allSettled(Array.from({length:10},(_,i)=>
      (i%2?ledgerA:ledgerB).reserve({projectId,estimatedCostMicros:150_000,idempotencyKey:"parallel-"+i})
    ));
    assert.equal(results.filter(x=>x.status==="fulfilled").length,6);
    assert.equal(results.filter(x=>x.status==="rejected").length,4);
    const persisted=await ledgerC.listReservations(projectId,"RESERVED");
    assert.equal(persisted.length,6);
    await ledgerC.settle(persisted[0].id,200_000);
    const status=await ledgerC.getStatus(projectId);
    assert.equal(status.spentMicros,200_000);
    assert.equal(status.activeReservedMicros,750_000);
    assert.equal(status.availableMicros,50_000);
  }finally{
    await poolC.query("DELETE FROM cg_reservations WHERE project_id=$1",[projectId]);
    await poolC.query("DELETE FROM cg_projects WHERE project_id=$1",[projectId]);
    await Promise.all([poolA.end(),poolB.end(),poolC.end()]);
  }
});
