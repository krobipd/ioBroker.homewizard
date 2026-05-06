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
var i18n_logs_exports = {};
__export(i18n_logs_exports, {
  LOG_STRINGS: () => LOG_STRINGS,
  tLog: () => tLog
});
module.exports = __toCommonJS(i18n_logs_exports);
const SUPPORTED_LANGS = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"];
function fmt(template, params) {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const v = params[key];
    if (v === null) {
      return "(none)";
    }
    if (v === void 0) {
      return `{${key}}`;
    }
    return String(v);
  });
}
const LOG_STRINGS = {
  // ──────── Adapter lifecycle / crash defense ────────
  onReadyFailed: {
    en: "onReady failed: {error}",
    de: "onReady fehlgeschlagen: {error}",
    ru: "onReady \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u043B\u0441\u044F \u0441 \u043E\u0448\u0438\u0431\u043A\u043E\u0439: {error}",
    pt: "onReady falhou: {error}",
    nl: "onReady is mislukt: {error}",
    fr: "onReady a \xE9chou\xE9 : {error}",
    it: "onReady non riuscito: {error}",
    es: "onReady fall\xF3: {error}",
    pl: "onReady nie powi\xF3d\u0142 si\u0119: {error}",
    uk: "onReady \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u0432\u0441\u044F \u0437 \u043F\u043E\u043C\u0438\u043B\u043A\u043E\u044E: {error}",
    "zh-cn": "onReady \u5931\u8D25\uFF1A{error}"
  },
  stateChangeFailed: {
    en: "stateChange failed: {error}",
    de: "stateChange fehlgeschlagen: {error}",
    ru: "stateChange \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u043B\u0441\u044F \u0441 \u043E\u0448\u0438\u0431\u043A\u043E\u0439: {error}",
    pt: "stateChange falhou: {error}",
    nl: "stateChange is mislukt: {error}",
    fr: "stateChange a \xE9chou\xE9 : {error}",
    it: "stateChange non riuscito: {error}",
    es: "stateChange fall\xF3: {error}",
    pl: "stateChange nie powi\xF3d\u0142 si\u0119: {error}",
    uk: "stateChange \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u0432\u0441\u044F \u0437 \u043F\u043E\u043C\u0438\u043B\u043A\u043E\u044E: {error}",
    "zh-cn": "stateChange \u5931\u8D25\uFF1A{error}"
  },
  unhandledRejection: {
    en: "Unhandled rejection: {error}",
    de: "Unbehandelte Promise-Rejection: {error}",
    ru: "\u041D\u0435\u043E\u0431\u0440\u0430\u0431\u043E\u0442\u0430\u043D\u043D\u044B\u0439 rejection: {error}",
    pt: "Rejei\xE7\xE3o n\xE3o tratada: {error}",
    nl: "Onafgehandelde rejection: {error}",
    fr: "Rejet non g\xE9r\xE9 : {error}",
    it: "Rejection non gestita: {error}",
    es: "Rechazo no manejado: {error}",
    pl: "Nieobs\u0142u\u017Cone odrzucenie: {error}",
    uk: "\u041D\u0435\u043E\u0431\u0440\u043E\u0431\u043B\u0435\u043D\u0438\u0439 rejection: {error}",
    "zh-cn": "\u672A\u5904\u7406\u7684 rejection\uFF1A{error}"
  },
  uncaughtException: {
    en: "Uncaught exception: {error}",
    de: "Nicht abgefangene Exception: {error}",
    ru: "\u041D\u0435\u043E\u0431\u0440\u0430\u0431\u043E\u0442\u0430\u043D\u043D\u043E\u0435 \u0438\u0441\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435: {error}",
    pt: "Exce\xE7\xE3o n\xE3o capturada: {error}",
    nl: "Niet-opgevangen exception: {error}",
    fr: "Exception non captur\xE9e : {error}",
    it: "Eccezione non catturata: {error}",
    es: "Excepci\xF3n no capturada: {error}",
    pl: "Nieprzechwycony wyj\u0105tek: {error}",
    uk: "\u041D\u0435\u043F\u0435\u0440\u0435\u0445\u043E\u043F\u043B\u0435\u043D\u0435 \u0432\u0438\u043A\u043B\u044E\u0447\u0435\u043D\u043D\u044F: {error}",
    "zh-cn": "\u672A\u6355\u83B7\u7684\u5F02\u5E38\uFF1A{error}"
  },
  // ──────── Pairing flow ────────
  noDevicesConfigured: {
    en: "No devices configured \u2014 set 'startPairing' to true to add a device",
    de: "Keine Ger\xE4te konfiguriert \u2014 'startPairing' auf true setzen, um ein Ger\xE4t hinzuzuf\xFCgen",
    ru: "\u041D\u0435\u0442 \u043D\u0430\u0441\u0442\u0440\u043E\u0435\u043D\u043D\u044B\u0445 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432 \u2014 \u0443\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u0435 'startPairing' \u0432 true, \u0447\u0442\u043E\u0431\u044B \u0434\u043E\u0431\u0430\u0432\u0438\u0442\u044C \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u043E",
    pt: "Nenhum dispositivo configurado \u2014 defina 'startPairing' como true para adicionar um dispositivo",
    nl: "Geen apparaten geconfigureerd \u2014 zet 'startPairing' op true om een apparaat toe te voegen",
    fr: "Aucun appareil configur\xE9 \u2014 d\xE9finissez 'startPairing' sur true pour ajouter un appareil",
    it: "Nessun dispositivo configurato \u2014 imposta 'startPairing' su true per aggiungere un dispositivo",
    es: "No hay dispositivos configurados \u2014 establece 'startPairing' en true para a\xF1adir uno",
    pl: "Brak skonfigurowanych urz\u0105dze\u0144 \u2014 ustaw 'startPairing' na true, aby doda\u0107 urz\u0105dzenie",
    uk: "\u041D\u0435\u043C\u0430\u0454 \u043D\u0430\u043B\u0430\u0448\u0442\u043E\u0432\u0430\u043D\u0438\u0445 \u043F\u0440\u0438\u0441\u0442\u0440\u043E\u0457\u0432 \u2014 \u0432\u0441\u0442\u0430\u043D\u043E\u0432\u0456\u0442\u044C 'startPairing' \u043D\u0430 true, \u0449\u043E\u0431 \u0434\u043E\u0434\u0430\u0442\u0438 \u043F\u0440\u0438\u0441\u0442\u0440\u0456\u0439",
    "zh-cn": "\u672A\u914D\u7F6E\u8BBE\u5907 \u2014 \u5C06 'startPairing' \u8BBE\u7F6E\u4E3A true \u4EE5\u6DFB\u52A0\u8BBE\u5907"
  },
  deviceFound: {
    en: "Found {name} ({type}) at {ip} \u2014 press the button on the device to pair",
    de: "Gefunden: {name} ({type}) unter {ip} \u2014 Knopf am Ger\xE4t dr\xFCcken, um zu koppeln",
    ru: "\u041D\u0430\u0439\u0434\u0435\u043D\u043E {name} ({type}) \u043F\u043E \u0430\u0434\u0440\u0435\u0441\u0443 {ip} \u2014 \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \u043A\u043D\u043E\u043F\u043A\u0443 \u043D\u0430 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0435 \u0434\u043B\u044F \u0441\u043E\u043F\u0440\u044F\u0436\u0435\u043D\u0438\u044F",
    pt: "Encontrado {name} ({type}) em {ip} \u2014 pressione o bot\xE3o do dispositivo para emparelhar",
    nl: "Gevonden: {name} ({type}) op {ip} \u2014 druk op de knop op het apparaat om te koppelen",
    fr: "Trouv\xE9 : {name} ({type}) \xE0 {ip} \u2014 appuyez sur le bouton de l'appareil pour l'appairer",
    it: "Trovato {name} ({type}) a {ip} \u2014 premi il pulsante sul dispositivo per accoppiare",
    es: "Encontrado {name} ({type}) en {ip} \u2014 pulsa el bot\xF3n del dispositivo para emparejar",
    pl: "Znaleziono {name} ({type}) pod {ip} \u2014 naci\u015Bnij przycisk na urz\u0105dzeniu, aby sparowa\u0107",
    uk: "\u0417\u043D\u0430\u0439\u0434\u0435\u043D\u043E {name} ({type}) \u0437\u0430 \u0430\u0434\u0440\u0435\u0441\u043E\u044E {ip} \u2014 \u043D\u0430\u0442\u0438\u0441\u043D\u0456\u0442\u044C \u043A\u043D\u043E\u043F\u043A\u0443 \u043D\u0430 \u043F\u0440\u0438\u0441\u0442\u0440\u043E\u0457 \u0434\u043B\u044F \u0441\u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043D\u044F",
    "zh-cn": "\u5DF2\u627E\u5230 {name} ({type}) \u4F4D\u4E8E {ip} \u2014 \u6309\u8BBE\u5907\u4E0A\u7684\u6309\u94AE\u914D\u5BF9"
  },
  pairingEnabledManual: {
    en: "Pairing mode enabled for {ip} \u2014 press the button on your HomeWizard device now (60 seconds timeout)",
    de: "Pairing-Modus aktiv f\xFCr {ip} \u2014 jetzt Knopf am HomeWizard-Ger\xE4t dr\xFCcken (60 Sekunden Timeout)",
    ru: "\u0420\u0435\u0436\u0438\u043C \u0441\u043E\u043F\u0440\u044F\u0436\u0435\u043D\u0438\u044F \u0432\u043A\u043B\u044E\u0447\u0451\u043D \u0434\u043B\u044F {ip} \u2014 \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \u043A\u043D\u043E\u043F\u043A\u0443 \u043D\u0430 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0435 HomeWizard (\u0442\u0430\u0439\u043C-\u0430\u0443\u0442 60 \u0441\u0435\u043A\u0443\u043D\u0434)",
    pt: "Modo de emparelhamento ativo para {ip} \u2014 pressione o bot\xE3o do dispositivo HomeWizard agora (60 segundos)",
    nl: "Koppelmodus actief voor {ip} \u2014 druk nu op de knop van uw HomeWizard-apparaat (60 seconden time-out)",
    fr: "Mode d'appairage activ\xE9 pour {ip} \u2014 appuyez sur le bouton de l'appareil HomeWizard (timeout 60 secondes)",
    it: "Modalit\xE0 di accoppiamento attiva per {ip} \u2014 premi ora il pulsante sul dispositivo HomeWizard (timeout 60 secondi)",
    es: "Modo de emparejamiento activo para {ip} \u2014 pulsa ahora el bot\xF3n del dispositivo HomeWizard (60 segundos)",
    pl: "Tryb parowania aktywny dla {ip} \u2014 naci\u015Bnij teraz przycisk na urz\u0105dzeniu HomeWizard (timeout 60 sekund)",
    uk: "\u0420\u0435\u0436\u0438\u043C \u0441\u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043D\u044F \u0430\u043A\u0442\u0438\u0432\u043D\u0438\u0439 \u0434\u043B\u044F {ip} \u2014 \u043D\u0430\u0442\u0438\u0441\u043D\u0456\u0442\u044C \u0437\u0430\u0440\u0430\u0437 \u043A\u043D\u043E\u043F\u043A\u0443 \u043D\u0430 \u043F\u0440\u0438\u0441\u0442\u0440\u043E\u0457 HomeWizard (\u0442\u0430\u0439\u043C-\u0430\u0443\u0442 60 \u0441\u0435\u043A\u0443\u043D\u0434)",
    "zh-cn": "\u5DF2\u4E3A {ip} \u542F\u7528\u914D\u5BF9\u6A21\u5F0F \u2014 \u73B0\u5728\u8BF7\u6309\u4E0B HomeWizard \u8BBE\u5907\u4E0A\u7684\u6309\u94AE\uFF0860 \u79D2\u8D85\u65F6\uFF09"
  },
  pairingEnabledMdns: {
    en: "Pairing mode enabled \u2014 searching for devices via mDNS, press the button on your HomeWizard device now (60 seconds timeout)",
    de: "Pairing-Modus aktiv \u2014 Ger\xE4te-Suche via mDNS, jetzt Knopf am HomeWizard-Ger\xE4t dr\xFCcken (60 Sekunden Timeout)",
    ru: "\u0420\u0435\u0436\u0438\u043C \u0441\u043E\u043F\u0440\u044F\u0436\u0435\u043D\u0438\u044F \u0432\u043A\u043B\u044E\u0447\u0451\u043D \u2014 \u043F\u043E\u0438\u0441\u043A \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432 \u0447\u0435\u0440\u0435\u0437 mDNS, \u043D\u0430\u0436\u043C\u0438\u0442\u0435 \u043A\u043D\u043E\u043F\u043A\u0443 \u043D\u0430 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0435 HomeWizard (60 \u0441\u0435\u043A\u0443\u043D\u0434)",
    pt: "Modo de emparelhamento ativo \u2014 procurando dispositivos via mDNS, pressione o bot\xE3o agora (60 segundos)",
    nl: "Koppelmodus actief \u2014 apparaten zoeken via mDNS, druk nu op de knop van uw HomeWizard-apparaat (60 seconden)",
    fr: "Mode d'appairage activ\xE9 \u2014 recherche d'appareils via mDNS, appuyez maintenant sur le bouton (timeout 60 secondes)",
    it: "Modalit\xE0 di accoppiamento attiva \u2014 ricerca dispositivi tramite mDNS, premi ora il pulsante (timeout 60 secondi)",
    es: "Modo de emparejamiento activo \u2014 buscando dispositivos v\xEDa mDNS, pulsa ahora el bot\xF3n (60 segundos)",
    pl: "Tryb parowania aktywny \u2014 wyszukiwanie urz\u0105dze\u0144 przez mDNS, naci\u015Bnij teraz przycisk (timeout 60 sekund)",
    uk: "\u0420\u0435\u0436\u0438\u043C \u0441\u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043D\u044F \u0430\u043A\u0442\u0438\u0432\u043D\u0438\u0439 \u2014 \u043F\u043E\u0448\u0443\u043A \u043F\u0440\u0438\u0441\u0442\u0440\u043E\u0457\u0432 \u0447\u0435\u0440\u0435\u0437 mDNS, \u043D\u0430\u0442\u0438\u0441\u043D\u0456\u0442\u044C \u0437\u0430\u0440\u0430\u0437 \u043A\u043D\u043E\u043F\u043A\u0443 (\u0442\u0430\u0439\u043C-\u0430\u0443\u0442 60 \u0441\u0435\u043A\u0443\u043D\u0434)",
    "zh-cn": "\u5DF2\u542F\u7528\u914D\u5BF9\u6A21\u5F0F \u2014 \u901A\u8FC7 mDNS \u641C\u7D22\u8BBE\u5907\uFF0C\u73B0\u5728\u8BF7\u6309\u4E0B\u8BBE\u5907\u4E0A\u7684\u6309\u94AE\uFF0860 \u79D2\u8D85\u65F6\uFF09"
  },
  pairingTimeout: {
    en: "Pairing mode automatically disabled after 60 seconds timeout",
    de: "Pairing-Modus nach 60 Sekunden automatisch beendet",
    ru: "\u0420\u0435\u0436\u0438\u043C \u0441\u043E\u043F\u0440\u044F\u0436\u0435\u043D\u0438\u044F \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u0435\u0441\u043A\u0438 \u043E\u0442\u043A\u043B\u044E\u0447\u0451\u043D \u043F\u043E\u0441\u043B\u0435 \u0442\u0430\u0439\u043C-\u0430\u0443\u0442\u0430 60 \u0441\u0435\u043A\u0443\u043D\u0434",
    pt: "Modo de emparelhamento desativado automaticamente ap\xF3s timeout de 60 segundos",
    nl: "Koppelmodus automatisch uitgeschakeld na time-out van 60 seconden",
    fr: "Mode d'appairage d\xE9sactiv\xE9 automatiquement apr\xE8s timeout de 60 secondes",
    it: "Modalit\xE0 di accoppiamento disattivata automaticamente dopo timeout di 60 secondi",
    es: "Modo de emparejamiento desactivado autom\xE1ticamente tras 60 segundos",
    pl: "Tryb parowania automatycznie wy\u0142\u0105czony po 60 sekundach",
    uk: "\u0420\u0435\u0436\u0438\u043C \u0441\u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043D\u044F \u0430\u0432\u0442\u043E\u043C\u0430\u0442\u0438\u0447\u043D\u043E \u0432\u0438\u043C\u043A\u043D\u0435\u043D\u043E \u043F\u0456\u0441\u043B\u044F \u0442\u0430\u0439\u043C-\u0430\u0443\u0442\u0443 60 \u0441\u0435\u043A\u0443\u043D\u0434",
    "zh-cn": "60 \u79D2\u8D85\u65F6\u540E\u5DF2\u81EA\u52A8\u7981\u7528\u914D\u5BF9\u6A21\u5F0F"
  },
  pairingSuccess: {
    en: "Successfully paired with {name} ({type}) at {ip} \u2014 connecting...",
    de: "Erfolgreich gekoppelt mit {name} ({type}) unter {ip} \u2014 verbinde...",
    ru: "\u0423\u0441\u043F\u0435\u0448\u043D\u043E\u0435 \u0441\u043E\u043F\u0440\u044F\u0436\u0435\u043D\u0438\u0435 \u0441 {name} ({type}) \u043F\u043E \u0430\u0434\u0440\u0435\u0441\u0443 {ip} \u2014 \u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435...",
    pt: "Emparelhamento bem-sucedido com {name} ({type}) em {ip} \u2014 conectando...",
    nl: "Succesvol gekoppeld met {name} ({type}) op {ip} \u2014 verbinden...",
    fr: "Appairage r\xE9ussi avec {name} ({type}) \xE0 {ip} \u2014 connexion...",
    it: "Accoppiamento riuscito con {name} ({type}) a {ip} \u2014 connessione in corso...",
    es: "Emparejamiento exitoso con {name} ({type}) en {ip} \u2014 conectando...",
    pl: "Pomy\u015Blnie sparowano z {name} ({type}) pod {ip} \u2014 \u0142\u0105czenie...",
    uk: "\u0423\u0441\u043F\u0456\u0448\u043D\u0435 \u0441\u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043D\u044F \u0437 {name} ({type}) \u0437\u0430 \u0430\u0434\u0440\u0435\u0441\u043E\u044E {ip} \u2014 \u043F\u0456\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u043D\u044F...",
    "zh-cn": "\u5DF2\u6210\u529F\u4E0E {name} ({type}) \u914D\u5BF9\uFF0C\u5730\u5740 {ip} \u2014 \u6B63\u5728\u8FDE\u63A5..."
  },
  // ──────── State writes ────────
  rebootingDevice: {
    en: "Rebooting {name} ({ip})",
    de: "Starte {name} ({ip}) neu",
    ru: "\u041F\u0435\u0440\u0435\u0437\u0430\u0433\u0440\u0443\u0437\u043A\u0430 {name} ({ip})",
    pt: "Reiniciando {name} ({ip})",
    nl: "Opnieuw opstarten van {name} ({ip})",
    fr: "Red\xE9marrage de {name} ({ip})",
    it: "Riavvio di {name} ({ip})",
    es: "Reiniciando {name} ({ip})",
    pl: "Restartowanie {name} ({ip})",
    uk: "\u041F\u0435\u0440\u0435\u0437\u0430\u0432\u0430\u043D\u0442\u0430\u0436\u0435\u043D\u043D\u044F {name} ({ip})",
    "zh-cn": "\u6B63\u5728\u91CD\u542F {name} ({ip})"
  },
  failedToSetState: {
    en: "Failed to set {id}: {error}",
    de: "Setzen von {id} fehlgeschlagen: {error}",
    ru: "\u041D\u0435 \u0443\u0434\u0430\u043B\u043E\u0441\u044C \u0443\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u044C {id}: {error}",
    pt: "Falha ao definir {id}: {error}",
    nl: "Instellen van {id} is mislukt: {error}",
    fr: "\xC9chec de la d\xE9finition de {id} : {error}",
    it: "Impossibile impostare {id}: {error}",
    es: "Error al establecer {id}: {error}",
    pl: "Nie uda\u0142o si\u0119 ustawi\u0107 {id}: {error}",
    uk: "\u041D\u0435 \u0432\u0434\u0430\u043B\u043E\u0441\u044F \u0432\u0441\u0442\u0430\u043D\u043E\u0432\u0438\u0442\u0438 {id}: {error}",
    "zh-cn": "\u65E0\u6CD5\u8BBE\u7F6E {id}\uFF1A{error}"
  },
  invalidPermissionsJson: {
    en: "Invalid JSON for battery.permissions: {error} \u2014 expected array, got: {value}",
    de: "Ung\xFCltiges JSON f\xFCr battery.permissions: {error} \u2014 Array erwartet, erhalten: {value}",
    ru: "\u041D\u0435\u0432\u0435\u0440\u043D\u044B\u0439 JSON \u0434\u043B\u044F battery.permissions: {error} \u2014 \u043E\u0436\u0438\u0434\u0430\u043B\u0441\u044F \u043C\u0430\u0441\u0441\u0438\u0432, \u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043E: {value}",
    pt: "JSON inv\xE1lido para battery.permissions: {error} \u2014 esperado array, recebido: {value}",
    nl: "Ongeldige JSON voor battery.permissions: {error} \u2014 array verwacht, ontvangen: {value}",
    fr: "JSON invalide pour battery.permissions : {error} \u2014 tableau attendu, re\xE7u : {value}",
    it: "JSON non valido per battery.permissions: {error} \u2014 atteso array, ricevuto: {value}",
    es: "JSON inv\xE1lido para battery.permissions: {error} \u2014 se esperaba array, recibido: {value}",
    pl: "Nieprawid\u0142owy JSON dla battery.permissions: {error} \u2014 oczekiwano tablicy, otrzymano: {value}",
    uk: "\u041D\u0435\u0432\u0456\u0440\u043D\u0438\u0439 JSON \u0434\u043B\u044F battery.permissions: {error} \u2014 \u043E\u0447\u0456\u043A\u0443\u0432\u0430\u0432\u0441\u044F \u043C\u0430\u0441\u0438\u0432, \u043E\u0442\u0440\u0438\u043C\u0430\u043D\u043E: {value}",
    "zh-cn": "battery.permissions \u7684 JSON \u65E0\u6548\uFF1A{error} \u2014 \u671F\u671B\u6570\u7EC4\uFF0C\u6536\u5230\uFF1A{value}"
  },
  invalidBatteryMode: {
    en: "Invalid battery.mode value: '{value}' \u2014 expected one of: zero, to_full, standby",
    de: "Ung\xFCltiger battery.mode-Wert: '{value}' \u2014 erwartet: zero, to_full oder standby",
    ru: "\u041D\u0435\u0432\u0435\u0440\u043D\u043E\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u0438\u0435 battery.mode: '{value}' \u2014 \u043E\u0436\u0438\u0434\u0430\u0435\u0442\u0441\u044F: zero, to_full \u0438\u043B\u0438 standby",
    pt: "Valor inv\xE1lido para battery.mode: '{value}' \u2014 esperado: zero, to_full ou standby",
    nl: "Ongeldige battery.mode-waarde: '{value}' \u2014 verwacht: zero, to_full of standby",
    fr: "Valeur battery.mode invalide : '{value}' \u2014 attendu : zero, to_full ou standby",
    it: "Valore battery.mode non valido: '{value}' \u2014 atteso: zero, to_full o standby",
    es: "Valor battery.mode inv\xE1lido: '{value}' \u2014 esperado: zero, to_full o standby",
    pl: "Nieprawid\u0142owa warto\u015B\u0107 battery.mode: '{value}' \u2014 oczekiwano: zero, to_full lub standby",
    uk: "\u041D\u0435\u0432\u0456\u0440\u043D\u0435 \u0437\u043D\u0430\u0447\u0435\u043D\u043D\u044F battery.mode: '{value}' \u2014 \u043E\u0447\u0456\u043A\u0443\u0454\u0442\u044C\u0441\u044F: zero, to_full \u0430\u0431\u043E standby",
    "zh-cn": "battery.mode \u503C\u65E0\u6548\uFF1A'{value}' \u2014 \u671F\u671B\uFF1Azero\u3001to_full \u6216 standby"
  },
  removingDevice: {
    en: "Removing device {name} ({serial})",
    de: "Entferne Ger\xE4t {name} ({serial})",
    ru: "\u0423\u0434\u0430\u043B\u0435\u043D\u0438\u0435 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0430 {name} ({serial})",
    pt: "Removendo dispositivo {name} ({serial})",
    nl: "Apparaat {name} ({serial}) verwijderen",
    fr: "Suppression de l'appareil {name} ({serial})",
    it: "Rimozione del dispositivo {name} ({serial})",
    es: "Eliminando dispositivo {name} ({serial})",
    pl: "Usuwanie urz\u0105dzenia {name} ({serial})",
    uk: "\u0412\u0438\u0434\u0430\u043B\u0435\u043D\u043D\u044F \u043F\u0440\u0438\u0441\u0442\u0440\u043E\u044E {name} ({serial})",
    "zh-cn": "\u6B63\u5728\u79FB\u9664\u8BBE\u5907 {name} ({serial})"
  },
  // ──────── Connection lifecycle ────────
  searchingNewIp: {
    en: "Device unreachable \u2014 searching for new IP via mDNS",
    de: "Ger\xE4t nicht erreichbar \u2014 suche neue IP via mDNS",
    ru: "\u0423\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u043E \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u2014 \u043F\u043E\u0438\u0441\u043A \u043D\u043E\u0432\u043E\u0433\u043E IP \u0447\u0435\u0440\u0435\u0437 mDNS",
    pt: "Dispositivo inacess\xEDvel \u2014 procurando novo IP via mDNS",
    nl: "Apparaat onbereikbaar \u2014 nieuwe IP zoeken via mDNS",
    fr: "Appareil injoignable \u2014 recherche d'une nouvelle IP via mDNS",
    it: "Dispositivo non raggiungibile \u2014 ricerca nuovo IP tramite mDNS",
    es: "Dispositivo inaccesible \u2014 buscando nueva IP v\xEDa mDNS",
    pl: "Urz\u0105dzenie nieosi\u0105galne \u2014 wyszukiwanie nowego IP przez mDNS",
    uk: "\u041F\u0440\u0438\u0441\u0442\u0440\u0456\u0439 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0438\u0439 \u2014 \u043F\u043E\u0448\u0443\u043A \u043D\u043E\u0432\u043E\u0457 IP \u0447\u0435\u0440\u0435\u0437 mDNS",
    "zh-cn": "\u8BBE\u5907\u4E0D\u53EF\u8FBE \u2014 \u901A\u8FC7 mDNS \u641C\u7D22\u65B0 IP"
  },
  foundAtNewIp: {
    en: "{name}: found at new IP {newIp} (was {oldIp})",
    de: "{name}: unter neuer IP {newIp} gefunden (zuvor {oldIp})",
    ru: "{name}: \u043D\u0430\u0439\u0434\u0435\u043D\u043E \u043F\u043E \u043D\u043E\u0432\u043E\u043C\u0443 IP {newIp} (\u0431\u044B\u043B\u043E {oldIp})",
    pt: "{name}: encontrado em novo IP {newIp} (era {oldIp})",
    nl: "{name}: gevonden op nieuwe IP {newIp} (was {oldIp})",
    fr: "{name} : trouv\xE9 \xE0 la nouvelle IP {newIp} (auparavant {oldIp})",
    it: "{name}: trovato al nuovo IP {newIp} (era {oldIp})",
    es: "{name}: encontrado en nueva IP {newIp} (antes {oldIp})",
    pl: "{name}: znaleziono pod nowym IP {newIp} (by\u0142o {oldIp})",
    uk: "{name}: \u0437\u043D\u0430\u0439\u0434\u0435\u043D\u043E \u0437\u0430 \u043D\u043E\u0432\u043E\u044E IP {newIp} (\u0431\u0443\u043B\u043E {oldIp})",
    "zh-cn": "{name}\uFF1A\u5DF2\u5728\u65B0 IP {newIp} \u627E\u5230\uFF08\u4E4B\u524D\u4E3A {oldIp}\uFF09"
  },
  deviceOfflineRetrying: {
    en: "{name}: device offline \u2014 will keep retrying every {seconds}s",
    de: "{name}: Ger\xE4t offline \u2014 Versuche werden alle {seconds}s wiederholt",
    ru: "{name}: \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u043E \u043E\u0444\u043B\u0430\u0439\u043D \u2014 \u043F\u043E\u0432\u0442\u043E\u0440 \u043A\u0430\u0436\u0434\u044B\u0435 {seconds}\u0441",
    pt: "{name}: dispositivo offline \u2014 tentando novamente a cada {seconds}s",
    nl: "{name}: apparaat offline \u2014 opnieuw proberen elke {seconds}s",
    fr: "{name} : appareil hors-ligne \u2014 nouvelle tentative toutes les {seconds}s",
    it: "{name}: dispositivo offline \u2014 nuovi tentativi ogni {seconds}s",
    es: "{name}: dispositivo desconectado \u2014 reintentando cada {seconds}s",
    pl: "{name}: urz\u0105dzenie offline \u2014 ponawianie co {seconds}s",
    uk: "{name}: \u043F\u0440\u0438\u0441\u0442\u0440\u0456\u0439 \u043E\u0444\u043B\u0430\u0439\u043D \u2014 \u043F\u043E\u0432\u0442\u043E\u0440\u043D\u0456 \u0441\u043F\u0440\u043E\u0431\u0438 \u043A\u043E\u0436\u043D\u0456 {seconds}\u0441",
    "zh-cn": "{name}\uFF1A\u8BBE\u5907\u79BB\u7EBF \u2014 \u5C06\u6BCF {seconds} \u79D2\u91CD\u8BD5\u4E00\u6B21"
  },
  deviceUnreachable: {
    en: "{name}: device unreachable \u2014 will keep retrying",
    de: "{name}: Ger\xE4t nicht erreichbar \u2014 Versuche werden fortgesetzt",
    ru: "{name}: \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u043E \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u043E \u2014 \u043F\u043E\u043F\u044B\u0442\u043A\u0438 \u0431\u0443\u0434\u0443\u0442 \u043F\u0440\u043E\u0434\u043E\u043B\u0436\u0435\u043D\u044B",
    pt: "{name}: dispositivo inacess\xEDvel \u2014 tentativas continuar\xE3o",
    nl: "{name}: apparaat onbereikbaar \u2014 pogingen worden voortgezet",
    fr: "{name} : appareil injoignable \u2014 les tentatives continuent",
    it: "{name}: dispositivo non raggiungibile \u2014 i tentativi continueranno",
    es: "{name}: dispositivo inaccesible \u2014 se seguir\xE1n intentando",
    pl: "{name}: urz\u0105dzenie nieosi\u0105galne \u2014 pr\xF3by b\u0119d\u0105 kontynuowane",
    uk: "{name}: \u043F\u0440\u0438\u0441\u0442\u0440\u0456\u0439 \u043D\u0435\u0434\u043E\u0441\u0442\u0443\u043F\u043D\u0438\u0439 \u2014 \u0441\u043F\u0440\u043E\u0431\u0438 \u0442\u0440\u0438\u0432\u0430\u0442\u0438\u043C\u0443\u0442\u044C",
    "zh-cn": "{name}\uFF1A\u8BBE\u5907\u4E0D\u53EF\u8FBE \u2014 \u5C06\u7EE7\u7EED\u91CD\u8BD5"
  },
  deviceErrorContext: {
    en: "{name} {context}: {error}",
    de: "{name} {context}: {error}",
    ru: "{name} {context}: {error}",
    pt: "{name} {context}: {error}",
    nl: "{name} {context}: {error}",
    fr: "{name} {context} : {error}",
    it: "{name} {context}: {error}",
    es: "{name} {context}: {error}",
    pl: "{name} {context}: {error}",
    uk: "{name} {context}: {error}",
    "zh-cn": "{name} {context}\uFF1A{error}"
  },
  connectionRestored: {
    en: "{name}: connection restored",
    de: "{name}: Verbindung wiederhergestellt",
    ru: "{name}: \u0441\u043E\u0435\u0434\u0438\u043D\u0435\u043D\u0438\u0435 \u0432\u043E\u0441\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u043E",
    pt: "{name}: conex\xE3o restabelecida",
    nl: "{name}: verbinding hersteld",
    fr: "{name} : connexion r\xE9tablie",
    it: "{name}: connessione ripristinata",
    es: "{name}: conexi\xF3n restablecida",
    pl: "{name}: po\u0142\u0105czenie przywr\xF3cone",
    uk: "{name}: \u0437'\u0454\u0434\u043D\u0430\u043D\u043D\u044F \u0432\u0456\u0434\u043D\u043E\u0432\u043B\u0435\u043D\u043E",
    "zh-cn": "{name}\uFF1A\u8FDE\u63A5\u5DF2\u6062\u590D"
  },
  connectionRestoredUnstable: {
    en: "{name}: connection restored (unstable mode)",
    de: "{name}: Verbindung wiederhergestellt (Unstable-Modus)",
    ru: "{name}: \u0441\u043E\u0435\u0434\u0438\u043D\u0435\u043D\u0438\u0435 \u0432\u043E\u0441\u0441\u0442\u0430\u043D\u043E\u0432\u043B\u0435\u043D\u043E (\u043D\u0435\u0441\u0442\u0430\u0431\u0438\u043B\u044C\u043D\u044B\u0439 \u0440\u0435\u0436\u0438\u043C)",
    pt: "{name}: conex\xE3o restabelecida (modo inst\xE1vel)",
    nl: "{name}: verbinding hersteld (instabiele modus)",
    fr: "{name} : connexion r\xE9tablie (mode instable)",
    it: "{name}: connessione ripristinata (modalit\xE0 instabile)",
    es: "{name}: conexi\xF3n restablecida (modo inestable)",
    pl: "{name}: po\u0142\u0105czenie przywr\xF3cone (tryb niestabilny)",
    uk: "{name}: \u0437'\u0454\u0434\u043D\u0430\u043D\u043D\u044F \u0432\u0456\u0434\u043D\u043E\u0432\u043B\u0435\u043D\u043E (\u043D\u0435\u0441\u0442\u0430\u0431\u0456\u043B\u044C\u043D\u0438\u0439 \u0440\u0435\u0436\u0438\u043C)",
    "zh-cn": "{name}\uFF1A\u8FDE\u63A5\u5DF2\u6062\u590D\uFF08\u4E0D\u7A33\u5B9A\u6A21\u5F0F\uFF09"
  },
  unstableDetected: {
    en: "{name}: unstable connection detected \u2014 using faster reconnect",
    de: "{name}: instabile Verbindung erkannt \u2014 schnellerer Reconnect aktiv",
    ru: "{name}: \u043E\u0431\u043D\u0430\u0440\u0443\u0436\u0435\u043D\u043E \u043D\u0435\u0441\u0442\u0430\u0431\u0438\u043B\u044C\u043D\u043E\u0435 \u0441\u043E\u0435\u0434\u0438\u043D\u0435\u043D\u0438\u0435 \u2014 \u0438\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u0442\u0441\u044F \u0431\u044B\u0441\u0442\u0440\u043E\u0435 \u043F\u0435\u0440\u0435\u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435",
    pt: "{name}: conex\xE3o inst\xE1vel detectada \u2014 usando reconex\xE3o mais r\xE1pida",
    nl: "{name}: instabiele verbinding gedetecteerd \u2014 sneller opnieuw verbinden",
    fr: "{name} : connexion instable d\xE9tect\xE9e \u2014 reconnexion plus rapide activ\xE9e",
    it: "{name}: rilevata connessione instabile \u2014 riconnessione pi\xF9 veloce",
    es: "{name}: conexi\xF3n inestable detectada \u2014 reconexi\xF3n m\xE1s r\xE1pida activada",
    pl: "{name}: wykryto niestabilne po\u0142\u0105czenie \u2014 szybsze ponowne \u0142\u0105czenie",
    uk: "{name}: \u0432\u0438\u044F\u0432\u043B\u0435\u043D\u043E \u043D\u0435\u0441\u0442\u0430\u0431\u0456\u043B\u044C\u043D\u0435 \u0437'\u0454\u0434\u043D\u0430\u043D\u043D\u044F \u2014 \u0432\u0438\u043A\u043E\u0440\u0438\u0441\u0442\u043E\u0432\u0443\u0454\u0442\u044C\u0441\u044F \u0448\u0432\u0438\u0434\u0448\u0435 \u043F\u043E\u0432\u0442\u043E\u0440\u043D\u0435 \u043F\u0456\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u043D\u044F",
    "zh-cn": "{name}\uFF1A\u68C0\u6D4B\u5230\u4E0D\u7A33\u5B9A\u8FDE\u63A5 \u2014 \u4F7F\u7528\u66F4\u5FEB\u7684\u91CD\u8FDE"
  },
  connectionStabilized: {
    en: "{name}: connection stabilized \u2014 using normal reconnect",
    de: "{name}: Verbindung stabilisiert \u2014 normaler Reconnect aktiv",
    ru: "{name}: \u0441\u043E\u0435\u0434\u0438\u043D\u0435\u043D\u0438\u0435 \u0441\u0442\u0430\u0431\u0438\u043B\u0438\u0437\u0438\u0440\u043E\u0432\u0430\u043D\u043E \u2014 \u043E\u0431\u044B\u0447\u043D\u043E\u0435 \u043F\u0435\u0440\u0435\u043F\u043E\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u0438\u0435",
    pt: "{name}: conex\xE3o estabilizada \u2014 usando reconex\xE3o normal",
    nl: "{name}: verbinding gestabiliseerd \u2014 normale reconnect actief",
    fr: "{name} : connexion stabilis\xE9e \u2014 reconnexion normale active",
    it: "{name}: connessione stabilizzata \u2014 riconnessione normale",
    es: "{name}: conexi\xF3n estabilizada \u2014 reconexi\xF3n normal activa",
    pl: "{name}: po\u0142\u0105czenie ustabilizowane \u2014 normalne ponowne \u0142\u0105czenie",
    uk: "{name}: \u0437'\u0454\u0434\u043D\u0430\u043D\u043D\u044F \u0441\u0442\u0430\u0431\u0456\u043B\u0456\u0437\u043E\u0432\u0430\u043D\u043E \u2014 \u0437\u0432\u0438\u0447\u0430\u0439\u043D\u0435 \u043F\u043E\u0432\u0442\u043E\u0440\u043D\u0435 \u043F\u0456\u0434\u043A\u043B\u044E\u0447\u0435\u043D\u043D\u044F",
    "zh-cn": "{name}\uFF1A\u8FDE\u63A5\u5DF2\u7A33\u5B9A \u2014 \u4F7F\u7528\u5E38\u89C4\u91CD\u8FDE"
  },
  tokenInvalid: {
    en: "{name}: token invalid \u2014 re-pair device to fix",
    de: "{name}: Token ung\xFCltig \u2014 Ger\xE4t neu koppeln, um den Fehler zu beheben",
    ru: "{name}: \u0442\u043E\u043A\u0435\u043D \u043D\u0435\u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0442\u0435\u043B\u0435\u043D \u2014 \u0432\u044B\u043F\u043E\u043B\u043D\u0438\u0442\u0435 \u043F\u043E\u0432\u0442\u043E\u0440\u043D\u043E\u0435 \u0441\u043E\u043F\u0440\u044F\u0436\u0435\u043D\u0438\u0435 \u0443\u0441\u0442\u0440\u043E\u0439\u0441\u0442\u0432\u0430",
    pt: "{name}: token inv\xE1lido \u2014 emparelhe o dispositivo novamente para corrigir",
    nl: "{name}: token ongeldig \u2014 apparaat opnieuw koppelen om dit op te lossen",
    fr: "{name} : token invalide \u2014 r\xE9appairez l'appareil pour corriger",
    it: "{name}: token non valido \u2014 riaccoppia il dispositivo per risolvere",
    es: "{name}: token inv\xE1lido \u2014 vuelve a emparejar el dispositivo para arreglarlo",
    pl: "{name}: token nieprawid\u0142owy \u2014 sparuj urz\u0105dzenie ponownie, aby naprawi\u0107",
    uk: "{name}: \u0442\u043E\u043A\u0435\u043D \u043D\u0435\u0434\u0456\u0439\u0441\u043D\u0438\u0439 \u2014 \u043F\u043E\u0432\u0442\u043E\u0440\u0456\u0442\u044C \u0441\u043F\u043E\u043B\u0443\u0447\u0435\u043D\u043D\u044F \u043F\u0440\u0438\u0441\u0442\u0440\u043E\u044E",
    "zh-cn": "{name}\uFF1Atoken \u65E0\u6548 \u2014 \u8BF7\u91CD\u65B0\u914D\u5BF9\u8BBE\u5907\u4EE5\u4FEE\u590D"
  }
};
function tLog(lang, key, params) {
  var _a;
  const langKey = SUPPORTED_LANGS.includes(lang) ? lang : "en";
  const bundle = LOG_STRINGS[key];
  const template = (_a = bundle[langKey]) != null ? _a : bundle.en;
  return fmt(template, params);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LOG_STRINGS,
  tLog
});
//# sourceMappingURL=i18n-logs.js.map
