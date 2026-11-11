import Fastify from "fastify";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { PostgresCreditLedger, PostgresProjectStore, PostgresLoopStore, DecisionEngine } from "@credit-guard/guard-core";
import type { Pool } from "pg";
import { createProviderAdapters, type ProviderAdapter, type ProviderName, type ProviderResult } from "./provider-adapters.js";
import { estimateCostMicros, actualCostMicros as calculateActualCostMicros, resolveCheaperFallback, type ModelPricing } from "./pricing.js";

export interface GatewayConfig {
  pool: Pool;
  projectTokens: Record<string,string|string[]>;
  providerKeys: Record<string,string>;
  pricing: Record<string,ModelPricing>;
  modelFallbacks: Record<string,string>;
  safetyMultiplier: number;
  adapters?: Record<ProviderName,ProviderAdapter>;
}
export function constantTimeTokenMatch(received:string|string[]|undefined,expected:string|string[]):boolean{
  if(typeof received!=="string")return false;
  const candidates=Array.isArray(expected)?expected:[expected];
  const receivedBytes=Buffer.from(received);
  let matched=false;
  for(const candidate of candidates){
    const expectedBytes=Buffer.from(candidate);
    const equalLength=receivedBytes.length===expectedBytes.length;
    const candidateMatch=equalLength&&timingSafeEqual(receivedBytes,expectedBytes);
    matched=matched||candidateMatch;
  }
  return matched;
}
export function createGatewayServer(config:GatewayConfig){
  const {pool,projectTokens,providerKeys,pricing,modelFallbacks,safetyMultiplier}=config;
  const ledger=new PostgresCreditLedger(pool);
  const projectStore=new PostgresProjectStore(pool);
  const loopStore=new PostgresLoopStore(pool);
  const decisionEngine=new DecisionEngine();
  const adapters=config.adapters??createProviderAdapters();
  const app=Fastify({logger:false,bodyLimit:2*1024*1024});
  app.get("/health",async()=>({service:"credit-guard-gateway",status:"ok",mode:"enforced-proxy",providers:Object.keys(adapters)}));
  app.post<{Body:{model:string;messages:Array<{role:string;content:string}>;max_tokens?:number;temperature?:number}}>(
    "/v1/chat/completions",
    async(request,reply)=>{
      const projectId=String(request.headers["x-credit-guard-project"]??"");
      const provider=String(request.headers["x-credit-guard-provider"]??"") as ProviderName;
      if(!projectId.trim())return reply.code(400).send({error:"PROJECT_REQUIRED"});
      const expectedToken=projectTokens[projectId];
      if(!expectedToken||!constantTimeTokenMatch(request.headers["x-credit-guard-token"],expectedToken))return reply.code(401).send({error:"UNAUTHORIZED"});
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
      const inputCharacters=JSON.stringify(body.messages).length;
      let dispatchModel=body.model;
      let dispatchRate=rate;
      let estimatedCostMicros=estimateCostMicros(inputCharacters,maxTokens,rate,safetyMultiplier).costMicros;
      let optimizedFrom:string|undefined;
      let availableMicros=0;
      let loopAssessment;
      try{
        loopAssessment=await loopStore.record({projectId,kind:"request"});
        const [credit,project,progress]=await Promise.all([
          ledger.getStatus(projectId),projectStore.get(projectId),projectStore.progress(projectId)
        ]);
        availableMicros=credit.availableMicros;
        const decision=decisionEngine.decide({credit,projectState:project.state,progressPercent:progress.percent,progressTracked:progress.total>0,
          estimatedCostMicros,loop:loopAssessment,checkpointAvailable:true});
        if(decision.action==="OPTIMIZE"){
          const fallback=resolveCheaperFallback({provider,requestedModel:body.model,fallbacks:modelFallbacks,pricing,
            inputCharacters,maxOutputTokens:maxTokens,safetyMultiplier,requestedCostMicros:estimatedCostMicros,availableMicros});
          if(!fallback)return reply.code(409).send({error:"GUARD_OPTIMIZATION_REQUIRED",decision,
            recommendation:"Configure an affordable cheaper model in MODEL_FALLBACKS_JSON or reduce context/output tokens."});
          dispatchModel=fallback.model;dispatchRate=fallback.rate;
          estimatedCostMicros=fallback.costMicros;optimizedFrom=body.model;
        }else if(decision.action!=="ALLOW"){
          return reply.code(409).send({error:"GUARD_DECISION",decision});
        }
      }catch(error){
        return reply.code(404).send({error:"PROJECT_OR_BUDGET_NOT_CONFIGURED",message:error instanceof Error?error.message:"Project state unavailable"});
      }
      const idempotencyKey=randomUUID();
      let reservation: Awaited<ReturnType<PostgresCreditLedger["reserve"]>>;
      try{reservation=await ledger.reserve({projectId,estimatedCostMicros:Math.max(1,estimatedCostMicros),idempotencyKey});}
      catch(error){return reply.code(402).send({error:error instanceof Error?error.message:"CREDIT_RESERVATION_FAILED"});}
      const requestId=randomUUID();
      try{
        await pool.query("INSERT INTO cg_gateway_requests(request_id,project_id,reservation_id,provider,model,status,estimated_cost_micros) VALUES($1,$2,$3,$4,$5,'STARTED',$6)",
          [requestId,projectId,reservation.id,provider,dispatchModel,String(estimatedCostMicros)]);
      }catch{
        await ledger.release(reservation.id);
        return reply.code(503).send({error:"AUDIT_WRITE_FAILED",warning:"Provider request was not dispatched; reservation released."});
      }
      let result:ProviderResult;
      try{
        result=await adapters[provider].send({model:dispatchModel,messages:body.messages,maxTokens,temperature:body.temperature},apiKey);
      }catch{
        await pool.query("UPDATE cg_gateway_requests SET status='UNKNOWN',updated_at=now() WHERE request_id=$1",[requestId]);
        try{await loopStore.record({projectId,kind:"error",signature:"UPSTREAM_TRANSPORT"});}catch{}
        return reply.code(502).send({error:"UPSTREAM_OUTCOME_UNKNOWN",requestId,reservationId:reservation.id,
          warning:"Provider outcome and billing are uncertain; reservation remains held for reconciliation."});
      }
      let actualCostMicros:number|null=null;
      if(result.usage){
        actualCostMicros=calculateActualCostMicros(result.usage,dispatchRate);
        try{await ledger.settle(reservation.id,actualCostMicros);}
        catch{
          try{await loopStore.record({projectId,kind:"error",signature:"LEDGER_RECONCILIATION"});}catch{}
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
        try{await loopStore.record({projectId,kind:"error",signature:"PROVIDER_HTTP_"+result.status});}catch{}
        return reply.code(result.status).send({error:"PROVIDER_ERROR",providerBody:result.body,requestId,
          reservationId:reservation.id,usageKnown:Boolean(result.usage),
          warning:result.usage?"Provider usage was reconciled.":"Usage is unknown; reservation remains held for manual reconciliation."});
      }
      return reply.code(200).send({provider:result.body,creditGuard:{requestId,reservationId:reservation.id,
        estimatedCostMicros,actualCostMicros,actualUsage:result.usage,settled:Boolean(result.usage),
        requestedModel:body.model,actualModel:dispatchModel,optimized:Boolean(optimizedFrom),
        optimizationReason:optimizedFrom?"LOW_REMAINING_BUDGET":undefined,
        warning:result.usage?undefined:"Provider usage was not returned; reservation remains held."}});
    }
  );
  return app;
}
