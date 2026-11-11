import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { PostgresCreditLedger } from "@credit-guard/guard-core";
import { createProviderAdapters, type ProviderName } from "./provider-adapters.js";

type Pricing={inputUsdPerMillion:number;outputUsdPerMillion:number};
const databaseUrl=process.env.DATABASE_URL;
const gatewayToken=process.env.CREDIT_GUARD_GATEWAY_TOKEN;
const pricing:Record<string,Pricing>=JSON.parse(process.env.PROVIDER_PRICING_JSON??"{}");
const safetyMultiplier=Number(process.env.ESTIMATE_SAFETY_MULTIPLIER??"1.5");
if(!databaseUrl)throw new Error("DATABASE_URL is required for enforced Gateway mode");
if(!gatewayToken||gatewayToken.length<24)throw new Error("CREDIT_GUARD_GATEWAY_TOKEN must be configured with at least 24 characters");
if(!Number.isFinite(safetyMultiplier)||safetyMultiplier<1||safetyMultiplier>5)throw new Error("ESTIMATE_SAFETY_MULTIPLIER must be between 1 and 5");

const pool=new Pool({connectionString:databaseUrl,max:20});
const schema=await pool.query("SELECT to_regclass('public.cg_projects') AS projects,to_regclass('public.cg_reservations') AS reservations");
if(!schema.rows[0]?.projects||!schema.rows[0]?.reservations){await pool.end();throw new Error("Apply database/migrations/001_credit_ledger.sql before starting Gateway");}
const ledger=new PostgresCreditLedger(pool);
const adapters=createProviderAdapters();
const app=Fastify({logger:false,bodyLimit:2*1024*1024});
app.get("/health",async()=>({service:"credit-guard-gateway",status:"ok",mode:"enforced-proxy",providers:Object.keys(adapters)}));

app.post<{Body:{model:string;messages:Array<{role:string;content:string}>;max_tokens?:number;temperature?:number}}>(
  "/v1/chat/completions",
  async(request,reply)=>{
    if(request.headers["x-credit-guard-token"]!==gatewayToken)return reply.code(401).send({error:"UNAUTHORIZED"});
    const projectId=String(request.headers["x-credit-guard-project"]??"");
    const provider=String(request.headers["x-credit-guard-provider"]??"") as ProviderName;
    const apiKey=String(request.headers["x-provider-api-key"]??"");
    if(!projectId.trim()||!apiKey.trim())return reply.code(400).send({error:"PROJECT_AND_PROVIDER_KEY_REQUIRED"});
    if(!(provider in adapters))return reply.code(400).send({error:"UNSUPPORTED_PROVIDER"});
    const body=request.body;
    if(!body||typeof body.model!=="string"||!Array.isArray(body.messages)||!body.messages.length)return reply.code(400).send({error:"INVALID_REQUEST"});
    const maxTokens=body.max_tokens??1024;
    if(!Number.isSafeInteger(maxTokens)||maxTokens<1||maxTokens>32768)return reply.code(400).send({error:"INVALID_MAX_TOKENS"});
    const rate=pricing[`${provider}:${body.model}`];
    if(!rate||!Number.isFinite(rate.inputUsdPerMillion)||!Number.isFinite(rate.outputUsdPerMillion)||rate.inputUsdPerMillion<0||rate.outputUsdPerMillion<0)
      return reply.code(503).send({error:"PRICING_NOT_CONFIGURED",model:body.model,provider});
    // Conservative character-based estimate. Provider-reported usage is authoritative after completion.
    const inputCharacters=JSON.stringify(body.messages).length;
    const estimatedInputTokens=Math.ceil(inputCharacters/3);
    const estimatedCostMicros=Math.ceil((estimatedInputTokens*rate.inputUsdPerMillion+maxTokens*rate.outputUsdPerMillion)*safetyMultiplier);
    const idempotencyKey=randomUUID();
    let reservation;
    try{reservation=await ledger.reserve({projectId,estimatedCostMicros:Math.max(1,estimatedCostMicros),idempotencyKey});}
    catch(error){return reply.code(402).send({error:error instanceof Error?error.message:"CREDIT_RESERVATION_FAILED"});}
    try{
      const result=await adapters[provider].send({model:body.model,messages:body.messages,maxTokens,temperature:body.temperature},apiKey);
      if(result.usage){
        const actual=Math.ceil(result.usage.inputTokens*rate.inputUsdPerMillion+result.usage.outputTokens*rate.outputUsdPerMillion);
        await ledger.settle(reservation.id,actual);
      }
      if(result.status<200||result.status>=300){
        return reply.code(result.status).send({error:"PROVIDER_ERROR",providerBody:result.body,
          reservationId:reservation.id,usageKnown:Boolean(result.usage),
          warning:result.usage?"Provider usage was reconciled.":"Usage is unknown; reservation remains held for manual reconciliation."});
      }
      return reply.code(200).send({provider:result.body,creditGuard:{reservationId:reservation.id,
        estimatedCostMicros,actualUsage:result.usage,settled:Boolean(result.usage),
        warning:result.usage?undefined:"Provider usage was not returned; reservation remains held."}});
    }catch(error){
      // A transport failure may still have reached the provider. Never release blindly.
      return reply.code(502).send({error:"UPSTREAM_OR_RECONCILIATION_ERROR",reservationId:reservation.id,
        warning:"Reservation remains held because provider billing outcome is uncertain."});
    }
  }
);

const host=process.env.GATEWAY_HOST??"127.0.0.1";
const port=Number(process.env.GATEWAY_PORT??8787);
await app.listen({host,port});
const shutdown=async()=>{await app.close();await pool.end();process.exit(0);};
process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);
