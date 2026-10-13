/**
 * Purpose: Pins the Phase 1 product/category request contract (src/validators/product.validator.ts,
 * category.validator.ts) before the services exist: the documented Swagger examples must parse,
 * and every cross-field rule the frontend relies on must hold.
 */

import { describe, it, expect } from "vitest";
import {
  createProductSchema,
  updateProductSchema,
  createVariantSchema,
  updateVariantSchema,
} from "../../src/validators/product.validator";
import { createCategorySchema, updateCategorySchema } from "../../src/validators/category.validator";
import { singleExample, variantExample, serviceExample } from "../../src/docs/product.openapi";

function issues(result: { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } }) {
  return (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

function expectRejected(body: unknown, pathFragment: string) {
  const result = createProductSchema.safeParse(body);
  expect(result.success, JSON.stringify(body)).toBe(false);
  expect(issues(result).join("\n")).toContain(pathFragment);
}

function updateIssues(body: unknown) {
  const result = updateProductSchema.safeParse(body);
  expect(result.success, JSON.stringify(body)).toBe(false);
  return issues(result).join("\n");
}

const single = (overrides: Record<string, unknown> = {}) => ({
  name: "Coffee",
  type: "goods",
  sales: { sellingPrice: "2.750" },
  ...overrides,
});

const variantItem = (overrides: Record<string, unknown> = {}) => ({
  name: "T-shirt",
  type: "goods",
  itemType: "variant",
  attributes: [
    { name: "Size", options: ["S", "M"] },
    { name: "Colour", options: ["Red", "Blue"] },
  ],
  variants: [
    { attributeValues: { Size: "S", Colour: "Red" }, sellingPrice: "4.500" },
    { attributeValues: { Size: "M", Colour: "Red" }, sellingPrice: "4.500" },
  ],
  ...overrides,
});

describe("documented examples", () => {
  it("the single, variant and service examples in Swagger are valid", () => {
    for (const example of [singleExample, variantExample, serviceExample]) {
      const result = createProductSchema.safeParse(example);
      expect(issues(result)).toEqual([]);
    }
  });

  it("applies defaults: itemType single, unit pcs, taxPreference standard", () => {
    const parsed = createProductSchema.parse(single());
    expect(parsed).toMatchObject({ itemType: "single", unit: "pcs", taxPreference: "standard" });
  });
});

describe("single items", () => {
  it("require a selling price", () => {
    expectRejected(single({ sales: {} }), "sales.sellingPrice");
  });

  it("cannot send attributes or variants", () => {
    expectRejected(single({ attributes: [{ name: "Size", options: ["S"] }] }), "attributes");
    expectRejected(single({ variants: [{ attributeValues: {}, sellingPrice: "1" }] }), "variants");
  });

  it("accept an optional SKU, barcodes and cost", () => {
    const parsed = createProductSchema.parse(
      single({ sku: "COF-1", barcodes: { upc: "012345678905", isbn: "978-0-306-40615-7" }, purchase: { costPrice: "1.5" } })
    );
    expect(parsed.barcodes?.isbn).toBe("9780306406157");
  });
});

describe("variant items", () => {
  it("are valid with matching attribute values", () => {
    expect(issues(createProductSchema.safeParse(variantItem()))).toEqual([]);
  });

  it("need attributes and variants", () => {
    expectRejected(variantItem({ attributes: undefined }), "attributes");
    expectRejected(variantItem({ variants: undefined }), "variants");
  });

  it("reject single-item fields at the top level", () => {
    expectRejected(variantItem({ sku: "X" }), "sku");
    expectRejected(variantItem({ sales: { sellingPrice: "1" } }), "sales.sellingPrice");
    expectRejected(variantItem({ purchase: { costPrice: "1" } }), "purchase.costPrice");
    expectRejected(variantItem({ inventory: { reorderPoint: 1 } }), "inventory.reorderPoint");
  });

  it("need exactly one value per attribute, from its options", () => {
    expectRejected(
      variantItem({ variants: [{ attributeValues: { Size: "S" }, sellingPrice: "1" }] }),
      "variants.0.attributeValues"
    );
    expectRejected(
      variantItem({ variants: [{ attributeValues: { Size: "S", Colour: "Red", Fit: "Slim" }, sellingPrice: "1" }] }),
      "variants.0.attributeValues"
    );
    expectRejected(
      variantItem({ variants: [{ attributeValues: { Size: "XL", Colour: "Red" }, sellingPrice: "1" }] }),
      "'XL' is not an option of Size"
    );
  });

  it("refuse duplicate combinations, attributes, options, SKUs and barcodes (case-insensitive)", () => {
    expectRejected(
      variantItem({
        variants: [
          { attributeValues: { Size: "S", Colour: "Red" }, sellingPrice: "1" },
          { attributeValues: { Size: "s", Colour: "red" }, sellingPrice: "1" },
        ],
      }),
      "same attribute values"
    );
    expectRejected(
      variantItem({ attributes: [{ name: "Size", options: ["S"] }, { name: "size", options: ["M"] }] }),
      "listed twice"
    );
    expectRejected(variantItem({ attributes: [{ name: "Size", options: ["S", "s"] }] }), "listed twice");
    expectRejected(
      variantItem({
        variants: [
          { attributeValues: { Size: "S", Colour: "Red" }, sellingPrice: "1", sku: "TS-1" },
          { attributeValues: { Size: "M", Colour: "Red" }, sellingPrice: "1", sku: "ts-1" },
        ],
      }),
      "SKU 'ts-1'"
    );
    expectRejected(
      variantItem({
        variants: [
          { attributeValues: { Size: "S", Colour: "Red" }, sellingPrice: "1", barcodes: { ean: "6291041500213" } },
          { attributeValues: { Size: "M", Colour: "Red" }, sellingPrice: "1", barcodes: { ean: "6291041500213" } },
        ],
      }),
      "Barcode '6291041500213'"
    );
  });

  it("limit attributes to 3 and variants to 100", () => {
    const attrs = ["A", "B", "C", "D"].map((name) => ({ name, options: ["x"] }));
    expectRejected(variantItem({ attributes: attrs }), "At most 3 attributes");
    const many = Array.from({ length: 101 }, () => ({ attributeValues: { Size: "S", Colour: "Red" }, sellingPrice: "1" }));
    expectRejected(variantItem({ variants: many }), "At most 100 variants");
  });
});

describe("services", () => {
  it("are single, without brand/manufacturer or inventory tracking", () => {
    expectRejected({ ...serviceExample, itemType: "variant" }, "itemType");
    expectRejected({ ...serviceExample, brand: "X" }, "brand");
    expectRejected({ ...serviceExample, manufacturer: "X" }, "manufacturer");
    expectRejected({ ...serviceExample, inventory: { trackInventory: true } }, "inventory.trackInventory");
  });
});

describe("tax", () => {
  it("only standard products may carry a taxRateId", () => {
    expectRejected(single({ taxPreference: "zero_rated", taxRateId: "665f1c2e8a4b3c0012ab3600" }), "taxRateId");
    expect(createProductSchema.safeParse(single({ taxPreference: "exempt" })).success).toBe(true);
  });

  it("rejects the GST-only preference and an unknown one", () => {
    expectRejected(single({ taxPreference: "non_gst_supply" }), "taxPreference");
  });
});

describe("money, quantities and units", () => {
  it("money must be a non-negative decimal string with at most 3 decimals", () => {
    for (const bad of [2.75, "-1", "1.2345", "1,000", "abc", ""]) {
      expectRejected(single({ sales: { sellingPrice: bad } }), "sales.sellingPrice");
    }
    expect(createProductSchema.safeParse(single({ sales: { sellingPrice: " 0.5 " } })).success).toBe(true);
  });

  it("reorderPoint must be whole for count units and may be fractional for kg", () => {
    expectRejected(single({ inventory: { reorderPoint: 1.5 } }), "only allows whole quantities");
    expect(createProductSchema.safeParse(single({ unit: "kg", inventory: { reorderPoint: 1.5 } })).success).toBe(true);
    expectRejected(single({ unit: "kg", inventory: { reorderPoint: 1.2345 } }), "at most 3 decimal places");
    expectRejected(single({ unit: "tonne" }), "unit");
  });
});

describe("fields that are not accepted", () => {
  it("rejects opening stock, valuation method and server-computed fields with a helpful message", () => {
    expectRejected(single({ inventory: { openingStock: 5 } }), "openingStock");
    expectRejected(single({ inventory: { valuationMethod: "fifo" } }), "valuationMethod");
    expectRejected(single({ price: "1.000" }), "computed by the server");
    expectRejected(single({ stock: 4 }), "computed by the server");
    expectRejected(single({ organizationId: "665f1c2e8a4b3c0012ab3300" }), "Unknown product field");
  });

  it("imageUrl must be an http(s) link", () => {
    expectRejected(single({ imageUrl: "ftp://x.test/a.jpg" }), "must be an http(s) URL");
    expectRejected(single({ imageUrl: "data:image/png;base64,AAAA" }), "must be an http(s) URL");
  });

  it("validates barcode formats", () => {
    expectRejected(single({ barcodes: { upc: "123" } }), "barcodes.upc");
    expectRejected(single({ barcodes: { ean: "12345678901" } }), "barcodes.ean");
    expectRejected(single({ barcodes: { gtin: "1" } }), "Unknown barcode type");
  });
});

describe("updates", () => {
  it("cannot change type or itemType and needs at least one field", () => {
    expect(updateIssues({ type: "service" })).toContain("immutable field");
    expect(updateIssues({ itemType: "variant" })).toContain("immutable field");
    expect(updateIssues({})).toContain("At least one field must be provided");
  });

  it("accepts null to clear optional fields", () => {
    const parsed = updateProductSchema.parse({ brand: null, categoryId: null, imageUrl: null, sku: null });
    expect(parsed).toMatchObject({ brand: null, categoryId: null, imageUrl: null, sku: null });
  });

  it("variant updates cannot change attributeValues", () => {
    expect(updateVariantSchema.safeParse({ attributeValues: { Size: "L" } }).success).toBe(false);
    expect(updateVariantSchema.safeParse({ sellingPrice: "5.000", costPrice: null }).success).toBe(true);
  });

  it("adding a variant needs attributeValues and a selling price", () => {
    expect(createVariantSchema.safeParse({ attributeValues: { Size: "L" } }).success).toBe(false);
    expect(createVariantSchema.safeParse({ attributeValues: { Size: "L" }, sellingPrice: "5" }).success).toBe(true);
  });
});

describe("categories", () => {
  it("validates name and sortOrder and rejects unknown fields", () => {
    expect(createCategorySchema.safeParse({ name: "Beverages", sortOrder: 10 }).success).toBe(true);
    expect(createCategorySchema.safeParse({ name: " " }).success).toBe(false);
    expect(createCategorySchema.safeParse({ name: "X", sortOrder: 1.5 }).success).toBe(false);
    expect(createCategorySchema.safeParse({ name: "X", parentId: "665f1c2e8a4b3c0012ab3700" }).success).toBe(false);
    expect(updateCategorySchema.safeParse({}).success).toBe(false);
  });
});
