import process from "node:process";
import { runEditingCommand } from "./checkout-editing.js";

process.exitCode = await runEditingCommand({ args: process.argv.slice(2), legacy: true });
