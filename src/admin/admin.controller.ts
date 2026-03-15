import { Body, Controller, Post } from '@nestjs/common';

import { AdminService } from './admin.service';

@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Post('jobs')
  createJob(@Body() body: Record<string, unknown>) {
    return this.adminService.createJob(body);
  }
}
