"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var main_helpers_exports = {};
__export(main_helpers_exports, {
  computeReconnectDelay: () => computeReconnectDelay,
  decideUnstableTransition: () => decideUnstableTransition,
  findConnectionForState: () => findConnectionForState,
  pickRestPollInterval: () => pickRestPollInterval,
  shouldEmitAfterCooldown: () => shouldEmitAfterCooldown,
  shouldStartIpRecovery: () => shouldStartIpRecovery,
  stripNamespace: () => stripNamespace
});
module.exports = __toCommonJS(main_helpers_exports);
function decideUnstableTransition(prevDisconnects, durationMs, stableThresholdMs, unstableThreshold) {
  if (durationMs < stableThresholdMs) {
    const next = prevDisconnects + 1;
    return next === unstableThreshold ? "becameUnstable" : "noChange";
  }
  return prevDisconnects >= unstableThreshold ? "stabilized" : "noChange";
}
function computeReconnectDelay(failCount, baseMs, maxMs) {
  if (failCount <= 0) {
    return baseMs;
  }
  return Math.min(baseMs * Math.pow(2, failCount - 1), maxMs);
}
function shouldStartIpRecovery(failCount, beforeMdns, retryEvery) {
  if (failCount < beforeMdns) {
    return false;
  }
  return (failCount - beforeMdns) % retryEvery === 0;
}
function pickRestPollInterval(unstable, stableIntervalMs, unstableIntervalMs) {
  return unstable ? unstableIntervalMs : stableIntervalMs;
}
function stripNamespace(stateId, namespace) {
  const prefix = `${namespace}.`;
  return stateId.startsWith(prefix) ? stateId.slice(prefix.length) : stateId;
}
function findConnectionForState(stateId, namespace, connections) {
  const localId = stripNamespace(stateId, namespace);
  for (const [prefix, conn] of connections) {
    if (localId.startsWith(`${prefix}.`)) {
      return conn;
    }
  }
  return void 0;
}
function shouldEmitAfterCooldown(lastMs, now, cooldownMs) {
  if (lastMs === 0) {
    return true;
  }
  return now - lastMs >= cooldownMs;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  computeReconnectDelay,
  decideUnstableTransition,
  findConnectionForState,
  pickRestPollInterval,
  shouldEmitAfterCooldown,
  shouldStartIpRecovery,
  stripNamespace
});
//# sourceMappingURL=main-helpers.js.map
