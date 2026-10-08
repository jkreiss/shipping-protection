import { beforeEach, describe, expect, test, vi } from "vitest";

const authenticateWebhook = vi.fn();
const reportFailure = vi.fn();
const receiveOrderWebhook = vi.fn();

vi.mock("./shopify.server", () => ({ authenticate: { webhook: (...args) => authenticateWebhook(...args) } }));
vi.mock("./observability.server.js", () => ({ logEvent: vi.fn(), reportFailure: (...args) => reportFailure(...args) }));
vi.mock("./webhook-inbox.server.js", async (importOriginal) => ({
  ...(await importOriginal()),
  receiveOrderWebhook: (...args) => receiveOrderWebhook(...args),
}));

const { handleOrderWebhook } = await import("./order-webhook-route.server.js");
const { PermanentWebhookError } = await import("./webhook-inbox.server.js");

const request = () => new Request("https://app.example/webhooks/orders", {
  method: "POST", headers: { "X-Shopify-Webhook-Id": "delivery-1", "X-Shopify-Event-Id": "event-1" },
});

describe("order webhook route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authenticateWebhook.mockResolvedValue({ payload: { id: 123 }, shop: "one.myshopify.com", topic: "ORDERS_CREATE" });
  });

  test("acknowledges a stored delivery", async () => {
    receiveOrderWebhook.mockResolvedValue("delivery-row-1");
    const response = await handleOrderWebhook(request());
    expect(response.status).toBe(200);
    expect(reportFailure).not.toHaveBeenCalled();
  });

  test("acknowledges a delivery that can never be stored and reports it, so Shopify stops retrying", async () => {
    receiveOrderWebhook.mockRejectedValue(new PermanentWebhookError("Webhook has no valid Shopify order ID."));
    const response = await handleOrderWebhook(request());
    expect(response.status).toBe(200);
    expect(reportFailure).toHaveBeenCalledWith("webhook_rejected", expect.any(PermanentWebhookError),
      expect.objectContaining({ shop: "one.myshopify.com", topic: "ORDERS_CREATE", webhookId: "delivery-1" }));
  });

  test("rejects receipt on a database failure so Shopify can retry", async () => {
    receiveOrderWebhook.mockRejectedValue(new Error("database down"));
    const response = await handleOrderWebhook(request());
    expect(response.status).toBe(500);
    expect(reportFailure).toHaveBeenCalledWith("webhook_receipt", expect.any(Error), expect.any(Object));
  });
});
