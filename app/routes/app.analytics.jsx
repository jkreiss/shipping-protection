/* eslint-disable react/prop-types */
import { useEffect, useRef } from "react";
import { useFetcher, useLoaderData, useRevalidator, useSearchParams } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { readAnalytics } from "../analytics.server";
import { reconcileOrders } from "../order-reconciliation.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  return readAnalytics({ admin, shopDomain: session.shop, search: new URL(request.url).searchParams });
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  try {
    return await reconcileOrders({ admin, shopDomain: session.shop, maxPages: 3 });
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Analytics sync failed." };
  }
};

function Trend({ days, currencyCode, range }) {
  if (!days.length) return <s-paragraph>No revenue or refunds in this range.</s-paragraph>;
  const amounts = days.flatMap((day) => [Number(day.revenue), Number(day.refunds)]);
  const max = Math.max(...amounts, 0.01);
  const first = Date.parse(`${range.start ?? days[0].date}T00:00:00Z`);
  const last = Date.parse(`${range.end}T00:00:00Z`);
  const points = (field) => days.map((day) => {
    const x = first === last ? 360 : 20 + ((Date.parse(`${day.date}T00:00:00Z`) - first) * 680) / (last - first);
    const y = 160 - (Number(day[field]) / max) * 140;
    return `${x},${y}`;
  }).join(" ");
  return (
    <>
      <svg viewBox="0 0 720 180" role="img" aria-label={`Daily protection revenue and refunds in ${currencyCode}`} style={{ width: "100%", maxHeight: 240 }}>
        <line x1="20" y1="160" x2="700" y2="160" stroke="currentColor" opacity="0.3" />
        <polyline points={points("revenue")} fill="none" stroke="#287d5a" strokeWidth="3" />
        <polyline points={points("refunds")} fill="none" stroke="#b65b38" strokeWidth="3" />
      </svg>
      <s-paragraph>Green: revenue · Orange: refunds. Values use {currencyCode} shop currency.</s-paragraph>
      <details>
        <summary>Daily values</summary>
        <table style={{ width: "100%", textAlign: "left" }}>
          <thead><tr><th>Date</th><th>Revenue</th><th>Refunds</th></tr></thead>
          <tbody>{days.map((day) => <tr key={day.date}><td>{day.date}</td><td>{day.revenue}</td><td>{day.refunds}</td></tr>)}</tbody>
        </table>
      </details>
    </>
  );
}

export default function Analytics() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const [params, setParams] = useSearchParams();
  const started = useRef(false);
  const lastSyncResult = useRef(null);
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      fetcher.submit({}, { method: "post" });
    }
  }, [fetcher]);
  useEffect(() => {
    if (fetcher.data && fetcher.data !== lastSyncResult.current && !fetcher.data.error) {
      lastSyncResult.current = fetcher.data;
      revalidator.revalidate();
    }
  }, [fetcher.data, revalidator]);
  const money = (value) => new Intl.NumberFormat(undefined, {
    style: "currency", currency: data.currencyCode,
  }).format(Number(value));
  const update = (key, value) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next);
  };
  const pending = fetcher.state !== "idle";
  const notices = data.notices;
  return (
    <s-page heading="Analytics">
      <s-section heading="Date range">
        <s-stack direction="block" gap="base">
          <s-paragraph>Dates use {data.timeZone}. Revenue is dated by completed payment; refunds by successful refund transaction.</s-paragraph>
          <label>Period{" "}
            <select value={data.range.preset} onChange={(event) => update("range", event.target.value)}>
              <option value="7">Last 7 days</option><option value="30">Last 30 days</option>
              <option value="90">Last 90 days</option><option value="all">All available history</option>
              <option value="custom">Custom range</option>
            </select>
          </label>
          {data.range.preset === "custom" && <s-stack direction="inline" gap="base">
            <label>From <input type="date" value={data.range.start} onChange={(event) => update("start", event.target.value)} /></label>
            <label>Through <input type="date" value={data.range.end} onChange={(event) => update("end", event.target.value)} /></label>
          </s-stack>}
          <label><input type="checkbox" checked={data.includeTest} onChange={(event) => update("test", event.target.checked ? "1" : "")} /> Include test orders (preview only)</label>
        </s-stack>
      </s-section>

      <s-section heading="Overview">
        {!data.includeTest && data.hiddenTestOrders > 0 && data.eligibleOrders === 0 && data.protectedOrders === 0 && (
          <s-banner heading="Test orders are hidden" tone="info">
            <s-paragraph>
              {data.hiddenTestOrders} paid test {data.hiddenTestOrders === 1 ? "order was" : "orders were"} synced for this date range. Test orders are excluded from the default metrics.
            </s-paragraph>
            <s-button onClick={() => update("test", "1")}>Show test-order preview</s-button>
          </s-banner>
        )}
        <s-stack direction="inline" gap="base">
          {[
            ["Protected orders", data.protectedOrders],
            ["Eligible orders", data.eligibleOrders],
            ["Attach rate", data.attachRate === null ? "—" : `${data.attachRate.toFixed(1)}%`],
            ["Protection revenue", money(data.revenue)],
            ["Protection refunds", money(data.refunds)],
            ["Protected GMV", money(data.protectedGmv)],
            ["Average protection fee", data.averageProtectionFee === null ? "—" : money(data.averageProtectionFee)],
          ].map(([label, value]) => <s-box key={label} padding="base" borderWidth="base" borderRadius="base">
            <s-stack direction="block" gap="small-200"><s-text>{label}</s-text><s-heading>{value}</s-heading></s-stack>
          </s-box>)}
        </s-stack>
        <s-paragraph>Attach rate is protected eligible paid orders divided by eligible paid orders. Eligibility is an order-based estimate because checkout exposure is unknown. Protected GMV is paid shippable merchandise after discounts, excluding protection, shipping, and tax.</s-paragraph>
      </s-section>

      <s-section heading="Daily trend">
        <Trend days={data.trend} currencyCode={data.currencyCode} range={data.range} />
      </s-section>

      <s-section heading="Data coverage">
        <s-stack direction="block" gap="base">
          <s-paragraph>{data.sync.complete ? `Last completed scan: ${data.sync.reconciledThrough}.` : "Initial order scan is incomplete."} Shopify generally makes only the last 60 days of orders available to this app; older orders appear only if already stored locally.</s-paragraph>
          {data.sync.historyLimited && <s-banner heading="History may be incomplete" tone="warning">This range extends beyond the verified order scan. Older orders and their metrics may be missing.</s-banner>}
          {fetcher.data && !fetcher.data.error && <s-paragraph>Latest batch: {fetcher.data.ordersProcessed} orders across {fetcher.data.pages} pages; {fetcher.data.pendingRechecked} pending refund orders rechecked. {fetcher.data.complete ? "Scan complete." : "More pages remain."}</s-paragraph>}
          {fetcher.data?.error && <s-banner heading="Sync needs attention" tone="critical">{fetcher.data.error}</s-banner>}
          <s-button onClick={() => fetcher.submit({}, { method: "post" })} {...(pending ? { loading: true } : {})}> {data.sync.complete ? "Refresh data" : "Continue sync"} </s-button>
        </s-stack>
      </s-section>

      {(notices.pending || notices.unattributed || notices.currencyMismatch || notices.unresolvedPayments || notices.missingGmvSnapshots) ? <s-section heading="Data quality">
        <s-banner heading="Some records need review" tone="warning">
          {notices.pending} protection refunds await successful payment; {notices.unattributed} refunds cannot be attributed to a protection line; {notices.currencyMismatch} records use a different shop currency; {notices.unresolvedPayments} orders have a paid status without a dated successful payment transaction; {notices.missingGmvSnapshots} older protected orders lack a paid merchandise snapshot.
        </s-banner>
      </s-section> : null}
    </s-page>
  );
}

export const headers = (args) => boundary.headers(args);
