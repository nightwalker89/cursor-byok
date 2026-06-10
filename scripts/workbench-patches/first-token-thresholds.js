"use strict";

function patchFirstTokenWarningThresholds(content) {
  return content.replace(
    /const ([A-Za-z_$][\w$]*)=this\.getModelNameForMetrics\(([^)]{1,200})\);([\s\S]{0,400}?)const ([A-Za-z_$][\w$]*)=\[2e3,4e3,6e3,8e3,1e4,12e3,14e3,16e3,32e3\],([A-Za-z_$][\w$]*)=this\._experimentService\.getDynamicConfigParam\("composer_hang_detection_config","thresholds_ms",\{disableExposureLog:!1\}\)\?\?\4,([A-Za-z_$][\w$]*)="agent";/,
    (
      _match,
      modelNameVar,
      modelNameArgs,
      between,
      defaultThresholdsVar,
      thresholdsVar,
      chatServiceVar,
    ) => {
      const byokThresholds = "[6e3,8e3,1e4,12e3,14e3,16e3,32e3]";
      return `const ${modelNameVar}=this.getModelNameForMetrics(${modelNameArgs});${between}const ${defaultThresholdsVar}=[2e3,4e3,6e3,8e3,1e4,12e3,14e3,16e3,32e3],${thresholdsVar}=(typeof globalThis.__cursorByokIsModel==="function"&&globalThis.__cursorByokIsModel(${modelNameVar})?${byokThresholds}:this._experimentService.getDynamicConfigParam("composer_hang_detection_config","thresholds_ms",{disableExposureLog:!1})??${defaultThresholdsVar}),${chatServiceVar}="agent";`;
    },
  );
}

module.exports = {
  patchFirstTokenWarningThresholds,
  patch: {
    name: "first-token-thresholds",
    targets: ["workbench"],
    severity: "optional",
    isActive: (content) => content.includes("?[6e3,8e3,1e4,12e3,14e3,16e3,32e3]:"),
    apply: patchFirstTokenWarningThresholds,
  },
};
