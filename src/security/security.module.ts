import { Global, Module } from '@nestjs/common';

import { ChallengeStoreService } from './challenge-store.service';
import { IpGeoService } from './ip-geo.service';
import { NodeSessionStoreService } from './node-session-store.service';
import { ServerKeysService } from './server-keys.service';

@Global()
@Module({
  providers: [
    ChallengeStoreService,
    ServerKeysService,
    IpGeoService,
    NodeSessionStoreService
  ],
  exports: [
    ChallengeStoreService,
    ServerKeysService,
    IpGeoService,
    NodeSessionStoreService
  ]
})
export class SecurityModule {}
