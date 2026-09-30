/* eslint-disable react/prop-types */
import { useState } from "react";
import { useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { readOverview } from "../analytics.server";
import { readShippingProtectionState } from "../shipping-protection.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const includeTest = new URL(request.url).searchParams.get("test") === "1";
  const [protection, metrics] = await Promise.all([
    readShippingProtectionState(admin, session.shop),
    readOverview({ admin, shopDomain: session.shop, includeTest }),
  ]);
  return {
    protection: {
      active: protection.configuration.protectionEnabled,
      rate: protection.pricing?.percentage ?? null,
    },
    metrics,
  };
};

const CHART = { width: 720, height: 200, left: 56, right: 8, top: 12, bottom: 28 };

function adminOrderUrl(shopifyOrderId) {
  return `shopify:admin/orders/${String(shopifyOrderId).split("/").pop()}`;
}

function formatDay(date, withWeekday = false) {
  return new Intl.DateTimeFormat(undefined, {
    ...(withWeekday ? { weekday: "short" } : {}), month: "short", day: "numeric", timeZone: "UTC",
  }).format(new Date(`${date}T00:00:00Z`));
}

function RevenueTrend({ days, money }) {
  const [active, setActive] = useState(null);
  const values = days.map((day) => Number(day.revenue));
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total === 0) {
    return <s-paragraph color="subdued">No protection revenue in the last 30 days.</s-paragraph>;
  }
  const max = Math.max(...values);
  const plotWidth = CHART.width - CHART.left - CHART.right;
  const plotHeight = CHART.height - CHART.top - CHART.bottom;
  const baseline = CHART.top + plotHeight;
  const slot = plotWidth / days.length;
  const barWidth = Math.min(24, slot - 2);
  const bar = (value, index) => {
    const height = (value / max) * plotHeight;
    const x = CHART.left + index * slot + (slot - barWidth) / 2;
    const y = baseline - height;
    const radius = Math.min(4, height, barWidth / 2);
    return `M${x},${baseline} V${y + radius} Q${x},${y} ${x + radius},${y} H${x + barWidth - radius} Q${x + barWidth},${y} ${x + barWidth},${y + radius} V${baseline} Z`;
  };
  const labelIndexes = [0, Math.floor((days.length - 1) / 2), days.length - 1];
  const readout = active === null
    ? `30-day total ${money(total)}`
    : `${formatDay(days[active].date, true)} · ${money(values[active])}`;

  return (
    <s-stack direction="block" gap="small-200">
      <s-text color="subdued">{readout}</s-text>
      <svg
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        role="img"
        aria-label={`Daily protection revenue for the last 30 days. Total ${money(total)}, highest day ${money(max)}.`}
        style={{ width: "100%", height: "auto", display: "block" }}
        onMouseLeave={() => setActive(null)}
      >
        <line x1={CHART.left} x2={CHART.width - CHART.right} y1={CHART.top} y2={CHART.top} stroke="#e3e3e3" />
        <line x1={CHART.left} x2={CHART.width - CHART.right} y1={baseline} y2={baseline} stroke="#8a8a8a" />
        <text x={CHART.left - 8} y={CHART.top + 4} textAnchor="end" fontSize="12" fill="#616161">{money(max)}</text>
        <text x={CHART.left - 8} y={baseline + 4} textAnchor="end" fontSize="12" fill="#616161">{money(0)}</text>
        {labelIndexes.map((index) => (
          <text
            key={days[index].date}
            x={CHART.left + index * slot + slot / 2}
            y={CHART.height - 8}
            textAnchor={index === 0 ? "start" : index === days.length - 1 ? "end" : "middle"}
            fontSize="12"
            fill="#616161"
          >
            {formatDay(days[index].date)}
          </text>
        ))}
        {values.map((value, index) => value > 0 && (
          <path
            key={days[index].date}
            d={bar(value, index)}
            fill="#2a78d6"
            opacity={active === null || active === index ? 1 : 0.45}
          />
        ))}
        {days.map((day, index) => (
          <rect
            key={day.date}
            x={CHART.left + index * slot}
            y={CHART.top}
            width={slot}
            height={plotHeight}
            fill="transparent"
            tabIndex={0}
            aria-label={`${formatDay(day.date)}: ${money(values[index])}`}
            onMouseEnter={() => setActive(index)}
            onFocus={() => setActive(index)}
            onBlur={() => setActive(null)}
          />
        ))}
      </svg>
    </s-stack>
  );
}

function MetricTile({ label, value, caption = null }) {
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-text color="subdued">{label}</s-text>
        <s-heading>{value}</s-heading>
        {caption && <s-text color="subdued">{caption}</s-text>}
      </s-stack>
    </s-box>
  );
}

function dataQualityMessages(notices) {
  return [
    [notices.pending, "protection refunds are waiting for payment to complete"],
    [notices.unattributed, "refunds couldn't be matched to a protection line"],
    [notices.currencyMismatch, "records use a different currency from the shop and are excluded"],
    [notices.unresolvedPayments, "paid orders have no dated payment yet"],
    [notices.unmatchedPricing, "protected orders weren't charged the live price"],
  ].filter(([count]) => count > 0).map(([count, text]) => `${count} ${text}`);
}

export default function Overview() {
  const { protection, metrics } = useLoaderData();
  // Orders sync in the background worker; Refresh only re-reads stored data.
  const revalidator = useRevalidator();
  const [params, setParams] = useSearchParams();

  const money = (value, currency = metrics.currencyCode) => new Intl.NumberFormat(undefined, {
    style: "currency", currency,
  }).format(Number(value));
  const setTestPreview = (enabled) => {
    const next = new URLSearchParams(params);
    if (enabled) next.set("test", "1"); else next.delete("test");
    setParams(next);
  };
  const refreshing = revalidator.state !== "idle";
  const noLiveData = metrics.eligibleOrders === 0 && metrics.protectedOrders === 0;
  const qualityMessages = dataQualityMessages(metrics.notices);

  return (
    <s-page heading="Overview">
      <s-section>
        <s-grid gridTemplateColumns="1fr auto" gap="base" alignItems="center">
          <s-stack direction="block" gap="small-200">
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-heading>Shipping protection</s-heading>
              {protection.active
                ? <s-badge tone="success" icon="check-circle">Active</s-badge>
                : <s-badge tone="warning" icon="alert-triangle">Not active</s-badge>}
            </s-stack>
            <s-text color="subdued">
              {protection.active
                ? `Customers are offered protection at ${protection.rate} of eligible merchandise.`
                : "Finish setup in Settings to start offering protection at checkout."}
            </s-text>
            {protection.active && metrics.recentActivity.length === 0 && (
              <s-text color="subdued">
                No protected orders yet. Check that the protection block is added in your checkout editor.
              </s-text>
            )}
          </s-stack>
          <s-button href="/app/settings" variant={protection.active ? "secondary" : "primary"}>
            {protection.active ? "Manage" : "Finish setup"}
          </s-button>
        </s-grid>
      </s-section>

      {!metrics.includeTest && metrics.hiddenTestOrders > 0 && noLiveData && (
        <s-banner heading="Only test orders so far" tone="info">
          <s-paragraph>
            {metrics.hiddenTestOrders} test {metrics.hiddenTestOrders === 1 ? "order is" : "orders are"} hidden from these numbers.
          </s-paragraph>
          <s-button slot="secondary-actions" onClick={() => setTestPreview(true)}>Include test orders</s-button>
        </s-banner>
      )}
      {metrics.includeTest && (
        <s-banner heading="Test orders included" tone="info">
          <s-paragraph>These numbers include test orders and don&apos;t reflect real revenue.</s-paragraph>
          <s-button slot="secondary-actions" onClick={() => setTestPreview(false)}>Hide test orders</s-button>
        </s-banner>
      )}

      <s-section heading="Last 30 days">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(170px, 1fr))" gap="base">
          <MetricTile label="Protection revenue" value={money(metrics.revenue)} caption="Fees from paid orders" />
          <MetricTile
            label="Attach rate"
            value={metrics.attachRate === null ? "—" : `${metrics.attachRate.toFixed(1)}%`}
            caption={`${metrics.eligibleOrders} eligible ${metrics.eligibleOrders === 1 ? "order" : "orders"}`}
          />
          <MetricTile label="Protected orders" value={metrics.protectedOrders.toLocaleString()} />
          <MetricTile label="Claims paid" value={money(metrics.claimsPaid)} caption="No claim payouts recorded yet" />
          <MetricTile
            label="Net protection revenue"
            value={money(metrics.netRevenue)}
            caption={Number(metrics.refunds) > 0 ? `After ${money(metrics.refunds)} refunded and claims paid` : "After refunds and claims paid"}
          />
        </s-grid>
      </s-section>

      <s-section heading="Protection revenue">
        <RevenueTrend days={metrics.trend} money={money} />
      </s-section>

      <s-section heading="Recent activity">
        {metrics.recentActivity.length === 0 ? (
          <s-paragraph color="subdued">Protected orders and protection refunds will appear here.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Order</s-table-header>
              <s-table-header listSlot="secondary">Activity</s-table-header>
              <s-table-header listSlot="labeled" format="currency">Amount</s-table-header>
              <s-table-header listSlot="labeled">Date</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {metrics.recentActivity.map((entry) => (
                <s-table-row key={entry.id}>
                  <s-table-cell>
                    <s-link href={adminOrderUrl(entry.shopifyOrderId)}>{entry.orderName}</s-link>
                  </s-table-cell>
                  <s-table-cell>
                    {entry.kind === "PURCHASED" ? "Protection purchased" : "Protection refunded"}
                  </s-table-cell>
                  <s-table-cell>
                    {entry.kind === "REFUNDED" ? "−" : ""}{money(entry.amount, entry.currencyCode)}
                  </s-table-cell>
                  <s-table-cell>
                    {new Intl.DateTimeFormat(undefined, {
                      month: "short", day: "numeric", timeZone: metrics.timeZone,
                    }).format(new Date(entry.at))}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      {qualityMessages.length > 0 && (
        <s-banner heading="Some records need review" tone="warning">
          <s-paragraph>{qualityMessages.join("; ")}.</s-paragraph>
        </s-banner>
      )}
      {metrics.sync.behind && (
        <s-banner heading="Order sync is behind" tone="warning">
          <s-paragraph>Some recent orders may be missing from these numbers. They will appear once the sync catches up.</s-paragraph>
        </s-banner>
      )}

      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-text color="subdued">
          {metrics.sync.complete
              ? `Orders synced through ${new Date(metrics.sync.reconciledThrough).toLocaleString()}. Dates use ${metrics.timeZone}.`
              : "Order history is still syncing, so some numbers may be incomplete."}
        </s-text>
        <s-button variant="tertiary" onClick={() => revalidator.revalidate()} disabled={refreshing}>
          Refresh
        </s-button>
      </s-stack>
    </s-page>
  );
}

export const headers = (args) => boundary.headers(args);
