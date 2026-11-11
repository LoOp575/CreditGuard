import { timingSafeEqual } from "node:crypto";
export function verifySecretToken(received:string|undefined,expected:string|undefined):boolean{
  if(typeof received!=="string"||typeof expected!=="string"||!expected.length)return false;
  const a=Buffer.from(received);const b=Buffer.from(expected);
  return a.length===b.length&&timingSafeEqual(a,b);
}
