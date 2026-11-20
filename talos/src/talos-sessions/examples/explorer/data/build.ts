// Builds shop.db: a year (2025) of a made-up shop's sales. Seeded, so every
// build is the same, and the live check can trust its own queries against it.
// Run: bun build.ts (from this folder).
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";

// A small seeded random number generator (mulberry32), so the data never changes.
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
  return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
};

const PRODUCTS = [
  ["Pour-over kettle", "Brewing", 42],
  ["Ceramic dripper", "Brewing", 24],
  ["Paper filters (100)", "Brewing", 6],
  ["Hand grinder", "Grinding", 68],
  ["Burr grinder", "Grinding", 189],
  ["House blend 250g", "Coffee", 11],
  ["Single origin 250g", "Coffee", 15],
  ["Decaf 250g", "Coffee", 12],
  ["Glass carafe", "Serving", 29],
  ["Travel mug", "Serving", 22],
  ["Espresso cups (2)", "Serving", 18],
  ["Gift card", "Gifts", 25],
] as const;

const CITIES = ["Leeds", "Bristol", "Glasgow", "Cardiff", "Belfast", "York"];
const FIRST = ["Ada", "Ben", "Cleo", "Dev", "Eli", "Fay", "Gus", "Hana", "Ivo", "Jun", "Kit", "Lena"];
const LAST = ["Shaw", "Patel", "Okoro", "Byrne", "Novak", "Reyes", "Kaur", "Lund"];

// More sales towards the end of the year, most in December.
const MONTH_WEIGHTS = [0.7, 0.6, 0.8, 0.8, 0.9, 0.85, 0.8, 0.75, 1.0, 1.1, 1.4, 2.0];

export const buildShop = (file: string) => {
  rmSync(file, { force: true });
  const random = seeded(2025);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const db = new Database(file);
  db.run("CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, price REAL NOT NULL)");
  db.run("CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL)");
  db.run("CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), ordered_on TEXT NOT NULL)");
  db.run(
    "CREATE TABLE order_items (order_id INTEGER NOT NULL REFERENCES orders(id), product_id INTEGER NOT NULL REFERENCES products(id), quantity INTEGER NOT NULL)",
  );
  const addProduct = db.prepare("INSERT INTO products (name, category, price) VALUES (?, ?, ?)");
  PRODUCTS.forEach(([name, category, price]) => addProduct.run(name, category, price));
  const addCustomer = db.prepare("INSERT INTO customers (name, city) VALUES (?, ?)");
  for (let customer = 0; customer < 60; customer += 1) addCustomer.run(`${pick(FIRST)} ${pick(LAST)}`, pick(CITIES));
  const addOrder = db.prepare("INSERT INTO orders (customer_id, ordered_on) VALUES (?, ?)");
  const addItem = db.prepare("INSERT INTO order_items (order_id, product_id, quantity) VALUES (?, ?, ?)");
  db.transaction(() => {
    MONTH_WEIGHTS.forEach((weight, month) => {
      const orderCount = Math.round(110 * weight);
      const days = new Date(Date.UTC(2025, month + 1, 0)).getUTCDate();
      for (let order = 0; order < orderCount; order += 1) {
        const day = 1 + Math.floor(random() * days);
        const orderedOn = `2025-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const orderId = Number(addOrder.run(1 + Math.floor(random() * 60), orderedOn).lastInsertRowid);
        const itemCount = 1 + Math.floor(random() * 3);
        for (let item = 0; item < itemCount; item += 1) addItem.run(orderId, 1 + Math.floor(random() * PRODUCTS.length), 1 + Math.floor(random() * 2));
      }
    });
  })();
  db.close();
};

if (import.meta.main) buildShop(join(import.meta.dir, "shop.db"));
