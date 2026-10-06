-- CreateEnum
CREATE TYPE "BillingMode" AS ENUM ('FREE', 'GROSS_SHARE', 'NET_SHARE');

-- CreateEnum
CREATE TYPE "BillingAgreementStatus" AS ENUM ('PENDING_APPROVAL', 'ACTIVE', 'DECLINED', 'CANCELLED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "BillingChargeStatus" AS ENUM ('PENDING', 'BILLED', 'CAP_EXCEEDED', 'VOID');

-- CreateEnum
CREATE TYPE "BillingSourceType" AS ENUM ('PURCHASE', 'REFUND');

-- CreateTable
CREATE TABLE "BillingAgreement" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "mode" "BillingMode" NOT NULL,
    "rateBasisPoints" INTEGER NOT NULL,
    "cappedAmount" DECIMAL(20,4),
    "pendingCappedAmount" DECIMAL(20,4),
    "currencyCode" TEXT,
    "subscriptionGid" TEXT,
    "usageLineItemGid" TEXT,
    "status" "BillingAgreementStatus" NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingAgreement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingEntry" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "sourceType" "BillingSourceType" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "amount" DECIMAL(20,4) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "chargeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingCharge" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "periodDate" DATE,
    "baseAmount" DECIMAL(20,4) NOT NULL,
    "chargeAmount" DECIMAL(20,4) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "status" "BillingChargeStatus" NOT NULL DEFAULT 'PENDING',
    "usageRecordGid" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "errorMessage" TEXT,
    "billedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingCharge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingAgreement_subscriptionGid_key" ON "BillingAgreement"("subscriptionGid");

-- CreateIndex
CREATE INDEX "BillingAgreement_status_idx" ON "BillingAgreement"("status");

-- CreateIndex
CREATE UNIQUE INDEX "BillingAgreement_shopId_version_key" ON "BillingAgreement"("shopId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "BillingAgreement_id_shopId_key" ON "BillingAgreement"("id", "shopId");

-- CreateIndex
CREATE INDEX "BillingEntry_shopId_agreementId_chargeId_idx" ON "BillingEntry"("shopId", "agreementId", "chargeId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingEntry_shopId_sourceType_sourceId_revision_key" ON "BillingEntry"("shopId", "sourceType", "sourceId", "revision");

-- CreateIndex
CREATE INDEX "BillingCharge_status_nextAttemptAt_idx" ON "BillingCharge"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingCharge_id_shopId_key" ON "BillingCharge"("id", "shopId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingCharge_agreementId_periodDate_key" ON "BillingCharge"("agreementId", "periodDate");

-- AddForeignKey
ALTER TABLE "BillingAgreement" ADD CONSTRAINT "BillingAgreement_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingEntry" ADD CONSTRAINT "BillingEntry_agreementId_shopId_fkey" FOREIGN KEY ("agreementId", "shopId") REFERENCES "BillingAgreement"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingEntry" ADD CONSTRAINT "BillingEntry_chargeId_shopId_fkey" FOREIGN KEY ("chargeId", "shopId") REFERENCES "BillingCharge"("id", "shopId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingCharge" ADD CONSTRAINT "BillingCharge_agreementId_shopId_fkey" FOREIGN KEY ("agreementId", "shopId") REFERENCES "BillingAgreement"("id", "shopId") ON DELETE CASCADE ON UPDATE CASCADE;


-- At most one open agreement per shop.
CREATE UNIQUE INDEX "BillingAgreement_one_open_per_shop" ON "BillingAgreement"("shopId")
  WHERE "status" IN ('PENDING_APPROVAL', 'ACTIVE');

ALTER TABLE "BillingAgreement" ADD CONSTRAINT "BillingAgreement_terms_check" CHECK (
  ("mode" = 'FREE' AND "rateBasisPoints" = 0 AND "cappedAmount" IS NULL)
  OR ("mode" <> 'FREE' AND "rateBasisPoints" BETWEEN 1 AND 10000
    AND "cappedAmount" > 0 AND "currencyCode" IS NOT NULL)
);
ALTER TABLE "BillingEntry" ADD CONSTRAINT "BillingEntry_amount_check" CHECK ("amount" <> 0);
ALTER TABLE "BillingCharge" ADD CONSTRAINT "BillingCharge_amount_check"
  CHECK ("chargeAmount" > 0 AND "baseAmount" > 0);

-- Entries are append-only. The only update allowed assigns an unassigned
-- entry to a charge. Privacy redaction may delete them, as with ClaimEvent.
CREATE FUNCTION prevent_billing_entry_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('app.allow_shop_redaction', true) = 'on' THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'BillingEntry is append-only';
  END IF;
  IF OLD."chargeId" IS NULL AND NEW."chargeId" IS NOT NULL
    AND (NEW.id, NEW."shopId", NEW."agreementId", NEW."sourceType", NEW."sourceId", NEW.revision,
         NEW.amount, NEW."currencyCode", NEW."createdAt")
      IS NOT DISTINCT FROM
        (OLD.id, OLD."shopId", OLD."agreementId", OLD."sourceType", OLD."sourceId", OLD.revision,
         OLD.amount, OLD."currencyCode", OLD."createdAt") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'BillingEntry is append-only';
END $$;
CREATE TRIGGER "BillingEntry_append_only" BEFORE UPDATE OR DELETE ON "BillingEntry"
  FOR EACH ROW EXECUTE FUNCTION prevent_billing_entry_mutation();
