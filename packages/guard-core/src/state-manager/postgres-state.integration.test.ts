import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresProjectStore, PostgresLoopStore, PostgresCheckpointStore } from "./postgres-state.js";
const url=process.env.TEST_DATABASE_URL;
test("PostgreSQL project evidence, loop guard and checkpoints survive store instances",{skip:!url},async()=>{
  const pool=new Pool({connectionString:url});
  const id="it_state_"+randomUUID();
  const projects=new PostgresProjectStore(pool);
  const loops=new PostgresLoopStore(pool,{windowMs:60000,maxRepeatedErrors:2,maxRetries:3,maxRequestsWithoutProgress:4});
  const checkpoints=new PostgresCheckpointStore(pool);
  try{
    await projects.create({id,goal:"integration test",milestones:[{id:"m1",title:"Test passes"}]});
    await projects.transition(id,"PLANNING");
    await projects.transition(id,"EXECUTING");
    const evidence=await projects.recordEvidence({projectId:id,milestoneId:"m1",kind:"test",reference:"ci://test/123"});
    assert.equal(evidence.milestones[0].completed,false);
    const verified=await projects.verifyEvidence({projectId:id,milestoneId:"m1",reference:"ci://test/123",verificationSource:"integration-test"});
    assert.equal(verified.milestones[0].completed,true);
    await projects.transition(id,"VERIFYING");
    await projects.transition(id,"COMPLETED");
    await loops.record({projectId:id,kind:"error",signature:"E_TEST"});
    const assessment=await loops.record({projectId:id,kind:"error",signature:"E_TEST"});
    assert.equal(assessment.action,"PAUSE");
    const saved=await checkpoints.save(id,{goal:"integration test",nextStep:"resume",artifactRefs:[],errors:[],modelConfig:{}});
    const loaded=await checkpoints.latest(id);
    assert.equal(loaded?.checkpointId,saved.checkpointId);
  }finally{
    await pool.query("DELETE FROM cg_guard_projects WHERE project_id=$1",[id]);
    await pool.end();
  }
});
