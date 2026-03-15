import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

import { ConnectionMetadata } from './ip-geo.service';

type NodeSessionState = {
  nodeId: string;
  remoteIp: string | null;
  countryCode: string | null;
  regionCode: string | null;
  asn: number | null;
  ispOrOrg: string | null;
  connectedAt: string;
  lastSeenAt: string;
  isOnline: boolean;
};

@Injectable()
export class NodeSessionStoreService implements OnModuleDestroy {
  private readonly logger = new Logger(NodeSessionStoreService.name);
  private readonly fallback = new Map<string, NodeSessionState>();
  private readonly redis = new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    lazyConnect: true,
    maxRetriesPerRequest: 1
  });

  async setOnline(nodeId: string, metadata: ConnectionMetadata, connectedAt: Date) {
    const state: NodeSessionState = {
      nodeId,
      remoteIp: metadata.remoteIp,
      countryCode: metadata.countryCode,
      regionCode: metadata.regionCode,
      asn: metadata.asn,
      ispOrOrg: metadata.ispOrOrg,
      connectedAt: connectedAt.toISOString(),
      lastSeenAt: connectedAt.toISOString(),
      isOnline: true
    };

    await this.persist(nodeId, state);
    this.logger.log(`Redis session updated nodeId=${nodeId}`);
  }

  async touch(nodeId: string) {
    const current = await this.get(nodeId);
    if (!current) {
      return;
    }

    current.lastSeenAt = new Date().toISOString();
    current.isOnline = true;
    await this.persist(nodeId, current);
    this.logger.log(`Redis session updated nodeId=${nodeId}`);
  }

  async setOffline(nodeId: string) {
    const current = await this.get(nodeId);
    if (!current) {
      return;
    }

    current.lastSeenAt = new Date().toISOString();
    current.isOnline = false;
    await this.persist(nodeId, current);
    this.logger.log(`Redis session updated nodeId=${nodeId}`);
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  private async get(nodeId: string) {
    try {
      await this.ensureConnected();
      const raw = await this.redis.get(this.key(nodeId));
      return raw ? (JSON.parse(raw) as NodeSessionState) : null;
    } catch {
      return this.fallback.get(this.key(nodeId)) ?? null;
    }
  }

  private async persist(nodeId: string, state: NodeSessionState) {
    this.fallback.set(this.key(nodeId), state);

    try {
      await this.ensureConnected();
      await this.redis.set(this.key(nodeId), JSON.stringify(state));
    } catch (error) {
      this.logger.warn(
        `Falling back to in-memory node session store for nodeId=${nodeId}`
      );
    }
  }

  private key(nodeId: string) {
    return `node-session:${nodeId}`;
  }

  private async ensureConnected() {
    if (this.redis.status === 'wait') {
      await this.redis.connect();
    }
  }
}
