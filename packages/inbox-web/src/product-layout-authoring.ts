import { randomUUID } from "node:crypto";

import {
  renderProductViewRecipeContent,
  type ProductShellModel,
  type ProductShellRoute,
} from "./product-shell.js";
import { runProductViewRecipeConformance } from "./product-view-recipe-conformance.js";
import { compileProductViewRecipe, type ProductViewRecipeV1 } from "./product-view-recipe.js";

const PREVIEW_HREFS: Partial<Record<ProductShellRoute, string>> = {
  overview: "/home",
  conversation: "/conversation",
  reviews: "/review-center",
  activity: "/activity",
  control: "/control",
  settings: "/settings",
};

export interface ProductViewRecipeDraftSummary {
  readonly draftId: string;
  readonly revision: number;
  readonly label: string;
  readonly updatedAt: string;
}

export interface ProductViewRecipeDraft extends ProductViewRecipeDraftSummary {
  readonly ownerPrincipalId: string;
  readonly source: string;
}

export interface ProductViewRecipePublication {
  readonly generationId: string;
  readonly recipeId: string;
  readonly title: string;
  readonly draftId: string;
  readonly draftRevision: number;
  readonly recipeDigest: `sha256:${string}`;
  readonly source: string;
  readonly publishedBy: string;
  readonly publishedAt: string;
}

export interface ProductViewRecipePublicationEvent {
  readonly eventId: string;
  readonly kind: "published" | "rolled_back" | "deactivated";
  readonly recipeId: string;
  readonly generationId: string;
  readonly previousGenerationId?: string;
  readonly actorPrincipalId: string;
  readonly occurredAt: string;
}

export interface ProductViewRecipeDraftPort {
  create(input: {
    readonly ownerPrincipalId: string;
    readonly label: string;
    readonly source: string;
    readonly idempotencyKey: string;
  }): ProductViewRecipeDraft;
  update(input: {
    readonly draftId: string;
    readonly ownerPrincipalId: string;
    readonly expectedRevision: number;
    readonly label: string;
    readonly source: string;
  }): ProductViewRecipeDraft;
  remove(input: {
    readonly draftId: string;
    readonly ownerPrincipalId: string;
    readonly expectedRevision: number;
  }): void;
  read(draftId: string, ownerPrincipalId: string): ProductViewRecipeDraft | undefined;
  list(ownerPrincipalId: string): readonly ProductViewRecipeDraftSummary[];
  publish?(input: {
    readonly draftId: string;
    readonly ownerPrincipalId: string;
    readonly expectedRevision: number;
    readonly actorPrincipalId: string;
  }): ProductViewRecipePublication;
  rollbackPublication?(input: {
    readonly recipeId: string;
    readonly expectedGenerationId: string;
    readonly actorPrincipalId: string;
  }): ProductViewRecipePublication;
  deactivatePublication?(input: {
    readonly recipeId: string;
    readonly expectedGenerationId: string;
    readonly actorPrincipalId: string;
  }): void;
  listActivePublications?(): readonly ProductViewRecipePublication[];
  canRollbackPublication?(recipeId: string, generationId: string): boolean;
  listPublicationEvents?(): readonly ProductViewRecipePublicationEvent[];
}

export type LayoutDraftNotice =
  | "input"
  | "capacity"
  | "creation"
  | "revision"
  | "missing"
  | "storage"
  | "publication_capacity"
  | "publication_conflict"
  | "provider"
  | "published"
  | "rolled_back"
  | "deactivated";

export interface ProductLayoutAuthoringInput {
  readonly model: ProductShellModel;
  readonly ownerPrincipalId: string;
  readonly drafts: ProductViewRecipeDraftPort;
  readonly acceptsDynamic: (providerId: string) => boolean;
  readonly selectedDraftId?: string;
  readonly preview?: boolean;
  readonly notice?: LayoutDraftNotice;
}

/** Renders the owner-scoped layout workspace after the HTTP owner authorizes access. */
export function renderProductLayoutAuthoring(input: ProductLayoutAuthoringInput): string {
  try {
    const summaries = input.drafts.list(input.ownerPrincipalId);
    const selected = input.selectedDraftId === undefined
      ? undefined
      : input.drafts.read(input.selectedDraftId, input.ownerPrincipalId);
    const publications = input.drafts.listActivePublications?.() ?? [];
    const publicationEvents = (input.drafts.listPublicationEvents?.() ?? []).slice(-8).reverse();
    const list = summaries.length === 0
      ? `<p class="product-muted">还没有布局草稿。先为常用场景准备一个名称和布局描述。</p>`
      : `<ul class="product-layout-draft-list">${summaries.map((draft) => `<li><a href="/settings?layout=${encodeURIComponent(draft.draftId)}"><span><strong>${escapeHtml(draft.label)}</strong><small>草稿版本 ${draft.revision} · ${escapeHtml(updatedLabel(draft.updatedAt))}</small></span><span aria-hidden="true">›</span></a></li>`).join("")}</ul>`;
    const editor = selected === undefined
      ? `<form class="product-layout-editor" method="post" action="/settings/layout-drafts"><input type="hidden" name="idempotencyKey" value="create-${randomUUID()}"><label><span>草稿名称</span><input name="label" maxlength="80" required placeholder="比如：老人房夜间视图"></label><label><span>布局描述（JSON）</span><textarea name="source" maxlength="65536" spellcheck="false" required placeholder='{"apiVersion":"hob.view.recipe/v1", …}'></textarea></label><button class="product-primary-action" type="submit">建立草稿</button></form>`
      : `<div class="product-layout-editor-shell"><form class="product-layout-editor" method="post" action="/settings/layout-drafts/${encodeURIComponent(selected.draftId)}"><input type="hidden" name="expectedRevision" value="${selected.revision}"><label><span>草稿名称</span><input name="label" maxlength="80" required value="${escapeHtml(selected.label)}"></label><label><span>布局描述（JSON）</span><textarea name="source" maxlength="65536" spellcheck="false" required>${escapeHtml(selected.source)}</textarea></label><div class="product-layout-editor-actions"><button class="product-primary-action" type="submit">保存草稿</button><a class="product-secondary-action" href="/settings?layout=${encodeURIComponent(selected.draftId)}&amp;preview=1">预览版本 ${selected.revision}</a></div></form><details class="product-layout-delete"><summary>删除这个草稿</summary><div><p>删除会释放一个草稿位置，当前家庭视图保持原样。</p><form method="post" action="/settings/layout-drafts/${encodeURIComponent(selected.draftId)}/delete"><input type="hidden" name="expectedRevision" value="${selected.revision}"><button class="product-danger-action" type="submit">确认删除草稿</button></form></div></details></div>`;
    const previewHtml = selected !== undefined && input.preview === true
      ? renderDraftPreview(selected, input.model)
      : "";
    const candidate = selected === undefined ? undefined : productViewRecipePublicationCandidate(selected);
    const activeCandidate = candidate === undefined
      ? undefined
      : publications.find((item) => item.recipeId === candidate.recipeId);
    const publicationControl = selected === undefined
      ? ""
      : candidate === undefined
        ? `<div class="product-layout-publication-status"><strong>发布准备</strong><p>完成预览检查后即可发布这个草稿。</p></div>`
        : !input.acceptsDynamic(candidate.recipeId)
          ? `<div class="product-layout-publication-status" data-publication-state="provider-conflict"><strong>请选择新的布局 id</strong><p>这个标识由内置视图或部署视图持有。</p></div>`
          : activeCandidate?.draftId === selected.draftId
            && activeCandidate.draftRevision === selected.revision
            && activeCandidate.recipeDigest === candidate.recipeDigest
            ? `<div class="product-layout-publication-status" data-publication-state="current"><strong>当前草稿版本已发布</strong><p>它已在家庭视图选择器中可用。</p></div>`
            : `<form class="product-layout-publish" method="post" action="/settings/layout-drafts/${encodeURIComponent(selected.draftId)}/publish"><input type="hidden" name="expectedRevision" value="${selected.revision}"><div><strong>${activeCandidate === undefined ? "发布为可用视图" : "发布这个更新"}</strong><p>发布只增加或更新可用视图，当前会话和设备默认保持原样。</p></div><button class="product-primary-action" type="submit">发布版本 ${selected.revision}</button></form>`;
    const publicationList = publications.length === 0
      ? `<p class="product-muted">发布完成的布局会出现在这里。</p>`
      : `<ul class="product-layout-publication-list">${publications.map((item) => {
          const canRollback = input.drafts.canRollbackPublication?.(item.recipeId, item.generationId) ?? false;
          return `<li><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.recipeId)} · 草稿版本 ${item.draftRevision}</small></div><div class="product-layout-publication-actions"><a class="product-secondary-action" href="/settings?view=${encodeURIComponent(item.recipeId)}">查看视图</a>${canRollback ? `<form method="post" action="/settings/layout-publications/${encodeURIComponent(item.recipeId)}/rollback"><input type="hidden" name="expectedGenerationId" value="${escapeHtml(item.generationId)}"><button class="product-secondary-action" type="submit">恢复上一版</button></form>` : ""}<details><summary>撤下</summary><form method="post" action="/settings/layout-publications/${encodeURIComponent(item.recipeId)}/deactivate"><input type="hidden" name="expectedGenerationId" value="${escapeHtml(item.generationId)}"><button class="product-danger-action" type="submit">确认撤下视图</button></form></details></div></li>`;
        }).join("")}</ul>`;
    const publicationHistory = publicationEvents.length === 0
      ? `<p class="product-muted">首次发布后，这里会保留最近的发布动作。</p>`
      : `<ol class="product-layout-publication-history-list">${publicationEvents.map((event) => `<li><span class="product-layout-publication-history-mark" aria-hidden="true"></span><div><strong>${escapeHtml(publicationEventLabel(event.kind))} ${escapeHtml(event.recipeId)}</strong><small>${escapeHtml(event.actorPrincipalId)} · ${escapeHtml(updatedLabel(event.occurredAt))}</small></div></li>`).join("")}</ol>`;
    const noticeHtml = input.notice === undefined
      ? ""
      : `<div class="product-layout-notice" data-layout-notice="${input.notice}" role="status"><strong>${escapeHtml(noticeTitle(input.notice))}</strong><p>${escapeHtml(noticeMessage(input.notice))}</p></div>`;
    return `<section class="product-settings-section product-layout-workspace" aria-labelledby="layout-workspace-heading"><header><div><p class="product-kicker">高级设置</p><h2 id="layout-workspace-heading">布局工作室</h2><p class="product-muted">草稿保存在本机。预览只展示当前保存的版本，发布流程独立管理可用视图。</p></div><span class="product-layout-capacity">${summaries.length}/32</span></header>${noticeHtml}<div class="product-layout-workspace-grid"><div><h3>我的草稿</h3>${list}</div><div><h3>${selected === undefined ? "建立布局草稿" : `编辑 · ${escapeHtml(selected.label)}`}</h3>${editor}${publicationControl}</div></div>${previewHtml}<div class="product-layout-publications"><header><div><h3>已发布视图</h3><p class="product-muted">发布版本与设备选择相互独立。</p></div><span>${publications.length}/16</span></header>${publicationList}</div><div class="product-layout-publication-history"><header><div><h3>发布记录</h3><p class="product-muted">最近的发布动作按时间排列，便于确认由谁完成。</p></div></header>${publicationHistory}</div></section>`;
  } catch {
    return `<section class="product-settings-section product-layout-workspace" aria-labelledby="layout-workspace-heading"><div><p class="product-kicker">高级设置</p><h2 id="layout-workspace-heading">布局工作室</h2><p class="product-muted">草稿存储正在恢复。连接恢复后可继续编辑。</p></div></section>`;
  }
}

export function productViewRecipePublicationCandidate(draft: ProductViewRecipeDraft): {
  readonly recipeId: string;
  readonly recipeDigest: `sha256:${string}`;
} | undefined {
  try {
    const input = JSON.parse(draft.source);
    const recipe = compileProductViewRecipe(input);
    const report = runProductViewRecipeConformance(input);
    if (!report.passed || report.recipeDigest === undefined || report.recipeId !== recipe.id) return undefined;
    return Object.freeze({ recipeId: recipe.id, recipeDigest: report.recipeDigest });
  } catch {
    return undefined;
  }
}

function renderDraftPreview(draft: ProductViewRecipeDraft, model: ProductShellModel): string {
  let input: unknown;
  try {
    input = JSON.parse(draft.source);
  } catch {
    return previewFailure(draft.revision, "syntax_error", "JSON 结构还未完整，草稿内容保持原样。");
  }
  let recipe: ProductViewRecipeV1;
  try {
    recipe = compileProductViewRecipe(input);
  } catch {
    return previewFailure(draft.revision, "recipe_invalid", "布局字段需要调整，草稿内容保持原样。");
  }
  const conformance = runProductViewRecipeConformance(input);
  if (!conformance.passed || conformance.recipeDigest === undefined) {
    return previewFailure(draft.revision, "conformance_failed", "布局一致性检查需要调整，草稿内容保持原样。");
  }
  const rendered = renderProductViewRecipeContent(recipe, { ...model, route: "overview" }, { includeStyles: false, hrefs: PREVIEW_HREFS });
  const previewDocument = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/product.css"></head><body>${rendered}</body></html>`;
  return `<section class="product-layout-preview" data-layout-preview-revision="${draft.revision}" data-layout-preview-status="ready" aria-labelledby="layout-preview-heading"><header><div><p class="product-kicker">只读预览 · 草稿版本 ${draft.revision}</p><h3 id="layout-preview-heading">${escapeHtml(recipe.title)}</h3></div><code>${conformance.recipeDigest}</code></header><iframe class="product-layout-preview-canvas" inert data-layout-preview-canvas sandbox tabindex="-1" title="${escapeHtml(recipe.title)}的只读预览" srcdoc="${escapeHtml(previewDocument)}"></iframe></section>`;
}

function previewFailure(
  revision: number,
  status: "syntax_error" | "recipe_invalid" | "conformance_failed",
  message: string,
): string {
  return `<section class="product-layout-preview product-layout-preview--issue" data-layout-preview-revision="${revision}" data-layout-preview-status="${status}" role="status"><p class="product-kicker">预览检查 · 草稿版本 ${revision}</p><h3>这份草稿可以继续编辑</h3><p>${escapeHtml(message)}</p></section>`;
}

function noticeTitle(notice: LayoutDraftNotice): string {
  switch (notice) {
    case "input": return "请调整草稿内容";
    case "capacity": return "草稿位置已全部使用";
    case "creation": return "这次建立请求已经处理";
    case "revision": return "已载入草稿的新版本";
    case "missing": return "这份草稿已离开当前列表";
    case "storage": return "草稿存储正在恢复";
    case "publication_capacity": return "已发布视图位置已全部使用";
    case "publication_conflict": return "发布状态已有更新";
    case "provider": return "这个视图标识已有归属";
    case "published": return "布局版本已发布";
    case "rolled_back": return "已恢复上一版布局";
    case "deactivated": return "布局已从可用视图中撤下";
  }
}

function noticeMessage(notice: LayoutDraftNotice): string {
  switch (notice) {
    case "input": return "调整草稿名称或布局描述后即可继续保存。";
    case "capacity": return "删除一个旧草稿后即可建立新的布局草稿。";
    case "creation": return "请从左侧草稿列表选择当前版本继续。";
    case "revision": return "页面展示当前版本，请确认内容后继续编辑。";
    case "missing": return "请从当前草稿列表选择下一份内容。";
    case "storage": return "连接恢复后即可继续编辑，家庭视图保持原样。";
    case "publication_capacity": return "撤下一个已发布视图后即可发布新的视图。";
    case "publication_conflict": return "页面会展示当前发布版本，请确认后继续。";
    case "provider": return "请选择新的布局 id；内置视图和部署视图保持原有归属。";
    case "published": return "它已出现在家庭视图选择器中；当前会话和设备默认保持原样。";
    case "rolled_back": return "家庭视图选择器现在使用上一发布版本。";
    case "deactivated": return "使用该视图的浏览器会安全恢复到生活视图。";
  }
}

function publicationEventLabel(kind: ProductViewRecipePublicationEvent["kind"]): string {
  switch (kind) {
    case "published": return "发布了";
    case "rolled_back": return "恢复了上一版";
    case "deactivated": return "撤下了";
  }
}

function updatedLabel(value: string): string {
  return `${value.slice(0, 16).replace("T", " ")} UTC`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
