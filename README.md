# MeshPulse

MeshPulse ist ein verteiltes Monitoring-System mit zwei zentralen Komponenten:

- Einem NestJS-Backend im Repository-Root
- Einem Go-Agenten in [agent/](/home/meshpulse/agent)

Das Backend verwaltet Nodes, Jobs und Ergebnisse. Der Agent registriert sich mit einem einmaligen Claim-Token, authentifiziert sich per Ed25519-Challenge/Response und meldet Ergebnisse an das Backend zur asynchronen Verarbeitung.

## Architektur

### Backend

Das Backend basiert auf:

- NestJS 11
- Prisma
- PostgreSQL
- Redis
- BullMQ

Zentrale Module:

- `src/admin`: Provisionierung von Nodes und Erzeugung von Jobs
- `src/agent`: Registrierung, Authentifizierung, Job-Abruf und Ergebnisannahme
- `src/security`: Challenge-Speicher, Claim-Token-Hashing, Signaturprüfung und Server-Schlüsselverwaltung
- `src/queues`: Asynchrone Verarbeitung eingehender Agent-Ergebnisse
- `src/prisma`: Prisma-Integration

### Agent

Der Agent ist ein eigenständiger Go-Client, der:

- lokal ein Ed25519-Schlüsselpaar erzeugt und persistent speichert
- Hardware-Metadaten sammelt
- sich mit `nodeId` und Claim-Token beim Backend registriert
- eine Challenge vom Backend abholt und lokal signiert
- den Server-Public-Key im lokalen State-Verzeichnis ablegt

Der aktuelle `run`-Befehl führt derzeit den Authentifizierungstest aus und bestätigt damit die Challenge/Response-Kette. Eine fortlaufende Polling-Schleife für Jobs ist im aktuellen Stand noch nicht implementiert.

## Datenmodell

Das Prisma-Schema definiert aktuell drei Tabellen:

- `nodes`
  - eindeutige `nodeId`
  - Zustandsfelder wie `status`, `activatedAt`, `lastSeenAt`
  - `claimTokenHash` für die einmalige Inbetriebnahme
  - `publicKey` des Agenten
  - `hardwareRaw` für gemeldete Hardware-Daten
- `jobs`
  - `type`, `target`, `status`
  - optionale Zuordnung über `assignedNodeId`
- `job_results`
  - Referenz auf Job und Node
  - `status`, optionale `latencyMs`
  - Zeitstempel `createdAt`

Der Backend-Statusfluss ist aktuell:

- Node: `pending_registration` -> `active`
- Job: `pending` -> `running` -> `finished`

## Voraussetzungen

Für die lokale Entwicklung werden benötigt:

- Node.js und npm
- PostgreSQL
- Redis
- Go

Installierte Node-Abhängigkeiten liegen im aktuellen Workspace bereits vor, sollten lokal aber regulär mit `npm install` hergestellt werden.

## Installation und Start

### 1. Backend konfigurieren

Beispiel-Konfiguration aus [.env.example](/home/meshpulse/.env.example):

```env
PORT=3000
DATABASE_URL=postgresql://meshpulse_user:password@localhost:5432/meshpulse?schema=public
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
SERVER_KEY_PATH=.secrets/server-ed25519.json
AUTH_CHALLENGE_TTL_SECONDS=300
```

Bedeutung der Variablen:

- `PORT`: HTTP-Port des NestJS-Backends
- `DATABASE_URL`: PostgreSQL-Verbindungsstring für Prisma
- `REDIS_HOST` / `REDIS_PORT`: Redis für Challenge-Speicherung und BullMQ
- `SERVER_KEY_PATH`: Pfad zur persistenten Server-Ed25519-Keydatei
- `AUTH_CHALLENGE_TTL_SECONDS`: Gültigkeit einer Auth-Challenge in Sekunden

### 2. Backend-Abhängigkeiten und Prisma

Verfügbare npm-Skripte aus [package.json](/home/meshpulse/package.json):

```bash
npm run dev
npm run build
npm run prisma:generate
npm run prisma:migrate:dev
npm run prisma:migrate:deploy
npm run prisma:migrate:status
npm run prisma:push
```

Typischer lokaler Ablauf:

```bash
npm install
npm run prisma:generate
npm run prisma:migrate:dev
npm run dev
```

Das Backend startet standardmäßig auf Port `3000`.

### 3. Agent konfigurieren

Beispiel-Konfiguration aus [agent/.env.example](/home/meshpulse/agent/.env.example):

```env
NODE_ID=node-demo-001
NODE_CLAIM_TOKEN=replace-me
API_BASE_URL=https://api.pulseofmesh.app
AGENT_STATE_DIR=./data
```

Bedeutung:

- `NODE_ID`: logische Kennung des Agenten
- `NODE_CLAIM_TOKEN`: einmaliges Token aus der Node-Provisionierung
- `API_BASE_URL`: Basis-URL des Backends
- `AGENT_STATE_DIR`: lokales Verzeichnis für Schlüssel und zwischengespeicherte Serverdaten

### 4. Agent starten

Im Agent-Verzeichnis:

```bash
go run . register
go run . auth-test
go run . run
```

Aktuelles Verhalten:

- `register`: registriert einen vorprovisionierten Node und speichert den Server-Public-Key
- `auth-test`: fordert eine Challenge an, signiert sie lokal und verifiziert die Authentifizierung
- `run`: führt derzeit denselben Authentifizierungsablauf wie `auth-test` aus

## API-Überblick

### Admin-Endpunkte

#### `POST /admin/nodes`

Legt einen Node vorab an und erzeugt ein Claim-Token.

Beispiel-Request:

```json
{
  "nodeId": "node-demo-001"
}
```

Beispiel-Response:

```json
{
  "ok": true,
  "nodeId": "node-demo-001",
  "claimToken": "..."
}
```

Wichtig:

- `nodeId` muss eindeutig sein
- das Claim-Token wird nur bei der Provisionierung im Klartext zurückgegeben
- im Backend wird nur der SHA-256-Hash gespeichert

#### `POST /admin/jobs`

Erzeugt einen neuen Job.

Beispiel-Request:

```json
{
  "type": "ping",
  "target": "1.1.1.1"
}
```

Beispiel-Response:

```json
{
  "id": "...",
  "type": "ping",
  "target": "1.1.1.1",
  "status": "pending",
  "createdAt": "..."
}
```

### Agent-Endpunkte

#### `POST /agent/register`

Registriert einen vorprovisionierten Node.

Request-Felder:

- `nodeId`
- `claimToken`
- `publicKey` als Base64-codierter DER/SPKI Public Key
- optional `agentVersion`
- optional `hardware`

Erfolgsantwort:

```json
{
  "ok": true,
  "registered": true,
  "serverPublicKey": "..."
}
```

Effekte im Backend:

- Node-Status wird auf `active` gesetzt
- Claim-Token wird als verwendet markiert und entfernt
- Agent-Public-Key und Hardwaredaten werden gespeichert
- `lastSeenAt`, `activatedAt` und `serverPublicKeySentAt` werden gesetzt

#### `POST /agent/auth/challenge`

Fordert eine zeitlich begrenzte Auth-Challenge an.

Request:

```json
{
  "nodeId": "node-demo-001"
}
```

Response:

```json
{
  "ok": true,
  "challenge": "...",
  "serverPublicKey": "..."
}
```

Die Challenge wird in Redis unter einem Node-spezifischen Schlüssel gespeichert.

#### `POST /agent/auth/verify`

Verifiziert die vom Agenten signierte Challenge.

Request:

```json
{
  "nodeId": "node-demo-001",
  "signature": "..."
}
```

Bei Erfolg:

```json
{
  "ok": true,
  "authenticated": true
}
```

Intern:

- das Backend lädt den gespeicherten Agent-Public-Key
- die Signatur wird gegen die Challenge geprüft
- die Challenge wird nach der Prüfung gelöscht
- `lastSeenAt` wird aktualisiert

#### `POST /agent/jobs/pull`

Fordert den ältesten offenen Job an.

Request:

```json
{
  "nodeId": "node-demo-001"
}
```

Response ohne verfügbaren Job:

```json
{
  "job": null
}
```

Response mit Job:

```json
{
  "job": {
    "id": "...",
    "type": "ping",
    "target": "1.1.1.1",
    "status": "running",
    "createdAt": "...",
    "assignedNodeId": "node-demo-001"
  }
}
```

Die Zuordnung erfolgt transaktional. Das Backend versucht mehrfach, einen noch offenen Job atomar auf `running` zu setzen.

#### `POST /agent/jobs/result`

Nimmt ein Ergebnis entgegen und legt es zunächst in einer BullMQ-Queue ab.

Beispiel-Request:

```json
{
  "jobId": "...",
  "nodeId": "node-demo-001",
  "status": "ok",
  "latencyMs": 24
}
```

Direkte Response:

```json
{
  "ok": true,
  "queued": true
}
```

Asynchrone Verarbeitung in `AgentResultsProcessor`:

- Validierung des Payloads
- Prüfung, ob Node und Job existieren
- Persistenz eines `job_results`-Eintrags
- Setzen von `nodes.lastSeenAt`
- Rücksetzung des Node-Status auf `active`
- Setzen des Job-Status auf `finished`

## Sicherheit

Die aktuelle Implementierung enthält folgende Sicherheitsmechanismen:

- einmalige Claim-Tokens für die Erstregistrierung
- Speicherung des Claim-Tokens nur als SHA-256-Hash
- Ed25519-basierte Challenge/Response-Authentifizierung
- serverseitig persistenter Ed25519-Schlüssel unter `SERVER_KEY_PATH`
- Redis-basierte Challenges mit TTL

Wichtige operative Hinweise:

- Die Server-Keydatei ist zustandsbehaftet und darf in produktiven Umgebungen nicht verloren gehen, wenn der Public Key stabil bleiben soll.
- Das Claim-Token ist ein Bootstrap-Geheimnis und sollte nur über sichere Kanäle verteilt werden.
- Die aktuellen Admin-Endpunkte enthalten im gezeigten Code noch keine zusätzliche Zugriffskontrolle.

## Dateien und Laufzeitdaten

Wichtige Pfade:

- [src/](/home/meshpulse/src): NestJS-Quellcode
- [prisma/schema.prisma](/home/meshpulse/prisma/schema.prisma): Datenmodell
- [agent/main.go](/home/meshpulse/agent/main.go): Go-Agent
- [deploy/Caddyfile](/home/meshpulse/deploy/Caddyfile): Beispiel für HTTPS-Reverse-Proxy
- `.secrets/server-ed25519.json`: Server-Keydatei, wird lokal erzeugt
- `agent/data/`: Standard-State-Verzeichnis des Agenten

Der Agent legt dort typischerweise ab:

- `agent_private_key.pem`
- `agent_public_key.pem`
- `server_public_key.txt`

## Deployment mit Caddy

Ein Beispiel liegt in [deploy/Caddyfile](/home/meshpulse/deploy/Caddyfile):

```caddy
{
	email Manuel.Kammermann@hotmail.de
}

api.pulseofmesh.app {
	reverse_proxy 127.0.0.1:3000
}
```

Das Beispiel zeigt einen Reverse Proxy auf das lokal laufende Backend. Für produktive Setups müssen zusätzlich Firewall, Prozessmanagement, Datenbank-Backups, Redis-Betrieb und Secret-Handling sauber abgesichert werden.

## Entwicklungsstand und bekannte Lücken

Der aktuelle Repository-Stand deckt die Kernpfade für Provisionierung, Registrierung, Authentifizierung und Ergebnisannahme ab. Noch nicht vollständig ausgebaut sind unter anderem:

- dauerhafter Agent-Lauf mit Job-Polling und echter Ausführung
- feinere Statusmodelle für Fehler- und Retry-Fälle
- API-Authentisierung bzw. Autorisierung für Admin-Endpunkte
- Tests, Observability und strukturierte Produktionskonfiguration

## Kurzablauf für einen neuen Node

1. Admin ruft `POST /admin/nodes` auf und erhält `claimToken`.
2. Agent wird mit `NODE_ID` und `NODE_CLAIM_TOKEN` konfiguriert.
3. Agent führt `register` aus und hinterlegt seinen Public Key beim Backend.
4. Agent fordert eine Challenge an und bestätigt sie per `auth-test` oder `run`.
5. Admin erzeugt Jobs über `POST /admin/jobs`.
6. Agent ruft Jobs über `POST /agent/jobs/pull` ab.
7. Agent sendet Resultate an `POST /agent/jobs/result`.
8. BullMQ verarbeitet das Ergebnis asynchron und persistiert es in PostgreSQL.
