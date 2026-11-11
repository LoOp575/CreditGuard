export type ProviderName = "openai" | "anthropic" | "google";
export interface ProviderRequest { model:string; messages:Array<{role:string;content:string}>; maxTokens:number; temperature?:number; }
export interface ProviderUsage { inputTokens:number; outputTokens:number; }
export interface ProviderResult { status:number; body:unknown; usage:ProviderUsage|null; }
export interface ProviderAdapter { readonly provider:ProviderName; send(request:ProviderRequest,apiKey:string):Promise<ProviderResult>; }
async function post(url:string,headers:Record<string,string>,body:unknown):Promise<{status:number;json:unknown}>{
  const response=await fetch(url,{method:"POST",headers:{...headers,"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
  const raw=await response.text();
  let json:unknown;try{json=JSON.parse(raw);}catch{json={raw:raw.slice(0,4000)};}
  return {status:response.status,json};
}
function usageNumber(value:unknown):number|null{return typeof value==="number"&&Number.isSafeInteger(value)&&value>=0?value:null;}
export class OpenAIAdapter implements ProviderAdapter {
  readonly provider="openai" as const;
  async send(r:ProviderRequest,key:string):Promise<ProviderResult>{
    const result=await post("https://api.openai.com/v1/chat/completions",{authorization:"Bearer "+key},{model:r.model,messages:r.messages,max_tokens:r.maxTokens,temperature:r.temperature});
    const u=(result.json as any)?.usage;
    const input=usageNumber(u?.prompt_tokens),output=usageNumber(u?.completion_tokens);
    return {status:result.status,body:result.json,usage:input===null||output===null?null:{inputTokens:input,outputTokens:output}};
  }
}
export class AnthropicAdapter implements ProviderAdapter {
  readonly provider="anthropic" as const;
  async send(r:ProviderRequest,key:string):Promise<ProviderResult>{
    const system=r.messages.filter(m=>m.role==="system").map(m=>m.content).join("\n");
    const messages=r.messages.filter(m=>m.role!=="system").map(m=>({role:m.role==="assistant"?"assistant":"user",content:m.content}));
    const result=await post("https://api.anthropic.com/v1/messages",{"x-api-key":key,"anthropic-version":"2023-06-01"},{model:r.model,max_tokens:r.maxTokens,messages,system:system||undefined,temperature:r.temperature});
    const u=(result.json as any)?.usage;
    const input=usageNumber(u?.input_tokens),output=usageNumber(u?.output_tokens);
    return {status:result.status,body:result.json,usage:input===null||output===null?null:{inputTokens:input,outputTokens:output}};
  }
}
export class GoogleAdapter implements ProviderAdapter {
  readonly provider="google" as const;
  async send(r:ProviderRequest,key:string):Promise<ProviderResult>{
    const system=r.messages.filter(m=>m.role==="system").map(m=>m.content).join("\n");
    const contents=r.messages.filter(m=>m.role!=="system").map(m=>({role:m.role==="assistant"?"model":"user",parts:[{text:m.content}]}));
    const result=await post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(r.model)}:generateContent`,{"x-goog-api-key":key},{contents,systemInstruction:system?{parts:[{text:system}]}:undefined,generationConfig:{maxOutputTokens:r.maxTokens,temperature:r.temperature}});
    const u=(result.json as any)?.usageMetadata;
    const input=usageNumber(u?.promptTokenCount),output=usageNumber(u?.candidatesTokenCount);
    return {status:result.status,body:result.json,usage:input===null||output===null?null:{inputTokens:input,outputTokens:output}};
  }
}
export function createProviderAdapters():Record<ProviderName,ProviderAdapter>{
  return {openai:new OpenAIAdapter(),anthropic:new AnthropicAdapter(),google:new GoogleAdapter()};
}
