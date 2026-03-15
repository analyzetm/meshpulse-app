import { randomUUID } from 'node:crypto';

import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AgentService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('agent-results')
    private readonly agentResultsQueue: Queue
  ) {}

  async registerNode() {
    const nodeId = randomUUID();

    await this.prisma.node.create({
      data: {
        externalId: nodeId
      }
    });

    return {
      ok: true,
      nodeId
    };
  }

  async pullJob() {
    const existingJob = await this.prisma.job.findFirst({
      where: {
        status: 'pending'
      },
      orderBy: {
        createdAt: 'asc'
      }
    });

    const job =
      existingJob ??
      (await this.prisma.job.upsert({
        where: {
          externalId: 'job-1'
        },
        create: {
          externalId: 'job-1',
          type: 'tcp',
          target: 'example.com:443'
        },
        update: {
          type: 'tcp',
          target: 'example.com:443',
          status: 'pending'
        }
      }));

    return {
      job: {
        id: job.externalId,
        type: job.type,
        target: job.target
      }
    };
  }

  async queueJobResult(payload: Record<string, unknown>) {
    await this.agentResultsQueue.add('agent-result', payload, {
      removeOnComplete: 100,
      removeOnFail: 100
    });

    return {
      ok: true,
      queued: true
    };
  }
}
