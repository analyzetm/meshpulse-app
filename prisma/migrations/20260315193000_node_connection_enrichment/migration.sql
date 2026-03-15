ALTER TABLE "nodes"
    ADD COLUMN "remoteIp" TEXT,
    ADD COLUMN "ipVersion" INTEGER,
    ADD COLUMN "countryCode" TEXT,
    ADD COLUMN "regionCode" TEXT,
    ADD COLUMN "city" TEXT,
    ADD COLUMN "asn" INTEGER,
    ADD COLUMN "ispOrOrg" TEXT,
    ADD COLUMN "connectedAt" TIMESTAMP(3);

UPDATE "nodes"
SET "status" = CASE
    WHEN "status" = 'active' AND "isOnline" = true THEN 'online'
    WHEN "status" = 'active' THEN 'offline'
    ELSE "status"
END;
