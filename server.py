#!/usr/bin/env python3
"""Comfy home — server dell'app + sincronizzazione condivisa.

Serve i file statici della web app (cartella comfy-home/) e una piccola
API REST che tiene in comune dispositivi, comandi e log tra tutti i
client (PC e smartphone) della rete locale.

Avvio:            python server.py            (porta 8080)
Porta diversa:    python server.py 9090

I dati sono salvati in comfy-home-data.json accanto a questo file
(fuori dalla cartella servita: non è scaricabile dai client).

API (stesso origin dell'app):
  GET    /api/state        -> {rev, devices, commands, logRevs}
  PUT    /api/devices      -> sostituisce la lista dispositivi
  PUT    /api/commands     -> sostituisce la lista comandi
  GET    /api/log/<id>     -> {rev, entries}
  POST   /api/log/<id>     -> aggiunge una voce di log
  PUT    /api/log/<id>     -> sostituisce il log (migrazione iniziale)
  DELETE /api/log/<id>     -> svuota il log

Nota di sicurezza: l'API non ha autenticazione ed è pensata per una rete
domestica fidata; la configurazione (chiavi comprese) è leggibile da chi
è connesso alla LAN. Non esporre questa porta su Internet.
"""

import json
import os
import re
import sys
import tempfile
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE = Path(__file__).resolve().parent
STATIC_DIR = BASE / "comfy-home"
DATA_FILE = BASE / "comfy-home-data.json"

MAX_BODY = 1024 * 1024          # 1 MB (le icone sono data-URL fino a ~60 KB)
MAX_LIST = 200                  # massimo device/comandi
MAX_LOG = 300                   # voci di log per device
MAX_TEXT = 512                  # lunghezza testo voce di log
ID_RE = re.compile(r"^[a-f0-9]{16}$")

_lock = threading.Lock()
_state = {"rev": 0, "devices": [], "commands": [], "logs": {}, "logRevs": {}}


def _load():
    global _state
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as fp:
            data = json.load(fp)
        if isinstance(data, dict):
            _state = {
                "rev": int(data.get("rev", 0)),
                "devices": data.get("devices", []) or [],
                "commands": data.get("commands", []) or [],
                "logs": data.get("logs", {}) or {},
                "logRevs": data.get("logRevs", {}) or {},
            }
    except FileNotFoundError:
        pass
    except Exception as exc:  # file corrotto: si riparte puliti, senza perderlo
        print(f"Attenzione: {DATA_FILE.name} non leggibile ({exc}); ne creo uno nuovo.")
        try:
            os.replace(DATA_FILE, DATA_FILE.with_suffix(".json.bak"))
        except OSError:
            pass


def _save():
    # scrittura atomica: mai un file mezzo scritto
    fd, tmp = tempfile.mkstemp(dir=str(BASE), prefix=".ch-data-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fp:
            json.dump(_state, fp, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, DATA_FILE)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _clean_str(value, max_len):
    return str(value)[:max_len] if isinstance(value, str) else ""


def _clean_device(d):
    if not isinstance(d, dict) or not ID_RE.match(str(d.get("id", ""))):
        return None
    try:
        port = int(d.get("port"))
        timeout = float(d.get("timeout"))
    except (TypeError, ValueError):
        return None
    if not (1 <= port <= 65535 and 1 <= timeout <= 120):
        return None
    name = _clean_str(d.get("name"), 32).strip()
    host = _clean_str(d.get("host"), 253).strip()
    key = _clean_str(d.get("key"), 128)
    if not name or not host or len(key) < 8:
        return None
    return {"id": d["id"], "name": name, "host": host, "port": port,
            "key": key, "timeout": timeout}


def _clean_command(c):
    if not isinstance(c, dict):
        return None
    if not ID_RE.match(str(c.get("id", ""))) or not ID_RE.match(str(c.get("deviceId", ""))):
        return None
    label = _clean_str(c.get("label"), 40).strip()
    params = c.get("params")
    if not label or not isinstance(params, list) or not (1 <= len(params) <= 16):
        return None
    params = [_clean_str(p, 64).strip() for p in params]
    if any(not p or "|" in p or "$" in p for p in params):
        return None
    icon = c.get("icon", "")
    if not (isinstance(icon, str) and len(icon) <= 61440
            and (icon == "" or re.match(r"^data:image/(png|jpeg);base64,[A-Za-z0-9+/]+=*$", icon))):
        icon = ""
    return {"id": c["id"], "deviceId": c["deviceId"], "label": label,
            "params": params, "icon": icon}


def _clean_entry(e):
    if not isinstance(e, dict):
        return None
    try:
        ts = int(e.get("ts"))
    except (TypeError, ValueError):
        return None
    kind = e.get("kind")
    if kind not in ("tx", "rx", "ok", "fail", "info", "error"):
        kind = "info"
    return {"ts": ts, "kind": kind, "text": _clean_str(e.get("text"), MAX_TEXT)}


def _is_duplicate(entries, entry):
    """Due client connessi allo stesso ESP registrano entrambi le trasmissioni
    spontanee: la stessa voce (tipo+testo) entro 1,5 s viene tenuta una volta."""
    for old in entries[-20:]:
        if (old["kind"] == entry["kind"] and old["text"] == entry["text"]
                and abs(old["ts"] - entry["ts"]) < 1500):
            return True
    return False


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def log_message(self, fmt, *args):  # log essenziale, senza rumore statico
        if "/api/" in (args[0] if args else ""):
            return
        super().log_message(fmt, *args)

    # ---------------- helpers ----------------

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return None
        if length <= 0 or length > MAX_BODY:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    def _log_id(self):
        m = re.match(r"^/api/log/([a-f0-9]{16})$", self.path)
        return m.group(1) if m else None

    # ---------------- routing ----------------

    def do_GET(self):
        if self.path.startswith("/api/"):
            self._api_get()
        else:
            super().do_GET()

    def do_PUT(self):
        if self.path.startswith("/api/"):
            self._api_put()
        else:
            self.send_error(405)

    def do_POST(self):
        if self.path.startswith("/api/"):
            self._api_post()
        else:
            self.send_error(405)

    def do_DELETE(self):
        if self.path.startswith("/api/"):
            self._api_delete()
        else:
            self.send_error(405)

    # ---------------- API ----------------

    def _api_get(self):
        if self.path == "/api/state":
            with _lock:
                self._json({"rev": _state["rev"], "devices": _state["devices"],
                            "commands": _state["commands"], "logRevs": _state["logRevs"]})
            return
        log_id = self._log_id()
        if log_id:
            with _lock:
                self._json({"rev": _state["logRevs"].get(log_id, 0),
                            "entries": _state["logs"].get(log_id, [])})
            return
        self._json({"error": "not found"}, 404)

    def _api_put(self):
        if self.path in ("/api/devices", "/api/commands"):
            data = self._body()
            if not isinstance(data, list) or len(data) > MAX_LIST:
                self._json({"error": "bad request"}, 400)
                return
            clean_fn = _clean_device if self.path.endswith("devices") else _clean_command
            items = [x for x in (clean_fn(d) for d in data) if x]
            key = "devices" if self.path.endswith("devices") else "commands"
            with _lock:
                _state[key] = items
                if key == "devices":
                    # elimina log dei device rimossi
                    ids = {d["id"] for d in items}
                    _state["logs"] = {k: v for k, v in _state["logs"].items() if k in ids}
                    _state["logRevs"] = {k: v for k, v in _state["logRevs"].items() if k in ids}
                _state["rev"] += 1
                _save()
                self._json({"rev": _state["rev"]})
            return
        log_id = self._log_id()
        if log_id:  # sostituzione integrale (migrazione del log locale)
            data = self._body()
            if not isinstance(data, list) or len(data) > MAX_LOG:
                self._json({"error": "bad request"}, 400)
                return
            entries = [x for x in (_clean_entry(e) for e in data) if x]
            entries.sort(key=lambda e: e["ts"])
            with _lock:
                _state["logs"][log_id] = entries[-MAX_LOG:]
                _state["logRevs"][log_id] = _state["logRevs"].get(log_id, 0) + 1
                _save()
                self._json({"rev": _state["logRevs"][log_id]})
            return
        self._json({"error": "not found"}, 404)

    def _api_post(self):
        log_id = self._log_id()
        if not log_id:
            self._json({"error": "not found"}, 404)
            return
        entry = _clean_entry(self._body())
        if not entry:
            self._json({"error": "bad request"}, 400)
            return
        with _lock:
            entries = _state["logs"].setdefault(log_id, [])
            if not _is_duplicate(entries, entry):
                entries.append(entry)
                entries.sort(key=lambda e: e["ts"])
                del entries[:-MAX_LOG]
                _state["logRevs"][log_id] = _state["logRevs"].get(log_id, 0) + 1
                _save()
            self._json({"rev": _state["logRevs"].get(log_id, 0)})

    def _api_delete(self):
        log_id = self._log_id()
        if not log_id:
            self._json({"error": "not found"}, 404)
            return
        with _lock:
            _state["logs"][log_id] = []
            _state["logRevs"][log_id] = _state["logRevs"].get(log_id, 0) + 1
            _save()
            self._json({"rev": _state["logRevs"][log_id]})


def main():
    port = 8080
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print(f"Porta non valida: {sys.argv[1]}")
            sys.exit(1)
    if not STATIC_DIR.is_dir():
        print(f"Cartella dell'app non trovata: {STATIC_DIR}")
        sys.exit(1)
    _load()
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"Comfy home in ascolto su http://0.0.0.0:{port}")
    print(f"Dati condivisi in: {DATA_FILE}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nArresto.")


if __name__ == "__main__":
    main()
