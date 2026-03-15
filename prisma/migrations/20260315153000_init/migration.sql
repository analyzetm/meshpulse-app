-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "meshpulse";

-- CreateEnum
CREATE TYPE "meshpulse"."JobStatus" AS ENUM ('pending', 'completed', 'failed');

-- CreateTable
CREATE TABLE "meshpulse"."job_results" (
    "id" UUID NOT NULL,
    "nodeId" UUID,
    "jobId" UUID,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meshpulse"."jobs" (
    "id" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "status" "meshpulse"."JobStatus" NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meshpulse"."nodes" (
    "id" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nodes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "job_results_jobId_idx" ON "meshpulse"."job_results"("jobId" ASC);

-- CreateIndex
CREATE INDEX "job_results_nodeId_idx" ON "meshpulse"."job_results"("nodeId" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "jobs_externalId_key" ON "meshpulse"."jobs"("externalId" ASC);

-- CreateIndex
CREATE INDEX "jobs_status_idx" ON "meshpulse"."jobs"("status" ASC);

-- CreateIndex
CREATE UNIQUE INDEX "nodes_externalId_key" ON "meshpulse"."nodes"("externalId" ASC);

-- AddForeignKey
ALTER TABLE "meshpulse"."job_results" ADD CONSTRAINT "job_results_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "meshpulse"."jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meshpulse"."job_results" ADD CONSTRAINT "job_results_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "meshpulse"."nodes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
