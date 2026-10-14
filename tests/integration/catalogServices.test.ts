/**
 * Purpose: Service-level tests for the Phase 1 catalog (category.service.ts, product.service.ts)
 * and the guards it adds to other services (currency lock, tax rate in use). Inputs go through
 * the real Zod schemas first, so defaults and normalisation match what the routes will pass.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { Organization } from "../../src/models/organization.model";
import { TaxRate } from "../../src/models/taxRate.model";
import { AuditLog } from "../../src/models/auditLog.model";
import { ProductVariant } from "../../src/models/productVariant.model";
import { seedDefaultTaxRates, deleteTaxRate } from "../../src/services/taxRate.service";
import { updateOrganization } from "../../src/services/organization.service";
import * as categories from "../../src/services/category.service";
import * as products from "../../src/services/product.service";
import { createCategorySchema, updateCategorySchema } from "../../src/validators/category.validator";
import {
  createProductSchema,
  updateProductSchema,
  createVariantSchema,
  updateVariantSchema,
} from "../../src/validators/product.validator";

const actor = new mongoose.Types.ObjectId().toString();

let orgId: string;

async function createOrg(slug: string, currency = "BHD") {
  const org = await Organization.create({
    name: slug,
    slug,
    contactEmail: `owner@${slug}.test`,
    contactPhone: "+973 1234 5678",
    approvalStatus: "approved",
    isActive: true,
    settings: { currency, timezone: "Asia/Bahrain" },
  });
  await seedDefaultTaxRates(org._id, currency);
  return org._id.toString();
}

const create = (body: unknown, org = orgId) => products.createProduct(org, createProductSchema.parse(body), actor);
const update = (productId: string, body: unknown) =>
  products.updateProduct(orgId, productId, updateProductSchema.parse(body), actor);

const coffee = (overrides: Record<string, unknown> = {}) => ({
  name: "Arabic Coffee 250g",
  type: "goods",
  sku: "COF-AR-250",
  barcodes: { ean: "6291041500213" },
  sales: { sellingPrice: "2.750" },
  purchase: { costPrice: "1.6" },
  inventory: { reorderPoint: 12 },
  ...overrides,
});

const tshirt = (overrides: Record<string, unknown> = {}) => ({
  name: "Crew-neck T-shirt",
  type: "goods",
  itemType: "variant",
  attributes: [
    { name: "Size", options: ["S", "M", "L"] },
    { name: "Colour", options: ["Red", "Blue"] },
  ],
  variants: [
    { attributeValues: { Size: "M", Colour: "Red" }, sku: "TSHIRT-RED-M", sellingPrice: "4.500" },
    { attributeValues: { Size: "L", Colour: "Red" }, sku: "TSHIRT-RED-L", sellingPrice: "5", barcodes: { ean: "6291041500220" } },
  ],
  ...overrides,
});

/** Resolves to the ApiError a promise rejects with. */
async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { statusCode: number; code?: string; message: string; errors: Array<Record<string, unknown>> };
  }
  throw new Error("Expected the call to fail.");
}

beforeEach(async () => {
  orgId = await createOrg("catalog-org");
});

// ==========================================
// Categories
// ==========================================

describe("category.service", () => {
  it("lists by sortOrder then name, with product counts", async () => {
    const drinks = await categories.createCategory(orgId, createCategorySchema.parse({ name: "Drinks", sortOrder: 5 }), actor);
    await categories.createCategory(orgId, createCategorySchema.parse({ name: "Bakery", sortOrder: 5 }), actor);
    await categories.createCategory(orgId, createCategorySchema.parse({ name: "Zebra" }), actor);
    await create(coffee({ categoryId: String(drinks._id) }));

    const { categories: list } = await categories.listCategories(orgId);
    expect(list.map((c) => c.name)).toEqual(["Zebra", "Bakery", "Drinks"]);
    expect(list.find((c) => c.name === "Drinks")!.productCount).toBe(1);
    expect(list.find((c) => c.name === "Bakery")!.productCount).toBe(0);
  });

  it("refuses a duplicate name on create and rename (case-insensitive)", async () => {
    await categories.createCategory(orgId, createCategorySchema.parse({ name: "Drinks" }), actor);
    const other = await categories.createCategory(orgId, createCategorySchema.parse({ name: "Food" }), actor);

    expect((await failure(categories.createCategory(orgId, createCategorySchema.parse({ name: "DRINKS" }), actor))).code).toBe(
      "CATEGORY_NAME_TAKEN"
    );
    expect(
      (await failure(categories.updateCategory(orgId, String(other._id), updateCategorySchema.parse({ name: "drinks" }), actor))).code
    ).toBe("CATEGORY_NAME_TAKEN");
  });

  it("allows a case-only rename of the same category", async () => {
    const drinks = await categories.createCategory(orgId, createCategorySchema.parse({ name: "drinks" }), actor);
    const renamed = await categories.updateCategory(orgId, String(drinks._id), updateCategorySchema.parse({ name: "Drinks" }), actor);
    expect(renamed.name).toBe("Drinks");
  });

  it("refuses to delete a category that still has products, then allows it once empty", async () => {
    const drinks = await categories.createCategory(orgId, createCategorySchema.parse({ name: "Drinks" }), actor);
    const product = await create(coffee({ categoryId: String(drinks._id) }));

    const error = await failure(categories.deleteCategory(orgId, String(drinks._id), actor));
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("CATEGORY_IN_USE");
    expect(error.errors[0].meta).toEqual({ productCount: 1 });

    await products.deleteProduct(orgId, String(product._id), actor);
    await categories.deleteCategory(orgId, String(drinks._id), actor);
    expect((await failure(categories.getCategory(orgId, String(drinks._id)))).code).toBe("CATEGORY_NOT_FOUND");
  });

  it("does not see another organization's category", async () => {
    const otherOrg = await createOrg("other-org");
    const theirs = await categories.createCategory(otherOrg, createCategorySchema.parse({ name: "Drinks" }), actor);
    expect((await failure(categories.getCategory(orgId, String(theirs._id)))).statusCode).toBe(404);
  });
});

// ==========================================
// Products: create
// ==========================================

describe("product.service create", () => {
  it("creates a single item with a default variant and the org's default tax rate", async () => {
    const product = await create(coffee());

    expect(product.itemType).toBe("single");
    expect(product.taxRate).toMatchObject({ name: "VAT 10%", rate: 10 });
    expect(product.attributes).toEqual([]);
    expect(product.variants).toHaveLength(1);
    expect(product.variants[0]).toMatchObject({
      isDefault: true,
      attributeValues: {},
      name: "Arabic Coffee 250g",
      sku: "COF-AR-250",
      barcodes: { upc: null, ean: "6291041500213", isbn: null, mpn: null },
      sellingPrice: "2.750",
      costPrice: "1.600", // padded to the currency's 3 decimals
      reorderPoint: 12,
      isActive: true,
    });
    expect(product.priceRange).toEqual({ min: "2.750", max: "2.750" });
    expect(product.inventory).toEqual({ trackInventory: true, returnable: true, valuationMethod: "weighted_average" });
  });

  it("creates a variant item with canonical option spelling and display names", async () => {
    const product = await create(
      tshirt({
        variants: [{ attributeValues: { Size: "m", Colour: "RED" }, sellingPrice: "4.500" }],
      })
    );
    expect(product.variants).toHaveLength(1);
    expect(product.variants[0].attributeValues).toEqual({ Size: "M", Colour: "Red" });
    expect(product.variants[0].name).toBe("Crew-neck T-shirt - M / Red");
    expect(product.variants[0].isDefault).toBe(false);
  });

  it("reports the price range across active variants", async () => {
    const product = await create(tshirt());
    expect(product.priceRange).toEqual({ min: "4.500", max: "5.000" });
  });

  it("creates a service that never tracks inventory", async () => {
    const product = await create({ name: "Gift wrapping", type: "service", sales: { sellingPrice: "0.500" } });
    expect(product.inventory.trackInventory).toBe(false);
  });

  it("stores no tax rate for a non-standard product", async () => {
    const product = await create(coffee({ taxPreference: "zero_rated" }));
    expect(product.taxRate).toBeNull();
  });

  it("rejects more price decimals than the currency allows", async () => {
    const aedOrg = await createOrg("aed-org", "AED");
    const error = await failure(create(coffee({ sales: { sellingPrice: "2.755" } }), aedOrg));
    expect(error.code).toBe("TOO_MANY_DECIMALS");
    expect(error.errors[0]).toMatchObject({ field: "sales.sellingPrice", meta: { decimals: 2 } });
  });

  it("requires a tax rate for a standard product when the org has no default", async () => {
    const kwOrg = await createOrg("kw-org", "KWD"); // Kuwait has no VAT, so nothing is seeded
    expect((await failure(create(coffee(), kwOrg))).code).toBe("TAX_RATE_REQUIRED");
    const exempt = await create(coffee({ taxPreference: "out_of_scope" }), kwOrg);
    expect(exempt.taxRate).toBeNull();
  });

  it("refuses an unknown, foreign or inactive tax rate", async () => {
    const otherOrg = await createOrg("other-org");
    const foreign = await TaxRate.findOne({ organizationId: otherOrg });
    expect((await failure(create(coffee({ taxRateId: String(foreign!._id) })))).code).toBe("TAX_RATE_NOT_FOUND");

    const inactive = await TaxRate.create({
      organizationId: orgId,
      name: "Old VAT",
      components: [{ name: "VAT", rate: 5 }],
      isActive: false,
    });
    expect((await failure(create(coffee({ taxRateId: String(inactive._id) })))).code).toBe("TAX_RATE_INACTIVE");
  });

  it("refuses an unknown category with 400", async () => {
    const error = await failure(create(coffee({ categoryId: new mongoose.Types.ObjectId().toString() })));
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("CATEGORY_NOT_FOUND");
  });

  it("names the product that already has a SKU or barcode", async () => {
    const first = await create(coffee());
    const error = await failure(
      create(
        tshirt({
          variants: [
            { attributeValues: { Size: "M", Colour: "Red" }, sku: "cof-ar-250", sellingPrice: "4.500" },
            { attributeValues: { Size: "L", Colour: "Red" }, sellingPrice: "5", barcodes: { upc: "012345678905", isbn: "6291041500213" } },
          ],
        })
      )
    );
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("SKU_TAKEN");
    expect(error.message).toBe("SKU 'cof-ar-250' is already used by 'Arabic Coffee 250g'.");
    expect(error.errors).toEqual([
      {
        field: "variants[0].sku",
        code: "SKU_TAKEN",
        meta: { value: "cof-ar-250", productId: String(first._id), productName: "Arabic Coffee 250g" },
      },
      {
        field: "variants[1].barcodes.isbn",
        code: "BARCODE_TAKEN",
        meta: { value: "6291041500213", productId: String(first._id), productName: "Arabic Coffee 250g" },
      },
    ]);
    // Nothing was written.
    expect(await ProductVariant.countDocuments({ organizationId: orgId })).toBe(1);
  });

  it("survives a transient transaction retry (documents built before the transaction are re-inserted)", async () => {
    // The first variant save fails like a write conflict would. The retry must insert the
    // product again rather than "update" the row the aborted attempt never committed.
    const transient = new mongoose.mongo.MongoServerError({ message: "simulated write conflict", code: 112 });
    transient.addErrorLabel("TransientTransactionError");
    const save = ProductVariant.prototype.save;
    const spy = vi.spyOn(ProductVariant.prototype, "save").mockImplementationOnce(() => Promise.reject(transient));
    try {
      const product = await create(coffee());
      expect(product.variants).toHaveLength(1);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      expect(ProductVariant.prototype.save).toBe(save);
    }
  });

  it("allows the same SKU and barcode in another organization", async () => {
    await create(coffee());
    const otherOrg = await createOrg("other-org");
    await expect(create(coffee(), otherOrg)).resolves.toBeTruthy();
  });

  it("allows a fractional reorder point only on a decimal unit", async () => {
    const kg = await create(coffee({ unit: "kg", inventory: { reorderPoint: 1.5 } }));
    expect(kg.variants[0].reorderPoint).toBe(1.5);

    // The variant endpoint does not know the unit, so the service checks it.
    const shirt = await create(tshirt());
    const error = await failure(
      products.updateVariant(orgId, String(shirt._id), String(shirt.variants[0].id), updateVariantSchema.parse({ reorderPoint: 1.5 }), actor)
    );
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.errors[0].field).toBe("reorderPoint");
  });
});

// ==========================================
// Products: read
// ==========================================

describe("product.service list and lookup", () => {
  it("lists newest first with summaries, and filters", async () => {
    const drinks = await categories.createCategory(orgId, createCategorySchema.parse({ name: "Drinks" }), actor);
    await create(coffee({ categoryId: String(drinks._id), reportingTags: ["summer"] }));
    await create(tshirt());
    await create({ name: "Gift wrapping", type: "service", sales: { sellingPrice: "0.500" } });

    const all = await products.listProducts(orgId, {});
    expect(all.products.map((p) => p.name)).toEqual(["Gift wrapping", "Crew-neck T-shirt", "Arabic Coffee 250g"]);
    expect(all.pagination).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1 });

    const coffeeRow = all.products.find((p) => p.name === "Arabic Coffee 250g")!;
    expect(coffeeRow).toMatchObject({ sku: "COF-AR-250", variantCount: 1, category: { name: "Drinks" } });
    const shirtRow = all.products.find((p) => p.name === "Crew-neck T-shirt")!;
    expect(shirtRow).toMatchObject({ sku: null, variantCount: 2, priceRange: { min: "4.500", max: "5.000" } });

    expect((await products.listProducts(orgId, { type: "service" })).products).toHaveLength(1);
    expect((await products.listProducts(orgId, { categoryId: String(drinks._id) })).products).toHaveLength(1);
    expect((await products.listProducts(orgId, { categoryId: "none" })).products).toHaveLength(2);
    expect((await products.listProducts(orgId, { categoryId: "not-an-id" })).products).toHaveLength(0);
    expect((await products.listProducts(orgId, { tag: "summer" })).products).toHaveLength(1);
  });

  it("searches by name, SKU or barcode prefix", async () => {
    await create(coffee());
    await create(tshirt());

    const names = async (search: string) => (await products.listProducts(orgId, { search })).products.map((p) => p.name);
    expect(await names("arab")).toEqual(["Arabic Coffee 250g"]);
    expect(await names("tshirt-red")).toEqual(["Crew-neck T-shirt"]);
    expect(await names("629104150022")).toEqual(["Crew-neck T-shirt"]);
    expect(await names("6291041500")).toEqual(["Arabic Coffee 250g", "Crew-neck T-shirt"]);
    expect(await names("(")).toEqual([]); // regex characters are escaped
  });

  it("paginates", async () => {
    for (let i = 0; i < 3; i++) {
      await create(coffee({ name: `Item ${i}`, sku: `SKU-${i}`, barcodes: undefined }));
    }
    const page2 = await products.listProducts(orgId, { page: 2, limit: 2 });
    expect(page2.products).toHaveLength(1);
    expect(page2.pagination).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
  });

  it("looks up by barcode or SKU and says what matched", async () => {
    const shirt = await create(tshirt());

    const byEan = await products.lookupProduct(orgId, "6291041500220");
    expect(byEan.matchedOn).toBe("ean");
    expect(String(byEan.variantId)).toBe(String(shirt.variants[1].id));

    const bySku = await products.lookupProduct(orgId, "tshirt-red-m");
    expect(bySku.matchedOn).toBe("sku");
    expect(String(bySku.variantId)).toBe(String(shirt.variants[0].id));

    expect((await failure(products.lookupProduct(orgId, "0000000000000"))).code).toBe("PRODUCT_NOT_FOUND");
  });

  it("finds an ISBN typed with hyphens", async () => {
    await create(coffee({ sku: null, barcodes: { isbn: "978-0-306-40615-7" } }));
    const result = await products.lookupProduct(orgId, "978-0-306-40615-7");
    expect(result.matchedOn).toBe("isbn");
  });

  it("does not find deleted products", async () => {
    const product = await create(coffee());
    await products.deleteProduct(orgId, String(product._id), actor);
    expect((await failure(products.lookupProduct(orgId, "COF-AR-250"))).code).toBe("PRODUCT_NOT_FOUND");
    expect((await failure(products.getProduct(orgId, String(product._id)))).code).toBe("PRODUCT_NOT_FOUND");
  });
});

// ==========================================
// Products: update
// ==========================================

describe("product.service update", () => {
  it("updates a single item's default variant through the product, and audits the price change", async () => {
    const product = await create(coffee());
    const updated = await update(String(product._id), {
      sku: "COF-NEW",
      barcodes: { ean: null, upc: "012345678905" },
      sales: { sellingPrice: "3.000" },
      purchase: { costPrice: null },
    });

    expect(updated.variants[0]).toMatchObject({
      sku: "COF-NEW",
      barcodes: { upc: "012345678905", ean: null },
      sellingPrice: "3.000",
      costPrice: null,
    });
    // The old EAN is released.
    await expect(create(tshirt({ variants: [{ attributeValues: { Size: "S", Colour: "Red" }, sellingPrice: "1", barcodes: { ean: "6291041500213" } }] }))).resolves.toBeTruthy();

    const audits = await AuditLog.find({ organizationId: orgId, action: "product.price_changed" });
    expect(audits).toHaveLength(1);
    expect(audits[0].before).toMatchObject({ sellingPrice: "2.750", costPrice: "1.600" });
    expect(audits[0].after).toMatchObject({ sellingPrice: "3.000", costPrice: null });
  });

  it("does not audit an update that leaves prices unchanged", async () => {
    const product = await create(coffee());
    await update(String(product._id), { name: "Coffee", sales: { sellingPrice: "2.75" } });
    expect(await AuditLog.countDocuments({ organizationId: orgId, action: "product.price_changed" })).toBe(0);
  });

  it("refuses a SKU taken by another product, but not the product's own", async () => {
    const product = await create(coffee());
    await create(tshirt());
    expect((await failure(update(String(product._id), { sku: "tshirt-red-m" }))).code).toBe("SKU_TAKEN");
    await expect(update(String(product._id), { sku: "cof-ar-250" })).resolves.toBeTruthy();
  });

  it("refuses single-item fields on a variant item", async () => {
    const shirt = await create(tshirt());
    expect((await failure(update(String(shirt._id), { sales: { sellingPrice: "1" } }))).code).toBe("PRODUCT_IS_VARIANT_ITEM");
  });

  it("switching away from standard clears the rate; switching back takes the default", async () => {
    const product = await create(coffee());
    const exempt = await update(String(product._id), { taxPreference: "exempt" });
    expect(exempt.taxRate).toBeNull();
    const back = await update(String(product._id), { taxPreference: "standard" });
    expect(back.taxRate).toMatchObject({ rate: 10 });
  });

  it("refuses a tax rate with a stored non-standard preference", async () => {
    const product = await create(coffee({ taxPreference: "exempt" }));
    const rate = await TaxRate.findOne({ organizationId: orgId });
    expect((await failure(update(String(product._id), { taxRateId: String(rate!._id) }))).code).toBe("VALIDATION_FAILED");
  });

  it("refuses inventory tracking and brand on a service", async () => {
    const service = await create({ name: "Gift wrapping", type: "service", sales: { sellingPrice: "0.500" } });
    expect((await failure(update(String(service._id), { inventory: { trackInventory: true } }))).code).toBe("VALIDATION_FAILED");
    expect((await failure(update(String(service._id), { brand: "Acme" }))).code).toBe("VALIDATION_FAILED");
  });

  it("refuses a whole-number unit while a reorder point is fractional, unless replaced in the same request", async () => {
    const product = await create(coffee({ unit: "kg", inventory: { reorderPoint: 1.5 } }));
    expect((await failure(update(String(product._id), { unit: "pcs" }))).code).toBe("VALIDATION_FAILED");
    const updated = await update(String(product._id), { unit: "pcs", inventory: { reorderPoint: 2 } });
    expect(updated.unit).toBe("pcs");
  });

  describe("attributes", () => {
    it("adds options, keeping names and order", async () => {
      const shirt = await create(tshirt());
      const updated = await update(String(shirt._id), {
        attributes: [
          { name: "colour", options: ["Red", "Blue", "Green"] },
          { name: "Size", options: ["S", "M", "L", "XL"] },
        ],
      });
      expect(updated.attributes).toEqual([
        { name: "Size", options: ["S", "M", "L", "XL"] },
        { name: "Colour", options: ["Red", "Blue", "Green"] },
      ]);
    });

    it("refuses removing an option a variant uses, but allows an unused one", async () => {
      const shirt = await create(tshirt());
      const error = await failure(
        update(String(shirt._id), { attributes: [{ name: "Size", options: ["S", "L"] }, { name: "Colour", options: ["Red"] }] })
      );
      expect(error.code).toBe("ATTRIBUTE_OPTION_IN_USE");
      expect(error.message).toBe("Option 'M' of Size is used by a variant and cannot be removed.");

      const ok = await update(String(shirt._id), {
        attributes: [{ name: "Size", options: ["M", "L"] }, { name: "Colour", options: ["Red"] }],
      });
      expect(ok.attributes[0].options).toEqual(["M", "L"]);
    });

    it("refuses adding or removing an attribute", async () => {
      const shirt = await create(tshirt());
      expect((await failure(update(String(shirt._id), { attributes: [{ name: "Size", options: ["S", "M", "L"] }] }))).code).toBe(
        "ATTRIBUTES_LOCKED"
      );
    });

    it("refuses attributes on a single item", async () => {
      const product = await create(coffee());
      expect((await failure(update(String(product._id), { attributes: [{ name: "Size", options: ["S"] }] }))).code).toBe(
        "VALIDATION_FAILED"
      );
    });
  });
});

// ==========================================
// Variants
// ==========================================

describe("product.service variants", () => {
  const addVariant = (productId: string, body: unknown) =>
    products.addVariant(orgId, productId, createVariantSchema.parse(body), actor);

  it("adds a variant from existing options and refuses a repeated combination", async () => {
    const shirt = await create(tshirt());
    const updated = await addVariant(String(shirt._id), { attributeValues: { Size: "s", Colour: "blue" }, sellingPrice: "4" });
    expect(updated.variants).toHaveLength(3);
    expect(updated.variants[2].attributeValues).toEqual({ Size: "S", Colour: "Blue" });

    const dup = await failure(addVariant(String(shirt._id), { attributeValues: { Size: "M", Colour: "Red" }, sellingPrice: "4" }));
    expect(dup.code).toBe("VARIANT_COMBINATION_TAKEN");
    expect(dup.message).toBe("A variant with Size: M, Colour: Red already exists.");
  });

  it("refuses an unknown option or a missing attribute", async () => {
    const shirt = await create(tshirt());
    expect((await failure(addVariant(String(shirt._id), { attributeValues: { Size: "XL", Colour: "Red" }, sellingPrice: "4" }))).code).toBe(
      "VALIDATION_FAILED"
    );
    expect((await failure(addVariant(String(shirt._id), { attributeValues: { Size: "S" }, sellingPrice: "4" }))).code).toBe(
      "VALIDATION_FAILED"
    );
  });

  it("refuses variant management on a single item", async () => {
    const product = await create(coffee());
    expect((await failure(addVariant(String(product._id), { attributeValues: { Size: "S" }, sellingPrice: "4" }))).code).toBe(
      "PRODUCT_NOT_VARIANT_ITEM"
    );
    const variantId = String(product.variants[0].id);
    expect((await failure(products.setVariantActive(orgId, String(product._id), variantId, false, actor))).code).toBe(
      "PRODUCT_NOT_VARIANT_ITEM"
    );
  });

  it("updates a variant's price and audits it", async () => {
    const shirt = await create(tshirt());
    const variantId = String(shirt.variants[0].id);
    const updated = await products.updateVariant(
      orgId,
      String(shirt._id),
      variantId,
      updateVariantSchema.parse({ sellingPrice: "4.750" }),
      actor
    );
    expect(updated.variants[0].sellingPrice).toBe("4.750");
    expect(updated.priceRange).toEqual({ min: "4.750", max: "5.000" });
    expect(await AuditLog.countDocuments({ organizationId: orgId, action: "product.price_changed" })).toBe(1);
  });

  it("does not find a variant under another product", async () => {
    const shirt = await create(tshirt());
    const product = await create(coffee());
    const error = await failure(
      products.updateVariant(orgId, String(product._id), String(shirt.variants[0].id), updateVariantSchema.parse({ sellingPrice: "1" }), actor)
    );
    expect(error.code).toBe("VARIANT_NOT_FOUND");
  });

  it("keeps the last active variant active", async () => {
    const shirt = await create(tshirt());
    const [first, second] = shirt.variants.map((v) => String(v.id));

    const after = await products.setVariantActive(orgId, String(shirt._id), first, false, actor);
    expect(after.priceRange).toEqual({ min: "5.000", max: "5.000" });
    expect((await failure(products.setVariantActive(orgId, String(shirt._id), second, false, actor))).code).toBe("LAST_ACTIVE_VARIANT");
    expect((await failure(products.deleteVariant(orgId, String(shirt._id), second, actor))).code).toBe("LAST_ACTIVE_VARIANT");

    // The inactive one can still be deleted, and its SKU is released.
    const remaining = await products.deleteVariant(orgId, String(shirt._id), first, actor);
    expect(remaining.variants).toHaveLength(1);
    await expect(addVariant(String(shirt._id), { attributeValues: { Size: "M", Colour: "Red" }, sku: "TSHIRT-RED-M", sellingPrice: "4" })).resolves.toBeTruthy();
  });

  it("deleting a product releases every variant's SKU and barcodes", async () => {
    const shirt = await create(tshirt());
    await products.deleteProduct(orgId, String(shirt._id), actor);
    await expect(create(tshirt())).resolves.toBeTruthy();
  });

  it("activation is idempotent", async () => {
    const product = await create(coffee());
    const off = await products.setProductActive(orgId, String(product._id), false, actor);
    expect(off.isActive).toBe(false);
    const offAgain = await products.setProductActive(orgId, String(product._id), false, actor);
    expect(offAgain.isActive).toBe(false);
  });
});

// ==========================================
// Guards added to other services
// ==========================================

describe("catalog guards", () => {
  it("refuses deleting a tax rate any product uses", async () => {
    const rate = await TaxRate.create({ organizationId: orgId, name: "VAT 5%", components: [{ name: "VAT", rate: 5 }] });
    const product = await create(coffee({ taxRateId: String(rate._id) }));

    const error = await failure(deleteTaxRate(orgId, String(rate._id), actor));
    expect(error.code).toBe("TAX_RATE_IN_USE");
    expect(error.errors[0].meta).toEqual({ productCount: 1 });

    await products.deleteProduct(orgId, String(product._id), actor);
    await expect(deleteTaxRate(orgId, String(rate._id), actor)).resolves.toBeUndefined();
  });

  it("locks the currency once a product exists", async () => {
    await expect(updateOrganization(orgId, { settings: { currency: "AED" } }, actor)).resolves.toBeTruthy();
    await updateOrganization(orgId, { settings: { currency: "BHD" } }, actor);

    await create(coffee());
    const error = await failure(updateOrganization(orgId, { settings: { currency: "AED" } }, actor));
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe("CURRENCY_LOCKED");
  });
});
