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
var discovery_exports = {};
__export(discovery_exports, {
  HomeWizardDiscovery: () => HomeWizardDiscovery
});
module.exports = __toCommonJS(discovery_exports);
var import_bonjour_service = __toESM(require("bonjour-service"));
class HomeWizardDiscovery {
  bonjour = null;
  browser = null;
  log;
  /**
   * @param log Logger interface
   * @param log.debug Debug log function
   * @param log.warn Warning log function
   */
  constructor(log) {
    this.log = log;
  }
  /**
   * Start scanning for HomeWizard devices
   *
   * @param callback Called for each discovered device
   */
  start(callback) {
    this.stop();
    this.bonjour = new import_bonjour_service.default();
    this.log.debug("mDNS: browsing for _homewizard._tcp (v2)");
    this.browser = this.bonjour.find({ type: "homewizard", protocol: "tcp" }, (service) => {
      const device = this.parseService(service);
      if (device) {
        this.log.debug(`mDNS: found ${device.name} (${device.productType}) at ${device.ip}`);
        callback(device);
      }
    });
  }
  /** Stop scanning */
  stop() {
    if (this.browser) {
      this.browser.stop();
      this.browser = null;
    }
    if (this.bonjour) {
      this.bonjour.destroy();
      this.bonjour = null;
    }
  }
  /**
   * Parse a Bonjour service into a DiscoveredDevice
   *
   * @param service Bonjour service record
   */
  parseService(service) {
    var _a, _b, _c, _d, _e, _f;
    const ip = (_a = service.addresses) == null ? void 0 : _a.find((addr) => addr.includes("."));
    if (!ip) {
      this.log.debug(`mDNS: no IPv4 address for ${service.name}`);
      return null;
    }
    const txt = service.txt;
    const productType = (_b = txt == null ? void 0 : txt.product_type) != null ? _b : "unknown";
    const serial = (_d = (_c = txt == null ? void 0 : txt.serial) != null ? _c : service.name) != null ? _d : "unknown";
    const name = (_f = (_e = txt == null ? void 0 : txt.product_name) != null ? _e : service.name) != null ? _f : productType;
    const apiVersion = txt == null ? void 0 : txt.api_version;
    if (apiVersion) {
      this.log.debug(`mDNS: TXT api_version=${apiVersion} serial=${serial}`);
    }
    return { ip, productType, serial, name };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  HomeWizardDiscovery
});
//# sourceMappingURL=discovery.js.map
