import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isIP } from 'node:net';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import maxmind, { Reader, CityResponse, AsnResponse } from 'maxmind';

export type ConnectionMetadata = {
  remoteIp: string | null;
  ipVersion: number | null;
  countryCode: string | null;
  regionCode: string | null;
  city: string | null;
  asn: number | null;
  ispOrOrg: string | null;
};

@Injectable()
export class IpGeoService implements OnModuleInit {
  private readonly logger = new Logger(IpGeoService.name);
  private readonly cityDbPath = resolve(
    process.env.GEOLITE2_CITY_DB_PATH ?? '.secrets/GeoLite2-City.mmdb'
  );
  private readonly asnDbPath = resolve(
    process.env.GEOLITE2_ASN_DB_PATH ?? '.secrets/GeoLite2-ASN.mmdb'
  );
  private cityReader?: Reader<CityResponse>;
  private asnReader?: Reader<AsnResponse>;

  async onModuleInit() {
    await Promise.all([this.loadCityReader(), this.loadAsnReader()]);
  }

  detectRemoteIp(headers: Record<string, unknown>, socketRemoteAddress?: string | null) {
    const headerCandidates = [
      headers['x-forwarded-for'],
      headers['x-real-ip'],
      headers['cf-connecting-ip']
    ];

    for (const candidate of headerCandidates) {
      const resolved = this.extractIp(candidate);
      if (resolved) {
        return resolved;
      }
    }

    return this.normalizeIp(socketRemoteAddress ?? null);
  }

  async lookup(ip: string | null): Promise<ConnectionMetadata> {
    const normalizedIp = this.normalizeIp(ip);
    const ipVersion = normalizedIp ? isIP(normalizedIp) : 0;

    if (!normalizedIp || ipVersion === 0 || this.isPrivateIp(normalizedIp)) {
      return {
        remoteIp: normalizedIp,
        ipVersion: ipVersion || null,
        countryCode: null,
        regionCode: null,
        city: null,
        asn: null,
        ispOrOrg: null
      };
    }

    const cityRecord = this.cityReader?.get(normalizedIp);
    const asnRecord = this.asnReader?.get(normalizedIp);

    return {
      remoteIp: normalizedIp,
      ipVersion,
      countryCode: cityRecord?.country?.iso_code ?? null,
      regionCode: cityRecord?.subdivisions?.[0]?.iso_code ?? null,
      city: cityRecord?.city?.names?.en ?? null,
      asn: asnRecord?.autonomous_system_number ?? null,
      ispOrOrg: asnRecord?.autonomous_system_organization ?? null
    };
  }

  private async loadCityReader() {
    if (!existsSync(this.cityDbPath)) {
      this.logger.warn(`GeoLite2 City DB not found at ${this.cityDbPath}`);
      return;
    }

    this.cityReader = await maxmind.open<CityResponse>(this.cityDbPath);
    this.logger.log(`Loaded GeoLite2 City DB from ${this.cityDbPath}`);
  }

  private async loadAsnReader() {
    if (!existsSync(this.asnDbPath)) {
      this.logger.warn(`GeoLite2 ASN DB not found at ${this.asnDbPath}`);
      return;
    }

    this.asnReader = await maxmind.open<AsnResponse>(this.asnDbPath);
    this.logger.log(`Loaded GeoLite2 ASN DB from ${this.asnDbPath}`);
  }

  private extractIp(candidate: unknown) {
    if (typeof candidate !== 'string') {
      return null;
    }

    for (const part of candidate.split(',')) {
      const ip = this.normalizeIp(part.trim());
      if (ip) {
        return ip;
      }
    }

    return null;
  }

  private normalizeIp(value: string | null) {
    if (!value) {
      return null;
    }

    let normalized = value.trim();

    if (normalized.startsWith('::ffff:')) {
      normalized = normalized.slice('::ffff:'.length);
    }

    if (normalized.startsWith('[') && normalized.endsWith(']')) {
      normalized = normalized.slice(1, -1);
    }

    if (isIP(normalized)) {
      return normalized;
    }

    return null;
  }

  private isPrivateIp(ip: string) {
    if (ip === '127.0.0.1' || ip === '::1') {
      return true;
    }

    if (ip.startsWith('10.') || ip.startsWith('192.168.')) {
      return true;
    }

    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) {
      return true;
    }

    if (ip.startsWith('fc') || ip.startsWith('fd')) {
      return true;
    }

    return false;
  }
}
