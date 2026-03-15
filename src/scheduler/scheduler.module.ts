import { Module } from '@nestjs/common';

import { AgentModule } from '../agent/agent.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SchedulerService } from './scheduler.service';

@Module({
  imports: [PrismaModule, AgentModule],
  providers: [SchedulerService]
})
export class SchedulerModule {}
