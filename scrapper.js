// ============================================================
// KOKO ATELIER — Product Scraper
// Scrapes: Collections, Products, Descriptions, Prices, Sizes
// Output: koko-products.txt ready to upload to Zara's knowledge base
// Run: node scraper.js
// ============================================================

import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
import dotenv from "dotenv";
dotenv.config();

const BASE_URL = "https://www.kokoatelier.com";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── Helpers ──────────────────────────────────────────────────

async function fetchJSON(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; KokoBot/1.0)" }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function clean(text = "") {
  return text
    .replace(/<[^>]*>/g, " ")       // strip HTML tags
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&rsquo;/g, "'")
    .replace(/&lsquo;/g, "'")
    .replace(/\s+/g, " ")           // collapse whitespace
    .trim()
    .slice(0, 300);                  // cap at 300 chars for 2-liner
}

function formatPrice(price) {
  return `Rs. ${parseInt(price).toLocaleString()}`;
}

// ── Step 1: Fetch all collections ────────────────────────────

async function fetchCollections() {
  console.log("📦 Fetching collections...");
  const data = await fetchJSON(`${BASE_URL}/collections.json?limit=50`);
  if (!data?.collections) return [];

  return data.collections.map(c => ({
    handle: c.handle,
    title: c.title,
  }));
}

// ── Step 2: Fetch all products per collection ─────────────────

async function fetchProductsForCollection(handle) {
  const products = [];
  let page = 1;

  while (true) {
    const data = await fetchJSON(
      `${BASE_URL}/collections/${handle}/products.json?limit=50&page=${page}`
    );
    if (!data?.products?.length) break;
    products.push(...data.products);
    if (data.products.length < 50) break;
    page++;
  }

  return products;
}

// ── Step 3: Extract size info from product variants ───────────

function extractSizes(product) {
  const sizes = product.variants
    ?.filter(v => v.available !== false)
    .map(v => v.title)
    .filter(s => s && s !== "Default Title")
    .join(", ");
  return sizes || "One size / Custom available";
}

function extractSalePrice(product) {
  const variant = product.variants?.[0];
  if (!variant) return null;
  const price = formatPrice(variant.price);
  const compare = variant.compare_at_price
    ? formatPrice(variant.compare_at_price)
    : null;
  return compare && compare !== price
    ? `${price} (was ${compare})`
    : price;
}

// ── Step 4: Build knowledge text ─────────────────────────────

function buildProductEntry(product, collectionTitle) {
  const desc = clean(product.body_html);
  const sizes = extractSizes(product);
  const price = extractSalePrice(product);
  const url = `${BASE_URL}/products/${product.handle}`;

  return `
PRODUCT: ${product.title}
COLLECTION: ${collectionTitle}
PRICE: ${price || "See website"}
SIZES AVAILABLE: ${sizes}
DESCRIPTION: ${desc || "Premium ethnic wear by Koko Atelier."}
LINK: ${url}
`.trim();
}

// ── Main Scrape ───────────────────────────────────────────────

async function scrape() {
  console.log("🌸 Starting Koko Atelier scrape...\n");

  const collections = await fetchCollections();
  console.log(`✅ Found ${collections.length} collections\n`);

  const allEntries = [];
  const collectionSummaries = [];
  const seenProducts = new Set(); // avoid duplicates across collections

  for (const col of collections) {
    // Skip utility collections
    if (["frontpage", "all", "sale"].includes(col.handle)) continue;

    console.log(`  → Scraping: ${col.title} (${col.handle})`);
    const products = await fetchProductsForCollection(col.handle);

    if (!products.length) continue;

    // Collection summary line
    const names = products.slice(0, 5).map(p => p.title).join(", ");
    collectionSummaries.push(
      `COLLECTION: ${col.title} | ${products.length} items | Featured: ${names}${products.length > 5 ? "..." : ""}`
    );

    // Individual products
    for (const product of products) {
      if (seenProducts.has(product.id)) continue;
      seenProducts.add(product.id);
      allEntries.push(buildProductEntry(product, col.title));
    }

    // Small delay to be polite to the server
    await new Promise(r => setTimeout(r, 300));
  }

  // ── Build final text file ───────────────────────────────────

  const output = `
================================================================
KOKO ATELIER — FULL PRODUCT KNOWLEDGE BASE
Scraped from: kokoatelier.com
Total products: ${allEntries.length}
================================================================


----------------------------------------------------------------
ALL COLLECTIONS OVERVIEW
----------------------------------------------------------------
${collectionSummaries.join("\n")}


----------------------------------------------------------------
SIZE GUIDE (applies to all collections)
----------------------------------------------------------------
XS  — Chest 32", Waist 26", Hips 34"
S   — Chest 34", Waist 28", Hips 36"
M   — Chest 36", Waist 30", Hips 38"
L   — Chest 38", Waist 32", Hips 40"
XL  — Chest 40", Waist 34", Hips 42"
XXL — Chest 42", Waist 36", Hips 44"
Custom sizing available — WhatsApp +92 313 4730467


----------------------------------------------------------------
FABRIC CARE
----------------------------------------------------------------
Lawn/Cambric: Machine wash cold, mild detergent, do not bleach
Karandi/Khaddar: Dry clean recommended or hand wash cold
Chiffon/Organza: Dry clean only, store folded not hung
Embroidered pieces: Always dry clean, store in dust bags


----------------------------------------------------------------
SHIPPING
----------------------------------------------------------------
Lahore: 1-2 business days (PKR 150)
Other Pakistan cities: 3-5 business days (PKR 250)
International (UAE, UK, USA, Canada and more): Ships via DHL or Skynet. No fixed rates — courier quote shared with customer on request via WhatsApp.
Free shipping on orders above PKR 10,000 (Pakistan only)


----------------------------------------------------------------
RETURNS & EXCHANGES
----------------------------------------------------------------
7-day return window from delivery date
Items must be unworn, unwashed, tags attached
Sale items are final — no returns
To initiate: email support or WhatsApp with order number + reason
Exchanges subject to availability


----------------------------------------------------------------
PAYMENT
----------------------------------------------------------------
Credit/Debit card (Visa, Mastercard via Shopify)
Bank transfer (HBL, MCB — details at checkout)
EasyPaisa / JazzCash
Cash on Delivery available for select cities (Lahore, Karachi, Islamabad)


----------------------------------------------------------------
ALL PRODUCTS
----------------------------------------------------------------
${allEntries.join("\n\n---\n\n")}
`.trim();

  // ── Save to file ────────────────────────────────────────────
  writeFileSync("koko-products.txt", output, "utf-8");
  console.log(`\n✅ Saved koko-products.txt (${allEntries.length} products)`);

  // ── Upload to Supabase ──────────────────────────────────────
  console.log("\n📤 Uploading to Supabase knowledge base...");

  // Clear old product data first
  await supabase
    .from("koko_knowledge")
    .delete()
    .eq("filename", "koko-products.txt");

  // Chunk and insert
  const chunks = [];
  for (let i = 0; i < output.length; i += 600) {
    const content = output.slice(i, i + 600).trim();
    if (content.length > 20) {
      chunks.push({
        filename: "koko-products.txt",
        chunk_index: chunks.length,
        content,
      });
    }
  }

  // Insert in batches of 50
  for (let i = 0; i < chunks.length; i += 50) {
    const batch = chunks.slice(i, i + 50);
    const { error } = await supabase.from("koko_knowledge").insert(batch);
    if (error) console.error("Insert error:", error.message);
    else process.stdout.write(`\r  → Uploaded ${Math.min(i + 50, chunks.length)}/${chunks.length} chunks`);
  }

  console.log(`\n\n🌸 Done! ${chunks.length} chunks uploaded to Supabase.`);
  console.log("   Zara now knows about all your products.\n");
}

scrape().catch(console.error);