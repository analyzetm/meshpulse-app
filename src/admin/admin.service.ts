import { BadRequestException, Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminService {
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
}
