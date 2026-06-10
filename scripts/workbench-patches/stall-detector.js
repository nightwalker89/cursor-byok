"use strict";

function patchStallDetectorCleanup(content) {
  content = content.replace(
    'onStreamEnded(){this.trackActivity("stream","ended"),this.streamEndedAt=Date.now()}',
    'onStreamEnded(){this.trackActivity("stream","ended"),this.streamEndedAt=Date.now(),this.timer!==void 0&&(clearTimeout(this.timer),this.timer=void 0),this.advisoryTimer!==void 0&&(clearTimeout(this.advisoryTimer),this.advisoryTimer=void 0),this.heartbeatOnlyTimer!==void 0&&(clearTimeout(this.heartbeatOnlyTimer),this.heartbeatOnlyTimer=void 0)}',
  );
  content = content.replace(
    'onAdvisoryDetected(){if(this.hasLogged||this.hasLoggedAdvisory||this.advisoryThresholdMs===void 0||this.advisoryThresholdMs<=0)return;',
    'onAdvisoryDetected(){if(this.disposedAt||this.streamEndedAt||this.hasLogged||this.hasLoggedAdvisory||this.advisoryThresholdMs===void 0||this.advisoryThresholdMs<=0)return;',
  );
  content = content.replace(
    'onStallDetected(n){if(n==="heartbeat_only"){',
    'onStallDetected(n){if(this.disposedAt||this.streamEndedAt)return;if(n==="heartbeat_only"){',
  );
  return content;
}

module.exports = {
  patchStallDetectorCleanup,
  patch: {
    name: "stall-detector",
    targets: ["workbench"],
    severity: "optional",
    isActive: (content) => content.includes('this.streamEndedAt=Date.now(),this.timer!==void 0&&(clearTimeout(this.timer)'),
    apply: patchStallDetectorCleanup,
  },
};
