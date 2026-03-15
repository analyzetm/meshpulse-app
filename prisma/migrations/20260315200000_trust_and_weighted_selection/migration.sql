ALTER TABLE "nodes"
    ADD COLUMN "isTrusted" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "trustLevel" TEXT NOT NULL DEFAULT 'community',
    ADD COLUMN "checksToday" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "checksLastHour" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "lastAssignedAt" TIMESTAMP(3),
    ADD COLUMN "validationAccuracy" DOUBLE PRECISION,
    ALTER COLUMN "reputationScore" SET DEFAULT 50;

UPDATE "nodes"
SET "reputationScore" = 50
WHERE "reputationScore" = 0;

ALTER TABLE "check_definitions"
    ADD COLUMN "minReputation" INTEGER,
    ADD COLUMN "maxReputation" INTEGER,
    ADD COLUMN "preferTrusted" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "requireTrusted" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "preferDifferentAsn" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "preferDifferentRegion" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "node_reputation_events" (
    "id" UUID NOT NULL,
    "nodeId" TEXT NOT NULL,
    "executionId" UUID,
    "assignmentId" UUID,
    "eventType" TEXT NOT NULL,
    "scoreDelta" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "node_reputation_events_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "node_reputation_events"
    ADD CONSTRAINT "node_reputation_events_nodeId_fkey"
    FOREIGN KEY ("nodeId") REFERENCES "nodes"("nodeId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "node_reputation_events"
    ADD CONSTRAINT "node_reputation_events_executionId_fkey"
    FOREIGN KEY ("executionId") REFERENCES "check_executions"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "node_reputation_events"
    ADD CONSTRAINT "node_reputation_events_assignmentId_fkey"
    FOREIGN KEY ("assignmentId") REFERENCES "check_assignments"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "node_reputation_events_nodeId_createdAt_idx"
    ON "node_reputation_events"("nodeId", "createdAt");
