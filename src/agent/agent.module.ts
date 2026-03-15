import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';

@Module({
  imports: [
    BullModule.registerQueue({
      name: 'agent-results'
    })
  ],
  controllers: [AgentController],
  providers: [AgentService]
})
export class AgentModule {}
