import { Pool } from "pg";
import type { GuardProject, ProjectEvidence, ProjectState } from "../project-engine/types.js";
import type { LoopAssessment, LoopEvent, LoopGuardConfig } from "../loop-guard/types.js";
const allowed: Record<ProjectState, ProjectState[]> = {
  CREATED:["PLANNING","PAUSED","FAILED"], PLANNING:["EXECUTING","PAUSED","BLOCKED","FAILED"],
  EXECUTING:["VERIFYING","PAUSED","BLOCKED","FAILED"], VERIFYING:["EXECUTING","COMPLETED","PAUSED","BLOCKED","FAILED"],
  COMPLETED:[], PAUSED:["PLANNING","EXECUTING","VERIFYING","BLOCKED","FAILED"],
  BLOCKED:["PLANNING","EXECUTING","PAUSED","FAILED"], FAILED:[],
};
const loopDefaults: LoopGuardConfig = { windowMs:600000, maxRepeatedErrors:3, maxRetries:5, maxRequestsWithoutProgress:8 };
function projectRow(row:any, milestones:any[], evidence:any[]): GuardProject {
  const ms=milestones.map(m=>({id:m.milestone_id,title:m.title,required:m.required,completed:m.completed,
    completedAt:m.completed_at ? new Date(m.completed_at).toISOString() : null,
    evidence:evidence.filter(e=>e.milestone_id===m.milestone_id).map(e=>({kind:e.kind,reference:e.reference,verified:e.verified,recordedAt:new Date(e.recorded_at).toISOString()}))}));
  return {id:row.project_id,goal:row.goal,state:row.state,milestones:ms,
    createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),version:row.version};
}
export class PostgresProjectStore {
  constructor(private readonly pool:Pool) {}
  async create(input:{id:string;goal:string;milestones?:Array<{id:string;title:string;required?:boolean}>}):Promise<GuardProject>{
    if(!input.id.trim()||!input.goal.trim()) throw new TypeError("id and goal are required");
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      await client.query("INSERT INTO cg_guard_projects(project_id,goal,state) VALUES($1,$2,'CREATED')",[input.id,input.goal]);
      const ids=new Set<string>();
      for(const m of input.milestones??[]){
        if(!m.id.trim()||!m.title.trim()||ids.has(m.id)) throw new TypeError("milestone ids and titles must be unique and non-empty");
        ids.add(m.id);
        await client.query("INSERT INTO cg_project_milestones(project_id,milestone_id,title,required) VALUES($1,$2,$3,$4)",[input.id,m.id,m.title,m.required??true]);
      }
      await client.query("COMMIT"); return this.get(input.id);
    }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
  }
  async get(id:string):Promise<GuardProject>{
    const p=await this.pool.query("SELECT * FROM cg_guard_projects WHERE project_id=$1",[id]);
    if(!p.rowCount) throw new Error("PROJECT_NOT_FOUND");
    const [m,e]=await Promise.all([
      this.pool.query("SELECT * FROM cg_project_milestones WHERE project_id=$1 ORDER BY milestone_id",[id]),
      this.pool.query("SELECT * FROM cg_project_evidence WHERE project_id=$1 ORDER BY recorded_at",[id])
    ]);
    return projectRow(p.rows[0],m.rows,e.rows);
  }
  async transition(id:string,next:ProjectState):Promise<GuardProject>{
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      const p=await client.query("SELECT * FROM cg_guard_projects WHERE project_id=$1 FOR UPDATE",[id]);
      if(!p.rowCount) throw new Error("PROJECT_NOT_FOUND");
      const current=p.rows[0].state as ProjectState;
      if(!allowed[current].includes(next)) throw new Error("INVALID_PROJECT_TRANSITION:"+current+"->"+next);
      if(next==="COMPLETED"){
        const missing=await client.query("SELECT 1 FROM cg_project_milestones WHERE project_id=$1 AND required=true AND completed=false LIMIT 1",[id]);
        if(missing.rowCount) throw new Error("REQUIRED_MILESTONES_INCOMPLETE");
      }
      await client.query("UPDATE cg_guard_projects SET state=$2,version=version+1,updated_at=now() WHERE project_id=$1",[id,next]);
      await client.query("COMMIT");return this.get(id);
    }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
  }
  async recordEvidence(input:{projectId:string;milestoneId:string;kind:ProjectEvidence["kind"];reference:string}):Promise<GuardProject>{
    if(!input.reference.trim()) throw new TypeError("reference must not be empty");
    await this.pool.query("INSERT INTO cg_project_evidence(project_id,milestone_id,kind,reference,verified) VALUES($1,$2,$3,$4,false)",
      [input.projectId,input.milestoneId,input.kind,input.reference]);
    await this.pool.query("UPDATE cg_guard_projects SET version=version+1,updated_at=now() WHERE project_id=$1",[input.projectId]);
    return this.get(input.projectId);
  }
  async verifyEvidence(input:{projectId:string;milestoneId:string;reference:string;verificationSource:string}):Promise<GuardProject>{
    if(!input.verificationSource.trim()) throw new TypeError("verificationSource is required");
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      const evidence=await client.query(`UPDATE cg_project_evidence SET verified=true,verification_source=$4
        WHERE id=(SELECT id FROM cg_project_evidence WHERE project_id=$1 AND milestone_id=$2 AND reference=$3 ORDER BY recorded_at DESC LIMIT 1)
        RETURNING id`,[input.projectId,input.milestoneId,input.reference,input.verificationSource]);
      if(!evidence.rowCount) throw new Error("EVIDENCE_NOT_FOUND");
      await client.query("UPDATE cg_project_milestones SET completed=true,completed_at=now() WHERE project_id=$1 AND milestone_id=$2",[input.projectId,input.milestoneId]);
      await client.query("UPDATE cg_guard_projects SET version=version+1,updated_at=now() WHERE project_id=$1",[input.projectId]);
      await client.query("COMMIT");return this.get(input.projectId);
    }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
  }
  async progress(id:string):Promise<{completed:number;total:number;percent:number;requiredComplete:boolean}>{
    const r=await this.pool.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE completed)::int AS completed,
      bool_and(NOT required OR completed) AS required_complete FROM cg_project_milestones WHERE project_id=$1`,[id]);
    if(!r.rowCount) throw new Error("PROJECT_NOT_FOUND");
    const total=r.rows[0].total as number,completed=r.rows[0].completed as number;
    return {completed,total,percent:total?Math.round(completed/total*100):0,requiredComplete:r.rows[0].required_complete ?? true};
  }
}
export class PostgresLoopStore {
  constructor(private readonly pool:Pool,private readonly config:LoopGuardConfig=loopDefaults){}
  async record(event:LoopEvent):Promise<LoopAssessment>{
    await this.pool.query("INSERT INTO cg_loop_events(project_id,kind,signature,occurred_at) VALUES($1,$2,$3,COALESCE(to_timestamp($4::double precision/1000.0),now()))",
      [event.projectId,event.kind,event.signature??null,event.at??null]);
    return this.assess(event.projectId,event.at??Date.now());
  }
  async assess(projectId:string,now=Date.now()):Promise<LoopAssessment>{
    const r=await this.pool.query(`SELECT kind,signature,extract(epoch from occurred_at)*1000 AS at FROM cg_loop_events
      WHERE project_id=$1 AND occurred_at >= to_timestamp($2/1000.0) - ($3::bigint * interval '1 millisecond')
      ORDER BY occurred_at DESC`,[projectId,now,this.config.windowMs]);
    const events=r.rows as Array<{kind:LoopEvent["kind"];signature:string|null;at:string|number}>;
    const errors=events.filter(x=>x.kind==="error");
    const retries=events.filter(x=>x.kind==="retry").length;
    let noProgress=0;for(const e of events){if(e.kind==="progress")break;if(e.kind==="request")noProgress++;}
    const last=errors[0]?.signature;
    const repeated=last?errors.filter(x=>x.signature===last).length:errors.length;
    const reasons:string[]=[];
    if(repeated>=this.config.maxRepeatedErrors)reasons.push("REPEATED_ERROR");
    if(retries>=this.config.maxRetries)reasons.push("RETRY_LIMIT");
    if(noProgress>=this.config.maxRequestsWithoutProgress)reasons.push("NO_PROGRESS");
    const score=Math.min(100,Math.max(repeated/this.config.maxRepeatedErrors,retries/this.config.maxRetries,noProgress/this.config.maxRequestsWithoutProgress)*100);
    const action=reasons.length?"PAUSE":score>=60?"WARN":"CONTINUE";
    return {action,score:Math.round(score),repeatedErrors:repeated,retries,requestsWithoutProgress:noProgress,reason:reasons.join("|")||(action==="WARN"?"LOOP_RISK":"HEALTHY")};
  }
}
export class PostgresCheckpointStore {
  constructor(private readonly pool:Pool){}
  async save(projectId:string,payload:{goal:string;nextStep:string;artifactRefs:string[];errors:string[];modelConfig:Record<string,unknown>}):Promise<{checkpointId:string;version:number;createdAt:string}>{
    if(!payload.goal.trim()||!payload.nextStep.trim())throw new TypeError("goal and nextStep are required");
    const client=await this.pool.connect();
    try{
      await client.query("BEGIN");
      await client.query("SELECT project_id FROM cg_guard_projects WHERE project_id=$1 FOR UPDATE",[projectId]);
      const v=await client.query("SELECT COALESCE(MAX(version),0)::int+1 AS version FROM cg_checkpoints WHERE project_id=$1",[projectId]);
      const r=await client.query("INSERT INTO cg_checkpoints(project_id,version,payload) VALUES($1,$2,$3::jsonb) RETURNING checkpoint_id,version,created_at",
        [projectId,v.rows[0].version,JSON.stringify(payload)]);
      await client.query("COMMIT");
      return {checkpointId:r.rows[0].checkpoint_id,version:r.rows[0].version,createdAt:new Date(r.rows[0].created_at).toISOString()};
    }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}
  }
  async latest(projectId:string):Promise<{checkpointId:string;version:number;payload:unknown;createdAt:string}|null>{
    const r=await this.pool.query("SELECT checkpoint_id,version,payload,created_at FROM cg_checkpoints WHERE project_id=$1 ORDER BY version DESC LIMIT 1",[projectId]);
    if(!r.rowCount)return null;
    return {checkpointId:r.rows[0].checkpoint_id,version:r.rows[0].version,payload:r.rows[0].payload,createdAt:new Date(r.rows[0].created_at).toISOString()};
  }
}
