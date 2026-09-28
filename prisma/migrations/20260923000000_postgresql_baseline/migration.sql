CREATE SCHEMA IF NOT EXISTS "public";

CREATE TYPE "ShopInstallationState" AS ENUM ('INSTALLED', 'UNINSTALLED');
CREATE TYPE "PricingRuleState" AS ENUM ('PENDING', 'ACTIVE', 'FAILED', 'SUPERSEDED');
CREATE TYPE "WebhookProcessingStatus" AS ENUM ('PROCESSING', 'PROCESSED', 'FAILED');
CREATE TYPE "ProtectionAttributionStatus" AS ENUM ('ATTRIBUTED', 'UNATTRIBUTED');

CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopGid" TEXT,
    "installationState" "ShopInstallationState" NOT NULL DEFAULT 'INSTALLED',
    "activePricingRuleId" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "orderReconciliationSince" TIMESTAMP(3),
    "orderReconciliationCursor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PricingRule" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "productId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "rateBasisPoints" INTEGER NOT NULL,
    "basis" TEXT NOT NULL,
    "state" "PricingRuleState" NOT NULL DEFAULT 'PENDING',
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PricingRule_rateBasisPoints_check" CHECK ("rateBasisPoints" BETWEEN 1 AND 10000),
    CONSTRAINT "PricingRule_version_check" CHECK ("version" >= 1),
    CONSTRAINT "PricingRule_basis_check" CHECK ("basis" = 'SHIPPABLE_PRE_DISCOUNT'),
    CONSTRAINT "PricingRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "eventId" TEXT,
    "topic" TEXT NOT NULL,
    "status" "WebhookProcessingStatus" NOT NULL DEFAULT 'PROCESSING',
    "errorMessage" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "checkoutTokenHash" TEXT,
    "shopifyCreatedAt" TIMESTAMP(3) NOT NULL,
    "shopifyUpdatedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),
    "currencyCode" TEXT NOT NULL,
    "subtotalAmount" DECIMAL(20,4) NOT NULL,
    "totalAmount" DECIMAL(20,4) NOT NULL,
    "totalDiscountsAmount" DECIMAL(20,4) NOT NULL,
    "totalShippingAmount" DECIMAL(20,4) NOT NULL,
    "totalTaxAmount" DECIMAL(20,4) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OrderLine" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shopifyLineItemId" TEXT NOT NULL,
    "productId" TEXT,
    "variantId" TEXT,
    "quantity" INTEGER NOT NULL,
    "requiresShipping" BOOLEAN NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "originalUnitAmount" DECIMAL(20,4) NOT NULL,
    "preDiscountAmount" DECIMAL(20,4) NOT NULL,
    "totalDiscountAmount" DECIMAL(20,4) NOT NULL,
    "finalAmount" DECIMAL(20,4) NOT NULL,
    "isProtection" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrderLine_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProtectionPurchase" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "pricingRuleId" TEXT,
    "ruleId" TEXT,
    "ruleVersion" INTEGER,
    "rateBasisPoints" INTEGER,
    "basis" TEXT,
    "currencyCode" TEXT NOT NULL,
    "eligibleSubtotalAmount" DECIMAL(20,4) NOT NULL,
    "feeAmount" DECIMAL(20,4) NOT NULL,
    "attributionStatus" "ProtectionAttributionStatus" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProtectionPurchase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");
CREATE UNIQUE INDEX "Shop_shopGid_key" ON "Shop"("shopGid");
CREATE UNIQUE INDEX "Shop_activePricingRuleId_key" ON "Shop"("activePricingRuleId");
CREATE UNIQUE INDEX "PricingRule_ruleId_key" ON "PricingRule"("ruleId");
CREATE INDEX "PricingRule_shopId_state_idx" ON "PricingRule"("shopId", "state");
CREATE UNIQUE INDEX "PricingRule_shopId_version_key" ON "PricingRule"("shopId", "version");
CREATE INDEX "WebhookDelivery_shopId_eventId_idx" ON "WebhookDelivery"("shopId", "eventId");
CREATE INDEX "WebhookDelivery_shopId_topic_status_idx" ON "WebhookDelivery"("shopId", "topic", "status");
CREATE UNIQUE INDEX "WebhookDelivery_shopId_webhookId_key" ON "WebhookDelivery"("shopId", "webhookId");
CREATE INDEX "Order_shopId_shopifyUpdatedAt_shopifyOrderId_idx" ON "Order"("shopId", "shopifyUpdatedAt", "shopifyOrderId");
CREATE UNIQUE INDEX "Order_shopId_shopifyOrderId_key" ON "Order"("shopId", "shopifyOrderId");
CREATE INDEX "OrderLine_orderId_isProtection_idx" ON "OrderLine"("orderId", "isProtection");
CREATE UNIQUE INDEX "OrderLine_orderId_shopifyLineItemId_key" ON "OrderLine"("orderId", "shopifyLineItemId");
CREATE UNIQUE INDEX "ProtectionPurchase_orderId_key" ON "ProtectionPurchase"("orderId");
CREATE INDEX "ProtectionPurchase_pricingRuleId_idx" ON "ProtectionPurchase"("pricingRuleId");
CREATE INDEX "ProtectionPurchase_attributionStatus_idx" ON "ProtectionPurchase"("attributionStatus");
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

ALTER TABLE "Shop" ADD CONSTRAINT "Shop_activePricingRuleId_fkey" FOREIGN KEY ("activePricingRuleId") REFERENCES "PricingRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PricingRule" ADD CONSTRAINT "PricingRule_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderLine" ADD CONSTRAINT "OrderLine_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProtectionPurchase" ADD CONSTRAINT "ProtectionPurchase_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProtectionPurchase" ADD CONSTRAINT "ProtectionPurchase_pricingRuleId_fkey" FOREIGN KEY ("pricingRuleId") REFERENCES "PricingRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Session" ADD CONSTRAINT "Session_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Shop"("shopDomain") ON DELETE CASCADE ON UPDATE CASCADE;
