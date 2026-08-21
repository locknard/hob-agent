import { createHash } from "node:crypto";

import {
  renderProductContent,
  renderProductHost,
  renderProductViewRecipeContent,
  type ProductShellModel,
  type ProductShellRoute,
} from "./product-shell.js";
import { PRODUCT_SHELL_STYLES } from "./product-shell-styles.js";
import { compileProductViewRecipe, type ProductViewRecipeV1 } from "./product-view-recipe.js";

const CHECK_NAMES = [
  "recipe_compilation",
  "immutable_plan",
  "deterministic_render",
  "semantic_headings",
  "host_boundary",
  "canonical_fallback",
  "responsive_layout",
] as const;

const ROUTES: readonly ProductShellRoute[] = [
  "overview",
  "conversation",
  "reviews",
  "activity",
  "control",
  "settings",
  "onboarding",
];

export type ProductViewRecipeConformanceCheckName = typeof CHECK_NAMES[number];
export type ProductViewRecipeConformanceStatus = "passed" | "failed" | "blocked";

export interface ProductViewRecipeConformanceCheck {
  readonly name: ProductViewRecipeConformanceCheckName;
  readonly status: ProductViewRecipeConformanceStatus;
}

export interface ProductViewRecipeConformanceReport {
  readonly passed: boolean;
  readonly recipeId?: string;
  readonly recipeDigest?: `sha256:${string}`;
  readonly checks: readonly ProductViewRecipeConformanceCheck[];
}

/** Runs the deterministic publication checks for one data-only layout recipe. */
export function runProductViewRecipeConformance(input: unknown): ProductViewRecipeConformanceReport {
  let recipe: ProductViewRecipeV1;
  try {
    recipe = compileProductViewRecipe(input);
  } catch {
    return report(CHECK_NAMES.map((name, index) => ({
      name,
      status: index === 0 ? "failed" : "blocked",
    })));
  }

  const checks: ProductViewRecipeConformanceCheck[] = [
    { name: "recipe_compilation", status: "passed" },
    check("immutable_plan", () => deeplyFrozen(recipe)),
    check("deterministic_render", () => deterministicRender(recipe)),
    check("semantic_headings", () => semanticHeadings(recipe)),
    check("host_boundary", () => hostBoundary(recipe)),
    check("canonical_fallback", () => canonicalFallback(recipe)),
    check("responsive_layout", responsiveLayout),
  ];
  const digest = createHash("sha256").update(JSON.stringify(recipe)).digest("hex");
  return report(checks, recipe.id, `sha256:${digest}`);
}

function check(
  name: ProductViewRecipeConformanceCheckName,
  operation: () => boolean,
): ProductViewRecipeConformanceCheck {
  try {
    return { name, status: operation() ? "passed" : "failed" };
  } catch {
    return { name, status: "failed" };
  }
}

function deterministicRender(recipe: ProductViewRecipeV1): boolean {
  return recipe.pages.every(({ route }) => {
    const source: ProductShellModel = { route };
    return renderProductViewRecipeContent(recipe, source) === renderProductViewRecipeContent(recipe, source);
  });
}

function semanticHeadings(recipe: ProductViewRecipeV1): boolean {
  return recipe.pages.every(({ route }) => {
    const html = renderProductViewRecipeContent(recipe, { route });
    return (html.match(/<h1(?:\s|>)/g) ?? []).length === 1
      && html.includes(`data-recipe-route="${route}"`);
  });
}

function hostBoundary(recipe: ProductViewRecipeV1): boolean {
  const route = recipe.pages[0]!.route;
  const source: ProductShellModel = {
    route,
    safetyAlerts: [{
      id: "conformance-safety",
      title: "安全提醒",
      status: "active",
      severity: "safety",
      snoozeAllowed: false,
    }],
    runtimeConfirmationCount: 1,
    proposalCapacityUsed: 2,
    proposalCapacity: 5,
    view: {
      activeId: recipe.id,
      currentPath: "/home",
      choices: [
        { id: "builtin.life", label: "生活视图" },
        { id: recipe.id, label: recipe.title },
      ],
    },
  };
  const content = renderProductViewRecipeContent(recipe, source);
  const host = renderProductHost(source, content);
  return !/<(?:script|style)\b/i.test(content)
    && !content.includes("data-host-owned")
    && !content.includes("data-badge=")
    && host.includes('class="product-safety-banner"')
    && host.includes('data-badge="runtime" data-count="1"')
    && host.includes('data-badge="proposal" data-count="2/5"')
    && host.includes(`data-recipe-provider="${recipe.id}"`);
}

function canonicalFallback(recipe: ProductViewRecipeV1): boolean {
  const declared = new Set(recipe.pages.map(({ route }) => route));
  return ROUTES.filter((route) => !declared.has(route)).every((route) => {
    const source: ProductShellModel = { route };
    return renderProductViewRecipeContent(recipe, source) === renderProductContent(source);
  });
}

function responsiveLayout(): boolean {
  return /\.product-recipe-layout\s*\{[^}]*grid-template-columns:\s*repeat\(6,/s.test(PRODUCT_SHELL_STYLES)
    && /data-recipe-width="full"\]\s*\{[^}]*grid-column:\s*span 6/s.test(PRODUCT_SHELL_STYLES)
    && /data-recipe-width="half"\]\s*\{[^}]*grid-column:\s*span 3/s.test(PRODUCT_SHELL_STYLES)
    && /data-recipe-width="third"\]\s*\{[^}]*grid-column:\s*span 2/s.test(PRODUCT_SHELL_STYLES)
    && /@media\s*\(max-width:\s*56rem\)[\s\S]*?\.product-recipe-slot\[data-recipe-width\]\s*\{[^}]*grid-column:\s*span 6/s.test(PRODUCT_SHELL_STYLES);
}

function deeplyFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value).every((child) => deeplyFrozen(child, seen));
}

function report(
  checks: readonly ProductViewRecipeConformanceCheck[],
  recipeId?: string,
  recipeDigest?: `sha256:${string}`,
): ProductViewRecipeConformanceReport {
  const snapshot = Object.freeze(checks.map((item) => Object.freeze({ ...item })));
  return Object.freeze({
    passed: snapshot.every(({ status }) => status === "passed"),
    ...(recipeId === undefined ? {} : { recipeId }),
    ...(recipeDigest === undefined ? {} : { recipeDigest }),
    checks: snapshot,
  });
}
