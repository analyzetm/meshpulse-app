import { Global, Module } from '@nestjs/common';

import { ChallengeStoreService } from './challenge-store.service';
import { ServerKeysService } from './server-keys.service';

@Global()
@Module({
  providers: [ChallengeStoreService, ServerKeysService],
  exports: [ChallengeStoreService, ServerKeysService]
})
export class SecurityModule {}
