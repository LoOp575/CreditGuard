import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresCreditLedger } from "@credit-guard/guard-core";
import { createProviderAdapters, type ProviderName, type ProviderResult } from "./provider-adapters.js";

type Pricing={inputUsdPerMillion:number;outputUsdPerMillion:number};
const databaseUrl=process.env.DATABASE_URL;
const projectTokens:Record<string,string>=JSON.parse(process.env.GATEWAY_PROJECT_TOKENS_JSON??"{}");
const providerKeys:Record<string,string>=JSON.parse(process.env.PROVIDER_API_KEYS_JSON??"{}");
const pricing:Record<string,Pricing>=JSON.parse(process.env.PROVIDER_PRICING_JSON??"{}");
const safetyMultiplier=Number(process.env.ESTIMATE_SAFETY_MULTIPLIER??"1.5");
if(!databaseUrl)throw new Error("DATABASE_URL is required for enforced Gateway mode");
if(!Object.keys(projectTokens).length||Object.values(projectTokens).some(token=>typeof token!=="string"||token.length<24))
  throw new Error("GATEWAY_PROJECT_TOKENS_JSON must map project IDs to tokens of at least 24 characters");
if(!Number.isFinite(safetyMultiplier)||safetyMultiplier<1||safetyMultiplier>5)throw new Error("ESTIMATE_SAFETY_MULTIPLIER must be between 1 and 5");

const pool=new Pool({connectionString:databaseUrl,max:20});
const schema=await pool.query("SELECT to_regclass('public.cg_projects') AS projects,to_regclass('public.cg_reservations') AS reservations,to_regclass('public.cg_gateway_requests') AS gateway_requests");
if(!schema.rows[0]?.projects||!schema.rows[0]?.reservations||!schema.rows[0]?.gateway_requests){await pool.end();throw new Error("Apply migrations 001_credit_ledger.sql and 003_gateway_audit.sql before starting Gateway");}
const ledger=new PostgresCreditLedger(pool);
const adapters=createProviderAdapters();
const app=Fastify({logger:false,bodyLimit:2*1024*1024});
app.get("/health",async()=>({service:"credit-guard-gateway",status:"ok",mode:"enforced-proxy",providers:Object.keys(adapters)}));

app.post<{Body:{model:string;messages:Array<{role:string;content:string}>;max_tokens?:number;temperature?:number}}>(
  "/v1/chat/completions",
  async(request,reply)=>{
    const projectId=String(request.headers["x-credit-guard-project"]??"");
    const provider=String(request.headers["x-credit-guard-provider"]??"") as ProviderName;
    if(!projectId.trim())return reply.code(400).send({error:"PROJECT_REQUIRED"});
    const expectedToken=projectTokens[projectId];
    if(!expectedToken||request.headers["x-credit-guard-token"]!==expectedToken)return reply.code(401).send({error:"UNAUTHORIZED"});
    // Provider keys are loaded only by the Gateway process, never sent by the Agent.
    if(!Object.hasOwn(adapters,provider))return reply.code(400).send({error:"UNSUPPORTED_PROVIDER"});
    const apiKey=providerKeys[`${provider}:${projectId}`];
    if(!apiKey)return reply.code(503).send({error:"PROVIDER_KEY_NOT_CONFIGURED",provider,projectId});
    const body=request.body;
    if(!body||typeof body.model!=="string"||!body.model.trim()||!Array.isArray(body.messages)||!body.messages.length||
      !body.messages.every(m=>m&&typeof m.role==="string"&&typeof m.content==="string"))
      return reply.code(400).send({error:"INVALID_REQUEST"});
    const maxTokens=body.max_tokens??1024;
    if(!Number.isSafeInteger(maxTokens)||maxTokens<1||maxTokens>32768)return reply.code(400).send({error:"INVALID_MAX_TOKENS"});
    if(body.temperature!==undefined&&(!Number.isFinite(body.temperature)||body.temperature<0||body.temperature>2))
      return reply.code(400).send({error:"INVALID_TEMPERATURE"});
    const rate=pricing[`${provider}:${body.model}`];
    if(!rate||!Number.isFinite(rate.inputUsdPerMillion)||!Number.isFinite(rate.outputUsdPerMillion)||rate.inputUsdPerMillion<0||rate.outputUsdPerMillion<0)
      return reply.code(503).send({error:"PRICING_NOT_CONFIGURED",model:body.model,provider});
    // Conservative character-based estimate. Provider-reported usage is authoritative after completion.
    const inputCharacters=JSON.stringify(body.messages).length;
    const estimatedInputTokens=Math.ceil(inputCharacters/3);
    const estimatedCostMicros=Math.ceil((estimatedInputTokens*rate.inputUsdPerMillion+maxTokens*rate.outputUsdPerMillion)*safetyMultiplier);
    const idempotencyKey=randomUUID();
    let reservation: Awaited<ReturnType<PostgresCreditLedger["reserve"]>>;
    try{reservation=await ledger.reserve({projectId,estimatedCostMicros:Math.max(1,estimatedCostMicros),idempotencyKey});}
    catch(error){return reply.code(402).send({error:error instanceof Error?error.message:"CREDIT_RESERVATION_FAILED"});}
    const requestId=randomUUID();
    try{
      await pool.query("INSERT INTO cg_gateway_requests(request_id,project_id,reservation_id,provider,model,status,estimated_cost_micros) VALUES($1,$2,$3,$4,$5,'STARTED',$6)",
        [requestId,projectId,reservation.id,provider,body.model,String(estimatedCostMicros)]);
    }catch{
      await ledger.release(reservation.id);
      return reply.code(503).send({error:"AUDIT_WRITE_FAILED",warning:"Provider request was not dispatched; reservation released."});
    }
    let result: ProviderResult;
    try{
      result=await adapters[provider].send({model:body.model,messages:body.messages,maxTokens,temperature:body.temperature},apiKey);
    }catch{
      await pool.query("UPDATE cg_gateway_requests SET status='UNKNOWN',updated_at=now() WHERE request_id=$1",[requestId]);
      return reply.code(502).send({error:"UPSTREAM_OUTCOME_UNKNOWN",requestId,reservationId:reservation.id,
        warning:"Provider outcome and billing are uncertain; reservation remains held for reconciliation."});
    }
    let actualCostMicros:number|null=null;
    if(result.usage){
      actualCostMicros=Math.ceil(result.usage.inputTokens*rate.inputUsdPerMillion+result.usage.outputTokens*rate.outputUsdPerMillion);
      try{await ledger.settle(reservation.id,actualCostMicros);}
      catch{
        await pool.query("UPDATE cg_gateway_requests SET status='RECONCILIATION_ERROR',actual_cost_micros=$2,input_tokens=$3,output_tokens=$4,updated_at=now() WHERE request_id=$1",
          [requestId,String(actualCostMicros),result.usage.inputTokens,result.usage.outputTokens]);
        return reply.code(502).send({error:"RECONCILIATION_FAILED",requestId,reservationId:reservation.id,
          actualCostMicros,warning:"Provider usage is known but ledger settlement failed. Manual reconciliation is required."});
      }
    }
    const providerSucceeded=result.status>=200&&result.status<300;
    const auditStatus=result.usage?(providerSucceeded?"SUCCEEDED":"PROVIDER_ERROR"):(providerSucceeded?"SUCCESS_USAGE_UNKNOWN":"PROVIDER_ERROR_USAGE_UNKNOWN");
    await pool.query("UPDATE cg_gateway_requests SET status=$2,actual_cost_micros=$3,input_tokens=$4,output_tokens=$5,updated_at=now() WHERE request_id=$1",
      [requestId,auditStatus,actualCostMicros===null?null:String(actualCostMicros),result.usage?.inputTokens??null,result.usage?.outputTokens??null]);
    if(!providerSucceeded){
      return reply.code(result.status).send({error:"PROVIDER_ERROR",providerBody:result.body,requestId,
        reservationId:reservation.id,usageKnown:Boolean(result.usage),
        warning:result.usage?"Provider usage was reconciled.":"Usage is unknown; reservation remains held for manual reconciliation."});
    }
    return reply.code(200).send({provider:result.body,creditGuard:{requestId,reservationId:reservation.id,
      estimatedCostMicros,actualCostMicros,actualUsage:result.usage,settled:Boolean(result.usage),
      warning:result.usage?undefined:"Provider usage was not returned; reservation remains held."}});
  }
);

const host=process.env.GATEWAY_HOST??"127.0.0.1";
const port=Number(process.env.GATEWAY_PORT??8787);
await app.listen({host,port});
const shutdown=async()=>{await app.close();await pool.end();process.exit(0);};
process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);
