import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

test("MCP server completes initialize and exposes expected tools",async()=>{
  const child=spawn(process.execPath,["--import","tsx","src/index.ts"],{
    cwd:process.cwd(),
    env:{...process.env,DATABASE_URL:""},
    stdio:["pipe","pipe","pipe"]
  });
  const lines=createInterface({input:child.stdout!});
  const iterator=lines[Symbol.asyncIterator]();
  const next=async()=>{
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("MCP response timed out")),10000);});
    const item=await Promise.race([iterator.next(),timeout]);
    if(timer)clearTimeout(timer);
    if(item.done)throw new Error("MCP server closed stdout unexpectedly");
    return JSON.parse(item.value);
  };
  try{
    child.stdin!.write(JSON.stringify({jsonrpc:"2.0",id:1,method:"initialize",params:{
      protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"credit-guard-smoke",version:"0.1.0"}
    }})+"\n");
    const initialized=await next();
    assert.equal(initialized.id,1);
    assert.ok(initialized.result?.serverInfo);
    child.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized",params:{}})+"\n");
    child.stdin.write(JSON.stringify({jsonrpc:"2.0",id:2,method:"tools/list",params:{}})+"\n");
    const listed=await next();
    assert.equal(listed.id,2);
    const names=(listed.result?.tools??[]).map((tool:{name:string})=>tool.name);
    assert.ok(names.includes("guard.credit.reserve"));
    assert.ok(names.includes("guard.project.create"));
    assert.ok(names.includes("guard.decision.evaluate"));
    assert.ok(names.includes("guard.gateway.unresolved"));
  }finally{
    lines.close();
    child.kill("SIGTERM");
  }
});
