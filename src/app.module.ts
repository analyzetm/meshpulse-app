import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { AdminModule } from './admin/admin.module';
import { AgentModule } from './agent/agent.module';
import { PrismaModule } from './prisma/prisma.module';
import { AgentResultsProcessor } from './queues/agent-results.processor';
import { AGENT_RESULTS_QUEUE } from './queues/queue.constants';
import { SchedulerModule } from './scheduler/scheduler.module';
import { SecurityModule } from './security/security.module';

@Module({
  imports: [
    PrismaModule,
    SecurityModule,
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6379)
      }
    }),
    BullModule.registerQueue({
      name: AGENT_RESULTS_QUEUE
    }),
    AdminModule,
    AgentModule,
    SchedulerModule
  ],
  providers: [AgentResultsProcessor]
})
export class AppModule {}
