import { createHash, randomBytes } from "node:crypto";
import { db } from "../src/db/client.js";
import { apiKeys, tenantConfig, tenants } from "../src/db/schema.js";

function makeId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

function makeApiKey() {
  const raw = `llmg_${randomBytes(20).toString("hex")}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  const prefix = raw.slice(0, 12);
  return { raw, hash, prefix };
}

const tenantId = makeId("tnt");
const keyId = makeId("key");
const key = makeApiKey();
const tenantName = process.argv[2] ?? `tenant-${randomBytes(3).toString("hex")}`;

db.insert(tenants)
  .values({
    id: tenantId,
    name: tenantName,
    status: "active",
  })
  .run();

db.insert(tenantConfig)
  .values({
    tenantId,
    monthlyBudgetUsd: null,
    dailyBudgetUsd: null,
    rateLimitRpm: null,
    rateLimitTpm: null,
  })
  .run();

db.insert(apiKeys)
  .values({
    id: keyId,
    tenantId,
    hash: key.hash,
    prefix: key.prefix,
    label: "seed",
  })
  .run();

console.log("\n==== llmgate seed ====");
console.log("Tenant ID:  ", tenantId);
console.log("Tenant Name:", tenantName);
console.log("API Key ID: ", keyId);
console.log("API Key:    ", key.raw);
console.log();
console.log("Save the API Key — only the hash is stored.");
console.log(`Use it via:  Authorization: Bearer ${key.raw}\n`);
