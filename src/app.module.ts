import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { AgentModule } from './agent/agent.module';
import { PrismaModule } from './prisma/prisma.module';
import { AgentResultsProcessor } from './queues/agent-results.processor';

@Module({
  imports: [
    PrismaModule,
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6379)
      }
    }),
    BullModule.registerQueue({
      name: 'agent-results'
    }),
    AgentModule
  ],
  providers: [AgentResultsProcessor]
})
export class AppModule {}
