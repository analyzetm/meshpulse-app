CREATE OR REPLACE VIEW "check_execution_overview" AS
SELECT
    cd."id" AS "checkDefinitionId",
    cd."type" AS "checkType",
    cd."target" AS "target",
    cd."intervalSec" AS "intervalSec",
    cd."validationMode" AS "validationMode",
    cd."validationCount" AS "validationCount",
    cd."requiredRegion" AS "requiredRegion",
    ce."id" AS "executionId",
    ce."status" AS "executionStatus",
    ce."consensusStatus" AS "consensusStatus",
    ce."createdAt" AS "executionCreatedAt",
    ca."id" AS "assignmentId",
    ca."role" AS "assignmentRole",
    ca."status" AS "assignmentStatus",
    ca."nodeId" AS "assignmentNodeId",
    ca."createdAt" AS "assignmentCreatedAt",
    cr."id" AS "resultId",
    cr."status" AS "resultStatus",
    cr."latencyMs" AS "resultLatencyMs",
    cr."createdAt" AS "resultCreatedAt"
FROM "check_definitions" cd
JOIN "check_executions" ce
    ON ce."checkDefinitionId" = cd."id"
LEFT JOIN "check_assignments" ca
    ON ca."executionId" = ce."id"
LEFT JOIN "check_results" cr
    ON cr."assignmentId" = ca."id";

CREATE OR REPLACE VIEW "latest_check_consensus" AS
SELECT DISTINCT ON (cd."id")
    cd."id" AS "checkDefinitionId",
    cd."type" AS "checkType",
    cd."target" AS "target",
    cd."intervalSec" AS "intervalSec",
    cd."validationMode" AS "validationMode",
    cd."validationCount" AS "validationCount",
    cd."requiredRegion" AS "requiredRegion",
    ce."id" AS "executionId",
    ce."status" AS "executionStatus",
    ce."consensusStatus" AS "consensusStatus",
    ce."createdAt" AS "executionCreatedAt"
FROM "check_definitions" cd
LEFT JOIN "check_executions" ce
    ON ce."checkDefinitionId" = cd."id"
ORDER BY cd."id", ce."createdAt" DESC NULLS LAST;
