import { randomBytes } from 'node:crypto';

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class ChallengeStoreService implements OnModuleDestroy {
  private readonly logger = new Logger(ChallengeStoreService.name);
  private readonly redis = new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    lazyConnect: true,
    maxRetriesPerRequest: 1
  });

  async issueChallenge(nodeId: string) {
    const challenge = randomBytes(32).toString('base64url');
    const ttlSeconds = Number(process.env.AUTH_CHALLENGE_TTL_SECONDS ?? 300);

    try {
      await this.ensureConnected();
      await this.redis.set(this.key(nodeId), challenge, 'EX', ttlSeconds);
    } catch (error) {
      this.logger.error('Failed to persist auth challenge in Redis', error);
      throw error;
    }

    return challenge;
  }

  async getChallenge(nodeId: string) {
    await this.ensureConnected();
    return this.redis.get(this.key(nodeId));
  }

  async deleteChallenge(nodeId: string) {
    await this.ensureConnected();
    return this.redis.del(this.key(nodeId));
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  private key(nodeId: string) {
    return `agent-auth:${nodeId}`;
  }

  private async ensureConnected() {
    if (this.redis.status === 'wait') {
      await this.redis.connect();
    }
  }
}
