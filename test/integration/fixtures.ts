// Synthetic shop data: no real names, addresses or companies.
import { Decimal128, ObjectId, type Db } from "mongodb";

export const oid = (n: number): ObjectId => new ObjectId(n.toString(16).padStart(24, "0"));
export const day = (d: number): Date => new Date(Date.UTC(2026, 8, 1) + d * 86_400_000);
export const STATUSES = ["paid", "pending", "refunded"] as const;
export const ORDER_COUNT = 72;

export async function seedShop(db: Db): Promise<void> {
  await db.createCollection("customers", {
    validator: { $jsonSchema: { bsonType: "object", required: ["email"], properties: { email: { bsonType: "string" } } } },
  });
  await db.collection("customers").insertMany(
    Array.from({ length: 5 }, (_, i) => ({
      _id: oid(i + 1),
      name: `Customer ${i + 1}`,
      email: `c${i + 1}@example.test`,
      plan: i % 2 === 0 ? "pro" : "free",
      created_at: day(i),
      address: { city: `Town ${i}`, country: i < 3 ? "NO" : "SE" },
      ...(i === 0 ? { password: "pbkdf2$fake-hash", notes: "x".repeat(300), tags: Array.from({ length: 30 }, (_, t) => `t${t}`) } : {}),
    })),
  );
  await db.collection("customers").createIndex({ email: 1 }, { unique: true });

  await db.collection("orders").insertMany(
    Array.from({ length: ORDER_COUNT }, (_, i) => ({
      _id: oid(1000 + i),
      customer_id: oid((i % 5) + 1),
      status: STATUSES[i % 3],
      // One order keeps its total as a string: the mixed-type case describe should flag.
      total: i === 7 ? "12.50" : 10 + i,
      price: Decimal128.fromString(`${10 + i}.50`),
      created_at: day(i % 40),
      items: [{ sku: `sku-${i % 4}`, qty: (i % 3) + 1 }],
    })),
  );
  await db.collection("orders").createIndex({ status: 1, created_at: -1 }, { name: "status_created" });
  await db.collection("orders").createIndex({ customer_id: 1 }, { partialFilterExpression: { status: "paid" } });

  // Reviews 4 and 5 point at orders that do not exist.
  await db.collection<{ _id: number }>("reviews").insertMany([1, 2, 3, 4, 5].map((n) => ({ _id: n, order_id: oid(n <= 3 ? 1000 + n : 9000 + n), stars: n })));

  await db.createCollection("paid_orders", { viewOn: "orders", pipeline: [{ $match: { status: "paid" } }] });
  await db.createCollection("events", { capped: true, size: 1_048_576, max: 100 });
  await db.collection("events").insertOne({ kind: "boot", at: day(0) });
}
