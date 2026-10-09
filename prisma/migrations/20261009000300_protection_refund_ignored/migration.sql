-- A refund stored while its money was still moving can later turn out to owe
-- nothing (for example, its transaction failed). It is kept as IGNORED rather
-- than deleted, so the record stays while leaving the recheck queue and totals.
ALTER TYPE "ProtectionRefundStatus" ADD VALUE 'IGNORED';
