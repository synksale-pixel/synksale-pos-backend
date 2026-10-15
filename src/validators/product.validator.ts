/**
 * Purpose: Product Validators.
 *
 * Shape follows the frontend product form (sales / purchase / inventory groups), with these
 * contract rules:
 * - Every product has at least one variant. A `single` item sends its SKU, barcodes, prices and
 *   reorder point at the top level and the server keeps them on one hidden default variant; a
 *   `variant` item sends `attributes` + `variants` instead.
 * - Money is a decimal string ("1.250"). The format is checked here; the number of decimals is
 *   checked against the organization's currency by the service (BHD 3, AED 2).
 * - Selling prices are as entered: VAT-inclusive when the organization's
 *   `settings.sales.pricesIncludeTax` is true (the default). Cost prices are always VAT-exclusive.
 * - Quantities (reorderPoint) are numbers with at most 3 decimals; whole numbers unless the unit
 *   allows decimals (kg, g, L, mL, m, cm).
 * - `type` and `itemType` are fixed at creation.
 * - Opening stock is not accepted yet; it arrives with the stock ledger (Phase 2).
 */

import "../config/openapi.registry"; // must load first: enables .openapi() on Zod
import { z } from "zod";
import { DEFAULT_UNIT, QUANTITY_DECIMALS, UNIT_CODES, unitAllowsDecimal } from "../config/units.config";

// ==========================================
// Field building blocks
// ==========================================

const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

const objectIdField = (label: string, example: string) =>
  z.string().regex(OBJECT_ID, { message: `${label} must be a 24-character hex id.` }).openapi({ example });

/** Non-negative decimal string with at most 3 decimals; the currency's own limit is checked later. */
const moneyField = (description: string, example: string) =>
  z
    .string({ invalid_type_error: "Amounts are sent as decimal strings, e.g. \"1.250\"." })
    .trim()
    .regex(/^\d{1,13}(\.\d{1,3})?$/, {
      message: 'Must be a non-negative decimal string such as "1.250" (at most 3 decimal places).',
    })
    .openapi({ description, example });

const quantityField = (description: string, example: number) =>
  z
    .number({ invalid_type_error: "Quantity must be a number." })
    .min(0, { message: "Quantity cannot be negative." })
    .max(1_000_000_000, { message: "Quantity is too large." })
    .refine((value) => Number.isInteger(Number((value * 10 ** QUANTITY_DECIMALS).toFixed(6))), {
      message: `Quantity may have at most ${QUANTITY_DECIMALS} decimal places.`,
    })
    .openapi({ description, example });

const optionalText = (label: string, max: number, example: string) =>
  z
    .string()
    .trim()
    .min(1, { message: `${label} cannot be empty. Send null to clear it.` })
    .max(max, { message: `${label} must be at most ${max} characters long.` })
    .openapi({ example });

const skuField = z
  .string()
  .trim()
  .min(1, { message: "SKU cannot be empty. Omit it or send null." })
  .max(40, { message: "SKU must be at most 40 characters long." })
  .regex(/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/, {
    message: "SKU may contain letters, digits and . _ - / and must start with a letter or digit.",
  })
  .openapi({
    description: "Optional. Unique within your organization (case-insensitive) when present.",
    example: "TSHIRT-RED-M",
  });

export const barcodesSchema = z
  .object({
    upc: z
      .string()
      .trim()
      .regex(/^\d{12}$/, { message: "UPC must be 12 digits." })
      .nullable()
      .optional()
      .openapi({ example: "012345678905" }),
    ean: z
      .string()
      .trim()
      .regex(/^(\d{8}|\d{13})$/, { message: "EAN must be 8 or 13 digits." })
      .nullable()
      .optional()
      .openapi({ example: "6291041500213" }),
    isbn: z
      .string()
      .trim()
      .transform((value) => value.replace(/-/g, "").toUpperCase())
      .pipe(z.string().regex(/^(\d{9}[\dX]|\d{13})$/, { message: "ISBN must be 10 or 13 characters (hyphens allowed)." }))
      .nullable()
      .optional()
      .openapi({ example: "9780306406157" }),
    mpn: optionalText("MPN", 40, "MX-2201-RD").nullable().optional().openapi({
      description: "Manufacturer part number. Stored for reference; not unique and not scannable.",
    }),
  })
  .strict({ message: "Unknown barcode type. Use upc, ean, isbn or mpn." })
  .openapi("ProductBarcodesInput", {
    description:
      "UPC, EAN and ISBN are scannable: each value is unique within your organization and found by the lookup endpoint. null clears a value on update.",
  });

const taxPreferenceField = z
  .enum(["standard", "zero_rated", "exempt", "out_of_scope"], {
    message: "taxPreference must be one of: standard, zero_rated, exempt, out_of_scope.",
  })
  .openapi({
    description:
      "GCC VAT treatment. `standard` uses `taxRateId` (or the organization's default rate when omitted); the others charge no VAT and must not send a taxRateId.",
    example: "standard",
  });

const dimensionsSchema = z
  .object({
    length: z.number().positive().max(100000),
    width: z.number().positive().max(100000),
    height: z.number().positive().max(100000),
    unit: z.enum(["cm", "in"]),
  })
  .strict()
  .openapi("ProductDimensions", { example: { length: 30, width: 20, height: 5, unit: "cm" } });

const weightSchema = z
  .object({
    value: z.number().positive().max(100000),
    unit: z.enum(["kg", "lb"]),
  })
  .strict()
  .openapi("ProductWeight", { example: { value: 0.25, unit: "kg" } });

const reportingTagsField = z
  .array(z.string().trim().min(1).max(30))
  .max(20, { message: "At most 20 reporting tags." })
  .openapi({ description: "Free-form tags for reports. Not shown in the form yet.", example: ["summer-2026"] });

const attributeSchema = z
  .object({
    name: z.string().trim().min(1).max(30).openapi({ example: "Size" }),
    options: z
      .array(z.string().trim().min(1).max(30))
      .min(1, { message: "An attribute needs at least one option." })
      .max(50, { message: "An attribute can have at most 50 options." })
      .openapi({ example: ["S", "M", "L"] }),
  })
  .strict()
  .openapi("ProductAttribute");

const attributesField = z
  .array(attributeSchema)
  .min(1, { message: "A variant item needs at least one attribute." })
  .max(3, { message: "At most 3 attributes (e.g. Size, Colour, Material)." });

const attributeValuesField = z
  .record(z.string().trim().min(1).max(30), z.string().trim().min(1).max(30))
  .openapi({
    description: "One value per attribute, keyed by attribute name. Each combination is unique within the product.",
    example: { Size: "M", Colour: "Red" },
  });

/** Fields of a sellable variant (also used for the default variant of a single item). */
const variantFields = {
  sku: skuField.nullable().optional(),
  barcodes: barcodesSchema.optional(),
  sellingPrice: moneyField("Selling price per unit. VAT-inclusive when the org's pricesIncludeTax is true.", "4.500"),
  costPrice: moneyField("Purchase cost per unit, VAT-exclusive.", "2.750").nullable().optional(),
  reorderPoint: quantityField("Stock level at which to reorder.", 10).nullable().optional(),
};

export const variantInputSchema = z
  .object({
    attributeValues: attributeValuesField,
    ...variantFields,
  })
  .strict({ message: "Unknown variant field. Opening stock is not accepted yet (it arrives with stock tracking)." })
  .openapi("ProductVariantInput");

// ==========================================
// Product groups (follow the frontend form)
// ==========================================

const salesGroup = z
  .object({
    sellingPrice: variantFields.sellingPrice.optional().openapi({
      description: "Single items only (required for them). Variant items set a price per variant.",
    }),
    description: optionalText("Sales description", 1000, "Soft cotton crew-neck T-shirt.").nullable().optional(),
  })
  .strict();

const purchaseGroup = z
  .object({
    costPrice: variantFields.costPrice.openapi({ description: "Single items only. VAT-exclusive." }),
    description: optionalText("Purchase description", 1000, "Carton of 24.").nullable().optional(),
    preferredVendorName: optionalText("Preferred vendor", 100, "Gulf Textiles W.L.L.").nullable().optional().openapi({
      description: "Free text for now; becomes a vendor reference when vendors exist.",
    }),
  })
  .strict();

const inventoryGroup = z
  .object({
    trackInventory: z.boolean().optional().openapi({
      description: "Goods default to true. Services never track inventory (sending true is rejected).",
      example: true,
    }),
    reorderPoint: variantFields.reorderPoint.openapi({ description: "Single items only." }),
    returnable: z.boolean().optional().openapi({ description: "Default true.", example: true }),
  })
  .strict({
    message:
      "Unknown inventory field. openingStock / openingStockValue are not accepted yet (they arrive with stock tracking); valuationMethod is fixed to weighted average.",
  });

const productFields = {
  name: z.string().trim().min(1, { message: "Product name is required." }).max(200).openapi({ example: "Crew-neck T-shirt" }),
  categoryId: objectIdField("categoryId", "665f1c2e8a4b3c0012ab3700").nullable().optional(),
  unit: z
    .enum(UNIT_CODES, { message: `unit must be one of: ${UNIT_CODES.join(", ")}.` })
    .openapi({ description: "Unit of sale. kg, g, L, mL, m and cm allow fractional quantities.", example: "pcs" }),
  brand: optionalText("Brand", 100, "Al Noor").nullable().optional(),
  manufacturer: optionalText("Manufacturer", 100, "Al Noor Garments").nullable().optional(),
  taxPreference: taxPreferenceField,
  taxRateId: objectIdField("taxRateId", "665f1c2e8a4b3c0012ab3600").nullable().optional(),
  imageUrl: z
    .string()
    .trim()
    .max(2048)
    .url({ message: "imageUrl must be a URL." })
    .refine((value) => /^https?:\/\//i.test(value), { message: "imageUrl must be an http(s) URL." })
    .nullable()
    .optional()
    .openapi({ description: "A link to an image hosted elsewhere. Uploads are not supported.", example: "https://cdn.example.com/tshirt.jpg" }),
  dimensions: dimensionsSchema.nullable().optional(),
  weight: weightSchema.nullable().optional(),
  reportingTags: reportingTagsField.optional(),
  isActive: z.boolean().optional().openapi({ description: "Default true.", example: true }),
  sales: salesGroup.optional(),
  purchase: purchaseGroup.optional(),
  inventory: inventoryGroup.optional(),
  // Single items only: these live on the hidden default variant.
  sku: skuField.nullable().optional(),
  barcodes: barcodesSchema.optional(),
};

// ==========================================
// Cross-field rules
// ==========================================

type Issue = { path: (string | number)[]; message: string };

const key = (value: string) => value.trim().toLowerCase();

function duplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const value of values.map(key)) {
    if (seen.has(value)) dup.add(value);
    seen.add(value);
  }
  return [...dup];
}

/**
 * The distinct scannable codes of one variant. A book's ISBN-13 is normally also its EAN-13, so
 * the same digits under two keys of one variant are one code, not a duplicate.
 */
function scannableCodes(barcodes?: z.infer<typeof barcodesSchema>): string[] {
  if (!barcodes) return [];
  const codes = [barcodes.upc, barcodes.ean, barcodes.isbn].filter((code): code is string => Boolean(code));
  return [...new Set(codes)];
}

/** True when a value carries an actual change: an empty nested group like `{ sales: {} }` does not. */
function hasContent(value: unknown): boolean {
  if (value === undefined) return false;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return Object.values(value).some(hasContent);
  }
  return true; // null (clear), arrays (replace) and scalars all count
}

/** Duplicate attribute names and duplicate options within an attribute (case-insensitive). */
function checkAttributeDuplicates(attributes: z.infer<typeof attributesField>, issues: Issue[]) {
  for (const name of duplicates(attributes.map((a) => a.name))) {
    issues.push({ path: ["attributes"], message: `Attribute '${name}' is listed twice.` });
  }
  attributes.forEach((attribute, index) => {
    for (const option of duplicates(attribute.options)) {
      issues.push({ path: ["attributes", index, "options"], message: `Option '${option}' is listed twice.` });
    }
  });
}

/** Rules shared by create and by add-variant: unit-aware quantity and in-request uniqueness. */
function checkReorderPoint(value: number | null | undefined, unit: string | undefined, path: (string | number)[], issues: Issue[]) {
  if (value !== null && value !== undefined && unit && !unitAllowsDecimal(unit) && !Number.isInteger(value)) {
    issues.push({ path, message: `Unit '${unit}' only allows whole quantities.` });
  }
}

/** Validates the attributes and the variants against them (used on create). */
function checkVariants(
  attributes: z.infer<typeof attributesField>,
  variants: z.infer<typeof variantInputSchema>[],
  unit: string | undefined,
  issues: Issue[]
) {
  checkAttributeDuplicates(attributes, issues);

  const combos = new Set<string>();
  variants.forEach((variant, index) => {
    const names = Object.keys(variant.attributeValues);
    const expected = attributes.map((a) => a.name);
    // Own properties only: `in` would also see Object.prototype members such as "constructor".
    const missing = expected.filter((name) => !Object.hasOwn(variant.attributeValues, name));
    const extra = names.filter((name) => !expected.includes(name));
    if (missing.length || extra.length) {
      issues.push({
        path: ["variants", index, "attributeValues"],
        message: `Each variant needs exactly one value for: ${expected.join(", ")}.`,
      });
      return;
    }
    for (const attribute of attributes) {
      const value = variant.attributeValues[attribute.name];
      if (typeof value !== "string" || !attribute.options.some((option) => key(option) === key(value))) {
        issues.push({
          path: ["variants", index, "attributeValues", attribute.name],
          message: `'${value}' is not an option of ${attribute.name}.`,
        });
      }
    }
    const combo = expected.map((name) => key(variant.attributeValues[name])).join("\u0000");
    if (combos.has(combo)) {
      issues.push({ path: ["variants", index, "attributeValues"], message: "Two variants have the same attribute values." });
    }
    combos.add(combo);
    checkReorderPoint(variant.reorderPoint, unit, ["variants", index, "reorderPoint"], issues);
  });

  for (const sku of duplicates(variants.map((v) => v.sku).filter((s): s is string => Boolean(s)))) {
    issues.push({ path: ["variants"], message: `SKU '${sku}' is used by more than one variant.` });
  }
  for (const code of duplicates(variants.flatMap((v) => scannableCodes(v.barcodes)))) {
    issues.push({ path: ["variants"], message: `Barcode '${code}' is used more than once.` });
  }
}

// ==========================================
// Create / update product
// ==========================================

export const createProductSchema = z
  .object({
    ...productFields,
    type: z.enum(["goods", "service"], { message: "type must be goods or service." }).openapi({ example: "goods" }),
    itemType: z
      .enum(["single", "variant"], { message: "itemType must be single or variant." })
      .default("single")
      .openapi({ description: "Fixed at creation. Services are always single.", example: "single" }),
    unit: productFields.unit.default(DEFAULT_UNIT),
    taxPreference: taxPreferenceField.default("standard"),
    attributes: attributesField.optional(),
    variants: z.array(variantInputSchema).min(1).max(100, { message: "At most 100 variants per product." }).optional(),
  })
  .strict({
    message:
      "Unknown product field. openingStock / openingStockValue are not accepted yet (they arrive with stock tracking); price and stock are computed by the server.",
  })
  .superRefine((body, ctx) => {
    const issues: Issue[] = [];
    const isSingle = body.itemType === "single";

    if (body.type === "service") {
      if (!isSingle) issues.push({ path: ["itemType"], message: "Services are always single items." });
      if (body.brand) issues.push({ path: ["brand"], message: "Services have no brand." });
      if (body.manufacturer) issues.push({ path: ["manufacturer"], message: "Services have no manufacturer." });
      if (body.inventory?.trackInventory) {
        issues.push({ path: ["inventory", "trackInventory"], message: "Services cannot track inventory." });
      }
      if (body.inventory?.reorderPoint !== undefined && body.inventory.reorderPoint !== null) {
        issues.push({ path: ["inventory", "reorderPoint"], message: "Services have no stock to reorder." });
      }
    }

    if (body.taxPreference !== "standard" && body.taxRateId) {
      issues.push({ path: ["taxRateId"], message: `A ${body.taxPreference} product must not have a tax rate.` });
    }

    if (isSingle) {
      if (!body.sales?.sellingPrice) {
        issues.push({ path: ["sales", "sellingPrice"], message: "Selling price is required for a single item." });
      }
      if (body.attributes) issues.push({ path: ["attributes"], message: "Only variant items have attributes." });
      if (body.variants) issues.push({ path: ["variants"], message: "Only variant items have variants." });
      checkReorderPoint(body.inventory?.reorderPoint, body.unit, ["inventory", "reorderPoint"], issues);
    } else {
      const singleOnly: [boolean, (string | number)[]][] = [
        [body.sku !== undefined, ["sku"]],
        [body.barcodes !== undefined, ["barcodes"]],
        [body.sales?.sellingPrice !== undefined, ["sales", "sellingPrice"]],
        [body.purchase?.costPrice !== undefined, ["purchase", "costPrice"]],
        [body.inventory?.reorderPoint !== undefined, ["inventory", "reorderPoint"]],
      ];
      for (const [present, path] of singleOnly) {
        if (present) issues.push({ path, message: "Variant items set this on each variant instead." });
      }
      if (!body.attributes) issues.push({ path: ["attributes"], message: "A variant item needs attributes." });
      if (!body.variants) issues.push({ path: ["variants"], message: "A variant item needs at least one variant." });
      if (body.attributes && body.variants) checkVariants(body.attributes, body.variants, body.unit, issues);
    }

    for (const issue of issues) ctx.addIssue({ code: z.ZodIssueCode.custom, ...issue });
  });

export const updateProductSchema = z
  .object({
    ...productFields,
    taxPreference: taxPreferenceField,
    attributes: attributesField.openapi({
      description:
        "Variant items only. Send the full list: options may be added (and renamed only if unused); removing an option a variant uses, or adding/removing an attribute, is refused.",
    }),
  })
  // Every field is optional on update (name and unit are required only on create).
  .partial()
  .strict({
    message:
      "Unknown or immutable field. type and itemType cannot be changed; variants are managed through /products/{productId}/variants.",
  })
  .superRefine((body, ctx) => {
    const issues: Issue[] = [];
    if (!hasContent(body)) {
      issues.push({ path: [], message: "At least one field must be provided." });
    }
    // The stored preference is unknown here; the service also refuses a rate on a non-standard product.
    if (body.taxPreference && body.taxPreference !== "standard" && body.taxRateId) {
      issues.push({ path: ["taxRateId"], message: `A ${body.taxPreference} product must not have a tax rate.` });
    }
    if (body.attributes) checkAttributeDuplicates(body.attributes, issues);
    for (const issue of issues) ctx.addIssue({ code: z.ZodIssueCode.custom, ...issue });
  });

// ==========================================
// Variants of a variant item
// ==========================================

export const createVariantSchema = variantInputSchema;

export const updateVariantSchema = z
  .object({
    sku: variantFields.sku,
    barcodes: variantFields.barcodes,
    sellingPrice: variantFields.sellingPrice.optional(),
    costPrice: variantFields.costPrice,
    reorderPoint: variantFields.reorderPoint,
  })
  .strict({
    message: "Unknown or immutable field. attributeValues cannot be changed: deactivate the variant and add a new one.",
  })
  .refine(hasContent, { message: "At least one field must be provided." });

// ==========================================
// Query strings (documented; parsed leniently by the controller)
// ==========================================

export const listProductsQuerySchema = z.object({
  search: z.string().optional().openapi({
    description: "Case-insensitive prefix match on name, SKU or barcode (UPC/EAN/ISBN).",
    example: "crew",
  }),
  categoryId: z.string().optional().openapi({
    description: "Filter by category, including its subcategories unless includeSubcategories=false. Use `none` for uncategorised.",
    example: "665f1c2e8a4b3c0012ab3700",
  }),
  includeSubcategories: z.enum(["true", "false"]).optional().openapi({
    description: "With categoryId: send exactly `false` to match only products directly in that category. Omitting it, or any other value (including FALSE, 0 or empty), includes subcategories; this never returns 400.",
    example: "false",
  }),
  type: z.enum(["goods", "service"]).optional(),
  isActive: z.enum(["true", "false"]).optional(),
  tag: z.string().optional().openapi({ description: "Filter by reporting tag.", example: "summer-2026" }),
  page: z.number().int().optional().openapi({ description: "1-based page number (default 1).", example: 1 }),
  limit: z.number().int().optional().openapi({ description: "Page size (default 20, max 100).", example: 20 }),
});

export const lookupProductQuerySchema = z.object({
  code: z.string().openapi({
    description: "A scanned barcode (UPC/EAN/ISBN) or a SKU (case-insensitive). Exact match.",
    example: "6291041500213",
  }),
});

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;
export type VariantInput = z.infer<typeof variantInputSchema>;
export type UpdateVariantInput = z.infer<typeof updateVariantSchema>;
