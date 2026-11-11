import test from "node:test";
import assert from "node:assert/strict";
import { verifySecretToken } from "./security.js";
test("evidence verifier token accepts only exact configured secret",()=>{
  assert.equal(verifySecretToken("secret-token-0123456789","secret-token-0123456789"),true);
  assert.equal(verifySecretToken("wrong-token","secret-token-0123456789"),false);
  assert.equal(verifySecretToken(undefined,"secret-token-0123456789"),false);
  assert.equal(verifySecretToken("anything",undefined),false);
});
