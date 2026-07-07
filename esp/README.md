# Comfy home — firmware ESP8266 / ESP32

Firmware Arduino (C++) unico per **ESP8266** ed **ESP32**: riceve i comandi
cifrati dalla web app Comfy home, li decifra e li consegna in chiaro alla
funzione `onCommandReceived()`, risponde con la conferma
`[nome_device]_[stringa ricevuta]` e può trasmettere telemetria cifrata in
qualunque momento con `comfySend()`.

## Protocollo (identico alla web app)

```
messaggio = base64( IV[12] ∥ CIPHERTEXT ∥ TAG[16] )
cifrario  = AES-256-GCM,  chiave = SHA-256(passphrase del device)
trasporto = WebSocket, l'ESP è il server (ws://IP:porta/)
```

- Comando dall'app: `param1|param2|...|paramN$`
- Conferma dall'ESP: `[nome]_[stringa ricevuta]` (automatica)
- Telemetria spontanea: **non** deve iniziare con `[nome]_` (prefisso
  riservato alle conferme)

## Compilazione e caricamento (Arduino IDE)

1. **Schede**: installare il core della propria scheda
   - ESP8266: *File → Impostazioni → URL gestore schede* →
     `https://arduino.esp8266.com/stable/package_esp8266com_index.json`
   - ESP32: `https://espressif.github.io/arduino-esp32/package_esp32_index.json`
2. **Librerie** (*Sketch → Includi libreria → Gestione librerie*):
   - **WebSockets** di Markus Sattler (Links2004/arduinoWebSockets)
   - **Crypto** di Rhys Weatherley (rweather/arduinolibs)
3. Aprire `comfy_home_esp/comfy_home_esp.ino`, selezionare la scheda e caricare.

## Prima configurazione

1. Aprire il **Monitor seriale** a **115200 baud** (fine riga: "Newline").
2. Alla prima accensione parte la procedura guidata: nome device
   (senza `_`, `|`, `$` — identico a quello configurato nell'app),
   SSID e password WiFi, chiave di cifratura (min 8 caratteri — identica
   a quella del device nell'app), porta WebSocket (es. 81), IP statico
   opzionale (vuoto = DHCP).
3. La configurazione è salvata in **memoria non volatile** (EEPROM/flash)
   con CRC di integrità: ai riavvii successivi il device parte da solo.
4. Per riconfigurare in qualsiasi momento: digitare `config` + Invio
   sul monitor seriale.

Nell'app: *Dispositivi → + Aggiungi dispositivo* con lo **stesso nome**,
l'IP e la porta dell'ESP e la **stessa chiave**. Il pallino diventa verde
quando la connessione WebSocket è stabilita.

## Dove scrivere il codice applicativo

In fondo allo sketch:

```cpp
void onCommandReceived(const char* command) {
  // command = "param1|param2|...|paramN$" GIÀ decifrato e autenticato.
  // La conferma all'app è già stata inviata automaticamente.
}
```

Per inviare dati all'app in qualunque momento (log, pagina Log del device):

```cpp
comfySend("temperatura|21.5$");
```

## Sicurezza

- Ogni messaggio è cifrato e **autenticato** (AES-256-GCM): messaggi
  manomessi o cifrati con la chiave sbagliata vengono scartati senza
  esporre il contenuto; IV casuale (RNG hardware) per ogni messaggio.
- Il protocollo non include protezione dal **replay**: se rilevante,
  aggiungere un contatore/timestamp nei parametri e verificarlo in
  `onCommandReceived()`.
- La chiave risiede nella flash del device: chi ha accesso fisico può
  estrarla (limite intrinseco della piattaforma).

## Verifica

Il firmware è stato compilato su host con le librerie reali
(rweather/Crypto) e testato in interoperabilità bidirezionale con la
crittografia della web app (WebCrypto): comando → decifratura → conferma
`[nome]_[stringa]`, telemetria, UTF-8, rifiuto di messaggi manomessi,
malformati o con chiave errata, IV mai riutilizzato.
