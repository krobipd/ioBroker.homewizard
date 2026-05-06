/**
 * Localized log strings — info/warn/error end up in the ioBroker admin log,
 * which is user-facing. Translations cover all 11 ioBroker system languages
 * (en/de/ru/pt/nl/fr/it/es/pl/uk/zh-cn).
 *
 * The active language is read once in `main.onReady` from
 * `system.config.language` and stored on the adapter instance. A language
 * change in admin requires an adapter restart — acceptable, users don't
 * switch languages on the fly.
 *
 * Debug logs stay English (maintainer diagnostics, not user-visible at
 * default loglevel). Stack traces stay verbatim — code paths aren't
 * translatable.
 */

const SUPPORTED_LANGS = ["en", "de", "ru", "pt", "nl", "fr", "it", "es", "pl", "uk", "zh-cn"] as const;
type Lang = (typeof SUPPORTED_LANGS)[number];

/**
 * Token substitution: `{name}` in the template is replaced with `params.name`.
 * `null` values render as `(none)`, missing tokens are kept as `{key}` so a
 * caller bug surfaces in the log instead of silently emitting an empty string.
 *
 * @param template Localized log string with `{key}` placeholders.
 * @param params   Token values; `null` → `(none)`, `undefined` → token kept.
 */
function fmt(template: string, params?: Record<string, string | number | null | undefined>): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = params[key];
    if (v === null) {
      return "(none)";
    }
    if (v === undefined) {
      return `{${key}}`;
    }
    return String(v);
  });
}

/**
 * All user-facing info/warn/error strings. Keys are descriptive identifiers,
 * values are bundles for the 11 supported ioBroker system languages. Tech
 * internals (module prefixes like `mDNS:`, raw `code` strings) are kept out
 * — user-facing logs should be readable without source-code context.
 */
export const LOG_STRINGS = {
  // ──────── Adapter lifecycle / crash defense ────────
  onReadyFailed: {
    en: "onReady failed: {error}",
    de: "onReady fehlgeschlagen: {error}",
    ru: "onReady завершился с ошибкой: {error}",
    pt: "onReady falhou: {error}",
    nl: "onReady is mislukt: {error}",
    fr: "onReady a échoué : {error}",
    it: "onReady non riuscito: {error}",
    es: "onReady falló: {error}",
    pl: "onReady nie powiódł się: {error}",
    uk: "onReady завершився з помилкою: {error}",
    "zh-cn": "onReady 失败：{error}",
  },
  stateChangeFailed: {
    en: "stateChange failed: {error}",
    de: "stateChange fehlgeschlagen: {error}",
    ru: "stateChange завершился с ошибкой: {error}",
    pt: "stateChange falhou: {error}",
    nl: "stateChange is mislukt: {error}",
    fr: "stateChange a échoué : {error}",
    it: "stateChange non riuscito: {error}",
    es: "stateChange falló: {error}",
    pl: "stateChange nie powiódł się: {error}",
    uk: "stateChange завершився з помилкою: {error}",
    "zh-cn": "stateChange 失败：{error}",
  },
  unhandledRejection: {
    en: "Unhandled rejection: {error}",
    de: "Unbehandelte Promise-Rejection: {error}",
    ru: "Необработанный rejection: {error}",
    pt: "Rejeição não tratada: {error}",
    nl: "Onafgehandelde rejection: {error}",
    fr: "Rejet non géré : {error}",
    it: "Rejection non gestita: {error}",
    es: "Rechazo no manejado: {error}",
    pl: "Nieobsłużone odrzucenie: {error}",
    uk: "Необроблений rejection: {error}",
    "zh-cn": "未处理的 rejection：{error}",
  },
  uncaughtException: {
    en: "Uncaught exception: {error}",
    de: "Nicht abgefangene Exception: {error}",
    ru: "Необработанное исключение: {error}",
    pt: "Exceção não capturada: {error}",
    nl: "Niet-opgevangen exception: {error}",
    fr: "Exception non capturée : {error}",
    it: "Eccezione non catturata: {error}",
    es: "Excepción no capturada: {error}",
    pl: "Nieprzechwycony wyjątek: {error}",
    uk: "Неперехоплене виключення: {error}",
    "zh-cn": "未捕获的异常：{error}",
  },

  // ──────── Pairing flow ────────
  noDevicesConfigured: {
    en: "No devices configured — set 'startPairing' to true to add a device",
    de: "Keine Geräte konfiguriert — 'startPairing' auf true setzen, um ein Gerät hinzuzufügen",
    ru: "Нет настроенных устройств — установите 'startPairing' в true, чтобы добавить устройство",
    pt: "Nenhum dispositivo configurado — defina 'startPairing' como true para adicionar um dispositivo",
    nl: "Geen apparaten geconfigureerd — zet 'startPairing' op true om een apparaat toe te voegen",
    fr: "Aucun appareil configuré — définissez 'startPairing' sur true pour ajouter un appareil",
    it: "Nessun dispositivo configurato — imposta 'startPairing' su true per aggiungere un dispositivo",
    es: "No hay dispositivos configurados — establece 'startPairing' en true para añadir uno",
    pl: "Brak skonfigurowanych urządzeń — ustaw 'startPairing' na true, aby dodać urządzenie",
    uk: "Немає налаштованих пристроїв — встановіть 'startPairing' на true, щоб додати пристрій",
    "zh-cn": "未配置设备 — 将 'startPairing' 设置为 true 以添加设备",
  },
  deviceFound: {
    en: "Found {name} ({type}) at {ip} — press the button on the device to pair",
    de: "Gefunden: {name} ({type}) unter {ip} — Knopf am Gerät drücken, um zu koppeln",
    ru: "Найдено {name} ({type}) по адресу {ip} — нажмите кнопку на устройстве для сопряжения",
    pt: "Encontrado {name} ({type}) em {ip} — pressione o botão do dispositivo para emparelhar",
    nl: "Gevonden: {name} ({type}) op {ip} — druk op de knop op het apparaat om te koppelen",
    fr: "Trouvé : {name} ({type}) à {ip} — appuyez sur le bouton de l'appareil pour l'appairer",
    it: "Trovato {name} ({type}) a {ip} — premi il pulsante sul dispositivo per accoppiare",
    es: "Encontrado {name} ({type}) en {ip} — pulsa el botón del dispositivo para emparejar",
    pl: "Znaleziono {name} ({type}) pod {ip} — naciśnij przycisk na urządzeniu, aby sparować",
    uk: "Знайдено {name} ({type}) за адресою {ip} — натисніть кнопку на пристрої для сполучення",
    "zh-cn": "已找到 {name} ({type}) 位于 {ip} — 按设备上的按钮配对",
  },
  pairingEnabledManual: {
    en: "Pairing mode enabled for {ip} — press the button on your HomeWizard device now (60 seconds timeout)",
    de: "Pairing-Modus aktiv für {ip} — jetzt Knopf am HomeWizard-Gerät drücken (60 Sekunden Timeout)",
    ru: "Режим сопряжения включён для {ip} — нажмите кнопку на устройстве HomeWizard (тайм-аут 60 секунд)",
    pt: "Modo de emparelhamento ativo para {ip} — pressione o botão do dispositivo HomeWizard agora (60 segundos)",
    nl: "Koppelmodus actief voor {ip} — druk nu op de knop van uw HomeWizard-apparaat (60 seconden time-out)",
    fr: "Mode d'appairage activé pour {ip} — appuyez sur le bouton de l'appareil HomeWizard (timeout 60 secondes)",
    it: "Modalità di accoppiamento attiva per {ip} — premi ora il pulsante sul dispositivo HomeWizard (timeout 60 secondi)",
    es: "Modo de emparejamiento activo para {ip} — pulsa ahora el botón del dispositivo HomeWizard (60 segundos)",
    pl: "Tryb parowania aktywny dla {ip} — naciśnij teraz przycisk na urządzeniu HomeWizard (timeout 60 sekund)",
    uk: "Режим сполучення активний для {ip} — натисніть зараз кнопку на пристрої HomeWizard (тайм-аут 60 секунд)",
    "zh-cn": "已为 {ip} 启用配对模式 — 现在请按下 HomeWizard 设备上的按钮（60 秒超时）",
  },
  pairingEnabledMdns: {
    en: "Pairing mode enabled — searching for devices via mDNS, press the button on your HomeWizard device now (60 seconds timeout)",
    de: "Pairing-Modus aktiv — Geräte-Suche via mDNS, jetzt Knopf am HomeWizard-Gerät drücken (60 Sekunden Timeout)",
    ru: "Режим сопряжения включён — поиск устройств через mDNS, нажмите кнопку на устройстве HomeWizard (60 секунд)",
    pt: "Modo de emparelhamento ativo — procurando dispositivos via mDNS, pressione o botão agora (60 segundos)",
    nl: "Koppelmodus actief — apparaten zoeken via mDNS, druk nu op de knop van uw HomeWizard-apparaat (60 seconden)",
    fr: "Mode d'appairage activé — recherche d'appareils via mDNS, appuyez maintenant sur le bouton (timeout 60 secondes)",
    it: "Modalità di accoppiamento attiva — ricerca dispositivi tramite mDNS, premi ora il pulsante (timeout 60 secondi)",
    es: "Modo de emparejamiento activo — buscando dispositivos vía mDNS, pulsa ahora el botón (60 segundos)",
    pl: "Tryb parowania aktywny — wyszukiwanie urządzeń przez mDNS, naciśnij teraz przycisk (timeout 60 sekund)",
    uk: "Режим сполучення активний — пошук пристроїв через mDNS, натисніть зараз кнопку (тайм-аут 60 секунд)",
    "zh-cn": "已启用配对模式 — 通过 mDNS 搜索设备，现在请按下设备上的按钮（60 秒超时）",
  },
  pairingTimeout: {
    en: "Pairing mode automatically disabled after 60 seconds timeout",
    de: "Pairing-Modus nach 60 Sekunden automatisch beendet",
    ru: "Режим сопряжения автоматически отключён после тайм-аута 60 секунд",
    pt: "Modo de emparelhamento desativado automaticamente após timeout de 60 segundos",
    nl: "Koppelmodus automatisch uitgeschakeld na time-out van 60 seconden",
    fr: "Mode d'appairage désactivé automatiquement après timeout de 60 secondes",
    it: "Modalità di accoppiamento disattivata automaticamente dopo timeout di 60 secondi",
    es: "Modo de emparejamiento desactivado automáticamente tras 60 segundos",
    pl: "Tryb parowania automatycznie wyłączony po 60 sekundach",
    uk: "Режим сполучення автоматично вимкнено після тайм-ауту 60 секунд",
    "zh-cn": "60 秒超时后已自动禁用配对模式",
  },
  pairingSuccess: {
    en: "Successfully paired with {name} ({type}) at {ip} — connecting...",
    de: "Erfolgreich gekoppelt mit {name} ({type}) unter {ip} — verbinde...",
    ru: "Успешное сопряжение с {name} ({type}) по адресу {ip} — подключение...",
    pt: "Emparelhamento bem-sucedido com {name} ({type}) em {ip} — conectando...",
    nl: "Succesvol gekoppeld met {name} ({type}) op {ip} — verbinden...",
    fr: "Appairage réussi avec {name} ({type}) à {ip} — connexion...",
    it: "Accoppiamento riuscito con {name} ({type}) a {ip} — connessione in corso...",
    es: "Emparejamiento exitoso con {name} ({type}) en {ip} — conectando...",
    pl: "Pomyślnie sparowano z {name} ({type}) pod {ip} — łączenie...",
    uk: "Успішне сполучення з {name} ({type}) за адресою {ip} — підключення...",
    "zh-cn": "已成功与 {name} ({type}) 配对，地址 {ip} — 正在连接...",
  },

  // ──────── State writes ────────
  rebootingDevice: {
    en: "Rebooting {name} ({ip})",
    de: "Starte {name} ({ip}) neu",
    ru: "Перезагрузка {name} ({ip})",
    pt: "Reiniciando {name} ({ip})",
    nl: "Opnieuw opstarten van {name} ({ip})",
    fr: "Redémarrage de {name} ({ip})",
    it: "Riavvio di {name} ({ip})",
    es: "Reiniciando {name} ({ip})",
    pl: "Restartowanie {name} ({ip})",
    uk: "Перезавантаження {name} ({ip})",
    "zh-cn": "正在重启 {name} ({ip})",
  },
  failedToSetState: {
    en: "Failed to set {id}: {error}",
    de: "Setzen von {id} fehlgeschlagen: {error}",
    ru: "Не удалось установить {id}: {error}",
    pt: "Falha ao definir {id}: {error}",
    nl: "Instellen van {id} is mislukt: {error}",
    fr: "Échec de la définition de {id} : {error}",
    it: "Impossibile impostare {id}: {error}",
    es: "Error al establecer {id}: {error}",
    pl: "Nie udało się ustawić {id}: {error}",
    uk: "Не вдалося встановити {id}: {error}",
    "zh-cn": "无法设置 {id}：{error}",
  },
  invalidPermissionsJson: {
    en: "Invalid JSON for battery.permissions: {error} — expected array, got: {value}",
    de: "Ungültiges JSON für battery.permissions: {error} — Array erwartet, erhalten: {value}",
    ru: "Неверный JSON для battery.permissions: {error} — ожидался массив, получено: {value}",
    pt: "JSON inválido para battery.permissions: {error} — esperado array, recebido: {value}",
    nl: "Ongeldige JSON voor battery.permissions: {error} — array verwacht, ontvangen: {value}",
    fr: "JSON invalide pour battery.permissions : {error} — tableau attendu, reçu : {value}",
    it: "JSON non valido per battery.permissions: {error} — atteso array, ricevuto: {value}",
    es: "JSON inválido para battery.permissions: {error} — se esperaba array, recibido: {value}",
    pl: "Nieprawidłowy JSON dla battery.permissions: {error} — oczekiwano tablicy, otrzymano: {value}",
    uk: "Невірний JSON для battery.permissions: {error} — очікувався масив, отримано: {value}",
    "zh-cn": "battery.permissions 的 JSON 无效：{error} — 期望数组，收到：{value}",
  },
  invalidBatteryMode: {
    en: "Invalid battery.mode value: '{value}' — expected one of: zero, to_full, standby",
    de: "Ungültiger battery.mode-Wert: '{value}' — erwartet: zero, to_full oder standby",
    ru: "Неверное значение battery.mode: '{value}' — ожидается: zero, to_full или standby",
    pt: "Valor inválido para battery.mode: '{value}' — esperado: zero, to_full ou standby",
    nl: "Ongeldige battery.mode-waarde: '{value}' — verwacht: zero, to_full of standby",
    fr: "Valeur battery.mode invalide : '{value}' — attendu : zero, to_full ou standby",
    it: "Valore battery.mode non valido: '{value}' — atteso: zero, to_full o standby",
    es: "Valor battery.mode inválido: '{value}' — esperado: zero, to_full o standby",
    pl: "Nieprawidłowa wartość battery.mode: '{value}' — oczekiwano: zero, to_full lub standby",
    uk: "Невірне значення battery.mode: '{value}' — очікується: zero, to_full або standby",
    "zh-cn": "battery.mode 值无效：'{value}' — 期望：zero、to_full 或 standby",
  },
  removingDevice: {
    en: "Removing device {name} ({serial})",
    de: "Entferne Gerät {name} ({serial})",
    ru: "Удаление устройства {name} ({serial})",
    pt: "Removendo dispositivo {name} ({serial})",
    nl: "Apparaat {name} ({serial}) verwijderen",
    fr: "Suppression de l'appareil {name} ({serial})",
    it: "Rimozione del dispositivo {name} ({serial})",
    es: "Eliminando dispositivo {name} ({serial})",
    pl: "Usuwanie urządzenia {name} ({serial})",
    uk: "Видалення пристрою {name} ({serial})",
    "zh-cn": "正在移除设备 {name} ({serial})",
  },

  // ──────── Connection lifecycle ────────
  searchingNewIp: {
    en: "Device unreachable — searching for new IP via mDNS",
    de: "Gerät nicht erreichbar — suche neue IP via mDNS",
    ru: "Устройство недоступно — поиск нового IP через mDNS",
    pt: "Dispositivo inacessível — procurando novo IP via mDNS",
    nl: "Apparaat onbereikbaar — nieuwe IP zoeken via mDNS",
    fr: "Appareil injoignable — recherche d'une nouvelle IP via mDNS",
    it: "Dispositivo non raggiungibile — ricerca nuovo IP tramite mDNS",
    es: "Dispositivo inaccesible — buscando nueva IP vía mDNS",
    pl: "Urządzenie nieosiągalne — wyszukiwanie nowego IP przez mDNS",
    uk: "Пристрій недоступний — пошук нової IP через mDNS",
    "zh-cn": "设备不可达 — 通过 mDNS 搜索新 IP",
  },
  foundAtNewIp: {
    en: "{name}: found at new IP {newIp} (was {oldIp})",
    de: "{name}: unter neuer IP {newIp} gefunden (zuvor {oldIp})",
    ru: "{name}: найдено по новому IP {newIp} (было {oldIp})",
    pt: "{name}: encontrado em novo IP {newIp} (era {oldIp})",
    nl: "{name}: gevonden op nieuwe IP {newIp} (was {oldIp})",
    fr: "{name} : trouvé à la nouvelle IP {newIp} (auparavant {oldIp})",
    it: "{name}: trovato al nuovo IP {newIp} (era {oldIp})",
    es: "{name}: encontrado en nueva IP {newIp} (antes {oldIp})",
    pl: "{name}: znaleziono pod nowym IP {newIp} (było {oldIp})",
    uk: "{name}: знайдено за новою IP {newIp} (було {oldIp})",
    "zh-cn": "{name}：已在新 IP {newIp} 找到（之前为 {oldIp}）",
  },
  deviceOfflineRetrying: {
    en: "{name}: device offline — will keep retrying every {seconds}s",
    de: "{name}: Gerät offline — Versuche werden alle {seconds}s wiederholt",
    ru: "{name}: устройство офлайн — повтор каждые {seconds}с",
    pt: "{name}: dispositivo offline — tentando novamente a cada {seconds}s",
    nl: "{name}: apparaat offline — opnieuw proberen elke {seconds}s",
    fr: "{name} : appareil hors-ligne — nouvelle tentative toutes les {seconds}s",
    it: "{name}: dispositivo offline — nuovi tentativi ogni {seconds}s",
    es: "{name}: dispositivo desconectado — reintentando cada {seconds}s",
    pl: "{name}: urządzenie offline — ponawianie co {seconds}s",
    uk: "{name}: пристрій офлайн — повторні спроби кожні {seconds}с",
    "zh-cn": "{name}：设备离线 — 将每 {seconds} 秒重试一次",
  },
  deviceUnreachable: {
    en: "{name}: device unreachable — will keep retrying",
    de: "{name}: Gerät nicht erreichbar — Versuche werden fortgesetzt",
    ru: "{name}: устройство недоступно — попытки будут продолжены",
    pt: "{name}: dispositivo inacessível — tentativas continuarão",
    nl: "{name}: apparaat onbereikbaar — pogingen worden voortgezet",
    fr: "{name} : appareil injoignable — les tentatives continuent",
    it: "{name}: dispositivo non raggiungibile — i tentativi continueranno",
    es: "{name}: dispositivo inaccesible — se seguirán intentando",
    pl: "{name}: urządzenie nieosiągalne — próby będą kontynuowane",
    uk: "{name}: пристрій недоступний — спроби триватимуть",
    "zh-cn": "{name}：设备不可达 — 将继续重试",
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
    "zh-cn": "{name} {context}：{error}",
  },
  connectionRestored: {
    en: "{name}: connection restored",
    de: "{name}: Verbindung wiederhergestellt",
    ru: "{name}: соединение восстановлено",
    pt: "{name}: conexão restabelecida",
    nl: "{name}: verbinding hersteld",
    fr: "{name} : connexion rétablie",
    it: "{name}: connessione ripristinata",
    es: "{name}: conexión restablecida",
    pl: "{name}: połączenie przywrócone",
    uk: "{name}: з'єднання відновлено",
    "zh-cn": "{name}：连接已恢复",
  },
  connectionRestoredUnstable: {
    en: "{name}: connection restored (unstable mode)",
    de: "{name}: Verbindung wiederhergestellt (Unstable-Modus)",
    ru: "{name}: соединение восстановлено (нестабильный режим)",
    pt: "{name}: conexão restabelecida (modo instável)",
    nl: "{name}: verbinding hersteld (instabiele modus)",
    fr: "{name} : connexion rétablie (mode instable)",
    it: "{name}: connessione ripristinata (modalità instabile)",
    es: "{name}: conexión restablecida (modo inestable)",
    pl: "{name}: połączenie przywrócone (tryb niestabilny)",
    uk: "{name}: з'єднання відновлено (нестабільний режим)",
    "zh-cn": "{name}：连接已恢复（不稳定模式）",
  },
  unstableDetected: {
    en: "{name}: unstable connection detected — using faster reconnect",
    de: "{name}: instabile Verbindung erkannt — schnellerer Reconnect aktiv",
    ru: "{name}: обнаружено нестабильное соединение — используется быстрое переподключение",
    pt: "{name}: conexão instável detectada — usando reconexão mais rápida",
    nl: "{name}: instabiele verbinding gedetecteerd — sneller opnieuw verbinden",
    fr: "{name} : connexion instable détectée — reconnexion plus rapide activée",
    it: "{name}: rilevata connessione instabile — riconnessione più veloce",
    es: "{name}: conexión inestable detectada — reconexión más rápida activada",
    pl: "{name}: wykryto niestabilne połączenie — szybsze ponowne łączenie",
    uk: "{name}: виявлено нестабільне з'єднання — використовується швидше повторне підключення",
    "zh-cn": "{name}：检测到不稳定连接 — 使用更快的重连",
  },
  connectionStabilized: {
    en: "{name}: connection stabilized — using normal reconnect",
    de: "{name}: Verbindung stabilisiert — normaler Reconnect aktiv",
    ru: "{name}: соединение стабилизировано — обычное переподключение",
    pt: "{name}: conexão estabilizada — usando reconexão normal",
    nl: "{name}: verbinding gestabiliseerd — normale reconnect actief",
    fr: "{name} : connexion stabilisée — reconnexion normale active",
    it: "{name}: connessione stabilizzata — riconnessione normale",
    es: "{name}: conexión estabilizada — reconexión normal activa",
    pl: "{name}: połączenie ustabilizowane — normalne ponowne łączenie",
    uk: "{name}: з'єднання стабілізовано — звичайне повторне підключення",
    "zh-cn": "{name}：连接已稳定 — 使用常规重连",
  },
  tokenInvalid: {
    en: "{name}: token invalid — re-pair device to fix",
    de: "{name}: Token ungültig — Gerät neu koppeln, um den Fehler zu beheben",
    ru: "{name}: токен недействителен — выполните повторное сопряжение устройства",
    pt: "{name}: token inválido — emparelhe o dispositivo novamente para corrigir",
    nl: "{name}: token ongeldig — apparaat opnieuw koppelen om dit op te lossen",
    fr: "{name} : token invalide — réappairez l'appareil pour corriger",
    it: "{name}: token non valido — riaccoppia il dispositivo per risolvere",
    es: "{name}: token inválido — vuelve a emparejar el dispositivo para arreglarlo",
    pl: "{name}: token nieprawidłowy — sparuj urządzenie ponownie, aby naprawić",
    uk: "{name}: токен недійсний — повторіть сполучення пристрою",
    "zh-cn": "{name}：token 无效 — 请重新配对设备以修复",
  },
} as const;

/**
 * Look up a log string in the requested language with EN fallback.
 *
 * @param lang   ioBroker system language (`'en'`, `'de'`, …) — any string
 *               accepted, falls back to `en` for unknown values.
 * @param key    Translation key from {@link LOG_STRINGS}.
 * @param params Token values for `{name}` placeholders.
 */
export function tLog(
  lang: string,
  key: keyof typeof LOG_STRINGS,
  params?: Record<string, string | number | null | undefined>,
): string {
  const langKey = (SUPPORTED_LANGS as readonly string[]).includes(lang) ? (lang as Lang) : "en";
  const bundle = LOG_STRINGS[key];
  const template = bundle[langKey] ?? bundle.en;
  return fmt(template, params);
}
