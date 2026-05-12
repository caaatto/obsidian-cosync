# CoSync — Live Collaboration für Obsidian

Mehrere Personen editieren gleichzeitig dieselbe Notiz, Änderungen werden über
einen selbstgehosteten Server (CRDT via [Yjs](https://yjs.dev)) konfliktfrei
zusammengeführt. Offline-fähig, mit Cursor-Anzeige der anderen.

Die Markdown-Dateien bleiben normale `.md` im Vault — Suche, Backlinks und Graph
funktionieren weiter.

## Installation via BRAT

Setzt das [BRAT-Plugin](https://github.com/TfTHacker/obsidian42-brat) voraus.

1. **BRAT installieren**: `Settings → Community plugins → Browse → "Obsidian42 - BRAT" → Install + Enable`
2. **CoSync hinzufügen**: `Settings → BRAT → Add Beta plugin`
3. Repo eingeben: `caaatto/obsidian-cosync`
4. Haken bei *Enable after installing the plugin* → BRAT lädt das Release und aktiviert das Plugin.

Updates kommen automatisch, wenn BRAT regelmäßig nach neuen Releases sucht
(oder manuell via `BRAT → Check for updates`).

## Konfiguration

Im neuen Settings-Tab "CoSync" eintragen:

| Feld | Wert |
|---|---|
| **Enabled** | an |
| **Server URL** | bekommst du vom Server-Admin (`wss://…`) |
| **Username** | dein Login — den Namen vereinbarst du vorher mit dem Server-Admin |
| **Password** | min. 8 Zeichen, du wählst frei |
| **Invite code** | einmaliger Code vom Server-Admin (nur bei der allerersten Registrierung nötig) |
| **Display name** | optional — wie du an deinem Cursor erscheinst |
| **Cursor color** | freie Wahl |
| **Vault ID** | bekommst du vom Server-Admin — alle, die den gleichen Wert eintragen, syncen denselben Vault |

**Erste Anmeldung:** Invite-Code eintragen, dann „Register" klicken — legt den
Account an und loggt direkt ein. Der Code ist danach verbraucht. Bei späteren
Logins reicht Username + Passwort, der Code wird nicht mehr gebraucht.

Sessions sind 90 Tage gültig; nach Ablauf einfach erneut „Login".

## Bedienung

- Datei öffnen → Verbindung wird aufgebaut, Cursor der anderen werden sichtbar.
- Tippen → live bei allen anderen.
- Offline arbeiten → läuft weiter (lokaler IndexedDB-Cache); beim Reconnect wird
  automatisch zusammengeführt.

## Build aus den Quellen

```bash
npm install --legacy-peer-deps
npm run build
```

Erzeugt `main.js`. Zum Entwickeln stattdessen `npm run dev` (Watch-Modus).

## Bekannte Einschränkungen

- Datei-Operationen (Umbenennen, Verschieben) werden nicht über CoSync
  propagiert — am besten machen, wenn niemand sonst die Datei offen hat.
- Tokens liegen im Klartext in `<vault>/.obsidian/plugins/obsidian-cosync/data.json`.
  Wer Vault-Zugriff hat, kennt den Token.

## Lizenz

MIT.
