/**
 * Purpose: Model-level tests for the Phase 1 catalog (src/models/category.model.ts,
 * product.model.ts, productVariant.model.ts). Exercises the MongoDB indexes directly, since the
 * services rely on them as the final word on uniqueness: case-insensitive names and SKUs,
 * org-wide scannable barcodes, one default variant per product, and reuse after soft delete.
 */

import { beforeAll, describe, expect, it } from "vitest";
import mongoose from "mongoose";
import { Category } from "../../src/models/category.model";
import { Product } from "../../src/models/product.model";
import { ProductVariant, deriveScanCodes } from "../../src/models/productVariant.model";

const orgA = new mongoose.Types.ObjectId();
const orgB = new mongoose.Types.ObjectId();

const isDuplicateKey = (error: unknown) => (error as { code?: number })?.code === 11000;

async function makeProduct(organizationId = orgA, overrides: Record<string, unknown> = {}) {
  return Product.create({ organizationId, name: "Crew-neck T-shirt", type: "goods", ...overrides });
}

function variant(productId: mongoose.Types.ObjectId, overrides: Record<string, unknown> = {}, organizationId = orgA) {
  return { organizationId, productId, sellingPriceMinor: 4500, ...overrides };
}

beforeAll(async () => {
  // Builds the indexes once; the per-test cleanup deletes documents but keeps indexes.
  await Promise.all([Category.init(), Product.init(), ProductVariant.init()]);
});

describe("Category model", () => {
  it("derives nameKey and keeps it out of JSON", async () => {
    const category = await Category.create({ organizationId: orgA, name: "  Beverages " });
    expect(category.name).toBe("Beverages");
    expect(category.nameKey).toBe("beverages");
    expect(category.sortOrder).toBe(0);
    expect(category.toJSON()).not.toHaveProperty("nameKey");
  });

  it("rejects a case-insensitive duplicate name in the same organization", async () => {
    await Category.create({ organizationId: orgA, name: "Beverages" });
    await expect(Category.create({ organizationId: orgA, name: "BEVERAGES" })).rejects.toSatisfy(isDuplicateKey);
  });

  it("allows the same name in another organization, and after soft delete", async () => {
    const first = await Category.create({ organizationId: orgA, name: "Beverages" });
    await expect(Category.create({ organizationId: orgB, name: "Beverages" })).resolves.toBeTruthy();

    await Category.updateOne({ _id: first._id }, { $set: { isDelete: true } });
    await expect(Category.create({ organizationId: orgA, name: "Beverages" })).resolves.toBeTruthy();
  });

  it("rejects a fractional or negative sortOrder", async () => {
    await expect(Category.create({ organizationId: orgA, name: "A", sortOrder: 1.5 })).rejects.toThrow(/whole number/);
    await expect(Category.create({ organizationId: orgA, name: "B", sortOrder: -1 })).rejects.toThrow(/negative/);
  });
});

describe("Product model", () => {
  it("applies the documented defaults", async () => {
    const product = await makeProduct();
    expect(product.nameKey).toBe("crew-neck t-shirt");
    expect(product.itemType).toBe("single");
    expect(product.unit).toBe("pcs");
    expect(product.taxPreference).toBe("standard");
    expect(product.categoryId).toBeNull();
    expect(product.inventory.trackInventory).toBe(true);
    expect(product.inventory.returnable).toBe(true);
    expect(product.inventory.valuationMethod).toBe("weighted_average");
    expect(product.attributes).toEqual([]);
    expect(product.isActive).toBe(true);
  });

  it("never tracks inventory for a service", async () => {
    const product = await makeProduct(orgA, { type: "service", inventory: { trackInventory: true } });
    expect(product.inventory.trackInventory).toBe(false);
  });

  it("drops the tax rate of a non-standard product", async () => {
    const product = await makeProduct(orgA, {
      taxPreference: "exempt",
      taxRateId: new mongoose.Types.ObjectId(),
    });
    expect(product.taxRateId).toBeNull();
  });

  it("refuses attributes on a single item", async () => {
    await expect(makeProduct(orgA, { attributes: [{ name: "Size", options: ["S"] }] })).rejects.toThrow(
      /Only variant items have attributes/
    );
  });

  it("refuses an unknown unit", async () => {
    await expect(makeProduct(orgA, { unit: "furlong" })).rejects.toThrow(/unit/);
  });

  it("keeps type and itemType fixed after creation", async () => {
    const product = await makeProduct();
    await Product.updateOne({ _id: product._id }, { $set: { type: "service", itemType: "variant" } });
    const reloaded = await Product.findById(product._id);
    expect(reloaded!.type).toBe("goods");
    expect(reloaded!.itemType).toBe("single");
  });
});

describe("ProductVariant model", () => {
  it("derives skuKey and scanCodes, and hides them from JSON", async () => {
    const product = await makeProduct();
    const created = await ProductVariant.create(
      variant(product._id, {
        sku: "TSHIRT-Red-M",
        barcodes: { ean: "9780306406157", isbn: "9780306406157", mpn: "MX-1" },
      })
    );
    expect(created.skuKey).toBe("tshirt-red-m");
    expect(created.scanCodes).toEqual(["9780306406157"]); // ISBN == EAN counts once; MPN is not scannable
    const json = created.toJSON();
    expect(json).not.toHaveProperty("skuKey");
    expect(json).not.toHaveProperty("scanCodes");
    expect(json).not.toHaveProperty("comboKey");
  });

  it("rejects fractional or negative minor-unit prices", async () => {
    const product = await makeProduct();
    await expect(ProductVariant.create(variant(product._id, { sellingPriceMinor: 4.5 }))).rejects.toThrow(/minor units/);
    await expect(ProductVariant.create(variant(product._id, { costPriceMinor: -1 }))).rejects.toThrow(/negative/);
  });

  describe("SKU uniqueness", () => {
    it("rejects a case-insensitive duplicate SKU anywhere in the organization", async () => {
      const p1 = await makeProduct();
      const p2 = await makeProduct();
      await ProductVariant.create(variant(p1._id, { sku: "ABC-1" }));
      await expect(ProductVariant.create(variant(p2._id, { sku: "abc-1" }))).rejects.toSatisfy(isDuplicateKey);
    });

    it("allows any number of SKU-less variants", async () => {
      const p1 = await makeProduct();
      const p2 = await makeProduct();
      await ProductVariant.create(variant(p1._id));
      await expect(ProductVariant.create(variant(p2._id, { sku: null }))).resolves.toBeTruthy();
    });

    it("allows the same SKU in another organization, and after soft delete", async () => {
      const p1 = await makeProduct();
      const pB = await makeProduct(orgB);
      const first = await ProductVariant.create(variant(p1._id, { sku: "ABC-1" }));
      await expect(ProductVariant.create(variant(pB._id, { sku: "ABC-1" }, orgB))).resolves.toBeTruthy();

      await ProductVariant.updateOne({ _id: first._id }, { $set: { isDelete: true } });
      const p2 = await makeProduct();
      await expect(ProductVariant.create(variant(p2._id, { sku: "ABC-1" }))).resolves.toBeTruthy();
    });
  });

  describe("barcode uniqueness", () => {
    it("rejects the same scannable code on two variants, even under different barcode kinds", async () => {
      const p1 = await makeProduct();
      const p2 = await makeProduct();
      await ProductVariant.create(variant(p1._id, { barcodes: { ean: "9780306406157" } }));
      await expect(
        ProductVariant.create(variant(p2._id, { barcodes: { isbn: "9780306406157" } }))
      ).rejects.toSatisfy(isDuplicateKey);
    });

    it("allows any number of variants with no barcodes", async () => {
      const p1 = await makeProduct();
      const p2 = await makeProduct();
      await ProductVariant.create(variant(p1._id));
      await expect(ProductVariant.create(variant(p2._id, { barcodes: { mpn: "MX-1" } }))).resolves.toBeTruthy();
    });

    it("does not treat a shared MPN as a duplicate", async () => {
      const p1 = await makeProduct();
      const p2 = await makeProduct();
      await ProductVariant.create(variant(p1._id, { barcodes: { mpn: "MX-1" } }));
      await expect(ProductVariant.create(variant(p2._id, { barcodes: { mpn: "MX-1" } }))).resolves.toBeTruthy();
    });

    it("allows the same code in another organization", async () => {
      const p1 = await makeProduct();
      const pB = await makeProduct(orgB);
      await ProductVariant.create(variant(p1._id, { barcodes: { upc: "012345678905" } }));
      await expect(
        ProductVariant.create(variant(pB._id, { barcodes: { upc: "012345678905" } }, orgB))
      ).resolves.toBeTruthy();
    });
  });

  it("allows at most one default variant per product", async () => {
    const product = await makeProduct();
    await ProductVariant.create(variant(product._id, { isDefault: true }));
    await expect(
      ProductVariant.create(variant(product._id, { isDefault: true, comboKey: "x" }))
    ).rejects.toSatisfy(isDuplicateKey);
  });

  it("rejects a repeated attribute combination within a product, but not across products", async () => {
    const p1 = await makeProduct(orgA, { itemType: "variant", attributes: [{ name: "Size", options: ["M"] }] });
    const p2 = await makeProduct(orgA, { itemType: "variant", attributes: [{ name: "Size", options: ["M"] }] });
    const m = { attributeValues: { Size: "M" }, comboKey: "m" };
    await ProductVariant.create(variant(p1._id, m));
    await expect(ProductVariant.create(variant(p1._id, m))).rejects.toSatisfy(isDuplicateKey);
    await expect(ProductVariant.create(variant(p2._id, m))).resolves.toBeTruthy();
  });

  it("keeps productId, attributeValues and isDefault fixed after creation", async () => {
    const product = await makeProduct();
    const created = await ProductVariant.create(variant(product._id, { isDefault: true }));
    await ProductVariant.updateOne(
      { _id: created._id },
      { $set: { productId: new mongoose.Types.ObjectId(), isDefault: false, attributeValues: { Size: "L" } } }
    );
    const reloaded = await ProductVariant.findById(created._id);
    expect(String(reloaded!.productId)).toBe(String(product._id));
    expect(reloaded!.isDefault).toBe(true);
    expect(reloaded!.attributeValues.size).toBe(0);
  });
});

describe("deriveScanCodes", () => {
  it("returns distinct UPC/EAN/ISBN values and ignores MPN and nulls", () => {
    expect(deriveScanCodes(undefined)).toEqual([]);
    expect(deriveScanCodes({ upc: null, ean: "6291041500213", isbn: null, mpn: "X" })).toEqual(["6291041500213"]);
    expect(deriveScanCodes({ upc: "012345678905", ean: "6291041500213" })).toEqual(["012345678905", "6291041500213"]);
  });
});
