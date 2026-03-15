import { Body, Controller, Post } from '@nestjs/common';

import { AgentService } from './agent.service';

@Controller('agent')
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  @Post('register')
  register() {
    return this.agentService.registerNode();
  }

  @Post('jobs/pull')
  pullJob() {
    return this.agentService.pullJob();
  }

  @Post('jobs/result')
  async submitResult(@Body() payload: Record<string, unknown>) {
    return this.agentService.queueJobResult(payload);
  }
}
