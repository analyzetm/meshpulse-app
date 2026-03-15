-- DropForeignKey
ALTER TABLE "meshpulse"."job_results" DROP CONSTRAINT "job_results_jobId_fkey";

-- DropForeignKey
ALTER TABLE "meshpulse"."job_results" DROP CONSTRAINT "job_results_nodeId_fkey";

-- DropTable
DROP TABLE "meshpulse"."job_results";

-- DropTable
DROP TABLE "meshpulse"."jobs";

-- DropTable
DROP TABLE "meshpulse"."nodes";

-- DropEnum
DROP TYPE "meshpulse"."JobStatus";

-- CreateTable
CREATE TABLE "meshpulse"."nodes" (
    "id" UUID NOT NULL,
    "nodeKey" TEXT,
    "version" TEXT,
    "status" TEXT NOT NULL DEFAULT 'online',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "nodes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meshpulse"."jobs" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedNodeId" UUID,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meshpulse"."job_results" (
    "id" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "nodeId" UUID NOT NULL,
    "status" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_results_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "meshpulse"."job_results" ADD CONSTRAINT "job_results_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "meshpulse"."jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meshpulse"."job_results" ADD CONSTRAINT "job_results_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "meshpulse"."nodes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
