"use strict";

const INTEGRITY_WARNING_PATTERN =
  /const ([A-Za-z_$][\w$]*)=this\.storage\.get\(\);\1\?\.dontShowPrompt&&\1\.commit===this\.productService\.commit\|\|this\._showNotification\(\)/;

function patchIntegrityWarning(content) {
  return content.replace(INTEGRITY_WARNING_PATTERN, "void 0");
}

module.exports = {
  patchIntegrityWarning,
  patch: {
    name: "integrity-warning",
    targets: ["workbench", "extHost"],
    severity: "optional",
    // The patched output ("void 0") leaves no distinctive marker, so an
    // already-suppressed prompt cannot be told apart from an absent one.
    isActive: null,
    apply: patchIntegrityWarning,
  },
};
