ALTER TABLE "check_definitions"
    ADD COLUMN "validationMode" TEXT NOT NULL DEFAULT 'on_failure',
    ADD COLUMN "validationCount" INTEGER NOT NULL DEFAULT 2,
    ADD COLUMN "requiredRegion" TEXT;

CREATE TABLE "check_executions" (
    "id" UUID NOT NULL,
    "checkDefinitionId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "consensusStatus" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "check_executions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "check_assignments" (
    "id" UUID NOT NULL,
    "executionId" UUID NOT NULL,
    "nodeId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'assigned',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "check_assignments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "check_results" (
    "id" UUID NOT NULL,
    "executionId" UUID NOT NULL,
    "assignmentId" UUID NOT NULL,
    "nodeId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "check_results_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "check_results_assignmentId_key" ON "check_results"("assignmentId");

ALTER TABLE "check_executions"
    ADD CONSTRAINT "check_executions_checkDefinitionId_fkey"
    FOREIGN KEY ("checkDefinitionId") REFERENCES "check_definitions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "check_assignments"
    ADD CONSTRAINT "check_assignments_executionId_fkey"
    FOREIGN KEY ("executionId") REFERENCES "check_executions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "check_assignments"
    ADD CONSTRAINT "check_assignments_nodeId_fkey"
    FOREIGN KEY ("nodeId") REFERENCES "nodes"("nodeId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "check_results"
    ADD CONSTRAINT "check_results_executionId_fkey"
    FOREIGN KEY ("executionId") REFERENCES "check_executions"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "check_results"
    ADD CONSTRAINT "check_results_assignmentId_fkey"
    FOREIGN KEY ("assignmentId") REFERENCES "check_assignments"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "check_results"
    ADD CONSTRAINT "check_results_nodeId_fkey"
    FOREIGN KEY ("nodeId") REFERENCES "nodes"("nodeId")
    ON DELETE CASCADE ON UPDATE CASCADE;
