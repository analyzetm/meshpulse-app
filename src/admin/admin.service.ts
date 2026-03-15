import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger
} from '@nestjs/common';

import { AgentGateway } from '../agent/agent.gateway';
import { PrismaService } from '../prisma/prisma.service';
import { generateClaimToken, hashClaimToken } from '../security/crypto.utils';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentGateway: AgentGateway
  ) {}

  async createJob(body: Record<string, unknown>) {
    const type = typeof body.type === 'string' ? body.type.trim() : '';
    const target = typeof body.target === 'string' ? body.target.trim() : '';

    if (!type || !target) {
      throw new BadRequestException('type and target are required');
    }

    return this.prisma.job.create({
      data: {
        type,
        target
      }
    });
  }

  async createNode(body: Record<string, unknown>) {
    const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : '';

    if (!nodeId) {
      throw new BadRequestException('nodeId is required');
    }

    const existingNode = await this.prisma.node.findUnique({
      where: {
        nodeId
      }
    });

    if (existingNode) {
      throw new ConflictException(`node ${nodeId} already exists`);
    }

    const claimToken = generateClaimToken();

    const node = await this.prisma.node.create({
      data: {
        nodeId,
        status: 'pending_registration',
        claimTokenHash: hashClaimToken(claimToken)
      }
    });

    this.logger.log(`Pre-provisioned node ${node.nodeId}`);

    return {
      ok: true,
      nodeId: node.nodeId,
      claimToken
    };
  }

  async sendTestAssignment(body: Record<string, unknown>) {
    const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : '';
    const target = typeof body.target === 'string' ? body.target.trim() : '';
    const checkType =
      typeof body.checkType === 'string' ? body.checkType.trim() : '';

    if (!nodeId || !target || !checkType) {
      throw new BadRequestException('nodeId, target, and checkType are required');
    }

    const job = await this.prisma.job.create({
      data: {
        type: checkType,
        target,
        status: 'assigned',
        assignedNodeId: nodeId
      }
    });

    this.logger.log(
      `Job created for test assignment jobId=${job.id} nodeId=${nodeId} target=${target} checkType=${checkType}`
    );

    return this.agentGateway.sendTestAssignment(
      nodeId,
      null,
      job.id,
      target,
      checkType
    );
  }

  async createCheckDefinition(body: Record<string, unknown>) {
    const type = typeof body.type === 'string' ? body.type.trim() : '';
    const target = typeof body.target === 'string' ? body.target.trim() : '';
    const intervalSec =
      typeof body.intervalSec === 'number' ? body.intervalSec : NaN;
    const validationMode =
      typeof body.validationMode === 'string'
        ? body.validationMode.trim()
        : 'on_failure';
    const validationCount =
      typeof body.validationCount === 'number' ? body.validationCount : 2;
    const requiredRegion =
      typeof body.requiredRegion === 'string' ? body.requiredRegion.trim() : '';

    if (!type || !target || !Number.isFinite(intervalSec) || intervalSec <= 0) {
      throw new BadRequestException(
        'type, target, and positive intervalSec are required'
      );
    }

    if (!['on_failure', 'always', 'never'].includes(validationMode)) {
      throw new BadRequestException(
        'validationMode must be one of on_failure, always, never'
      );
    }

    if (!Number.isFinite(validationCount) || validationCount < 0) {
      throw new BadRequestException('validationCount must be zero or greater');
    }

    const checkDefinition = await this.prisma.checkDefinition.create({
      data: {
        type,
        target,
        intervalSec,
        validationMode,
        validationCount,
        requiredRegion: requiredRegion || undefined,
        nextRunAt: new Date()
      }
    });

    this.logger.log(
      `check definition created checkDefinitionId=${checkDefinition.id} target=${target} type=${type} intervalSec=${intervalSec}`
    );

    return checkDefinition;
  }
}
