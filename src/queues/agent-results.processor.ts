import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

import { PrismaService } from '../prisma/prisma.service';
import { AGENT_RESULTS_QUEUE } from './queue.constants';

@Processor(AGENT_RESULTS_QUEUE)
export class AgentResultsProcessor extends WorkerHost {
  private readonly logger = new Logger(AgentResultsProcessor.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async process(job: Job<Record<string, unknown>>) {
    this.logger.log(
      `Started processing job ${job.id} from ${AGENT_RESULTS_QUEUE}`
    );

    try {
      const result = this.parseResultPayload(job.data);

      if (!result) {
        this.logger.warn(
          `Invalid agent result payload: ${JSON.stringify(job.data)}`
        );
        return;
      }

      const [node, persistedJob] = await Promise.all([
        this.prisma.node.findUnique({
          where: {
            nodeId: result.nodeId
          }
        }),
        this.prisma.job.findUnique({
          where: {
            id: result.jobId
          }
        })
      ]);

      if (!node) {
        this.logger.warn(`Skipping job result: node ${result.nodeId} was not found`);
        return;
      }

      if (!persistedJob) {
        this.logger.warn(`Skipping job result: job ${result.jobId} was not found`);
        return;
      }

      await this.prisma.jobResult.create({
        data: {
          jobId: result.jobId,
          nodeId: result.nodeId,
          status: result.status,
          latencyMs: result.latencyMs
        }
      });

      await Promise.all([
        this.prisma.node.update({
          where: {
            nodeId: result.nodeId
          },
          data: {
            lastSeenAt: new Date(),
            status: 'active'
          }
        }),
        this.prisma.job.update({
          where: {
            id: result.jobId
          },
          data: {
            status: 'finished'
          }
        })
      ]);

      this.logger.log(`Marked job ${result.jobId} as finished`);
    } finally {
      this.logger.log(
        `Finished processing job ${job.id} from ${AGENT_RESULTS_QUEUE}`
      );
    }
  }

  private parseResultPayload(payload: Record<string, unknown>) {
    const jobId = typeof payload.jobId === 'string' ? payload.jobId : undefined;
    const nodeId = typeof payload.nodeId === 'string' ? payload.nodeId : undefined;
    const status = typeof payload.status === 'string' ? payload.status : undefined;
    const latencyMs =
      typeof payload.latencyMs === 'number' ? payload.latencyMs : undefined;

    if (!jobId || !nodeId || !status) {
      return null;
    }

    return {
      jobId,
      nodeId,
      status,
      latencyMs
    };
  }
}
