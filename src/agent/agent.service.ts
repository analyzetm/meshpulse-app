import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException
} from '@nestjs/common';
import { Node, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';

import { PrismaService } from '../prisma/prisma.service';
import {
  AGENT_RESULT_JOB_NAME,
  AGENT_RESULTS_QUEUE
} from '../queues/queue.constants';
import { ChallengeStoreService } from '../security/challenge-store.service';
import {
  verifyClaimToken,
  verifyNodeSignature
} from '../security/crypto.utils';
import { ServerKeysService } from '../security/server-keys.service';

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly challengeStore: ChallengeStoreService,
    private readonly serverKeys: ServerKeysService,
    @InjectQueue(AGENT_RESULTS_QUEUE)
    private readonly agentResultsQueue: Queue
  ) {}

  async registerNode(body: Record<string, unknown>) {
    const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : '';
    const claimToken =
      typeof body.claimToken === 'string' ? body.claimToken.trim() : '';
    const publicKey =
      typeof body.publicKey === 'string' ? body.publicKey.trim() : '';
    const agentVersion =
      typeof body.agentVersion === 'string' ? body.agentVersion.trim() : '';
    const hardware =
      typeof body.hardware === 'object' && body.hardware !== null
        ? (body.hardware as Record<string, unknown>)
        : null;

    if (!nodeId || !claimToken || !publicKey) {
      throw new BadRequestException(
        'nodeId, claimToken, and publicKey are required'
      );
    }

    this.logger.log(`Registration attempt for node ${nodeId}`);

    const node = await this.prisma.node.findUnique({
      where: {
        nodeId
      }
    });

    if (!node) {
      throw new NotFoundException(`node ${nodeId} was not pre-provisioned`);
    }

    if (node.status !== 'pending_registration') {
      this.logger.warn(`Duplicate registration blocked for node ${nodeId}`);
      throw new ConflictException(`node ${nodeId} is not pending registration`);
    }

    if (node.publicKey) {
      this.logger.warn(`Duplicate registration blocked for node ${nodeId}`);
      throw new ConflictException(`node ${nodeId} is already registered`);
    }

    if (!node.claimTokenHash || !verifyClaimToken(claimToken, node.claimTokenHash)) {
      throw new UnauthorizedException('invalid claim token');
    }

    await this.prisma.node.update({
      where: {
        nodeId
      },
      data: {
        status: 'active',
        isOnline: false,
        publicKey,
        hardwareRaw: hardware as Prisma.InputJsonValue | undefined,
        agentVersion: agentVersion || undefined,
        activatedAt: new Date(),
        claimTokenUsedAt: new Date(),
        claimTokenHash: null,
        serverPublicKeySentAt: new Date(),
        lastSeenAt: new Date()
      }
    });

    this.logger.log(`Registration success for node ${nodeId}`);

    return {
      ok: true,
      registered: true,
      serverPublicKey: this.serverKeys.getPublicKey()
    };
  }

  async pullJob(body: Record<string, unknown>) {
    const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : '';

    if (!nodeId) {
      throw new BadRequestException('nodeId is required');
    }

    const node = await this.prisma.node.findUnique({
      where: {
        nodeId
      }
    });

    if (!node || node.status !== 'active') {
      throw new UnauthorizedException(`node ${nodeId} is not active`);
    }

    const job = await this.claimPendingJob(nodeId);

    if (job === null) {
      this.logger.log(`No pending job available for node ${nodeId}`);
    } else {
      this.logger.log(`Assigned job ${job.id} to node ${nodeId}`);
    }

    return {
      job:
        job === null
          ? null
          : {
              id: job.id,
              type: job.type,
              target: job.target,
              status: job.status,
              createdAt: job.createdAt,
              assignedNodeId: job.assignedNodeId
            }
    };
  }

  async issueAuthChallenge(body: Record<string, unknown>) {
    const nodeId = this.requireNodeId(body);
    const challenge = await this.issueChallengeForNode(nodeId, 'http-auth');

    return {
      ok: true,
      challenge: challenge.challenge,
      serverPublicKey: challenge.serverPublicKey
    };
  }

  async verifyAuthChallenge(body: Record<string, unknown>) {
    const nodeId = this.requireNodeId(body);
    const signature =
      typeof body.signature === 'string' ? body.signature.trim() : '';

    if (!signature) {
      throw new BadRequestException('nodeId and signature are required');
    }

    await this.verifyChallengeForNode(nodeId, signature, 'http-auth');

    return {
      ok: true,
      authenticated: true
    };
  }

  async issueWsAuthChallenge(nodeId: string) {
    return this.issueChallengeForNode(nodeId, 'ws-auth');
  }

  async verifyWsAuthChallenge(nodeId: string, signature: string) {
    await this.verifyChallengeForNode(nodeId, signature, 'ws-auth');
  }

  async markNodeOnline(nodeId: string) {
    await this.prisma.node.update({
      where: {
        nodeId
      },
      data: {
        isOnline: true,
        lastSeenAt: new Date()
      }
    });
  }

  async markNodeOffline(nodeId: string) {
    await this.prisma.node.updateMany({
      where: {
        nodeId
      },
      data: {
        isOnline: false
      }
    });
  }

  async touchNode(nodeId: string) {
    await this.prisma.node.update({
      where: {
        nodeId
      },
      data: {
        isOnline: true,
        lastSeenAt: new Date()
      }
    });
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

  private async claimPendingJob(nodeId: string) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const job = await this.prisma.job.findFirst({
        where: {
          status: 'pending'
        },
        orderBy: {
          createdAt: 'asc'
        }
      });

      if (job === null) {
        return null;
      }

      const claimedJob = await this.prisma.$transaction(async (tx) => {
        const updateResult = await tx.job.updateMany({
          where: {
            id: job.id,
            status: 'pending'
          },
          data: {
            status: 'running',
            assignedNodeId: nodeId
          }
        });

        if (updateResult.count === 0) {
          return null;
        }

        return tx.job.findUnique({
          where: {
            id: job.id
          }
        });
      });

      if (claimedJob !== null) {
        return claimedJob;
      }
    }

    return null;
  }

  private requireNodeId(body: Record<string, unknown>) {
    const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : '';

    if (!nodeId) {
      throw new BadRequestException('nodeId is required');
    }

    return nodeId;
  }

  private async issueChallengeForNode(
    nodeId: string,
    scope: 'http-auth' | 'ws-auth'
  ) {
    await this.getActiveNodeForAuth(nodeId);
    const challenge = await this.challengeStore.issueChallenge(nodeId, scope);

    await this.prisma.node.update({
      where: {
        nodeId
      },
      data: {
        serverPublicKeySentAt: new Date()
      }
    });

    this.logger.log(`Issued ${scope} challenge for node ${nodeId}`);

    return {
      challenge,
      serverPublicKey: this.serverKeys.getPublicKey()
    };
  }

  private async verifyChallengeForNode(
    nodeId: string,
    signature: string,
    scope: 'http-auth' | 'ws-auth'
  ) {
    const node = await this.getActiveNodeForAuth(nodeId);
    const challenge = await this.challengeStore.getChallenge(nodeId, scope);

    if (!challenge) {
      this.logger.warn(`Auth verify failed for node ${nodeId}`);
      throw new UnauthorizedException('challenge not found or expired');
    }

    const verified = verifyNodeSignature(node.publicKey!, challenge, signature);
    await this.challengeStore.deleteChallenge(nodeId, scope);

    if (!verified) {
      this.logger.warn(`Auth verify failed for node ${nodeId}`);
      throw new UnauthorizedException('invalid signature');
    }

    await this.prisma.node.update({
      where: {
        nodeId
      },
      data: {
        lastSeenAt: new Date()
      }
    });

    this.logger.log(`Auth verify success for node ${nodeId}`);
  }

  private async getActiveNodeForAuth(nodeId: string): Promise<Node> {
    const node = await this.prisma.node.findUnique({
      where: {
        nodeId
      }
    });

    if (!node || node.status !== 'active' || !node.publicKey) {
      throw new UnauthorizedException(`node ${nodeId} is not active`);
    }

    return node;
  }
}
