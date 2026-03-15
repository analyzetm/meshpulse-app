import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';

import { AgentGateway } from '../agent/agent.gateway';
import { AgentService } from '../agent/agent.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SchedulerService.name);
  private readonly intervalMs = 10_000;
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly agentGateway: AgentGateway,
    private readonly agentService: AgentService
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.runCycle();
    }, this.intervalMs);
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
    }
  }

  private async runCycle() {
    if (this.running) {
      return;
    }

    this.running = true;
    this.logger.log('scheduler cycle');

    try {
      const dueChecks = await this.prisma.checkDefinition.findMany({
        where: {
          isActive: true,
          nextRunAt: {
            lte: new Date()
          }
        },
        orderBy: {
          nextRunAt: 'asc'
        }
      });

      for (const checkDefinition of dueChecks) {
        this.logger.log(
          `due check found checkDefinitionId=${checkDefinition.id} target=${checkDefinition.target} type=${checkDefinition.type}`
        );

        const selectedNode = (
          await this.agentService.selectNodesForCheck({
            activeNodeIds: this.agentGateway.listActiveNodeIds(),
            requiredRegion: checkDefinition.requiredRegion,
            minReputation: checkDefinition.minReputation,
            maxReputation: checkDefinition.maxReputation,
            preferTrusted: checkDefinition.preferTrusted,
            requireTrusted: checkDefinition.requireTrusted,
            preferDifferentAsn: checkDefinition.preferDifferentAsn,
            preferDifferentRegion: checkDefinition.preferDifferentRegion,
            limit: 1
          })
        )[0];

        if (!selectedNode) {
          this.logger.warn(
            `no online node available checkDefinitionId=${checkDefinition.id} target=${checkDefinition.target}`
          );
          continue;
        }

        this.logger.log(
          `node selected checkDefinitionId=${checkDefinition.id} nodeId=${selectedNode.nodeId}`
        );

        const execution = await this.prisma.checkExecution.create({
          data: {
            checkDefinitionId: checkDefinition.id,
            status: 'running'
          }
        });
        const assignment = await this.prisma.checkAssignment.create({
          data: {
            executionId: execution.id,
            nodeId: selectedNode.nodeId,
            role: 'primary',
            status: 'assigned'
          }
        });

        await this.agentService.recordAssignmentDispatch(selectedNode.nodeId);

        this.logger.log(
          `primary assignment created executionId=${execution.id} assignmentId=${assignment.id} nodeId=${selectedNode.nodeId}`
        );

        const sendResult = this.agentGateway.sendTestAssignment(
          selectedNode.nodeId,
          execution.id,
          assignment.id,
          checkDefinition.target,
          checkDefinition.type,
          'primary'
        );

        if (!sendResult.sent) {
          await this.prisma.checkAssignment.delete({
            where: {
              id: assignment.id
            }
          });
          await this.prisma.checkExecution.delete({
            where: {
              id: execution.id
            }
          });
          this.logger.warn(
            `no online node available checkDefinitionId=${checkDefinition.id} target=${checkDefinition.target}`
          );
          continue;
        }

        await this.prisma.checkDefinition.update({
          where: {
            id: checkDefinition.id
          },
          data: {
            nextRunAt: new Date(Date.now() + checkDefinition.intervalSec * 1000)
          }
        });
      }
    } finally {
      this.running = false;
    }
  }
}
