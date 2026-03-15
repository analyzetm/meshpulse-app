import { randomBytes } from 'node:crypto';

import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

type ChallengeScope = 'http-auth' | 'ws-auth';

@Injectable()
export class ChallengeStoreService implements OnModuleDestroy {
  private readonly logger = new Logger(ChallengeStoreService.name);
  private readonly fallbackChallenges = new Map<
    string,
    { challenge: string; expiresAt: number }
  >();
  private readonly redis = new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    lazyConnect: true,
    maxRetriesPerRequest: 1
  });

  async issueChallenge(nodeId: string, scope: ChallengeScope = 'http-auth') {
    const challenge = randomBytes(32).toString('base64url');
    const ttlSeconds = Number(process.env.AUTH_CHALLENGE_TTL_SECONDS ?? 300);

    try {
      await this.ensureConnected();
      await this.redis.set(this.key(nodeId, scope), challenge, 'EX', ttlSeconds);
    } catch (error) {
      this.logger.warn(
        `Falling back to in-memory challenge store for ${scope}:${nodeId}`
      );
      this.fallbackChallenges.set(this.key(nodeId, scope), {
        challenge,
        expiresAt: Date.now() + ttlSeconds * 1000
      });
    }

    return challenge;
  }

  async getChallenge(nodeId: string, scope: ChallengeScope = 'http-auth') {
    try {
      await this.ensureConnected();
      return this.redis.get(this.key(nodeId, scope));
    } catch {
      const entry = this.fallbackChallenges.get(this.key(nodeId, scope));

      if (!entry || entry.expiresAt <= Date.now()) {
        this.fallbackChallenges.delete(this.key(nodeId, scope));
        return null;
      }

      return entry.challenge;
    }
  }

  async deleteChallenge(nodeId: string, scope: ChallengeScope = 'http-auth') {
    this.fallbackChallenges.delete(this.key(nodeId, scope));

    try {
      await this.ensureConnected();
      return this.redis.del(this.key(nodeId, scope));
    } catch {
      return 0;
    }
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  private key(nodeId: string, scope: ChallengeScope) {
    return `agent-auth:${scope}:${nodeId}`;
  }

  private async ensureConnected() {
    if (this.redis.status === 'wait') {
      await this.redis.connect();
    }
  }
}
