import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Prisma } from '@prisma/client';
import { Job } from 'bullmq';

import { PrismaService } from '../prisma/prisma.service';

@Processor('agent-results')
export class AgentResultsProcessor extends WorkerHost {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<Record<string, unknown>>) {
    console.log('agent-results payload:', job.data);

    const nodeExternalId =
      typeof job.data.nodeId === 'string' ? job.data.nodeId : undefined;
    const jobExternalId =
      typeof job.data.jobId === 'string' ? job.data.jobId : undefined;

    const [node, persistedJob] = await Promise.all([
      nodeExternalId
        ? this.prisma.node.findUnique({
            where: {
              externalId: nodeExternalId
            }
          })
        : Promise.resolve(null),
      jobExternalId
        ? this.prisma.job.findUnique({
            where: {
              externalId: jobExternalId
            }
          })
        : Promise.resolve(null)
    ]);

    await this.prisma.jobResult.create({
      data: {
        nodeId: node?.id,
        jobId: persistedJob?.id,
        payload: job.data as Prisma.InputJsonValue
      }
    });

    if (persistedJob) {
      await this.prisma.job.update({
        where: {
          id: persistedJob.id
        },
        data: {
          status: 'completed'
        }
      });
    }
  }
}
