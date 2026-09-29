-- PostgreSQL cannot use a new enum value until the transaction adding it has
-- committed. Keep this migration limited to the enum change; the next migration
-- applies the columns, defaults, and constraints.
ALTER TYPE "WebhookProcessingStatus" ADD VALUE IF NOT EXISTS 'PENDING';
