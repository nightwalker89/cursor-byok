"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { patchModelPickerUnlock } = require("../scripts/workbench-patches/model-picker-unlock");
const { hookRuntime } = require("../src/workbench-hook");

const SAMPLE = [
  "class Auth {",
  "constructor(){",
  "this.membershipType=()=>{switch(this._membershipType()){case Ja.ENTERPRISE:return Ja.ENTERPRISE;default:return Ja.FREE}},",
  "}",
  "function picker(e){",
  "e.cursorAuthenticationService.refreshMembership().then(()=>{",
  "Ve||Je(e.cursorAuthenticationService.membershipType()===Ja.FREE?\"confirmed-free\":\"allow-full\")",
  "})",
  "}",
  "function glass(a){",
  "a.refreshMembership().then(()=>{Ue||A(a.membershipType()===Ja.FREE?\"confirmed-free\":\"allow-full\")})",
  "}",
].join("");

test("patchModelPickerUnlock bypasses free-tier model picker lock when BYOK models are configured", () => {
  const patched = patchModelPickerUnlock(SAMPLE);
  assert.match(patched, /__cursorByokBypassFreeModelLock/);
  assert.match(patched, /model-picker-unlock-membership/);
  assert.match(patched, /return Ja\.ULTRA;/);
  assert.match(patched, /__cursorByokBypassFreeModelLock\(\)\?"allow-full":e\.cursorAuthenticationService\.membershipType\(\)===Ja\.FREE\?"confirmed-free":"allow-full"/);
  assert.match(patched, /__cursorByokBypassFreeModelLock\(\)\?"allow-full":a\.membershipType\(\)===Ja\.FREE\?"confirmed-free":"allow-full"/);
});

test("hook runtime exposes BYOK bypass helper from configured model ids", () => {
  const originalReady = globalThis.__cursorByokReady;
  const originalModelIds = globalThis.__cursorByokModelIds;
  const originalBypass = globalThis.__cursorByokBypassFreeModelLock;
  try {
    delete globalThis.__cursorByokReady;
    hookRuntime({
      byokUrl: "http://127.0.0.1:9960",
      routes: [],
      byokModelIds: ["gpt-test"],
      byokModels: [],
    });
    assert.equal(typeof globalThis.__cursorByokBypassFreeModelLock, "function");
    assert.equal(globalThis.__cursorByokBypassFreeModelLock(), true);
    globalThis.__cursorByokModelIds = new Set();
    assert.equal(globalThis.__cursorByokBypassFreeModelLock(), false);
  } finally {
    if (originalReady === undefined) delete globalThis.__cursorByokReady;
    else globalThis.__cursorByokReady = originalReady;
    if (originalModelIds === undefined) delete globalThis.__cursorByokModelIds;
    else globalThis.__cursorByokModelIds = originalModelIds;
    if (originalBypass === undefined) delete globalThis.__cursorByokBypassFreeModelLock;
    else globalThis.__cursorByokBypassFreeModelLock = originalBypass;
  }
});