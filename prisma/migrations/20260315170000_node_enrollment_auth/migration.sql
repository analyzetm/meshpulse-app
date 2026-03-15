ALTER TABLE "nodes"
    ADD COLUMN "nodeId" TEXT,
    ADD COLUMN "ownerUserId" TEXT,
    ADD COLUMN "claimTokenHash" TEXT,
    ADD COLUMN "claimTokenUsedAt" TIMESTAMP(3),
    ADD COLUMN "publicKey" TEXT,
    ADD COLUMN "serverPublicKeySentAt" TIMESTAMP(3),
    ADD COLUMN "activatedAt" TIMESTAMP(3),
    ADD COLUMN "agentVersion" TEXT,
    ADD COLUMN "hardwareRaw" JSONB,
    ADD COLUMN "hardwareFingerprint" TEXT,
    ADD COLUMN "region" TEXT,
    ADD COLUMN "reputationScore" INTEGER NOT NULL DEFAULT 0;

UPDATE "nodes"
SET
    "nodeId" = "id"::text,
    "status" = CASE
        WHEN "status" IN ('pending_registration', 'active', 'disabled', 'revoked', 'reverify_required') THEN "status"
        ELSE 'active'
    END,
    "activatedAt" = COALESCE("activatedAt", "createdAt");

ALTER TABLE "nodes"
    ALTER COLUMN "nodeId" SET NOT NULL,
    ALTER COLUMN "status" SET DEFAULT 'pending_registration';

CREATE UNIQUE INDEX "nodes_nodeId_key" ON "nodes"("nodeId");

ALTER TABLE "job_results" DROP CONSTRAINT "job_results_nodeId_fkey";

ALTER TABLE "jobs"
    ALTER COLUMN "assignedNodeId" TYPE TEXT USING "assignedNodeId"::text;

ALTER TABLE "job_results"
    ALTER COLUMN "nodeId" TYPE TEXT USING "nodeId"::text;

ALTER TABLE "job_results"
    ADD CONSTRAINT "job_results_nodeId_fkey"
    FOREIGN KEY ("nodeId") REFERENCES "nodes"("nodeId")
    ON DELETE CASCADE ON UPDATE CASCADE;
