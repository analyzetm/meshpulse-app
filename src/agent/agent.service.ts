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

  async markJobRunning(jobId: string, nodeId: string) {
    await this.prisma.job.update({
      where: {
        id: jobId
      },
      data: {
        status: 'running',
        assignedNodeId: nodeId
      }
    });

    this.logger.log(`job marked running jobId=${jobId} nodeId=${nodeId}`);
  }

  async markCheckAssignmentRunning(
    executionId: string,
    assignmentId: string,
    nodeId: string
  ) {
    await this.prisma.checkAssignment.update({
      where: {
        id: assignmentId
      },
      data: {
        status: 'running',
        nodeId
      }
    });

    this.logger.log(
      `check assignment marked running executionId=${executionId} assignmentId=${assignmentId} nodeId=${nodeId}`
    );
  }

  async markCheckAssignmentFailed(executionId: string, assignmentId: string) {
    await this.prisma.checkAssignment.update({
      where: {
        id: assignmentId
      },
      data: {
        status: 'failed'
      }
    });

    await this.finalizeExecutionIfReady(executionId);
  }

  async storeAssignmentResult(
    jobId: string,
    nodeId: string,
    resultStatus: string,
    latencyMs?: number
  ) {
    await this.prisma.job.findUniqueOrThrow({
      where: {
        id: jobId
      }
    });

    await this.prisma.jobResult.create({
      data: {
        jobId,
        nodeId,
        status: resultStatus,
        latencyMs
      }
    });
    this.logger.log(
      `job result stored jobId=${jobId} nodeId=${nodeId} resultStatus=${resultStatus} latencyMs=${latencyMs ?? 'n/a'}`
    );

    await this.prisma.job.update({
      where: {
        id: jobId
      },
      data: {
        status: 'finished'
      }
    });
    this.logger.log(`job marked finished jobId=${jobId} nodeId=${nodeId}`);
  }

  async storeCheckResult(
    executionId: string,
    assignmentId: string,
    nodeId: string,
    resultStatus: string,
    latencyMs: number | undefined,
    activeNodeIds: string[]
  ) {
    const assignment = await this.prisma.checkAssignment.findUniqueOrThrow({
      where: {
        id: assignmentId
      },
      include: {
        execution: {
          include: {
            checkDefinition: true,
            assignments: true,
            results: true
          }
        }
      }
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.checkResult.create({
        data: {
          executionId,
          assignmentId,
          nodeId,
          status: resultStatus,
          latencyMs
        }
      });

      await tx.checkAssignment.update({
        where: {
          id: assignmentId
        },
        data: {
          status: 'completed'
        }
      });
    });

    this.logger.log(
      `check result stored executionId=${executionId} assignmentId=${assignmentId} nodeId=${nodeId} resultStatus=${resultStatus} latencyMs=${latencyMs ?? 'n/a'}`
    );

    const dispatches =
      assignment.role === 'primary'
        ? await this.maybeCreateValidationAssignments(
            assignment.execution.checkDefinitionId,
            executionId,
            assignment.nodeId,
            resultStatus,
            activeNodeIds
          )
        : [];

    await this.finalizeExecutionIfReady(executionId);
    return dispatches;
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

  private async maybeCreateValidationAssignments(
    checkDefinitionId: string,
    executionId: string,
    primaryNodeId: string,
    resultStatus: string,
    activeNodeIds: string[]
  ) {
    const execution = await this.prisma.checkExecution.findUniqueOrThrow({
      where: {
        id: executionId
      },
      include: {
        checkDefinition: true,
        assignments: true
      }
    });

    const { checkDefinition } = execution;
    const shouldTriggerValidation =
      checkDefinition.validationMode === 'always' ||
      (checkDefinition.validationMode === 'on_failure' && resultStatus !== 'up');

    if (!shouldTriggerValidation || checkDefinition.validationMode === 'never') {
      return [];
    }

    const existingValidationCount = execution.assignments.filter(
      (assignment) => assignment.role === 'validation'
    ).length;

    if (existingValidationCount > 0) {
      return [];
    }

    this.logger.log(
      `validation triggered executionId=${executionId} checkDefinitionId=${checkDefinitionId} primaryNodeId=${primaryNodeId} resultStatus=${resultStatus}`
    );

    const excludedNodeIds = execution.assignments.map((assignment) => assignment.nodeId);
    const selectedNodes = await this.selectNodesForCheck({
      activeNodeIds,
      excludeNodeIds: excludedNodeIds,
      requiredRegion: checkDefinition.requiredRegion,
      limit: checkDefinition.validationCount
    });

    if (selectedNodes.length === 0) {
      this.logger.warn(
        `no online node available for validation executionId=${executionId}`
      );
      return [];
    }

    this.logger.log(
      `nodes selected executionId=${executionId} nodeIds=${selectedNodes
        .map((node) => node.nodeId)
        .join(',')}`
    );

    const createdAssignments = await Promise.all(
      selectedNodes.map((node) =>
        this.prisma.checkAssignment.create({
          data: {
            executionId,
            nodeId: node.nodeId,
            role: 'validation',
            status: 'assigned'
          }
        })
      )
    );

    this.logger.log(
      `validation assignments created executionId=${executionId} count=${createdAssignments.length}`
    );

    return createdAssignments.map((assignment) => ({
      executionId,
      assignmentId: assignment.id,
      nodeId: assignment.nodeId,
      target: checkDefinition.target,
      checkType: checkDefinition.type,
      role: 'validation' as const
    }));
  }

  async selectNodesForCheck(params: {
    activeNodeIds: string[];
    excludeNodeIds?: string[];
    requiredRegion?: string | null;
    limit: number;
  }) {
    const { activeNodeIds, excludeNodeIds = [], requiredRegion, limit } = params;

    if (activeNodeIds.length === 0 || limit <= 0) {
      return [];
    }

    const candidateNodes = await this.prisma.node.findMany({
      where: {
        nodeId: {
          in: activeNodeIds,
          notIn: excludeNodeIds
        },
        status: 'active',
        isOnline: true,
        ...(requiredRegion ? { region: requiredRegion } : {})
      },
      select: {
        nodeId: true,
        lastSeenAt: true
      }
    });

    const rankedNodes = await Promise.all(
      candidateNodes.map(async (node) => {
        const [activeAssignments, latestAssignment] = await Promise.all([
          this.prisma.checkAssignment.count({
            where: {
              nodeId: node.nodeId,
              status: {
                in: ['assigned', 'running']
              }
            }
          }),
          this.prisma.checkAssignment.findFirst({
            where: {
              nodeId: node.nodeId
            },
            orderBy: {
              createdAt: 'desc'
            },
            select: {
              createdAt: true
            }
          })
        ]);

        return {
          nodeId: node.nodeId,
          lastSeenAt: node.lastSeenAt?.getTime() ?? 0,
          activeAssignments,
          lastAssignedAt: latestAssignment?.createdAt.getTime() ?? 0
        };
      })
    );

    return rankedNodes
      .filter((node) => node.activeAssignments === 0)
      .sort((left, right) => {
        if (left.lastAssignedAt !== right.lastAssignedAt) {
          return left.lastAssignedAt - right.lastAssignedAt;
        }

        return right.lastSeenAt - left.lastSeenAt;
      })
      .slice(0, limit);
  }

  async finalizeExecutionIfReady(executionId: string) {
    const execution = await this.prisma.checkExecution.findUniqueOrThrow({
      where: {
        id: executionId
      },
      include: {
        assignments: true,
        results: true
      }
    });

    const hasPendingAssignments = execution.assignments.some((assignment) =>
      ['assigned', 'running'].includes(assignment.status)
    );

    if (hasPendingAssignments) {
      return null;
    }

    const upCount = execution.results.filter((result) => result.status === 'up').length;
    const downCount = execution.results.length - upCount;

    let consensusStatus = 'mixed';
    if (upCount > downCount) {
      consensusStatus = 'up';
    } else if (downCount > upCount) {
      consensusStatus = 'down';
    }

    await this.prisma.checkExecution.update({
      where: {
        id: executionId
      },
      data: {
        status: 'completed',
        consensusStatus
      }
    });

    this.logger.log(
      `consensus decision executionId=${executionId} consensusStatus=${consensusStatus} upCount=${upCount} downCount=${downCount}`
    );

    return consensusStatus;
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
