# MeshPulse

MeshPulse ist ein verteiltes Monitoring-System mit einem NestJS-Backend und einem Go-Agenten. Nodes werden vorab provisioniert, registrieren sich einmalig mit Claim-Token, halten anschließend eine persistente WSS-Verbindung zum Backend und führen darüber Monitoring-Aufträge aus.

Aktueller Schwerpunkt des Projekts:

- persistente Agent-Sessions über WSS
- wiederkehrende Checks per Scheduler
- Primary-/Validation-Ausführung mit Konsensbildung
- Persistenz in PostgreSQL
- operative Sichtbarkeit über SQL-Views

## Komponenten

- Backend: NestJS im Repository-Root
- Agent: Go-Client in [agent/](/home/meshpulse/agent)
- Datenbank: PostgreSQL
- Session-/Challenge-Speicher: Redis
- Reverse Proxy / TLS: Caddy

## Architektur

### Backend

Das Backend verwendet:

- NestJS 11
- Prisma
- PostgreSQL
- Redis
- BullMQ
- native WebSockets über `@nestjs/platform-ws` und `ws`

Wichtige Module:

- `src/admin`: Provisionierung und Admin-Testendpunkte
- `src/agent`: HTTP-Registrierung, WSS-Gateway, Result-Verarbeitung
- `src/scheduler`: periodische Planung wiederkehrender Checks
- `src/security`: Claim-Token, Server-Keypair, Challenges
- `src/prisma`: Prisma-Client und Datenbankzugriff
- `src/queues`: älterer asynchroner Result-Pfad über BullMQ

### Agent

Der Agent:

- lädt `.env` und Umgebungsvariablen
- stellt ein persistentes Ed25519-Schlüsselpaar sicher
- registriert sich bei Bedarf automatisch
- verbindet sich per WSS mit `/agent/ws`
- authentifiziert sich per Challenge/Response
- sendet Heartbeats
- empfängt Assignments
- führt aktuell TCP-Checks aus
- sendet Ergebnisse über dieselbe WSS-Verbindung zurück
- verbindet sich bei Abbruch automatisch neu

Ohne Argument startet der Agent automatisch im Modus `run`.

## Datenmodell

### Bestehende Basistabellen

- `nodes`
  - `nodeId`
  - `status`
  - `isOnline`
  - `publicKey`
  - `activatedAt`
  - `lastSeenAt`
  - `hardwareRaw`
  - `region`
  - `reputationScore`
- `jobs`
- `job_results`

`jobs` und `job_results` existieren weiterhin für den älteren bzw. temporären Pfad. Der aktuelle Scheduler- und Validation-Flow läuft primär über die neuen Check-Tabellen.

### Neue Check-Tabellen

- `check_definitions`
  - wiederkehrende Check-Konfiguration
  - `type`
  - `target`
  - `intervalSec`
  - `validationMode`
  - `validationCount`
  - optional `requiredRegion`
  - `isActive`
  - `nextRunAt`
- `check_executions`
  - eine konkrete Ausführung eines `CheckDefinition`
  - `status`
  - `consensusStatus`
- `check_assignments`
  - einzelne Ausführungen pro Node
  - `role = primary | validation`
  - `status = assigned | running | completed | failed`
- `check_results`
  - Ergebnis pro Assignment
  - `status = up | down | timeout | error`
  - `latencyMs`

### SQL-Views

Für die operative Auswertung gibt es zwei Views:

- `check_execution_overview`
  - zeigt Execution, Assignments, Rollen, Nodes, Resultate und Konsens in einer Sicht
- `latest_check_consensus`
  - zeigt pro `CheckDefinition` den letzten bekannten Execution- und Konsensstatus

## Ausführungsmodell

### Primary + Validation

Jeder wiederkehrende Check startet mit genau einem `primary`-Assignment.

Danach gilt:

- `validationMode = never`
  - nach dem Primary-Ergebnis ist die Execution sofort fertig
- `validationMode = always`
  - Validation-Assignments werden immer erstellt
- `validationMode = on_failure`
  - Validation wird nur erstellt, wenn das Primary-Ergebnis nicht `up` ist

Validation-Assignments:

- verwenden dieselbe `executionId`
- haben `role = validation`
- dürfen nie auf den Primary-Node gehen
- dürfen nie auf einen Node gehen, der in derselben Execution schon verwendet wurde
- werden nur auf online Nodes mit aktiver WSS-Session verteilt

Wenn alle Assignments einer Execution abgeschlossen sind, berechnet das Backend den Konsens:

- Mehrheit `up` -> `consensusStatus = up`
- Mehrheit `down` -> `consensusStatus = down`
- ansonsten -> `consensusStatus = mixed`

## Node-Lebenszyklus

Node-Zustände:

- `pending_registration`
- `active`

Presence:

- `isOnline = false`
- `isOnline = true`

Ein Node muss für aktive Planung:

- `status = active` haben
- `isOnline = true` haben
- eine aktive authentifizierte WSS-Session besitzen

## Installation

### Voraussetzungen

- Node.js und npm
- PostgreSQL
- Redis
- Go

### Backend konfigurieren

Beispiel aus [.env.example](/home/meshpulse/.env.example):

```env
PORT=3000
DATABASE_URL=postgresql://meshpulse_user:password@localhost:5432/meshpulse?schema=public
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
SERVER_KEY_PATH=.secrets/server-ed25519.json
AUTH_CHALLENGE_TTL_SECONDS=300
```

Bedeutung:

- `PORT`: HTTP-Port des Backends
- `DATABASE_URL`: PostgreSQL für Prisma
- `REDIS_HOST`, `REDIS_PORT`: Redis für Challenges und BullMQ
- `SERVER_KEY_PATH`: persistentes Server-Keypair
- `AUTH_CHALLENGE_TTL_SECONDS`: Gültigkeit einer Auth-Challenge

### Backend starten

```bash
npm install
npm run prisma:generate
npm run prisma:migrate:deploy
npm run start
```

Für Entwicklung:

```bash
npm run dev
```

### Agent konfigurieren

Beispiel aus [agent/.env.example](/home/meshpulse/agent/.env.example):

```env
NODE_ID=node-demo-001
NODE_CLAIM_TOKEN=replace-me
API_BASE_URL=https://api.pulseofmesh.app
AGENT_STATE_DIR=./data
AGENT_VERSION=0.1.0
```

Bedeutung:

- `NODE_ID`: Node-Kennung
- `NODE_CLAIM_TOKEN`: Bootstrap-Token für die Erstregistrierung
- `API_BASE_URL`: Basis-URL des Backends
- `AGENT_STATE_DIR`: lokaler Zustand des Agenten
- `AGENT_VERSION`: gemeldete Agent-Version

### Agent starten

Im Agent-Verzeichnis:

```bash
go run . register
go run . auth-test
go run . run
go run .
```

Aktuelles Verhalten:

- `register`: manuelle Erstregistrierung
- `auth-test`: HTTP-Challenge-Test
- `run`: vollständiger Betriebsmodus
- ohne Argument: automatischer Fallback auf `run`

## Registrierungs- und Sitzungsfluss

### Registrierung

1. Admin provisioniert einen Node über `POST /admin/nodes`.
2. Der Agent erhält `NODE_ID` und `NODE_CLAIM_TOKEN`.
3. Der Agent erzeugt lokal ein Ed25519-Keypair.
4. Der Agent ruft `POST /agent/register` auf.
5. Das Backend speichert Public Key und Hardwaredaten und setzt den Node auf `active`.

### WSS-Authentifizierung

Agent -> Server:

```json
{
  "type": "hello",
  "nodeId": "node-demo-001"
}
```

Server -> Agent:

```json
{
  "type": "challenge",
  "challenge": "...",
  "serverPublicKey": "..."
}
```

Agent -> Server:

```json
{
  "type": "auth",
  "nodeId": "node-demo-001",
  "signature": "..."
}
```

Server -> Agent:

```json
{
  "type": "auth_ok"
}
```

Nach erfolgreicher Authentifizierung folgen Heartbeats:

```json
{
  "type": "heartbeat",
  "nodeId": "node-demo-001",
  "ts": 1234567890
}
```

Server -> Agent:

```json
{
  "type": "heartbeat_ack"
}
```

## Scheduler-Flow

Der Scheduler läuft aktuell alle 10 Sekunden.

Ablauf pro fälliger `CheckDefinition`:

1. `check_definitions.nextRunAt <= now`
2. passende Nodes suchen:
   - `status = active`
   - `isOnline = true`
   - aktive WSS-Session
   - `requiredRegion` passend, falls gesetzt
   - Node nicht bereits durch laufende Check-Assignments belegt
3. `check_execution` anlegen
4. genau ein `check_assignment` mit `role = primary` anlegen
5. Assignment per WSS versenden
6. `nextRunAt = now + intervalSec`

Wenn kein passender Node existiert:

- es wird nichts gesendet
- ein Logeintrag wird erzeugt
- der Check wird im nächsten Scheduler-Zyklus erneut versucht

## Assignment- und Result-Protokoll

### Server -> Agent

```json
{
  "type": "assignment",
  "executionId": "...",
  "assignmentId": "...",
  "target": "mymafi.app:443",
  "checkType": "tcp",
  "role": "primary"
}
```

oder:

```json
{
  "type": "assignment",
  "executionId": "...",
  "assignmentId": "...",
  "target": "mymafi.app:443",
  "checkType": "tcp",
  "role": "validation"
}
```

### Agent -> Server: Ack

```json
{
  "type": "assignment_ack",
  "nodeId": "...",
  "executionId": "...",
  "assignmentId": "..."
}
```

### Agent -> Server: Result

```json
{
  "type": "result",
  "nodeId": "...",
  "executionId": "...",
  "assignmentId": "...",
  "resultStatus": "up",
  "latencyMs": 42
}
```

Unterstützte Ergebniszustände:

- `up`
- `down`
- `timeout`
- `error`

## Aktuelle Check-Ausführung im Agenten

Der Agent unterstützt aktuell TCP-Checks:

- Ziel: `host:port`
- Timeout: kurz und fest im Agent-Code
- Ergebnis:
  - Verbindungsaufbau erfolgreich -> `up`
  - Timeout -> `timeout`
  - anderer Fehler -> `error`

## Admin-Endpunkte

### `POST /admin/nodes`

Provisioniert einen Node und gibt ein Claim-Token zurück.

Beispiel:

```json
{
  "nodeId": "node-demo-001"
}
```

### `POST /admin/test-assignment`

Temporärer Testendpunkt für sofortige Live-Zustellung an einen verbundenen Node.

Beispiel:

```json
{
  "nodeId": "node-demo-001",
  "target": "mymafi.app:443",
  "checkType": "tcp"
}
```

### `POST /admin/check-definitions`

Legt eine wiederkehrende CheckDefinition an.

Beispiel:

```json
{
  "type": "tcp",
  "target": "mymafi.app:443",
  "intervalSec": 60,
  "validationMode": "on_failure",
  "validationCount": 2
}
```

Optional:

- `requiredRegion`

Gültige `validationMode`-Werte:

- `on_failure`
- `always`
- `never`

## Agent-Endpunkte

### `POST /agent/register`

Registriert einen vorprovisionierten Node.

Pflichtfelder:

- `nodeId`
- `claimToken`
- `publicKey`

Optionale Felder:

- `agentVersion`
- `hardware`

### `POST /agent/auth/challenge`

Gibt eine kurzlebige HTTP-Challenge zurück.

### `POST /agent/auth/verify`

Verifiziert die HTTP-Challenge.

### `POST /agent/jobs/pull`

Älterer Pull-Pfad für Jobs. Der aktuelle operative Flow läuft primär über WSS-Assignments.

### `POST /agent/jobs/result`

Älterer Result-Pfad über Queue/BullMQ.

## Wichtige Logs

Scheduler / Check-Flow:

- `check definition created`
- `scheduler cycle`
- `due check found`
- `node selected`
- `primary assignment created`
- `validation triggered`
- `validation assignments created`
- `consensus decision`

WSS / Agent:

- `socket connected`
- `hello received`
- `challenge sent`
- `auth verified`
- `heartbeat received`
- `socket disconnected`
- `assignment received`
- `result sent`

Persistenz:

- `job marked running`
- `job result stored`
- `job marked finished`
- `check result stored`

## Datenbankabfragen

### Primary und Validation je Execution sehen

```sql
select
  "executionId",
  "assignmentRole",
  "assignmentNodeId",
  "resultStatus",
  "consensusStatus"
from "check_execution_overview"
order by "executionCreatedAt" desc, "assignmentCreatedAt" asc;
```

### Letzten Konsens pro CheckDefinition sehen

```sql
select
  "checkDefinitionId",
  target,
  "executionId",
  "consensusStatus"
from "latest_check_consensus"
order by "executionCreatedAt" desc nulls last;
```

### Vollständige Übersicht pro Assignment

```sql
select
  "checkDefinitionId",
  "checkType",
  target,
  "executionId",
  "executionStatus",
  "consensusStatus",
  "assignmentId",
  "assignmentRole",
  "assignmentNodeId",
  "assignmentStatus",
  "resultStatus",
  "resultLatencyMs"
from "check_execution_overview"
order by "executionCreatedAt" desc, "assignmentCreatedAt" asc;
```

## Deployment mit Caddy

Beispiel aus [deploy/Caddyfile](/home/meshpulse/deploy/Caddyfile):

```caddy
{
	email Manuel.Kammermann@hotmail.de
}

api.pulseofmesh.app {
	reverse_proxy /agent/ws 127.0.0.1:3000
	reverse_proxy 127.0.0.1:3000
}
```

Caddy terminiert TLS und leitet WebSocket-Upgrades für `/agent/ws` an das Backend weiter.

## Sicherheit

Enthaltene Sicherheitsmechanismen:

- einmalige Claim-Tokens für die Erstregistrierung
- Speicherung des Claim-Tokens nur als SHA-256-Hash
- Ed25519-basierte Challenge/Response-Authentifizierung
- persistenter Server-Signing-Key unter `SERVER_KEY_PATH`
- Redis-basierte Challenges mit TTL
- WSS-Authentifizierung mit signierten Challenges

Wichtige Hinweise:

- die Server-Keydatei darf in produktiven Umgebungen nicht verloren gehen
- Claim-Tokens sind Bootstrap-Geheimnisse
- Admin-Endpunkte sind aktuell noch nicht zusätzlich autorisiert

## Testen

### Lokal

1. PostgreSQL und Redis starten.
2. Migrationen anwenden:

```bash
npm run prisma:migrate:deploy
```

3. Backend starten:

```bash
npm run start
```

4. Node provisionieren:

```bash
curl -sS -X POST http://127.0.0.1:3000/admin/nodes \
  -H 'content-type: application/json' \
  -d '{"nodeId":"node-demo-001"}'
```

5. Agent starten:

```bash
cd agent
go run .
```

6. CheckDefinition anlegen:

```bash
curl -sS -X POST http://127.0.0.1:3000/admin/check-definitions \
  -H 'content-type: application/json' \
  -d '{"type":"tcp","target":"mymafi.app:443","intervalSec":60,"validationMode":"on_failure","validationCount":2}'
```

7. Ergebnis in den Views prüfen:

```sql
select * from "check_execution_overview";
select * from "latest_check_consensus";
```

### Gegen `api.pulseofmesh.app`

1. gültigen Node provisionieren
2. `.env` mit `API_BASE_URL=https://api.pulseofmesh.app` setzen
3. Agent starten
4. im Backend-Log WSS-Handshake, Heartbeats und Scheduler-Logs prüfen
5. in PostgreSQL die Views `check_execution_overview` und `latest_check_consensus` prüfen

## Entwicklungsstand

Der aktuelle Stand deckt ab:

- Node-Provisionierung und Registrierung
- WSS-Authentifizierung und Heartbeats
- wiederkehrende Checks per Scheduler
- Primary-/Validation-Flow
- Result-Persistenz
- Konsensbildung
- SQL-Views zur operativen Auswertung

Noch offen bzw. bewusst minimal gehalten:

- ausgereiftes Overload-Modell
- Reputation/Health-Scoring
- umfangreiche API-Autorisierung
- feinere Scheduling-Strategien
- zusätzliche Check-Typen neben TCP
- Testsuite und erweiterte Observability
