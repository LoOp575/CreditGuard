import type { ProviderUsage } from "./provider-adapters.js";
export interface ModelPricing { inputUsdPerMillion:number; outputUsdPerMillion:number; }
function safeMicros(value:number):number {
  const rounded=Math.ceil(value);
  if(!Number.isSafeInteger(rounded)||rounded<0)throw new RangeError("estimated cost exceeds safe USD-micros range");
  return rounded;
}
// USD per million tokens multiplied by token count is numerically USD micros.
export function estimateCostMicros(inputCharacters:number,maxOutputTokens:number,rate:ModelPricing,safetyMultiplier=1.5):{inputTokens:number;costMicros:number}{
  if(!Number.isSafeInteger(inputCharacters)||inputCharacters<0)throw new TypeError("inputCharacters must be a non-negative integer");
  if(!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<1)throw new TypeError("maxOutputTokens must be a positive integer");
  if(!Number.isFinite(safetyMultiplier)||safetyMultiplier<1||safetyMultiplier>5)throw new TypeError("safetyMultiplier must be between 1 and 5");
  const inputTokens=Math.ceil(inputCharacters/3);
  const raw=inputTokens*rate.inputUsdPerMillion+maxOutputTokens*rate.outputUsdPerMillion;
  return {inputTokens,costMicros:safeMicros(raw*safetyMultiplier)};
}
export function actualCostMicros(usage:ProviderUsage,rate:ModelPricing):number{
  return safeMicros(usage.inputTokens*rate.inputUsdPerMillion+usage.outputTokens*rate.outputUsdPerMillion);
}

export function resolveCheaperFallback(input:{
  provider:string;requestedModel:string;fallbacks:Record<string,string>;pricing:Record<string,ModelPricing>;
  inputCharacters:number;maxOutputTokens:number;safetyMultiplier:number;requestedCostMicros:number;availableMicros:number;
}):{model:string;rate:ModelPricing;costMicros:number}|null{
  const model=input.fallbacks[`${input.provider}:${input.requestedModel}`];
  if(!model)return null;
  const rate=input.pricing[`${input.provider}:${model}`];
  if(!rate)return null;
  const estimate=estimateCostMicros(input.inputCharacters,input.maxOutputTokens,rate,input.safetyMultiplier);
  if(estimate.costMicros>=input.requestedCostMicros||estimate.costMicros>input.availableMicros)return null;
  return {model,rate,costMicros:estimate.costMicros};
}
