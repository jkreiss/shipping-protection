import process from "node:process";
import prisma from "../app/db.server.js";
import { unauthenticated } from "../app/shopify.server.js";
import { createWorkerRuntime } from "../app/worker-runtime.server.js";

const worker = createWorkerRuntime({ database: prisma, adminForShop: (shop) => unauthenticated.admin(shop) });
process.on("SIGTERM", worker.stop);
process.on("SIGINT", worker.stop);
await worker.run();
