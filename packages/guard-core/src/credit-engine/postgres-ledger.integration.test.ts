import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresCreditLedger } from "./postgres-ledger.js";
const url=process.env.TEST_DATABASE_URL;
test("PostgreSQL ledger persists reservations and prevents concurrent overspend",{skip:!url},async()=>{
  const pool=new Pool({connectionString:url});
  const ledger=new PostgresCreditLedger(pool);
  const projectId="it_credit_"+randomUUID();
  try{
    await ledger.createProjectBudget({projectId,budgetMicros:1_000_000});
    const results=await Promise.allSettled([
      ledger.reserve({projectId,estimatedCostMicros:700_000,idempotencyKey:"req-a"}),
      ledger.reserve({projectId,estimatedCostMicros:700_000,idempotencyKey:"req-b"})
    ]);
    assert.equal(results.filter(x=>x.status==="fulfilled").length,1);
    assert.equal(results.filter(x=>x.status==="rejected").length,1);
    const status=await ledger.getStatus(projectId);
    assert.equal(status.activeReservedMicros,700_000);
    const reservation=results.find(x=>x.status==="fulfilled");
    if(reservation?.status==="fulfilled"){
      await ledger.settle(reservation.value.id,650_000);
      assert.equal((await ledger.getStatus(projectId)).spentMicros,650_000);
    }
  }finally{
    await pool.query("DELETE FROM cg_reservations WHERE project_id=$1",[projectId]);
    await pool.query("DELETE FROM cg_projects WHERE project_id=$1",[projectId]);
    await pool.end();
  }
});
