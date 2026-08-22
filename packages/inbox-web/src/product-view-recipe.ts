import { z } from "zod";

const RECIPE_API_VERSION = "hob.view.recipe/v1" as const;
const RECIPE_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;
const RECIPE_FAILURE = "Product view recipe is invalid";

const recipeRouteSchema = z.enum([
  "overview",
  "conversation",
  "reviews",
  "activity",
  "control",
  "settings",
  "automations",
  "onboarding",
]);

const recipeSlotSchema = z.enum([
  "overview.header",
  "overview.status",
  "overview.active-turn",
  "overview.spaces",
  "overview.review-summary",
  "overview.agent-note",
  "overview.energy",
  "overview.composer",
  "conversation.workspace",
  "reviews.workspace",
  "activity.workspace",
  "control.workspace",
  "settings.workspace",
  "automations.workspace",
  "onboarding.workspace",
]);

const recipeSlotPlacementSchema = z.strictObject({
  slot: recipeSlotSchema,
  width: z.enum(["full", "half", "third"]),
});

const recipePageSchema = z.strictObject({
  route: recipeRouteSchema,
  layout: z.enum(["stack", "split", "grid"]),
  slots: z.array(recipeSlotPlacementSchema).min(1).max(12),
});

const productViewRecipeSchema = z.strictObject({
  apiVersion: z.literal(RECIPE_API_VERSION),
  id: z.string().min(1).max(120).regex(RECIPE_ID).refine((value) => !value.startsWith("builtin.")),
  title: z.string().min(1).max(80)
    .refine((value) => value.trim() === value)
    .refine((value) => !/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(value)),
  pages: z.array(recipePageSchema).min(1).max(7),
}).superRefine((recipe, context) => {
  const routes = new Set<string>();
  let slotCount = 0;
  for (const [pageIndex, page] of recipe.pages.entries()) {
    if (routes.has(page.route)) {
      context.addIssue({ code: "custom", path: ["pages", pageIndex, "route"], message: "Duplicate route" });
    }
    routes.add(page.route);
    slotCount += page.slots.length;

    const slots = new Set<string>();
    for (const [slotIndex, placement] of page.slots.entries()) {
      if (slots.has(placement.slot)) {
        context.addIssue({ code: "custom", path: ["pages", pageIndex, "slots", slotIndex, "slot"], message: "Duplicate slot" });
      }
      slots.add(placement.slot);
      if (!placement.slot.startsWith(`${page.route}.`)) {
        context.addIssue({ code: "custom", path: ["pages", pageIndex, "slots", slotIndex, "slot"], message: "Route mismatch" });
      }
      if (page.layout === "stack" && placement.width !== "full") {
        context.addIssue({ code: "custom", path: ["pages", pageIndex, "slots", slotIndex, "width"], message: "Stack width" });
      }
      if (page.layout === "split" && placement.width === "third") {
        context.addIssue({ code: "custom", path: ["pages", pageIndex, "slots", slotIndex, "width"], message: "Split width" });
      }
    }
    if (page.route === "overview" && !slots.has("overview.header")) {
      context.addIssue({ code: "custom", path: ["pages", pageIndex, "slots"], message: "Overview heading" });
    }
    if (page.route === "overview" && page.slots[0]?.slot !== "overview.header") {
      context.addIssue({ code: "custom", path: ["pages", pageIndex, "slots", 0], message: "Overview heading order" });
    }
    const overviewHeader = page.slots.find((placement) => placement.slot === "overview.header");
    if (overviewHeader !== undefined && overviewHeader.width !== "full") {
      context.addIssue({ code: "custom", path: ["pages", pageIndex, "slots"], message: "Overview heading width" });
    }
    const composerIndex = page.slots.findIndex((placement) => placement.slot === "overview.composer");
    if (composerIndex >= 0 && composerIndex !== page.slots.length - 1) {
      context.addIssue({ code: "custom", path: ["pages", pageIndex, "slots", composerIndex], message: "Overview composer order" });
    }
    if (page.layout !== "stack" && page.slots.length < 2) {
      context.addIssue({ code: "custom", path: ["pages", pageIndex, "slots"], message: "Layout requires multiple slots" });
    }
  }
  if (slotCount > 64) {
    context.addIssue({ code: "custom", path: ["pages"], message: "Recipe slot budget" });
  }
});

export type ProductViewRecipeV1 = z.infer<typeof productViewRecipeSchema>;

/** Validates untrusted recipe data and returns a stable Host-owned slot plan. */
export function compileProductViewRecipe(input: unknown): ProductViewRecipeV1 {
  try {
    if (!hasBoundedRecipeShape(input)) throw new TypeError(RECIPE_FAILURE);
    const parsed = productViewRecipeSchema.safeParse(input);
    if (!parsed.success) throw new TypeError(RECIPE_FAILURE);
    return deepFreeze(parsed.data);
  } catch {
    throw new TypeError(RECIPE_FAILURE);
  }
}

function hasBoundedRecipeShape(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  const pages = (input as { readonly pages?: unknown }).pages;
  if (!Array.isArray(pages) || pages.length < 1 || pages.length > 7) return false;
  let slotCount = 0;
  for (const page of pages) {
    if (typeof page !== "object" || page === null) return false;
    const slots = (page as { readonly slots?: unknown }).slots;
    if (!Array.isArray(slots) || slots.length < 1 || slots.length > 12) return false;
    slotCount += slots.length;
    if (slotCount > 64) return false;
  }
  return true;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null) return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(object)) deepFreeze(child, seen);
  return Object.freeze(value);
}
