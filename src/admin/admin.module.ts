import { Module } from '@nestjs/common';

import { AgentModule } from '../agent/agent.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [AgentModule],
  controllers: [AdminController],
  providers: [AdminService]
})
export class AdminModule {}
