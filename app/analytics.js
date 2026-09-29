import { moneyToScaled, scaledToMoney } from "./order-normalization.js";

export function calendarDate(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(value));
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function shiftDate(date, days) {
  const shifted = new Date(`${date}T12:00:00Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

export function analyticsRange(search, timeZone, now = new Date()) {
  const params = search instanceof URLSearchParams ? search : new URLSearchParams(search);
  const preset = ["7", "30", "90", "all", "custom"].includes(params.get("range"))
    ? params.get("range") : "30";
  const today = calendarDate(now, timeZone);
  if (preset === "all") return { preset, start: null, end: today };
  if (preset === "custom") {
    const start = params.get("start") || shiftDate(today, -29);
    const end = params.get("end") || today;
    if (!validDate(start) || !validDate(end) || start > end) {
      throw new RangeError("Choose a valid custom date range.");
    }
    return { preset, start, end };
  }
  return { preset, start: shiftDate(today, 1 - Number(preset)), end: today };
}

export function aggregateAnalytics({ orders, refunds, timeZone, currencyCode, range, includeTest = false }) {
  let eligibleOrders = 0;
  let protectedOrders = 0;
  let protectedEligibleOrders = 0;
  let revenue = 0n;
  let protectedGmv = 0n;
  let missingGmvSnapshots = 0;
  let refundAmount = 0n;
  let currencyMismatch = 0;
  let unresolvedPayments = 0;
  let hiddenTestOrders = 0;
  const trend = new Map();
  const inRange = (date) => date && (!range.start || date >= range.start) && date <= range.end;
  const bucket = (date) => {
    if (!trend.has(date)) trend.set(date, { date, revenue: 0n, refunds: 0n });
    return trend.get(date);
  };
  for (const order of orders) {
    if (!includeTest && order.isTest) {
      if (order.firstPaidAt && order.currencyCode === currencyCode &&
        inRange(calendarDate(order.firstPaidAt, timeZone))) hiddenTestOrders += 1;
      continue;
    }
    if (!order.firstPaidAt && ["PAID", "PARTIALLY_REFUNDED", "REFUNDED"].includes(order.financialStatus)) unresolvedPayments += 1;
    if (!order.firstPaidAt) continue;
    const date = calendarDate(order.firstPaidAt, timeZone);
    if (!inRange(date)) continue;
    if (order.currencyCode !== currencyCode) { currencyMismatch += 1; continue; }
    if (order.paidEligible) eligibleOrders += 1;
    const purchase = order.protectionPurchase?.purchasedAt ? order.protectionPurchase : null;
    if (purchase && inRange(calendarDate(purchase.purchasedAt, timeZone))) {
      if (purchase.currencyCode !== currencyCode) { currencyMismatch += 1; continue; }
      protectedOrders += 1;
      if (order.paidEligible) protectedEligibleOrders += 1;
      const amount = moneyToScaled(purchase.feeAmount);
      revenue += amount;
      if (purchase.coveredMerchandiseAmount === null || purchase.coveredMerchandiseAmount === undefined) {
        missingGmvSnapshots += 1;
      } else {
        protectedGmv += moneyToScaled(purchase.coveredMerchandiseAmount);
      }
      bucket(calendarDate(purchase.purchasedAt, timeZone)).revenue += amount;
    }
  }
  const unresolvedRefunds = { pending: 0, unattributed: 0 };
  for (const refund of refunds) {
    if (!includeTest && refund.order.isTest) continue;
    if (refund.status === "PENDING") unresolvedRefunds.pending += 1;
    if (refund.status === "UNATTRIBUTED") unresolvedRefunds.unattributed += 1;
    if (refund.status !== "CONFIRMED" || !refund.succeededAt) continue;
    const date = calendarDate(refund.succeededAt, timeZone);
    if (!inRange(date)) continue;
    if (refund.currencyCode !== currencyCode) { currencyMismatch += 1; continue; }
    const amount = moneyToScaled(refund.amount);
    refundAmount += amount;
    bucket(date).refunds += amount;
  }
  return {
    eligibleOrders, protectedOrders, hiddenTestOrders,
    attachRate: eligibleOrders ? (protectedEligibleOrders / eligibleOrders) * 100 : null,
    revenue: scaledToMoney(revenue), refunds: scaledToMoney(refundAmount),
    protectedGmv: scaledToMoney(protectedGmv),
    averageProtectionFee: protectedOrders ? scaledToMoney((revenue + BigInt(Math.floor(protectedOrders / 2))) / BigInt(protectedOrders)) : null,
    trend: [...trend.values()].sort((a, b) => a.date.localeCompare(b.date)).map((day) => ({
      date: day.date, revenue: scaledToMoney(day.revenue), refunds: scaledToMoney(day.refunds),
    })),
    notices: { ...unresolvedRefunds, currencyMismatch, unresolvedPayments, missingGmvSnapshots },
  };
}
