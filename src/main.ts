import 'dotenv/config';
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';

import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PORT ?? 3000);
  app.useWebSocketAdapter(new WsAdapter(app));

  await app.listen(port);
  console.log(`MeshPulse backend listening on port ${port}`);
}

void bootstrap();
