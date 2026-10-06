import process from "node:process";
import prisma from "../app/db.server.js";
import { processNextDelivery } from "../app/webhook-worker.server.js";

// Started by verify-webhook-postgres.js. Processes the next delivery batch,
// prints a marker once the order is persisted but not committed, then waits
// for the parent to SIGKILL it there.
const order = JSON.parse(process.argv[2]);
const admin = { graphql: async (query) => ({ json: async () => ({ data: {
  order: query.includes("query OrderVersion") ? { updatedAt: order.updatedAt } : structuredClone(order),
} }) }) };

// Marking the deliveries PROCESSED is the transaction's last step, after the
// order is persisted; stall there.
function stallBeforeCommit(transaction) {
  return new Proxy(transaction, { get(target, prop) {
    if (prop !== "webhookDelivery") return Reflect.get(target, prop);
    return {
      count: (args) => target.webhookDelivery.count(args),
      updateMany: async () => {
        process.stdout.write("PERSISTED_NOT_COMMITTED\n");
        await new Promise(() => setInterval(() => {}, 1_000));
      },
    };
  } });
}

const database = new Proxy(prisma, { get(target, prop) {
  if (prop === "$transaction") {
    return (callback, options) => target.$transaction((transaction) => callback(stallBeforeCommit(transaction)), options);
  }
  const value = Reflect.get(target, prop);
  return typeof value === "function" ? value.bind(target) : value;
} });

await processNextDelivery({ database, adminForShop: async () => ({ admin }) });
// Reaching here means the stall never happened.
process.exit(1);
