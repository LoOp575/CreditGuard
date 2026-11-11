import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
dotenv.config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
import { Pool } from "pg";
import { createGatewayServer } from "./server.js";
import type { ModelPricing } from "./pricing.js";

const databaseUrl=process.env.DATABASE_URL;
const projectTokens:Record<string,string|string[]>=JSON.parse(process.env.GATEWAY_PROJECT_TOKENS_JSON??"{}");
const providerKeys:Record<string,string>=JSON.parse(process.env.PROVIDER_API_KEYS_JSON??"{}");
const pricing:Record<string,ModelPricing>=JSON.parse(process.env.PROVIDER_PRICING_JSON??"{}");
const modelFallbacks:Record<string,string>=JSON.parse(process.env.MODEL_FALLBACKS_JSON??"{}");
const safetyMultiplier=Number(process.env.ESTIMATE_SAFETY_MULTIPLIER??"1.5");
const decisionPolicy={lowRemainingBudgetPercent:Number(process.env.GUARD_LOW_REMAINING_BUDGET_PERCENT??"10"),
  lowProgressPercent:Number(process.env.GUARD_LOW_PROGRESS_PERCENT??"10")};
if(!databaseUrl)throw new Error("DATABASE_URL is required for enforced Gateway mode");
if(!Object.keys(projectTokens).length||Object.values(projectTokens).some(value=>{
  const tokens=Array.isArray(value)?value:[value];
  return tokens.length<1||tokens.some(token=>typeof token!=="string"||token.length<24);
})) throw new Error("GATEWAY_PROJECT_TOKENS_JSON must map project IDs to a token or non-empty token array; every token must be at least 24 characters");
if(!Number.isFinite(safetyMultiplier)||safetyMultiplier<1||safetyMultiplier>5)
  throw new Error("ESTIMATE_SAFETY_MULTIPLIER must be between 1 and 5");

const pool=new Pool({connectionString:databaseUrl,max:20});
try{
  const schema=await pool.query("SELECT to_regclass('public.cg_projects') AS projects,to_regclass('public.cg_reservations') AS reservations,to_regclass('public.cg_gateway_requests') AS gateway_requests,to_regclass('public.cg_guard_projects') AS guard_projects,to_regclass('public.cg_loop_events') AS loop_events");
  if(!schema.rows[0]?.projects||!schema.rows[0]?.reservations||!schema.rows[0]?.gateway_requests||!schema.rows[0]?.guard_projects||!schema.rows[0]?.loop_events)
    throw new Error("Apply migrations 001, 002, and 003 before starting Gateway");
  const app=createGatewayServer({pool,projectTokens,providerKeys,pricing,modelFallbacks,safetyMultiplier,decisionPolicy});
  const host=process.env.GATEWAY_HOST??"127.0.0.1";
  const port=Number(process.env.GATEWAY_PORT??8787);
  await app.listen({host,port});
  const shutdown=async()=>{await app.close();await pool.end();process.exit(0);};
  process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);
}catch(error){
  await pool.end();
  throw error;
}
