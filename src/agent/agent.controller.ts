import { Body, Controller, Post } from '@nestjs/common';

import { AgentService } from './agent.service';

@Controller('agent')
export class AgentController {
  constructor(private readonly agentService: AgentService) {}

  @Post('register')
  register(@Body() body: Record<string, unknown>) {
    return this.agentService.registerNode(body);
  }

  @Post('auth/challenge')
  issueChallenge(@Body() body: Record<string, unknown>) {
    return this.agentService.issueAuthChallenge(body);
  }

  @Post('auth/verify')
  verifyChallenge(@Body() body: Record<string, unknown>) {
    return this.agentService.verifyAuthChallenge(body);
  }

  @Post('jobs/pull')
  pullJob(@Body() body: Record<string, unknown>) {
    return this.agentService.pullJob(body);
  }

  @Post('jobs/result')
  async submitResult(@Body() payload: Record<string, unknown>) {
    return this.agentService.queueJobResult(payload);
  }
}
