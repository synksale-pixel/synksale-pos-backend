/**
 * Purpose: Edge cases and boundaries of the Phase 1 product/category validators that
 * productValidator.test.ts does not cover: unit-aware quantities, SKU/barcode formats, money and
 * text limits, update-schema strictness, and regression tests for the contract gaps the review
 * found (prototype-key crash, EAN = ISBN on one variant, service reorderPoint, update tax and
 * attribute rules, empty nested updates).
 */

import { describe, it, expect } from "vitest";
import {
  createProductSchema,
  updateProductSchema,
  createVariantSchema,
  updateVariantSchema,
} from "../../src/validators/product.validator";
import { createCategorySchema, updateCategorySchema } from "../../src/validators/category.validator";
import { serviceExample } from "../../src/docs/product.openapi";

type Result = { success: boolean; error?: { issues: { path: (string | number)[]; message: string }[] } };

function issues(result: Result) {
  return (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

function expectRejected(body: unknown, fragment: string) {
  const result = createProductSchema.safeParse(body);
  expect(result.success, JSON.stringify(body)).toBe(false);
  expect(issues(result).join("\n")).toContain(fragment);
}

function updateIssues(body: unknown) {
  const result = updateProductSchema.safeParse(body);
  expect(result.success, JSON.stringify(body)).toBe(false);
  return issues(result).join("\n");
}

const OK = (body: unknown) => createProductSchema.safeParse(body).success;

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

const oneVariant = (extra: Record<string, unknown>) =>
  variantItem({ variants: [{ attributeValues: { Size: "S", Colour: "Red" }, sellingPrice: "1", ...extra }] });

describe("variant reorderPoint is unit-aware on create", () => {
  it("rejects a fractional variant reorderPoint for a count unit, allows it for kg", () => {
    expectRejected(
      variantItem({ unit: "pcs", variants: [{ attributeValues: { Size: "S", Colour: "Red" }, sellingPrice: "1", reorderPoint: 2.5 }] }),
      "variants.0.reorderPoint: Unit 'pcs' only allows whole quantities"
    );
    expect(OK(variantItem({ unit: "kg", variants: [{ attributeValues: { Size: "S", Colour: "Red" }, sellingPrice: "1", reorderPoint: 2.5 }] }))).toBe(true);
    expectRejected(oneVariant({ reorderPoint: 2.5555 }), "variants.0.reorderPoint: Quantity may have at most 3 decimal places");
  });

  it("accepts null/0/1e9 and rejects negative and too-large values", () => {
    expect(OK(oneVariant({ reorderPoint: null }))).toBe(true);
    expect(OK(oneVariant({ reorderPoint: 0 }))).toBe(true);
    expect(OK(oneVariant({ reorderPoint: 1_000_000_000 }))).toBe(true);
    expectRejected(oneVariant({ reorderPoint: -1 }), "Quantity cannot be negative");
    expectRejected(oneVariant({ reorderPoint: 1_000_000_001 }), "Quantity is too large");
  });

  it("unit is case-sensitive and must be one of the catalog", () => {
    expectRejected(single({ unit: "KG" }), "unit must be one of");
    expect(OK(single({ unit: "mL" }))).toBe(true);
  });
});

describe("services and required fields", () => {
  it("a service sending variants/attributes is rejected because itemType defaults to single", () => {
    expectRejected({ ...serviceExample, variants: [{ attributeValues: {}, sellingPrice: "1" }] }, "variants: Only variant items have variants");
    expectRejected({ ...serviceExample, attributes: [{ name: "S", options: ["a"] }] }, "attributes: Only variant items have attributes");
  });

  it("trackInventory false is fine for a service, true is rejected", () => {
    expect(OK({ ...serviceExample, inventory: { trackInventory: false } })).toBe(true);
    expectRejected({ ...serviceExample, inventory: { trackInventory: true } }, "inventory.trackInventory: Services cannot track inventory");
  });

  it("a service still needs a selling price", () => {
    const { sales: _sales, ...noPrice } = serviceExample;
    expectRejected(noPrice, "sales.sellingPrice");
  });

  it("type is required and limited to goods/service; itemType to single/variant", () => {
    const { type: _type, ...noType } = single();
    expectRejected(noType, "type");
    expectRejected(single({ type: "digital" }), "type must be goods or service");
    expectRejected(single({ itemType: "bundle" }), "itemType must be single or variant");
  });

  it("name is required, trimmed and capped at 200", () => {
    const { name: _name, ...noName } = single();
    expectRejected(noName, "name");
    expectRejected(single({ name: "   " }), "Product name is required");
    expectRejected(single({ name: "x".repeat(201) }), "name");
    expect(OK(single({ name: "x".repeat(200) }))).toBe(true);
    expect(createProductSchema.parse(single({ name: "  Coffee  " })).name).toBe("Coffee");
  });
});

describe("tax preference and ids", () => {
  it("standard without a taxRateId (or with null) is allowed: the org default rate applies", () => {
    expect(OK(single({ taxPreference: "standard" }))).toBe(true);
    expect(OK(single({ taxPreference: "standard", taxRateId: null }))).toBe(true);
    expect(OK(single({ taxPreference: "zero_rated", taxRateId: null }))).toBe(true);
  });

  it("every non-standard preference rejects a taxRateId", () => {
    for (const taxPreference of ["zero_rated", "exempt", "out_of_scope"]) {
      expectRejected(
        single({ taxPreference, taxRateId: "665f1c2e8a4b3c0012ab3600" }),
        `taxRateId: A ${taxPreference} product must not have a tax rate`
      );
    }
  });

  it("taxRateId and categoryId must be 24-char hex; categoryId may be null", () => {
    expectRejected(single({ taxRateId: "123" }), "taxRateId must be a 24-character hex id");
    expectRejected(single({ categoryId: "zzzzzzzzzzzzzzzzzzzzzzzz" }), "categoryId must be a 24-character hex id");
    expect(OK(single({ categoryId: null }))).toBe(true);
  });
});

describe("SKU", () => {
  it("accepts letters, digits and . _ - / (max 40)", () => {
    for (const sku of ["A", "a1", "TS-RED_M.1/2", "9X", "x".repeat(40)]) expect(OK(single({ sku })), sku).toBe(true);
  });

  it("rejects empty, blank, leading symbol, inner space, other symbols and > 40 chars", () => {
    expectRejected(single({ sku: "" }), "SKU cannot be empty");
    expectRejected(single({ sku: "   " }), "SKU cannot be empty");
    expectRejected(single({ sku: "x".repeat(41) }), "SKU must be at most 40");
    for (const sku of ["-A", ".A", "/A", "_A", "A B", "A#1", "Aé", "A,B"]) {
      expectRejected(single({ sku }), "SKU may contain letters, digits");
    }
  });

  it("trims surrounding whitespace and accepts null", () => {
    expect(createProductSchema.parse(single({ sku: "  COF-1  " })).sku).toBe("COF-1");
    expect(OK(single({ sku: null }))).toBe(true);
  });

  it("an empty-string sku on a variant is rejected", () => {
    expectRejected(oneVariant({ sku: "" }), "variants.0.sku: SKU cannot be empty");
  });
});

describe("barcodes", () => {
  const bc = (barcodes: unknown) => createProductSchema.safeParse(single({ barcodes }));

  it("accepts ISBN-10 with check digit X (any case, hyphenated) and normalises", () => {
    expect(bc({ isbn: "080442957X" }).data?.barcodes?.isbn).toBe("080442957X");
    expect(bc({ isbn: "0-8044-2957-x" }).data?.barcodes?.isbn).toBe("080442957X");
    expect(bc({ isbn: "978-0-306-40615-7" }).data?.barcodes?.isbn).toBe("9780306406157");
  });

  it("rejects malformed ISBNs", () => {
    for (const isbn of ["12345", "X080442957", "08044295XX", "978030640615X", "", "978 0306406157"]) {
      expect(bc({ isbn }).success, isbn).toBe(false);
    }
    expectRejected(single({ barcodes: { isbn: "12345" } }), "ISBN must be 10 or 13 characters");
  });

  it("UPC is exactly 12 digits, EAN is 8 or 13", () => {
    expect(bc({ upc: "012345678905" }).success).toBe(true);
    expect(bc({ upc: "0123456789055" }).success).toBe(false);
    expect(bc({ upc: "01234567890a" }).success).toBe(false);
    expect(bc({ ean: "12345678" }).success).toBe(true);
    expect(bc({ ean: "6291041500213" }).success).toBe(true);
    expect(bc({ ean: "123456789" }).success).toBe(false);
  });

  it("trims codes and accepts null for each type", () => {
    expect(bc({ upc: " 012345678905 " }).data?.barcodes?.upc).toBe("012345678905");
    expect(bc({ upc: null, ean: null, isbn: null, mpn: null }).success).toBe(true);
  });

  it("mpn is free text up to 40 characters and cannot be blank", () => {
    expect(bc({ mpn: "x".repeat(40) }).success).toBe(true);
    expectRejected(single({ barcodes: { mpn: "x".repeat(41) } }), "MPN must be at most 40 characters");
    expectRejected(single({ barcodes: { mpn: "  " } }), "MPN cannot be empty");
  });

  it("on update, null clears a barcode, ISBN is normalised and unknown types are rejected", () => {
    expect(updateProductSchema.parse({ barcodes: { upc: null, ean: null } })).toEqual({ barcodes: { upc: null, ean: null } });
    expect(updateProductSchema.parse({ barcodes: { isbn: "0-8044-2957-X" } }).barcodes?.isbn).toBe("080442957X");
    expect(updateIssues({ barcodes: { gtin: "1" } })).toContain("Unknown barcode type");
  });

  it("variant updates can clear barcodes, cost price, sku and reorderPoint with null", () => {
    const body = { barcodes: { ean: null }, costPrice: null, sku: null, reorderPoint: null };
    expect(updateVariantSchema.parse(body)).toEqual(body);
  });

  it("an ISBN written with hyphens collides with the same ISBN without, across variants", () => {
    expectRejected(
      variantItem({
        variants: [
          { attributeValues: { Size: "S", Colour: "Red" }, sellingPrice: "1", barcodes: { isbn: "978-0-306-40615-7" } },
          { attributeValues: { Size: "M", Colour: "Red" }, sellingPrice: "1", barcodes: { isbn: "9780306406157" } },
        ],
      }),
      "Barcode '9780306406157' is used more than once"
    );
  });

  it("null barcodes on several variants are not duplicates", () => {
    expect(
      OK(
        variantItem({
          variants: [
            { attributeValues: { Size: "S", Colour: "Red" }, sellingPrice: "1", barcodes: { ean: null } },
            { attributeValues: { Size: "M", Colour: "Red" }, sellingPrice: "1", barcodes: { ean: null } },
          ],
        })
      )
    ).toBe(true);
  });
});

describe("money, quantity and trimming boundaries", () => {
  const price = (sellingPrice: unknown) => OK(single({ sales: { sellingPrice } }));
  const rp = (unit: string, reorderPoint: unknown) => OK(single({ unit, inventory: { reorderPoint } }));

  it("allows 13 integer digits and 3 decimals, rejects 14 integer digits", () => {
    expect(price("9999999999999")).toBe(true);
    expect(price("9999999999999.999")).toBe(true);
    expect(price("10000000000000")).toBe(false);
    expect(price("0")).toBe(true);
    expect(price("00001.5")).toBe(true);
  });

  it("rejects missing integer part, trailing dot, exponent, signs, inner spaces and null", () => {
    for (const bad of [".5", "1.", "1e3", "+1", "-0", "1 000", "1.2.3", "NaN", null]) expect(price(bad), String(bad)).toBe(false);
  });

  it("a non-string price gets the explanatory type message", () => {
    expectRejected(single({ sales: { sellingPrice: 5 } }), "Amounts are sent as decimal strings");
  });

  it("cost price shares the format and may be null", () => {
    expect(OK(single({ purchase: { costPrice: null } }))).toBe(true);
    expectRejected(single({ purchase: { costPrice: "1.2345" } }), "purchase.costPrice");
    expectRejected(single({ purchase: { costPrice: 1.5 } }), "purchase.costPrice");
  });

  it("trims the price", () => {
    expect(createProductSchema.parse(single({ sales: { sellingPrice: " 0.5 " } })).sales?.sellingPrice).toBe("0.5");
  });

  it("quantities: 0.001 is the smallest fraction; float noise is tolerated", () => {
    expect(rp("kg", 0.001)).toBe(true);
    expect(rp("kg", 0.0005)).toBe(false);
    expect(rp("kg", 0.1 + 0.2)).toBe(true);
    expect(rp("kg", 1.005)).toBe(true);
  });

  it("every decimal unit accepts fractions and every count unit refuses them", () => {
    for (const unit of ["kg", "g", "L", "mL", "m", "cm"]) expect(rp(unit, 1.5), unit).toBe(true);
    for (const unit of ["pcs", "box", "pack", "dozen", "pair", "set", "bottle", "can", "bag"]) expect(rp(unit, 1.5), unit).toBe(false);
  });

  it("rejects a string reorderPoint", () => {
    expectRejected(single({ inventory: { reorderPoint: "5" } }), "Quantity must be a number");
  });
});

describe("text, dimensions, weight and tag limits", () => {
  it("brand and manufacturer: 100 max, not blank, null allowed", () => {
    for (const field of ["brand", "manufacturer"]) {
      expect(OK(single({ [field]: "x".repeat(100) }))).toBe(true);
      expectRejected(single({ [field]: "x".repeat(101) }), "must be at most 100 characters");
      expectRejected(single({ [field]: "  " }), "cannot be empty");
      expect(OK(single({ [field]: null }))).toBe(true);
    }
  });

  it("descriptions 1000; the old free-text preferred vendor is gone", () => {
    expect(OK(single({ sales: { sellingPrice: "1", description: "x".repeat(1000) } }))).toBe(true);
    expectRejected(single({ sales: { sellingPrice: "1", description: "x".repeat(1001) } }), "Sales description must be at most 1000");
    expectRejected(single({ purchase: { description: "x".repeat(1001) } }), "Purchase description must be at most 1000");
    expect(OK(single({ purchase: { preferredVendorName: "V" } }))).toBe(false);
  });

  it("imageUrl: http/https only (any case), max 2048, not javascript:", () => {
    expect(OK(single({ imageUrl: "http://x.test/a.png" }))).toBe(true);
    expect(OK(single({ imageUrl: "HTTPS://x.test/a.png" }))).toBe(true);
    expectRejected(single({ imageUrl: "javascript:alert(1)" }), "must be an http(s) URL");
    expectRejected(single({ imageUrl: "not a url" }), "imageUrl must be a URL");
    expectRejected(single({ imageUrl: `https://x.test/${"a".repeat(2048)}` }), "imageUrl");
  });

  it("dimensions need positive numbers, a cm/in unit, all keys and no extras", () => {
    const d = { length: 30, width: 20, height: 5, unit: "cm" };
    expect(OK(single({ dimensions: d }))).toBe(true);
    expect(OK(single({ dimensions: null }))).toBe(true);
    expect(OK(single({ dimensions: { ...d, unit: "in" } }))).toBe(true);
    expectRejected(single({ dimensions: { ...d, unit: "mm" } }), "dimensions.unit");
    expectRejected(single({ dimensions: { ...d, length: 0 } }), "dimensions.length");
    expectRejected(single({ dimensions: { ...d, width: -1 } }), "dimensions.width");
    expectRejected(single({ dimensions: { ...d, height: 100001 } }), "dimensions.height");
    expectRejected(single({ dimensions: { ...d, depth: 1 } }), "dimensions");
    expectRejected(single({ dimensions: { length: 1, width: 1, unit: "cm" } }), "dimensions.height");
    expectRejected(single({ dimensions: { ...d, length: "30" } }), "dimensions.length");
  });

  it("weight needs a positive value and a kg/lb unit", () => {
    expect(OK(single({ weight: { value: 0.25, unit: "kg" } }))).toBe(true);
    expect(OK(single({ weight: { value: 1, unit: "lb" } }))).toBe(true);
    expectRejected(single({ weight: { value: 0, unit: "kg" } }), "weight.value");
    expectRejected(single({ weight: { value: 1, unit: "g" } }), "weight.unit");
    expectRejected(single({ weight: { value: 100001, unit: "kg" } }), "weight.value");
    expectRejected(single({ weight: { value: 1 } }), "weight.unit");
    expectRejected(single({ weight: { value: 1, unit: "kg", x: 1 } }), "weight");
  });

  it("reporting tags: up to 20, each 1-30 chars, trimmed", () => {
    expect(OK(single({ reportingTags: Array.from({ length: 20 }, (_, i) => `t${i}`) }))).toBe(true);
    expectRejected(single({ reportingTags: Array.from({ length: 21 }, (_, i) => `t${i}`) }), "At most 20 reporting tags");
    expectRejected(single({ reportingTags: ["x".repeat(31)] }), "reportingTags.0");
    expectRejected(single({ reportingTags: [""] }), "reportingTags.0");
    expectRejected(single({ reportingTags: ["   "] }), "reportingTags.0");
    expect(createProductSchema.parse(single({ reportingTags: [" a "] })).reportingTags).toEqual(["a"]);
  });
});

describe("attributes and variants (create)", () => {
  const opts = (n: number) => Array.from({ length: n }, (_, i) => `o${i}`);
  const withAttr = (attributes: unknown) =>
    variantItem({ attributes, variants: [{ attributeValues: { Size: "S" }, sellingPrice: "1" }] });

  it("an attribute may have 50 options, not 51, and at least 1", () => {
    expect(
      OK(variantItem({ attributes: [{ name: "Size", options: opts(50) }], variants: [{ attributeValues: { Size: "o0" }, sellingPrice: "1" }] }))
    ).toBe(true);
    expectRejected(withAttr([{ name: "Size", options: opts(51) }]), "An attribute can have at most 50 options");
    expectRejected(withAttr([{ name: "Size", options: [] }]), "An attribute needs at least one option");
  });

  it("names and options are 1-30 chars and trimmed; at least one attribute; no extra keys", () => {
    expectRejected(withAttr([{ name: "x".repeat(31), options: ["S"] }]), "attributes.0.name");
    expectRejected(withAttr([{ name: "Size", options: ["x".repeat(31)] }]), "attributes.0.options.0");
    expectRejected(withAttr([{ name: " ", options: ["S"] }]), "attributes.0.name");
    expectRejected(variantItem({ attributes: [] }), "A variant item needs at least one attribute");
    expectRejected(withAttr([{ name: "Size", options: ["S"], extra: 1 }]), "attributes.0");
  });

  it("attributeValues values match options after trimming, case-insensitively", () => {
    expect(OK(variantItem({ variants: [{ attributeValues: { Size: " s ", Colour: "RED" }, sellingPrice: "1" }] }))).toBe(true);
  });

  it("attribute NAMES in attributeValues are case-sensitive ('size' is not 'Size')", () => {
    expectRejected(
      variantItem({ variants: [{ attributeValues: { size: "S", Colour: "Red" }, sellingPrice: "1" }] }),
      "Each variant needs exactly one value for: Size, Colour"
    );
  });

  it("variants must be a non-empty array of strict objects with a price", () => {
    expectRejected(variantItem({ variants: [] }), "variants");
    expectRejected(oneVariant({ openingStock: 3 }), "variants.0.openingStock: Expected array");
    expectRejected(variantItem({ variants: [{ attributeValues: { Size: "S", Colour: "Red" } }] }), "variants.0.sellingPrice");
  });

  it("variant items reject every single-only field even when null or empty", () => {
    expectRejected(variantItem({ sku: null }), "sku: Variant items set this on each variant instead");
    expectRejected(variantItem({ barcodes: {} }), "barcodes: Variant items set this");
    expectRejected(variantItem({ purchase: { costPrice: null } }), "purchase.costPrice");
    expectRejected(variantItem({ inventory: { reorderPoint: null } }), "inventory.reorderPoint");
  });

  it("descriptions, vendor and inventory flags are still allowed on a variant item", () => {
    expect(
      OK(variantItem({ purchase: { description: "x", preferredVendorId: "665f1c2e8a4b3c0012ab3900" }, inventory: { trackInventory: false, returnable: false }, sales: { description: "d" } }))
    ).toBe(true);
  });
});

describe("former contract gaps (fixed)", () => {
  // product.validator.ts:328 flattens upc/ean/isbn of one variant, so a book whose ISBN-13 is also
  // its EAN-13 is called a duplicate. Fix: dedupe per variant first (new Set(scannableCodes(v))),
  // and have the service do the same before checking organization-wide uniqueness.
  it("one variant may carry the same 13 digits as both ean and isbn", () => {
    expect(OK(oneVariant({ barcodes: { ean: "9780306406157", isbn: "9780306406157" } }))).toBe(true);
  });

  // product.validator.ts:299 uses `name in variant.attributeValues`, which also sees
  // Object.prototype members. An attribute called "constructor" with no value passes the
  // "missing value" test and then key(value) throws a TypeError (500 instead of 400).
  // Fix: Object.hasOwn(variant.attributeValues, name) in checkVariants (lines 299-300).
  it("an attribute named 'constructor' with no value is rejected cleanly instead of throwing", () => {
    const body = variantItem({
      attributes: [{ name: "constructor", options: ["a"] }],
      variants: [{ attributeValues: {}, sellingPrice: "1" }],
    });
    let result: Result | undefined;
    expect(() => {
      result = createProductSchema.safeParse(body);
    }).not.toThrow();
    expect(result?.success).toBe(false);
  });

  // product.validator.ts:213 inventoryGroup accepts reorderPoint for services, which never track
  // stock. Fix: in superRefine, for type === "service" reject inventory.reorderPoint (and
  // trackInventory is already rejected when true).
  it("a service cannot have a reorderPoint", () => {
    expect(OK({ ...serviceExample, inventory: { reorderPoint: 5 } })).toBe(false);
  });

  // updateProductSchema (product.validator.ts:397) does not reject a non-standard taxPreference
  // together with a taxRateId, unlike create. The docs only say that changing away from standard
  // clears the rate. Fix: add the same superRefine rule to the update schema (or document that the
  // service ignores/clears taxRateId in that case).
  it("update refuses taxPreference exempt together with a taxRateId", () => {
    expect(updateProductSchema.safeParse({ taxPreference: "exempt", taxRateId: "665f1c2e8a4b3c0012ab3600" }).success).toBe(false);
  });

  // updateProductSchema.attributes runs none of the duplicate attribute/option checks that create
  // runs in checkVariants. Fix: extract the duplicate checks from checkVariants and apply them in
  // an update superRefine (or have the service do it).
  it("update refuses duplicate attributes and duplicate options", () => {
    expect(updateProductSchema.safeParse({ attributes: [{ name: "Size", options: ["S", "s"] }] }).success).toBe(false);
    expect(
      updateProductSchema.safeParse({ attributes: [{ name: "Size", options: ["S"] }, { name: "size", options: ["M"] }] }).success
    ).toBe(false);
  });

  // updateProductSchema and updateVariantSchema: `{ sales: {} }` / `{ barcodes: {} }` count as a
  // provided field, so a no-op body passes the "at least one field" check. Fix: count leaf values
  // (or refine nested groups to be non-empty).
  it("update refuses an empty nested group as the only change", () => {
    expect(updateProductSchema.safeParse({ sales: {} }).success).toBe(false);
    expect(updateVariantSchema.safeParse({ barcodes: {} }).success).toBe(false);
  });
});

describe("updateProductSchema", () => {
  it("rejects unknown and server-owned fields", () => {
    for (const field of ["organizationId", "variants", "price", "stock", "openingStock", "createdAt", "_id", "isDelete", "itemType", "type"]) {
      expect(updateProductSchema.safeParse({ name: "X", [field]: "v" }).success, field).toBe(false);
    }
    expect(updateIssues({ name: "X", variants: [] })).toContain("variants are managed through");
    expect(updateIssues({ inventory: { openingStock: 1 } })).toContain("openingStock");
  });

  it("accepts any single field on its own, including name and unit (required only on create)", () => {
    for (const body of [
      { name: "N" },
      { unit: "kg" },
      { taxPreference: "exempt" },
      { isActive: false },
      { reportingTags: [] },
      { categoryId: null },
      { dimensions: null },
      { weight: null },
      { taxRateId: null },
      { inventory: { trackInventory: false } },
      { inventory: { returnable: false } },
      { inventory: { reorderPoint: null } },
      { sales: { sellingPrice: "1.000" } },
      { sales: { description: null } },
      { purchase: { costPrice: null } },
      { purchase: { preferredVendorId: null } },
    ]) {
      expect(updateProductSchema.safeParse(body).success, JSON.stringify(body)).toBe(true);
    }
  });

  it("does not inject create defaults into a partial update", () => {
    expect(updateProductSchema.parse({ name: "N" })).toEqual({ name: "N" });
    expect(updateProductSchema.parse({ brand: null })).toEqual({ brand: null });
  });

  it("nested groups are partial but still validated and strict", () => {
    expect(updateProductSchema.parse({ inventory: { returnable: true } })).toEqual({ inventory: { returnable: true } });
    expect(updateProductSchema.parse({ sales: { description: "d" } })).toEqual({ sales: { description: "d" } });
    for (const bad of [
      { sales: { sellingPrice: "1.2345" } },
      { sales: { sellingPrice: null } },
      { sales: { foo: 1 } },
      { inventory: { reorderPoint: -1 } },
      { name: "" },
      { name: null },
      { unit: null },
      { unit: "tonne" },
      { taxPreference: "non_gst_supply" },
    ]) {
      expect(updateProductSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("attributes on update follow the create shape (full list, 1-3, options 1-50)", () => {
    expect(updateProductSchema.safeParse({ attributes: [{ name: "Size", options: ["S", "M", "XL"] }] }).success).toBe(true);
    expect(updateIssues({ attributes: [] })).toContain("A variant item needs at least one attribute");
    expect(updateIssues({ attributes: [{ name: "Size", options: [] }] })).toContain("at least one option");
    expect(updateIssues({ attributes: [{ name: "Size", options: Array.from({ length: 51 }, (_, i) => `o${i}`) }] })).toContain("at most 50 options");
    expect(updateIssues({ attributes: ["A", "B", "C", "D"].map((name) => ({ name, options: ["x"] })) })).toContain("At most 3 attributes");
    expect(updateIssues({ attributes: [{ name: "Size" }] })).toContain("attributes.0.options");
  });

  it("trims and validates text on update like on create", () => {
    expect(updateProductSchema.parse({ name: "  N  ", brand: " B " })).toEqual({ name: "N", brand: "B" });
    expect(updateIssues({ brand: "  " })).toContain("cannot be empty");
    expect(updateIssues({ imageUrl: "ftp://x.test/a" })).toContain("http(s)");
  });

  // Documented limitations the service must handle because the schema cannot see the stored product:
  it("accepts a unit change and a fractional reorderPoint without the unit (service must cross-check)", () => {
    expect(updateProductSchema.safeParse({ unit: "pcs", inventory: { reorderPoint: 1.5 } }).success).toBe(true);
    expect(updateProductSchema.safeParse({ inventory: { trackInventory: true } }).success).toBe(true); // services: service must refuse
  });
});

describe("variant schemas", () => {
  it("createVariantSchema validates attributeValues entries, price type and strictness", () => {
    expect(createVariantSchema.safeParse({ attributeValues: {}, sellingPrice: "1" }).success).toBe(true);
    expect(createVariantSchema.safeParse({ attributeValues: { Size: "" }, sellingPrice: "1" }).success).toBe(false);
    expect(createVariantSchema.safeParse({ attributeValues: { Size: "x".repeat(31) }, sellingPrice: "1" }).success).toBe(false);
    expect(createVariantSchema.safeParse({ attributeValues: { Size: "L" }, sellingPrice: 5 }).success).toBe(false);
    expect(createVariantSchema.safeParse({ attributeValues: { Size: "L" }, sellingPrice: "5", openingStock: 1 }).success).toBe(false);
  });

  it("createVariantSchema cannot check reorderPoint against the unit (service must), only the 3-decimal rule", () => {
    expect(createVariantSchema.safeParse({ attributeValues: { Size: "L" }, sellingPrice: "5", reorderPoint: 1.5 }).success).toBe(true);
    expect(createVariantSchema.safeParse({ attributeValues: { Size: "L" }, sellingPrice: "5", reorderPoint: 1.5555 }).success).toBe(false);
  });

  it("updateVariantSchema requires one field, forbids null price, activation and unknown fields", () => {
    expect(updateVariantSchema.safeParse({}).success).toBe(false);
    for (const bad of [{ sellingPrice: null }, { isActive: false }, { isDefault: true }, { openingStock: 1 }, { sellingPrice: "1.2345" }, { sku: "" }]) {
      expect(updateVariantSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(updateVariantSchema.safeParse({ reorderPoint: 2.5 }).success).toBe(true);
  });
});

describe("categories (extra)", () => {
  it("create trims, caps the name at 60 and bounds sortOrder to 0..100000", () => {
    expect(createCategorySchema.parse({ name: "  Beverages " }).name).toBe("Beverages");
    expect(createCategorySchema.safeParse({ name: "x".repeat(60) }).success).toBe(true);
    expect(createCategorySchema.safeParse({ name: "x".repeat(61) }).success).toBe(false);
    expect(createCategorySchema.safeParse({ name: "X", sortOrder: 0 }).success).toBe(true);
    expect(createCategorySchema.safeParse({ name: "X", sortOrder: 100000 }).success).toBe(true);
    expect(createCategorySchema.safeParse({ name: "X", sortOrder: 100001 }).success).toBe(false);
    expect(createCategorySchema.safeParse({ name: "X", sortOrder: -1 }).success).toBe(false);
    expect(createCategorySchema.safeParse({ name: "X", sortOrder: "5" }).success).toBe(false);
    expect(createCategorySchema.safeParse({}).success).toBe(false);
    expect(createCategorySchema.safeParse({ name: "X", organizationId: "665f1c2e8a4b3c0012ab3300" }).success).toBe(false);
  });

  it("update accepts either field alone, rejects unknown, blank and null", () => {
    expect(updateCategorySchema.safeParse({ sortOrder: 3 }).success).toBe(true);
    expect(updateCategorySchema.safeParse({ name: "N" }).success).toBe(true);
    expect(updateCategorySchema.safeParse({ name: " " }).success).toBe(false);
    expect(updateCategorySchema.safeParse({ productCount: 1 }).success).toBe(false);
    expect(updateCategorySchema.safeParse({ sortOrder: null }).success).toBe(false);
  });
});
