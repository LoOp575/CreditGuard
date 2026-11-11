import assert from "node:assert/strict";
import test from "node:test";
import { constantTimeTokenMatch } from "./server.js";

test("accepts the current project token",()=>{
  assert.equal(constantTimeTokenMatch("current-token-0123456789abcdef","current-token-0123456789abcdef"),true);
});
test("accepts either token during a rotation overlap",()=>{
  assert.equal(constantTimeTokenMatch("next-token-0123456789abcdef",["current-token-0123456789abcdef","next-token-0123456789abcdef"]),true);
});
test("rejects a retired or malformed token",()=>{
  assert.equal(constantTimeTokenMatch("retired-token-0123456789abcdef",["current-token-0123456789abcdef","next-token-0123456789abcdef"]),false);
  assert.equal(constantTimeTokenMatch(["current-token-0123456789abcdef"],"current-token-0123456789abcdef"),false);
});
