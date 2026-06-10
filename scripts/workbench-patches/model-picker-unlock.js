"use strict";

const { HOOK_POINT_MARK_CALL } = require("./shared");

const MEMBERSHIP_TYPE_PATTERN =
  /this\.membershipType=\(\)=>\{switch\(this\._membershipType\(\)\)\{case (\w+)\.ENTERPRISE:/;

const CONFIRMED_FREE_PATTERN =
  /(\w+)(\.cursorAuthenticationService)?\.membershipType\(\)===(\w+)\.FREE\?"confirmed-free":"allow-full"/g;

const BYOK_BYPASS_MEMBERSHIP =
  `${HOOK_POINT_MARK_CALL}"model-picker-unlock-membership");` +
  "if(typeof globalThis.__cursorByokBypassFreeModelLock===\"function\"" +
  "&&globalThis.__cursorByokBypassFreeModelLock())return $1.ULTRA;";

const BYOK_BYPASS_CONFIRMED_FREE =
  "(typeof globalThis.__cursorByokBypassFreeModelLock===\"function\"" +
  "&&globalThis.__cursorByokBypassFreeModelLock()?\"allow-full\":" +
  "$1$2.membershipType()===$3.FREE?\"confirmed-free\":\"allow-full\")";

const BYOK_BYPASS_CONFIRMED_FREE_PREFIX = '__cursorByokBypassFreeModelLock()?"allow-full":';

function isWrappedConfirmedFree(content, offset) {
  const prefix = content.slice(Math.max(0, offset - BYOK_BYPASS_CONFIRMED_FREE_PREFIX.length), offset);
  return prefix.endsWith(BYOK_BYPASS_CONFIRMED_FREE_PREFIX);
}

function hasUnpatchedConfirmedFree(content) {
  CONFIRMED_FREE_PATTERN.lastIndex = 0;
  let match;
  while ((match = CONFIRMED_FREE_PATTERN.exec(content)) !== null) {
    if (!isWrappedConfirmedFree(content, match.index)) return true;
  }
  return false;
}

function replaceUnpatchedConfirmedFree(content) {
  CONFIRMED_FREE_PATTERN.lastIndex = 0;
  return content.replace(CONFIRMED_FREE_PATTERN, (fullMatch, serviceRef, authService, membershipEnum, offset) => {
    if (isWrappedConfirmedFree(content, offset)) return fullMatch;
    return BYOK_BYPASS_CONFIRMED_FREE.replace(/\$1/g, serviceRef)
      .replace(/\$2/g, authService || "")
      .replace(/\$3/g, membershipEnum);
  });
}

function patchModelPickerUnlock(content) {
  let next = content;
  if (!content.includes(`${HOOK_POINT_MARK_CALL}"model-picker-unlock-membership")`)) {
    next = next.replace(
      MEMBERSHIP_TYPE_PATTERN,
      `this.membershipType=()=>{${BYOK_BYPASS_MEMBERSHIP}switch(this._membershipType()){case $1.ENTERPRISE:`,
    );
  }
  if (hasUnpatchedConfirmedFree(next)) {
    next = replaceUnpatchedConfirmedFree(next);
  }
  return next;
}

module.exports = {
  patchModelPickerUnlock,
  hasUnpatchedConfirmedFree,
  patch: {
    name: "model-picker-unlock",
    targets: ["workbench"],
    severity: "optional",
    isActive: (content) =>
      content.includes(`${HOOK_POINT_MARK_CALL}"model-picker-unlock-membership")`) &&
      !hasUnpatchedConfirmedFree(content),
    apply: patchModelPickerUnlock,
  },
};