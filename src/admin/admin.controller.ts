import { Body, Controller, Post } from '@nestjs/common';

import { AdminService } from './admin.service';

@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Post('jobs')
  createJob(@Body() body: Record<string, unknown>) {
    return this.adminService.createJob(body);
  }

  @Post('nodes')
  createNode(@Body() body: Record<string, unknown>) {
    return this.adminService.createNode(body);
  }

  @Post('test-assignment')
  testAssignment(@Body() body: Record<string, unknown>) {
    return this.adminService.sendTestAssignment(body);
  }

  @Post('check-definitions')
  createCheckDefinition(@Body() body: Record<string, unknown>) {
    return this.adminService.createCheckDefinition(body);
  }
}
