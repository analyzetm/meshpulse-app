DELETE FROM "node_reputation_events" AS duplicate
USING "node_reputation_events" AS keeper
WHERE duplicate."assignmentId" IS NOT NULL
  AND keeper."assignmentId" IS NOT NULL
  AND duplicate."assignmentId" = keeper."assignmentId"
  AND duplicate."eventType" = keeper."eventType"
  AND duplicate."createdAt" < keeper."createdAt";

DELETE FROM "node_reputation_events" AS duplicate
USING "node_reputation_events" AS keeper
WHERE duplicate."assignmentId" IS NOT NULL
  AND keeper."assignmentId" IS NOT NULL
  AND duplicate."assignmentId" = keeper."assignmentId"
  AND duplicate."eventType" = keeper."eventType"
  AND duplicate."createdAt" = keeper."createdAt"
  AND duplicate."id" < keeper."id";

CREATE UNIQUE INDEX "node_reputation_events_assignmentId_eventType_key"
    ON "node_reputation_events"("assignmentId", "eventType");

WITH per_node AS (
    SELECT
        n."nodeId",
        GREATEST(0, LEAST(100, 50 + COALESCE(SUM(e."scoreDelta"), 0))) AS "recomputedScore"
    FROM "nodes" n
    LEFT JOIN "node_reputation_events" e
        ON e."nodeId" = n."nodeId"
    GROUP BY n."nodeId"
)
UPDATE "nodes" AS n
SET "reputationScore" = per_node."recomputedScore"
FROM per_node
WHERE n."nodeId" = per_node."nodeId";
