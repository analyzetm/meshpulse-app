import {
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway
} from '@nestjs/websockets';
import { Injectable, Logger } from '@nestjs/common';
import WebSocket from 'ws';

import { AgentService } from './agent.service';

type SessionState = {
  authenticated: boolean;
  nodeId?: string;
};

type AgentMessage = {
  type?: unknown;
  nodeId?: unknown;
  signature?: unknown;
  ts?: unknown;
};

@Injectable()
@WebSocketGateway({
  path: '/agent/ws'
})
export class AgentGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(AgentGateway.name);
  private readonly sessions = new Map<WebSocket, SessionState>();
  private readonly activeSockets = new Map<string, WebSocket>();

  constructor(private readonly agentService: AgentService) {}

  afterInit() {
    this.logger.log('agent gateway ready path=/agent/ws');
  }

  handleConnection(client: WebSocket) {
    this.sessions.set(client, {
      authenticated: false
    });
    this.logger.log('socket connected');

    client.on('message', (raw) => {
      void this.handleRawMessage(client, raw.toString());
    });
  }

  async handleDisconnect(client: WebSocket) {
    const session = this.sessions.get(client);
    this.sessions.delete(client);

    if (!session?.nodeId) {
      this.logger.log('socket disconnected');
      return;
    }

    const trackedSocket = this.activeSockets.get(session.nodeId);
    if (trackedSocket === client) {
      this.activeSockets.delete(session.nodeId);
      await this.agentService.markNodeOffline(session.nodeId);
    }

    this.logger.log(`socket disconnected nodeId=${session.nodeId}`);
  }

  private async handleRawMessage(client: WebSocket, rawMessage: string) {
    let parsed: AgentMessage;

    try {
      parsed = JSON.parse(rawMessage) as AgentMessage;
    } catch {
      this.send(client, {
        type: 'auth_error',
        reason: 'invalid_json'
      });
      client.close(1008, 'invalid_json');
      return;
    }

    const type = typeof parsed.type === 'string' ? parsed.type : '';

    switch (type) {
      case 'hello':
        await this.handleHello(client, parsed);
        return;
      case 'auth':
        await this.handleAuth(client, parsed);
        return;
      case 'heartbeat':
        await this.handleHeartbeat(client, parsed);
        return;
      default:
        this.logger.warn(`Unknown agent message type received: ${type || '<empty>'}`);
        this.send(client, {
          type: 'auth_error',
          reason: 'unknown_message_type'
        });
        if (!this.sessions.get(client)?.authenticated) {
          client.close(1008, 'unknown_message_type');
        }
    }
  }

  private async handleHello(client: WebSocket, message: AgentMessage) {
    const nodeId = typeof message.nodeId === 'string' ? message.nodeId.trim() : '';

    if (!nodeId) {
      this.send(client, {
        type: 'auth_error',
        reason: 'nodeId_required'
      });
      client.close(1008, 'nodeId_required');
      return;
    }

    this.logger.log(`hello received nodeId=${nodeId}`);

    try {
      const challenge = await this.agentService.issueWsAuthChallenge(nodeId);
      this.sessions.set(client, {
        authenticated: false,
        nodeId
      });

      this.send(client, {
        type: 'challenge',
        challenge: challenge.challenge,
        serverPublicKey: challenge.serverPublicKey
      });
      this.logger.log(`challenge sent nodeId=${nodeId}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'challenge_failed';
      this.logger.warn(`Challenge issue failed for node ${nodeId}: ${reason}`);
      this.send(client, {
        type: 'auth_error',
        reason
      });
      client.close(1008, 'challenge_failed');
    }
  }

  private async handleAuth(client: WebSocket, message: AgentMessage) {
    const nodeId = typeof message.nodeId === 'string' ? message.nodeId.trim() : '';
    const signature =
      typeof message.signature === 'string' ? message.signature.trim() : '';
    const session = this.sessions.get(client);

    if (!nodeId || !signature || !session?.nodeId || session.nodeId !== nodeId) {
      this.send(client, {
        type: 'auth_error',
        reason: 'invalid_auth_payload'
      });
      client.close(1008, 'invalid_auth_payload');
      return;
    }

    try {
      await this.agentService.verifyWsAuthChallenge(nodeId, signature);
      const existingSocket = this.activeSockets.get(nodeId);

      if (existingSocket && existingSocket !== client) {
        existingSocket.close(1000, 'replaced_by_new_session');
      }

      this.activeSockets.set(nodeId, client);
      this.sessions.set(client, {
        authenticated: true,
        nodeId
      });

      await this.agentService.markNodeOnline(nodeId);
      this.send(client, {
        type: 'auth_ok'
      });
      this.logger.log(`auth verified nodeId=${nodeId}`);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'auth_failed';
      this.logger.warn(`Auth failure for node ${nodeId}: ${reason}`);
      this.send(client, {
        type: 'auth_error',
        reason
      });
      client.close(1008, 'auth_failed');
    }
  }

  private async handleHeartbeat(client: WebSocket, message: AgentMessage) {
    const nodeId = typeof message.nodeId === 'string' ? message.nodeId.trim() : '';
    const session = this.sessions.get(client);

    if (!session?.authenticated || !nodeId || session.nodeId !== nodeId) {
      this.send(client, {
        type: 'auth_error',
        reason: 'heartbeat_requires_auth'
      });
      client.close(1008, 'heartbeat_requires_auth');
      return;
    }

    await this.agentService.touchNode(nodeId);
    this.logger.log(`heartbeat received nodeId=${nodeId}`);
    this.send(client, {
      type: 'heartbeat_ack'
    });
  }

  private send(client: WebSocket, payload: Record<string, unknown>) {
    if (client.readyState !== WebSocket.OPEN) {
      return;
    }

    client.send(JSON.stringify(payload));
  }
}
