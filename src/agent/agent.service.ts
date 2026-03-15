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
import { ConnectionMetadata } from '../security/ip-geo.service';
import { NodeSessionStoreService } from '../security/node-session-store.service';
import {
  verifyClaimToken,
  verifyNodeSignature
} from '../security/crypto.utils';
import { ServerKeysService } from '../security/server-keys.service';

type NodeSelectionParams = {
  activeNodeIds: string[];
  limit: number;
  requiredRegion?: string | null;
  minReputation?: number | null;
  maxReputation?: number | null;
  preferTrusted?: boolean;
  requireTrusted?: boolean;
  preferDifferentAsn?: boolean;
  preferDifferentRegion?: boolean;
  excludeNodeIds?: string[];
  usedRemoteIps?: string[];
  usedAsns?: number[];
  usedRegions?: string[];
};

type RankedNode = {
  nodeId: string;
  remoteIp: string | null;
  asn: number | null;
  regionCode: string | null;
  activeAssignments: number;
  checksToday: number;
  checksLastHour: number;
  lastAssignedAt: number | null;
  score: number;
  reasons: string[];
};

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly challengeStore: ChallengeStoreService,
    private readonly serverKeys: ServerKeysService,
    private readonly nodeSessionStore: NodeSessionStoreService,
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
        status: 'offline',
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

    if (!node || node.status !== 'online') {
      throw new UnauthorizedException(`node ${nodeId} is not online`);
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

  async markNodeOnline(nodeId: string, metadata: ConnectionMetadata) {
    const connectedAt = new Date();

    await this.prisma.node.update({
      where: {
        nodeId
      },
      data: {
        status: 'online',
        isOnline: true,
        remoteIp: metadata.remoteIp ?? undefined,
        ipVersion: metadata.ipVersion ?? undefined,
        countryCode: metadata.countryCode ?? undefined,
        regionCode: metadata.regionCode ?? undefined,
        city: metadata.city ?? undefined,
        asn: metadata.asn ?? undefined,
        ispOrOrg: metadata.ispOrOrg ?? undefined,
        connectedAt,
        lastSeenAt: connectedAt
      }
    });
    this.logger.log(
      `node DB updated nodeId=${nodeId} remoteIp=${metadata.remoteIp ?? 'unknown'} countryCode=${metadata.countryCode ?? 'n/a'} regionCode=${metadata.regionCode ?? 'n/a'}`
    );
    await this.nodeSessionStore.setOnline(nodeId, metadata, connectedAt);
  }

  async markNodeOffline(nodeId: string) {
    await this.prisma.node.updateMany({
      where: {
        nodeId
      },
      data: {
        status: 'offline',
        isOnline: false,
        lastSeenAt: new Date()
      }
    });
    this.logger.log(`node DB updated nodeId=${nodeId} status=offline`);
    await this.nodeSessionStore.setOffline(nodeId);
  }

  async touchNode(nodeId: string) {
    await this.prisma.node.update({
      where: {
        nodeId
      },
      data: {
        status: 'online',
        isOnline: true,
        lastSeenAt: new Date()
      }
    });
    await this.nodeSessionStore.touch(nodeId);
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
            executionId,
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
    executionId: string,
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
      `validation triggered executionId=${executionId} checkDefinitionId=${execution.checkDefinitionId} primaryNodeId=${execution.assignments.find((entry) => entry.role === 'primary')?.nodeId ?? 'unknown'} resultStatus=${resultStatus}`
    );

    const selectionContext = await this.getExecutionSelectionContext(executionId);
    const selectedNodes = await this.selectNodesForCheck({
      activeNodeIds,
      excludeNodeIds: selectionContext.usedNodeIds,
      requiredRegion: checkDefinition.requiredRegion,
      minReputation: checkDefinition.minReputation,
      maxReputation: checkDefinition.maxReputation,
      preferTrusted: checkDefinition.preferTrusted,
      requireTrusted: checkDefinition.requireTrusted,
      preferDifferentAsn: checkDefinition.preferDifferentAsn,
      preferDifferentRegion: checkDefinition.preferDifferentRegion,
      usedRemoteIps: selectionContext.usedRemoteIps,
      usedAsns: selectionContext.usedAsns,
      usedRegions: selectionContext.usedRegions,
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

    await Promise.all(
      createdAssignments.map((assignment) =>
        this.touchAssignmentPressure(assignment.nodeId)
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

  async selectNodesForCheck(params: NodeSelectionParams) {
    const {
      activeNodeIds,
      excludeNodeIds = [],
      requiredRegion,
      minReputation,
      maxReputation,
      preferTrusted = false,
      requireTrusted = false,
      preferDifferentAsn = true,
      preferDifferentRegion = false,
      usedRemoteIps = [],
      usedAsns = [],
      usedRegions = [],
      limit
    } = params;

    if (activeNodeIds.length === 0 || limit <= 0) {
      return [];
    }

    const candidateNodes = await this.prisma.node.findMany({
      where: {
        nodeId: {
          in: activeNodeIds,
          notIn: excludeNodeIds
        },
        status: 'online',
        isOnline: true,
        ...(requiredRegion
          ? {
              OR: [{ region: requiredRegion }, { regionCode: requiredRegion }]
            }
          : {}),
        ...(minReputation !== undefined && minReputation !== null
          ? {
              reputationScore: {
                gte: minReputation
              }
            }
          : {}),
        ...(maxReputation !== undefined && maxReputation !== null
          ? {
              reputationScore: {
                ...(minReputation !== undefined && minReputation !== null
                  ? { gte: minReputation }
                  : {}),
                lte: maxReputation
              }
            }
          : {}),
        ...(requireTrusted ? { isTrusted: true } : {})
      },
      select: {
        nodeId: true,
        lastSeenAt: true,
        lastAssignedAt: true,
        reputationScore: true,
        isTrusted: true,
        remoteIp: true,
        asn: true,
        regionCode: true
      }
    });

    this.logger.log(
      `eligibility filtering activeCandidates=${candidateNodes.length} requiredRegion=${requiredRegion ?? 'none'} minReputation=${minReputation ?? 'none'} maxReputation=${maxReputation ?? 'none'} requireTrusted=${requireTrusted}`
    );

    const rankedNodes = await Promise.all(
      candidateNodes.map(async (node) => {
        const activeAssignments = await this.prisma.checkAssignment.count({
          where: {
            nodeId: node.nodeId,
            status: {
              in: ['assigned', 'running']
            }
          }
        });

        const [checksLastHour, dailyLoad] = await Promise.all([
          this.prisma.checkAssignment.count({
            where: {
              nodeId: node.nodeId,
              createdAt: {
                gte: new Date(Date.now() - 60 * 60 * 1000)
              }
            }
          }),
          this.prisma.checkAssignment.count({
            where: {
              nodeId: node.nodeId,
              createdAt: {
                gte: this.getUtcDayStart()
              }
            }
          })
        ]);

        const score = this.calculateNodeSelectionScore(
          {
            ...node,
            activeAssignments,
            checksToday: dailyLoad,
            checksLastHour
          },
          {
            preferTrusted,
            preferDifferentAsn,
            preferDifferentRegion,
            usedRemoteIps,
            usedAsns,
            usedRegions
          }
        );

        return {
          nodeId: node.nodeId,
          remoteIp: node.remoteIp,
          asn: node.asn,
          regionCode: node.regionCode,
          activeAssignments,
          checksToday: dailyLoad,
          checksLastHour,
          lastAssignedAt: node.lastAssignedAt?.getTime() ?? null,
          score: score.score,
          reasons: score.reasons
        } satisfies RankedNode;
      })
    );

    const eligibleNodes = rankedNodes.filter((node) => {
      const overloaded = node.activeAssignments > 0;
      if (overloaded) {
        this.logger.log(
          `eligibility filtering nodeId=${node.nodeId} rejected=overloaded activeAssignments=${node.activeAssignments}`
        );
      }
      return !overloaded;
    });

    eligibleNodes.forEach((node) => {
      this.logger.log(
        `trusted preference decisions nodeId=${node.nodeId} score=${node.score} trusted=${node.reasons.filter((reason) => reason.startsWith('trusted')).join('|') || 'none'}`
      );
      this.logger.log(
        `ASN preference decisions nodeId=${node.nodeId} score=${node.score} asn=${node.asn ?? 'n/a'} reason=${node.reasons.filter((reason) => reason.startsWith('asn') || reason.startsWith('remoteIp')).join('|') || 'none'}`
      );
      this.logger.log(
        `region preference decisions nodeId=${node.nodeId} score=${node.score} regionCode=${node.regionCode ?? 'n/a'} reason=${node.reasons.filter((reason) => reason.startsWith('region')).join('|') || 'none'}`
      );
      this.logger.log(
        `fairness decisions nodeId=${node.nodeId} score=${node.score} checksToday=${node.checksToday} checksLastHour=${node.checksLastHour} lastAssignedAt=${node.lastAssignedAt ?? 0}`
      );
    });

    return eligibleNodes
      .sort((left, right) => {
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        const leftAssigned = left.lastAssignedAt ?? 0;
        const rightAssigned = right.lastAssignedAt ?? 0;
        if (leftAssigned !== rightAssigned) {
          return leftAssigned - rightAssigned;
        }

        return left.nodeId.localeCompare(right.nodeId);
      })
      .slice(0, limit);
  }

  async recordAssignmentDispatch(nodeId: string) {
    await this.touchAssignmentPressure(nodeId);
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

    if (execution.status === 'completed') {
      return execution.consensusStatus;
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

    await this.applyReputationForExecution(executionId, consensusStatus);

    return consensusStatus;
  }

  private calculateNodeSelectionScore(
    node: {
      nodeId: string;
      isTrusted: boolean;
      remoteIp: string | null;
      asn: number | null;
      regionCode: string | null;
      reputationScore: number;
      checksToday: number;
      checksLastHour: number;
      lastAssignedAt: Date | null;
      activeAssignments: number;
    },
    preferences: {
      preferTrusted: boolean;
      preferDifferentAsn: boolean;
      preferDifferentRegion: boolean;
      usedRemoteIps: string[];
      usedAsns: number[];
      usedRegions: string[];
    }
  ) {
    let score = 0;
    const reasons: string[] = [];
    const uniqueRemoteIps = new Set(preferences.usedRemoteIps.filter(Boolean));
    const uniqueAsns = new Set(preferences.usedAsns);
    const uniqueRegions = new Set(preferences.usedRegions.filter(Boolean));

    if (preferences.preferTrusted && node.isTrusted) {
      score += 25;
      reasons.push('trusted:+25');
    } else if (preferences.preferTrusted) {
      reasons.push('trusted:+0');
    }

    if (node.remoteIp && uniqueRemoteIps.has(node.remoteIp)) {
      score -= 1000;
      reasons.push('remoteIp:-1000');
    }

    if (preferences.preferDifferentAsn && node.asn !== null) {
      if (uniqueAsns.size > 0 && uniqueAsns.has(node.asn)) {
        score -= 35;
        reasons.push('asn:-35');
      } else if (uniqueAsns.size > 0) {
        score += 20;
        reasons.push('asn:+20');
      }
    }

    if (preferences.preferDifferentRegion && node.regionCode) {
      if (uniqueRegions.size > 0 && uniqueRegions.has(node.regionCode)) {
        score -= 10;
        reasons.push('region:-10');
      } else if (uniqueRegions.size > 0) {
        score += 10;
        reasons.push('region:+10');
      }
    }

    const lastAssignedAt = node.lastAssignedAt?.getTime() ?? 0;
    const minutesSinceLastAssignment = lastAssignedAt
      ? Math.max(0, (Date.now() - lastAssignedAt) / 60_000)
      : 1_440;
    const fairnessFromRecency = Math.min(20, Math.floor(minutesSinceLastAssignment / 5));
    const fairnessFromDailyLoad = Math.max(0, 15 - node.checksToday * 2);
    const fairnessFromHourlyLoad = Math.max(0, 20 - node.checksLastHour * 5);
    const reputationBonus = Math.max(0, Math.floor(node.reputationScore / 10));

    score += fairnessFromRecency + fairnessFromDailyLoad + fairnessFromHourlyLoad + reputationBonus;
    reasons.push(
      `fairness:+${fairnessFromRecency + fairnessFromDailyLoad + fairnessFromHourlyLoad}`,
      `reputation:+${reputationBonus}`
    );

    return {
      score,
      reasons
    };
  }

  private async getExecutionSelectionContext(executionId: string) {
    const assignments = await this.prisma.checkAssignment.findMany({
      where: {
        executionId
      },
      include: {
        node: {
          select: {
            nodeId: true,
            remoteIp: true,
            asn: true,
            regionCode: true
          }
        }
      }
    });

    return {
      usedNodeIds: assignments.map((assignment) => assignment.nodeId),
      usedRemoteIps: assignments
        .map((assignment) => assignment.node.remoteIp)
        .filter((value): value is string => Boolean(value)),
      usedAsns: assignments
        .map((assignment) => assignment.node.asn)
        .filter((value): value is number => value !== null),
      usedRegions: assignments
        .map((assignment) => assignment.node.regionCode)
        .filter((value): value is string => Boolean(value))
    };
  }

  private async touchAssignmentPressure(nodeId: string) {
    const now = new Date();
    const [checksToday, checksLastHour] = await Promise.all([
      this.prisma.checkAssignment.count({
        where: {
          nodeId,
          createdAt: {
            gte: this.getUtcDayStart()
          }
        }
      }),
      this.prisma.checkAssignment.count({
        where: {
          nodeId,
          createdAt: {
            gte: new Date(Date.now() - 60 * 60 * 1000)
          }
        }
      })
    ]);

    await this.prisma.node.update({
      where: {
        nodeId
      },
      data: {
        lastAssignedAt: now,
        checksToday,
        checksLastHour
      }
    });
  }

  private getUtcDayStart() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  }

  private async applyReputationForExecution(
    executionId: string,
    consensusStatus: string
  ) {
    if (!['up', 'down'].includes(consensusStatus)) {
      return;
    }

    const execution = await this.prisma.checkExecution.findUniqueOrThrow({
      where: {
        id: executionId
      },
      include: {
        results: true,
        assignments: true
      }
    });

    const assignmentById = new Map(
      execution.assignments.map((assignment) => [assignment.id, assignment])
    );

    for (const result of execution.results) {
      const assignment = assignmentById.get(result.assignmentId);
      if (!assignment) {
        continue;
      }

      const scoreDelta = result.status === consensusStatus ? 1 : -3;
      const node = await this.prisma.node.findUniqueOrThrow({
        where: {
          nodeId: result.nodeId
        }
      });
      const nextScore = Math.min(100, Math.max(0, node.reputationScore + scoreDelta));
      if (nextScore !== node.reputationScore + scoreDelta) {
        this.logger.log(
          `score clamping nodeId=${result.nodeId} previous=${node.reputationScore} attempted=${node.reputationScore + scoreDelta} next=${nextScore}`
        );
      }

      await this.prisma.$transaction(async (tx) => {
        const existingEvent = await tx.nodeReputationEvent.findFirst({
          where: {
            assignmentId: result.assignmentId,
            eventType:
              result.status === consensusStatus
                ? 'consensus_match'
                : 'consensus_mismatch'
          }
        });

        if (existingEvent) {
          this.logger.log(
            `reputation score changes skipped assignmentId=${result.assignmentId} eventType=${existingEvent.eventType} reason=already_recorded`
          );
          return;
        }

        await tx.node.update({
          where: {
            nodeId: result.nodeId
          },
          data: {
            reputationScore: nextScore
          }
        });

        await tx.nodeReputationEvent.create({
          data: {
            nodeId: result.nodeId,
            executionId,
            assignmentId: result.assignmentId,
            eventType: result.status === consensusStatus ? 'consensus_match' : 'consensus_mismatch',
            scoreDelta: nextScore - node.reputationScore,
            reason: `result ${result.status} vs consensus ${consensusStatus}`
          }
        });
      });

      if (assignment.role === 'validation') {
        await this.updateValidationAccuracy(result.nodeId);
      }

      this.logger.log(
        `reputation score changes nodeId=${result.nodeId} executionId=${executionId} assignmentId=${result.assignmentId} scoreDelta=${nextScore - node.reputationScore} reputationScore=${nextScore}`
      );
    }
  }

  private async updateValidationAccuracy(nodeId: string) {
    const results = await this.prisma.checkResult.findMany({
      where: {
        nodeId,
        assignment: {
          role: 'validation'
        },
        execution: {
          consensusStatus: {
            in: ['up', 'down']
          }
        }
      },
      include: {
        execution: {
          select: {
            consensusStatus: true
          }
        }
      }
    });

    if (results.length === 0) {
      return;
    }

    const matches = results.filter(
      (result) => result.status === result.execution.consensusStatus
    ).length;

    await this.prisma.node.update({
      where: {
        nodeId
      },
      data: {
        validationAccuracy: matches / results.length
      }
    });
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

    if (
      !node ||
      !['offline', 'online'].includes(node.status) ||
      !node.publicKey
    ) {
      throw new UnauthorizedException(`node ${nodeId} is not registered`);
    }

    return node;
  }
}
