import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';

type StoredKeyPair = {
  privateKeyDerBase64: string;
  publicKeyDerBase64: string;
};

@Injectable()
export class ServerKeysService {
  private readonly logger = new Logger(ServerKeysService.name);
  private readonly keyPath = resolve(
    process.env.SERVER_KEY_PATH ?? '.secrets/server-ed25519.json'
  );
  private readonly keyPair = this.loadOrGenerateKeyPair();

  getPublicKey() {
    return this.keyPair.publicKeyDerBase64;
  }

  private loadOrGenerateKeyPair(): StoredKeyPair {
    mkdirSync(dirname(this.keyPath), { recursive: true });

    if (existsSync(this.keyPath)) {
      this.logger.log(`Loaded server signing keypair from ${this.keyPath}`);
      return JSON.parse(readFileSync(this.keyPath, 'utf8')) as StoredKeyPair;
    }

    // Generate once locally and persist the private key on disk so the public key stays stable.
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyPair = {
      privateKeyDerBase64: privateKey
        .export({ format: 'der', type: 'pkcs8' })
        .toString('base64'),
      publicKeyDerBase64: publicKey
        .export({ format: 'der', type: 'spki' })
        .toString('base64')
    };

    writeFileSync(this.keyPath, JSON.stringify(keyPair, null, 2), {
      encoding: 'utf8',
      mode: 0o600
    });
    chmodSync(this.keyPath, 0o600);
    this.logger.log(`Generated server signing keypair at ${this.keyPath}`);

    return keyPair;
  }
}
