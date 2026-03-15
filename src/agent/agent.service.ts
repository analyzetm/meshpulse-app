import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

import { PrismaService } from '../prisma/prisma.service';
import {
  AGENT_RESULT_JOB_NAME,
  AGENT_RESULTS_QUEUE
} from '../queues/queue.constants';

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(AGENT_RESULTS_QUEUE)
    private readonly agentResultsQueue: Queue
  ) {}

  async registerNode() {
    const node = await this.prisma.node.create({
      data: {
        status: 'online',
        lastSeenAt: new Date()
      }
    });

    return {
      ok: true,
      nodeId: node.id
    };
  }

  async pullJob() {
    const job = await this.prisma.job.findFirst({
      where: {
        status: 'pending'
      },
      orderBy: {
        createdAt: 'asc'
      }
    });

    return {
      job:
        job === null
          ? null
          : {
              id: job.id,
              type: job.type,
              target: job.target,
              status: job.status,
              createdAt: job.createdAt
            }
    };
  }

  async queueJobResult(payload: Record<string, unknown>) {
    this.logger.log(
      `Queueing result job to ${AGENT_RESULTS_QUEUE}: ${JSON.stringify(payload)}`
    );

    const queuedJob = await this.agentResultsQueue.add(AGENT_RESULT_JOB_NAME, payload, {
      removeOnComplete: 100,
      removeOnFail: 100
    });

    this.logger.log(
      `Queued result job ${queuedJob.id} on ${AGENT_RESULTS_QUEUE}`
    );

    return {
      ok: true,
      queued: true
    };
  }
}
