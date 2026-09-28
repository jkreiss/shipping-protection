import { handleOrderWebhook } from "../order-webhook-route.server";

export const action = ({ request }) => handleOrderWebhook(request);
