/*
 * Comfy home — firmware per ESP8266 / ESP32
 * ==========================================
 *
 * Riceve comandi cifrati dalla web app "Comfy home" via WebSocket,
 * li decifra e li consegna in chiaro a onCommandReceived(); risponde
 * con la conferma "[nome_device]_[stringa ricevuta]" cifrata.
 * Può inviare in qualunque momento stringhe cifrate all'app con
 * comfySend() (telemetria, notifiche spontanee).
 *
 * Protocollo (identico alla web app):
 *   messaggio = base64( IV[12] || CIPHERTEXT || TAG[16] )
 *   cifrario  = AES-256-GCM, chiave = SHA-256(passphrase del device)
 *
 * Librerie richieste (Arduino IDE -> Gestione librerie):
 *   - "WebSockets" di Markus Sattler (Links2004/arduinoWebSockets)
 *   - "Crypto" di Rhys Weatherley (rweather/arduinolibs)
 *
 * Prima accensione: aprire il Monitor seriale a 115200 baud; parte la
 * configurazione guidata (nome, WiFi, chiave, porta, IP statico
 * opzionale). La configurazione è salvata in memoria non volatile.
 * Per riconfigurare in seguito: digitare  config  + Invio sul monitor.
 *
 * Il codice di esecuzione dei comandi andrà scritto dentro
 * onCommandReceived(), in fondo a questo file.
 */

#ifdef ESP8266
  #include <ESP8266WiFi.h>
#else
  #include <WiFi.h>
#endif
#include <EEPROM.h>
#include <WebSocketsServer.h>
#include <Crypto.h>
#include <AES.h>
#include <GCM.h>
#include <SHA256.h>

/* ------------------------------------------------------------------ */
/* Costanti                                                            */
/* ------------------------------------------------------------------ */

static const uint32_t CONFIG_MAGIC = 0x43484D31UL; // "CHM1"
static const size_t   IV_LEN  = 12;
static const size_t   TAG_LEN = 16;
static const size_t   MAX_PLAIN = 1200;   // stringa comando/telemetria max
static const size_t   MAX_B64   = 2048;   // payload base64 max in ingresso
static const uint16_t EEPROM_SIZE = 512;
static const unsigned long WIFI_RETRY_MS = 5000;

/* ------------------------------------------------------------------ */
/* Configurazione persistente                                          */
/* ------------------------------------------------------------------ */

struct Config {
  uint32_t magic;
  char     name[33];      // nome device (senza '_', '|', '$')
  char     ssid[33];
  char     wifiPass[65];
  char     key[129];      // passphrase di cifratura (>= 8 caratteri)
  uint16_t port;          // porta del server WebSocket
  uint8_t  useStaticIp;
  uint8_t  ip[4];
  uint8_t  gw[4];
  uint8_t  mask[4];
  uint32_t crc;           // CRC32 di tutto ciò che precede
};

static Config cfg;
static_assert(sizeof(Config) <= EEPROM_SIZE, "Config non entra nella EEPROM");
static uint8_t aesKey[32];               // SHA-256(cfg.key)
static GCM<AES256> gcm;
static WebSocketsServer* ws = nullptr;
static unsigned long lastWifiAttempt = 0;

/* ------------------------------------------------------------------ */
/* Utilità: CRC32, base64, casuale, esadecimale                        */
/* ------------------------------------------------------------------ */

static uint32_t crc32buf(const uint8_t* data, size_t len) {
  uint32_t crc = 0xFFFFFFFFUL;
  for (size_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (uint8_t b = 0; b < 8; b++) {
      crc = (crc >> 1) ^ (0xEDB88320UL & (-(int32_t)(crc & 1)));
    }
  }
  return ~crc;
}

static uint32_t hwRandom32() {
#ifdef ESP8266
  return RANDOM_REG32;              // RNG hardware ESP8266
#else
  return esp_random();              // RNG hardware ESP32
#endif
}

static void randomBytes(uint8_t* out, size_t len) {
  for (size_t i = 0; i < len; i += 4) {
    uint32_t r = hwRandom32();
    for (size_t j = 0; j < 4 && i + j < len; j++) {
      out[i + j] = (uint8_t)(r >> (8 * j));
    }
  }
}

static const char B64_CHARS[] =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static size_t b64Encode(const uint8_t* in, size_t len, char* out, size_t outMax) {
  size_t need = 4 * ((len + 2) / 3);
  if (need + 1 > outMax) return 0;
  size_t o = 0;
  for (size_t i = 0; i < len; i += 3) {
    uint32_t v = (uint32_t)in[i] << 16;
    if (i + 1 < len) v |= (uint32_t)in[i + 1] << 8;
    if (i + 2 < len) v |= in[i + 2];
    out[o++] = B64_CHARS[(v >> 18) & 63];
    out[o++] = B64_CHARS[(v >> 12) & 63];
    out[o++] = (i + 1 < len) ? B64_CHARS[(v >> 6) & 63] : '=';
    out[o++] = (i + 2 < len) ? B64_CHARS[v & 63] : '=';
  }
  out[o] = '\0';
  return o;
}

static int8_t b64Value(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}

// Ritorna la lunghezza decodificata, oppure -1 se l'input non è valido.
static int b64Decode(const char* in, size_t len, uint8_t* out, size_t outMax) {
  if (len == 0 || (len % 4) != 0) return -1;
  size_t o = 0;
  for (size_t i = 0; i < len; i += 4) {
    int8_t v[4];
    uint8_t pad = 0;
    for (uint8_t j = 0; j < 4; j++) {
      char c = in[i + j];
      if (c == '=') {
        // il padding è ammesso solo negli ultimi due caratteri
        if (i + 4 < len || j < 2) return -1;
        v[j] = 0;
        pad++;
      } else {
        if (pad) return -1;         // carattere dopo il padding
        v[j] = b64Value(c);
        if (v[j] < 0) return -1;
      }
    }
    uint32_t x = ((uint32_t)v[0] << 18) | ((uint32_t)v[1] << 12)
               | ((uint32_t)v[2] << 6) | (uint32_t)v[3];
    if (o + 3 - pad > outMax) return -1;
    out[o++] = (uint8_t)(x >> 16);
    if (pad < 2) out[o++] = (uint8_t)(x >> 8);
    if (pad < 1) out[o++] = (uint8_t)x;
  }
  return (int)o;
}

/* ------------------------------------------------------------------ */
/* Cifratura                                                           */
/* ------------------------------------------------------------------ */

static void deriveKey() {
  SHA256 sha;
  sha.reset();
  sha.update((const uint8_t*)cfg.key, strlen(cfg.key));
  sha.finalize(aesKey, sizeof(aesKey));
  gcm.setKey(aesKey, sizeof(aesKey));
}

/*
 * Cifra `plain` nel formato del protocollo e lo scrive (base64) in `out`.
 * Ritorna true se il messaggio è stato prodotto.
 */
static bool encryptToB64(const char* plain, char* out, size_t outMax) {
  size_t plen = strlen(plain);
  if (plen == 0 || plen > MAX_PLAIN) return false;
  // static: ~1,2 KB non stanno bene sullo stack dell'ESP8266 (4 KB);
  // tutto il flusso gira nel contesto di loop(), niente rientranza
  static uint8_t buf[IV_LEN + MAX_PLAIN + TAG_LEN];
  randomBytes(buf, IV_LEN);                        // IV nuovo per ogni messaggio
  gcm.setIV(buf, IV_LEN);
  gcm.encrypt(buf + IV_LEN, (const uint8_t*)plain, plen);
  gcm.computeTag(buf + IV_LEN + plen, TAG_LEN);
  return b64Encode(buf, IV_LEN + plen + TAG_LEN, out, outMax) > 0;
}

/*
 * Decifra un payload base64 del protocollo. Scrive la stringa in chiaro
 * (terminata da '\0') in `out`. Ritorna false se il messaggio è invalido
 * o manomesso (tag GCM errato).
 */
static bool decryptFromB64(const char* b64, size_t b64Len, char* out, size_t outMax) {
  if (b64Len > MAX_B64) return false;
  static uint8_t buf[IV_LEN + MAX_PLAIN + TAG_LEN];
  int n = b64Decode(b64, b64Len, buf, sizeof(buf));
  if (n < (int)(IV_LEN + TAG_LEN + 1)) return false;
  size_t clen = (size_t)n - IV_LEN - TAG_LEN;
  if (clen + 1 > outMax) return false;
  gcm.setIV(buf, IV_LEN);
  gcm.decrypt((uint8_t*)out, buf + IV_LEN, clen);
  if (!gcm.checkTag(buf + IV_LEN + clen, TAG_LEN)) {
    memset(out, 0, clen);                          // niente plaintext non autenticato
    return false;
  }
  out[clen] = '\0';
  return true;
}

/* ------------------------------------------------------------------ */
/* Invio all'app                                                       */
/* ------------------------------------------------------------------ */

/*
 * Invia una stringa cifrata a tutti i client connessi (la web app).
 * Da usare anche dal codice di esecuzione comandi per la telemetria.
 * NOTA: le trasmissioni spontanee NON devono iniziare con "<nome>_"
 * (prefisso riservato alle conferme di comando).
 */
bool comfySend(const char* text) {
  if (!ws) return false;
  static char b64[((IV_LEN + MAX_PLAIN + TAG_LEN + 2) / 3) * 4 + 8];
  if (!encryptToB64(text, b64, sizeof(b64))) return false;
  return ws->broadcastTXT(b64);
}

// Come sopra ma verso un solo client (usata per le conferme).
static bool sendTo(uint8_t clientNum, const char* text) {
  if (!ws) return false;
  static char b64[((IV_LEN + MAX_PLAIN + TAG_LEN + 2) / 3) * 4 + 8];
  if (!encryptToB64(text, b64, sizeof(b64))) return false;
  return ws->sendTXT(clientNum, b64);
}

/* ------------------------------------------------------------------ */
/* Gestione WebSocket                                                  */
/* ------------------------------------------------------------------ */

void onCommandReceived(const char* command);      // definita in fondo

static void wsEvent(uint8_t num, WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      Serial.printf("[WS] client %u connesso da %s\n", num,
                    ws->remoteIP(num).toString().c_str());
      break;
    case WStype_DISCONNECTED:
      Serial.printf("[WS] client %u disconnesso\n", num);
      break;
    case WStype_TEXT: {
      static char plain[MAX_PLAIN + 1];
      if (!decryptFromB64((const char*)payload, length, plain, sizeof(plain))) {
        Serial.println("[WS] messaggio scartato (non valido o chiave errata)");
        return;
      }
      Serial.printf("[WS] comando ricevuto: %s\n", plain);

      // conferma per la app: "[nome_device]_[stringa ricevuta]"
      static char ack[sizeof(cfg.name) + 1 + MAX_PLAIN + 1];
      snprintf(ack, sizeof(ack), "%s_%s", cfg.name, plain);
      if (!sendTo(num, ack)) {
        Serial.println("[WS] invio conferma fallito");
      }

      onCommandReceived(plain);                   // consegna in chiaro
      break;
    }
    default:
      break;                                      // binari/ping gestiti dalla libreria
  }
}

/* ------------------------------------------------------------------ */
/* Configurazione: EEPROM + procedura guidata su seriale               */
/* ------------------------------------------------------------------ */

static bool loadConfig() {
  EEPROM.get(0, cfg);
  if (cfg.magic != CONFIG_MAGIC) return false;
  uint32_t crc = crc32buf((const uint8_t*)&cfg, offsetof(Config, crc));
  if (crc != cfg.crc) return false;
  if (strlen(cfg.key) < 8 || cfg.port == 0 || cfg.name[0] == '\0') return false;
  return true;
}

static void saveConfig() {
  cfg.magic = CONFIG_MAGIC;
  cfg.crc = crc32buf((const uint8_t*)&cfg, offsetof(Config, crc));
  EEPROM.put(0, cfg);
  EEPROM.commit();
}

// Legge una riga dalla seriale (bloccante), con eco e supporto backspace.
static void readLine(char* out, size_t maxLen, bool secret = false) {
  size_t n = 0;
  for (;;) {
    while (!Serial.available()) { delay(10); yield(); }
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') break;
    if ((c == 8 || c == 127) && n > 0) {          // backspace
      n--;
      Serial.print("\b \b");
      continue;
    }
    if ((uint8_t)c >= 32 && n + 1 < maxLen) {
      out[n++] = c;
      Serial.print(secret ? '*' : c);
    }
  }
  out[n] = '\0';
  Serial.println();
}

static bool parseIp(const char* s, uint8_t out[4]) {
  IPAddress ip;
  if (!ip.fromString(s)) return false;
  for (uint8_t i = 0; i < 4; i++) out[i] = ip[i];
  return true;
}

static bool nameValid(const char* s) {
  size_t len = strlen(s);
  if (len == 0 || len > 32) return false;
  for (size_t i = 0; i < len; i++) {
    if (s[i] == '_' || s[i] == '|' || s[i] == '$') return false;
  }
  return true;
}

static void configWizard() {
  char line[130];
  Serial.println();
  Serial.println("=== Configurazione Comfy home ===");

  do {
    Serial.print("Nome device (senza '_', '|', '$'): ");
    readLine(line, sizeof(cfg.name));
  } while (!nameValid(line));
  strncpy(cfg.name, line, sizeof(cfg.name) - 1);
  cfg.name[sizeof(cfg.name) - 1] = '\0';

  Serial.print("WiFi SSID: ");
  readLine(cfg.ssid, sizeof(cfg.ssid));

  Serial.print("WiFi password: ");
  readLine(cfg.wifiPass, sizeof(cfg.wifiPass), true);

  do {
    Serial.print("Chiave di cifratura (min 8 caratteri, uguale a quella nell'app): ");
    readLine(line, sizeof(cfg.key), true);
  } while (strlen(line) < 8);
  strncpy(cfg.key, line, sizeof(cfg.key) - 1);
  cfg.key[sizeof(cfg.key) - 1] = '\0';

  long port = 0;
  do {
    Serial.print("Porta WebSocket (1-65535, es. 81): ");
    readLine(line, sizeof(line));
    port = atol(line);
  } while (port < 1 || port > 65535);
  cfg.port = (uint16_t)port;

  Serial.print("IP statico (vuoto = DHCP): ");
  readLine(line, sizeof(line));
  cfg.useStaticIp = 0;
  if (line[0] != '\0' && parseIp(line, cfg.ip)) {
    cfg.useStaticIp = 1;
    do {
      Serial.print("Gateway: ");
      readLine(line, sizeof(line));
    } while (!parseIp(line, cfg.gw));
    do {
      Serial.print("Netmask (es. 255.255.255.0): ");
      readLine(line, sizeof(line));
    } while (!parseIp(line, cfg.mask));
  }

  saveConfig();
  Serial.println("Configurazione salvata in memoria non volatile.");
}

// Digitare "config" + Invio sul monitor seriale per riconfigurare.
static void checkSerialForConfig() {
  static char buf[8];
  static uint8_t n = 0;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      buf[n] = '\0';
      if (strcmp(buf, "config") == 0) {
        configWizard();
        Serial.println("Riavvio...");
        delay(500);
        ESP.restart();
      }
      n = 0;
    } else if (n + 1u < sizeof(buf)) {
      buf[n++] = c;
    } else {
      n = 0;                                      // riga troppo lunga: scarta
    }
  }
}

/* ------------------------------------------------------------------ */
/* WiFi                                                                */
/* ------------------------------------------------------------------ */

static void wifiConnect() {
  WiFi.mode(WIFI_STA);
  if (cfg.useStaticIp) {
    WiFi.config(IPAddress(cfg.ip), IPAddress(cfg.gw), IPAddress(cfg.mask));
  }
  WiFi.begin(cfg.ssid, cfg.wifiPass);
  Serial.printf("[WiFi] connessione a \"%s\"...\n", cfg.ssid);
}

static void wifiKeepAlive() {
  if (WiFi.status() == WL_CONNECTED) return;
  unsigned long now = millis();
  if (now - lastWifiAttempt < WIFI_RETRY_MS) return;
  lastWifiAttempt = now;
  WiFi.disconnect();
  wifiConnect();
}

/* ------------------------------------------------------------------ */
/* Setup / loop                                                        */
/* ------------------------------------------------------------------ */

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("Comfy home ESP - avvio");

  EEPROM.begin(EEPROM_SIZE);
  if (!loadConfig()) {
    Serial.println("Nessuna configurazione valida trovata.");
    configWizard();
  }

  deriveKey();
  wifiConnect();

  // attesa iniziale (max 20 s), poi ci pensa wifiKeepAlive nel loop
  for (int i = 0; i < 200 && WiFi.status() != WL_CONNECTED; i++) {
    delay(100);
    yield();
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[WiFi] connesso, IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("[WiFi] non ancora connesso, ritento in background");
  }

  ws = new WebSocketsServer(cfg.port);
  ws->begin();
  ws->onEvent(wsEvent);
  ws->enableHeartbeat(15000, 3000, 2);            // ripulisce i client morti
  Serial.printf("[WS] server in ascolto sulla porta %u\n", cfg.port);
  Serial.printf("Device \"%s\" pronto. Digitare 'config' per riconfigurare.\n", cfg.name);
}

void loop() {
  ws->loop();
  wifiKeepAlive();
  checkSerialForConfig();

  // ============================================================
  // Qui (o dentro onCommandReceived) andrà la logica applicativa.
  // ============================================================
}

/* ------------------------------------------------------------------ */
/* CODICE DI ESECUZIONE COMANDI (da scrivere successivamente)          */
/* ------------------------------------------------------------------ */

/*
 * Riceve la stringa di comando GIÀ DECIFRATA, nel formato
 * "param1|param2|...|paramN$" (la conferma verso l'app è già stata
 * inviata automaticamente). Esempio di parsing dei parametri:
 *
 *   char copia[MAX_PLAIN + 1];
 *   strncpy(copia, command, sizeof(copia));
 *   copia[strcspn(copia, "$")] = '\0';       // rimuove il terminatore
 *   char* salva;
 *   for (char* p = strtok_r(copia, "|", &salva); p != nullptr;
 *        p = strtok_r(nullptr, "|", &salva)) {
 *     // p = parametro corrente
 *   }
 *
 * Per inviare dati all'app in qualunque momento: comfySend("testo$");
 */
void onCommandReceived(const char* command) {
  // TODO: logica applicativa (relè, sensori, ...) — la scriveremo insieme.
  Serial.printf("[CMD] da eseguire: %s\n", command);
}
