"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var cacert_exports = {};
__export(cacert_exports, {
  CA_NOT_AFTER: () => CA_NOT_AFTER,
  HOMEWIZARD_CA_CERT: () => HOMEWIZARD_CA_CERT,
  HW_AGENT: () => HW_AGENT,
  caDaysUntilExpiry: () => caDaysUntilExpiry,
  createDeviceAgent: () => createDeviceAgent,
  createDeviceAgentForSerial: () => createDeviceAgentForSerial,
  dropDeviceAgent: () => dropDeviceAgent
});
module.exports = __toCommonJS(cacert_exports);
var https = __toESM(require("node:https"));
const HOMEWIZARD_CA_CERT = `-----BEGIN CERTIFICATE-----
MIIDITCCAgkCFDn7cwYLioTM3VxdAygLl/Px9ovFMA0GCSqGSIb3DQEBCwUAME0x
CzAJBgNVBAYTAk5MMQswCQYDVQQIDAJaSDETMBEGA1UECgwKSG9tZVdpemFyZDEc
MBoGA1UEAwwTQXBwbGlhbmNlIEFjY2VzcyBDQTAeFw0yMTEyMTgxOTEyMTJaFw0z
MTEyMTYxOTEyMTJaME0xCzAJBgNVBAYTAk5MMQswCQYDVQQIDAJaSDETMBEGA1UE
CgwKSG9tZVdpemFyZDEcMBoGA1UEAwwTQXBwbGlhbmNlIEFjY2VzcyBDQTCCASIw
DQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAPBIvW8NRffqdvzHZY0M32fQHiGm
pJgNGhiaQmpJfRDhT9yihM0S/hYcN8IqnfrMqoCQb/56Ub0+dZizmtfcGsE+Lpm1
K1znkWqSDlpnuTNOb70TrsxBmbFuNOZQEi/xOjzT2j98wT0GSfxz1RVq6lZhDRRz
xoe08+Xo4+ttUGanfOggJi0BXygeFEVBpbctVVJ9EgqeEE9itjcMlcxMe1QN14f8
hCcOnId+9PSsdmyUCLrTB0FVYrbNfbJPk/vMU57fu6swBjWhYBxPx9ZhFy+7WnPR
9BFg4seHNVQIqZNrf1YwBXlmZQIL32SRPaiH/+AVNMrYGXBvncY0Km6ZHIMCAwEA
ATANBgkqhkiG9w0BAQsFAAOCAQEA6ybM8xm0PCXg8Rr/q0v1vPxQy44PmwXTDj0e
r2vW4ZMiEwXZCp0Kk2K16KJYz4iJyfiQk8ikAIMiRSbyXzmyQ7XmL1O4l4d8E1Pg
8EImvcyoBxFhd0Lq7VKriLc8Bw8SXbahPMGT+Y8Yz0uIsLAYVwlkLfgppVPmBaLD
QautcQnI8WxPvCIQf5anyzgAyJC5ac6/CkB+iyPcuWcG3RMYvXnC0QoTlRa5YMlE
FweVDlT2C/MdDyOxiAD/H1EP/eaySnU0zsxyD0yNFRKsQfQ+UJEPd2GS1AGA1lTy
CGdyYj/Gghrusw0hM4rYXQSERWGF0mpEnuJ+7bHDolHu0rzgTQ==
-----END CERTIFICATE-----`;
const CA_NOT_AFTER = /* @__PURE__ */ new Date("2031-12-16T19:12:12Z");
function caDaysUntilExpiry(now) {
  return Math.floor((CA_NOT_AFTER.getTime() - now) / 864e5);
}
const HW_AGENT = new https.Agent({
  ca: HOMEWIZARD_CA_CERT,
  rejectUnauthorized: true,
  minVersion: "TLSv1.2",
  // CN unknown pre-pairing — verified per-device once paired (createDeviceAgent).
  checkServerIdentity: () => void 0
});
const deviceAgents = /* @__PURE__ */ new Map();
function createDeviceAgent(expectedCn) {
  let agent = deviceAgents.get(expectedCn);
  if (!agent) {
    agent = new https.Agent({
      ca: HOMEWIZARD_CA_CERT,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      checkServerIdentity: (_hostname, cert) => {
        var _a;
        const cn = typeof ((_a = cert == null ? void 0 : cert.subject) == null ? void 0 : _a.CN) === "string" ? cert.subject.CN : void 0;
        if (cn === expectedCn) {
          return void 0;
        }
        return new Error(`HomeWizard certificate CN mismatch: expected "${expectedCn}", got "${cn != null ? cn : "?"}"`);
      }
    });
    deviceAgents.set(expectedCn, agent);
  }
  return agent;
}
const serialDeviceAgents = /* @__PURE__ */ new Map();
function createDeviceAgentForSerial(serial) {
  let agent = serialDeviceAgents.get(serial);
  if (!agent) {
    const expectedSuffix = `/${serial.toLowerCase()}`;
    agent = new https.Agent({
      ca: HOMEWIZARD_CA_CERT,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      checkServerIdentity: (_hostname, cert) => {
        var _a;
        const cn = typeof ((_a = cert == null ? void 0 : cert.subject) == null ? void 0 : _a.CN) === "string" ? cert.subject.CN.toLowerCase() : void 0;
        if (cn && cn.endsWith(expectedSuffix)) {
          return void 0;
        }
        return new Error(`HomeWizard certificate CN "${cn != null ? cn : "?"}" does not match device serial "${serial}"`);
      }
    });
    serialDeviceAgents.set(serial, agent);
  }
  return agent;
}
function dropDeviceAgent(expectedCn, serial) {
  if (expectedCn) {
    const agent = deviceAgents.get(expectedCn);
    if (agent) {
      agent.destroy();
      deviceAgents.delete(expectedCn);
    }
  }
  if (serial) {
    const agent = serialDeviceAgents.get(serial);
    if (agent) {
      agent.destroy();
      serialDeviceAgents.delete(serial);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CA_NOT_AFTER,
  HOMEWIZARD_CA_CERT,
  HW_AGENT,
  caDaysUntilExpiry,
  createDeviceAgent,
  createDeviceAgentForSerial,
  dropDeviceAgent
});
//# sourceMappingURL=cacert.js.map
