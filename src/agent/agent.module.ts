import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { AgentController } from './agent.controller';
import { AgentGateway } from './agent.gateway';
import { AgentService } from './agent.service';
import { AGENT_RESULTS_QUEUE } from '../queues/queue.constants';

@Module({
  imports: [
    BullModule.registerQueue({
      name: AGENT_RESULTS_QUEUE
    })
  ],
  controllers: [AgentController],
  providers: [AgentService, AgentGateway],
  exports: [AgentGateway, AgentService]
})
export class AgentModule {}
