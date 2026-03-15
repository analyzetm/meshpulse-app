import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { generateClaimToken, hashClaimToken } from '../security/crypto.utils';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(private readonly prisma: PrismaService) {}

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
}
