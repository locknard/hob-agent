#!/usr/bin/env python3
"""Build the design-review PDF for the hob-agent household experience."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence

from PIL import Image
from reportlab.lib.colors import Color, HexColor
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "output/pdf/hob-agent-interaction-design-v3.pdf"

ASSETS = ROOT / "docs/design/assets"
PROTOTYPE_QA = ROOT / "prototypes/household-spatial-prototype/qa"

PAGE_W, PAGE_H = landscape(A4)
MARGIN_X = 38
TOP = PAGE_H - 36
BOTTOM = 34

FONT_LIGHT = "HobSans"
FONT_MEDIUM = "HobSansMedium"

INK = HexColor("#17202B")
SECONDARY = HexColor("#5D6876")
MUTED = HexColor("#89929D")
LINE = HexColor("#D9D8D1")
SURFACE = HexColor("#F7F6F2")
PAPER = HexColor("#FCFBF8")
WHITE = HexColor("#FFFFFF")
BLUE = HexColor("#1769D2")
BLUE_SOFT = HexColor("#EAF2FF")
GREEN = HexColor("#397A4A")
GREEN_SOFT = HexColor("#EAF4EA")
AMBER = HexColor("#B97113")
AMBER_SOFT = HexColor("#FFF0DA")
RED = HexColor("#B54B4B")
RED_SOFT = HexColor("#FBEAEA")
VIOLET = HexColor("#6B5BB7")
VIOLET_SOFT = HexColor("#F0EDFF")


def register_fonts() -> None:
    pdfmetrics.registerFont(
        TTFont(FONT_LIGHT, "/System/Library/Fonts/STHeiti Light.ttc")
    )
    pdfmetrics.registerFont(
        TTFont(FONT_MEDIUM, "/System/Library/Fonts/STHeiti Medium.ttc")
    )


def wrap_lines(text: str, width: float, font: str, size: float) -> list[str]:
    lines: list[str] = []
    for paragraph in text.split("\n"):
        if not paragraph:
            lines.append("")
            continue
        current = ""
        for char in paragraph:
            candidate = current + char
            if current and pdfmetrics.stringWidth(candidate, font, size) > width:
                lines.append(current)
                current = char
            else:
                current = candidate
        if current:
            lines.append(current)
    return lines


def draw_text(
    c: canvas.Canvas,
    text: str,
    x: float,
    y: float,
    width: float,
    *,
    size: float = 10,
    leading: float | None = None,
    font: str = FONT_LIGHT,
    color: Color = INK,
    max_lines: int | None = None,
) -> float:
    leading = leading or size * 1.45
    lines = wrap_lines(text, width, font, size)
    if max_lines is not None:
        lines = lines[:max_lines]
    c.setFillColor(color)
    c.setFont(font, size)
    cursor = y
    for line in lines:
        c.drawString(x, cursor, line)
        cursor -= leading
    return cursor


def draw_rule(c: canvas.Canvas, x: float, y: float, width: float) -> None:
    c.setStrokeColor(LINE)
    c.setLineWidth(0.7)
    c.line(x, y, x + width, y)


def rounded_box(
    c: canvas.Canvas,
    x: float,
    y: float,
    w: float,
    h: float,
    *,
    fill: Color = WHITE,
    stroke: Color = LINE,
    radius: float = 10,
    line_width: float = 0.8,
) -> None:
    c.setFillColor(fill)
    c.setStrokeColor(stroke)
    c.setLineWidth(line_width)
    c.roundRect(x, y, w, h, radius, fill=1, stroke=1)


def pill(
    c: canvas.Canvas,
    text: str,
    x: float,
    y: float,
    *,
    fill: Color = BLUE_SOFT,
    color: Color = BLUE,
    size: float = 8,
    pad_x: float = 8,
    height: float = 20,
) -> float:
    w = pdfmetrics.stringWidth(text, FONT_MEDIUM, size) + pad_x * 2
    c.setFillColor(fill)
    c.roundRect(x, y, w, height, height / 2, fill=1, stroke=0)
    c.setFillColor(color)
    c.setFont(FONT_MEDIUM, size)
    c.drawString(x + pad_x, y + (height - size) / 2 + 1.3, text)
    return w


def dot(c: canvas.Canvas, x: float, y: float, color: Color = BLUE, r: float = 3) -> None:
    c.setFillColor(color)
    c.circle(x, y, r, fill=1, stroke=0)


def bullet_list(
    c: canvas.Canvas,
    items: Iterable[str],
    x: float,
    y: float,
    width: float,
    *,
    size: float = 9.3,
    gap: float = 8,
    bullet_color: Color = BLUE,
) -> float:
    cursor = y
    for item in items:
        dot(c, x + 3, cursor + 3.4, bullet_color, 2.4)
        after = draw_text(
            c,
            item,
            x + 13,
            cursor + 7,
            width - 13,
            size=size,
            leading=size * 1.45,
            color=INK,
        )
        cursor = after - gap
    return cursor


def number_badge(c: canvas.Canvas, number: str, x: float, y: float, color: Color = BLUE) -> None:
    c.setFillColor(color)
    c.circle(x, y, 11, fill=1, stroke=0)
    c.setFillColor(WHITE)
    c.setFont(FONT_MEDIUM, 8.8)
    tw = pdfmetrics.stringWidth(number, FONT_MEDIUM, 8.8)
    c.drawString(x - tw / 2, y - 3.2, number)


def draw_contain_image(
    c: canvas.Canvas,
    path: Path,
    x: float,
    y: float,
    w: float,
    h: float,
    *,
    radius: float = 8,
    background: Color = SURFACE,
) -> None:
    with Image.open(path) as image:
        iw, ih = image.size
    scale = min(w / iw, h / ih)
    dw, dh = iw * scale, ih * scale
    rounded_box(c, x, y, w, h, fill=background, stroke=LINE, radius=radius)
    c.drawImage(
        str(path),
        x + (w - dw) / 2,
        y + (h - dh) / 2,
        dw,
        dh,
        preserveAspectRatio=True,
        mask="auto",
    )


@dataclass
class Deck:
    c: canvas.Canvas
    page: int = 0

    def footer(self, section: str) -> None:
        self.c.setStrokeColor(LINE)
        self.c.setLineWidth(0.5)
        self.c.line(MARGIN_X, 23, PAGE_W - MARGIN_X, 23)
        self.c.setFont(FONT_LIGHT, 7.5)
        self.c.setFillColor(MUTED)
        self.c.drawString(MARGIN_X, 11, f"hob-agent · 完整交互设计稿 · {section}")
        label = f"{self.page:02d}"
        self.c.drawRightString(PAGE_W - MARGIN_X, 11, label)

    def start(self, title: str, section: str, subtitle: str = "") -> None:
        if self.page:
            self.c.showPage()
        self.page += 1
        self.c.setFillColor(PAPER)
        self.c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
        self.c.setFillColor(BLUE)
        self.c.setFont(FONT_MEDIUM, 8)
        self.c.drawString(MARGIN_X, TOP, section.upper())
        self.c.setFillColor(INK)
        self.c.setFont(FONT_MEDIUM, 23)
        self.c.drawString(MARGIN_X, TOP - 34, title)
        if subtitle:
            draw_text(
                self.c,
                subtitle,
                MARGIN_X,
                TOP - 56,
                PAGE_W - MARGIN_X * 2,
                size=9.6,
                color=SECONDARY,
            )
        self.footer(section)


def card_title(c: canvas.Canvas, title: str, x: float, y: float, width: float, *, tag: str = "") -> None:
    c.setFillColor(INK)
    c.setFont(FONT_MEDIUM, 12)
    c.drawString(x, y, title)
    if tag:
        tw = pdfmetrics.stringWidth(tag, FONT_MEDIUM, 7.3) + 14
        pill(c, tag, x + width - tw, y - 5, size=7.3, height=18)


def flow_node(
    c: canvas.Canvas,
    text: str,
    x: float,
    y: float,
    w: float,
    h: float,
    *,
    fill: Color = WHITE,
    stroke: Color = LINE,
    color: Color = INK,
    size: float = 8.2,
) -> None:
    rounded_box(c, x, y, w, h, fill=fill, stroke=stroke, radius=8)
    lines = wrap_lines(text, w - 18, FONT_MEDIUM, size)
    total_h = len(lines) * size * 1.25
    cursor = y + (h + total_h) / 2 - size
    c.setFillColor(color)
    c.setFont(FONT_MEDIUM, size)
    for line in lines:
        tw = pdfmetrics.stringWidth(line, FONT_MEDIUM, size)
        c.drawString(x + (w - tw) / 2, cursor, line)
        cursor -= size * 1.25


def arrow(c: canvas.Canvas, x1: float, y1: float, x2: float, y2: float, color: Color = MUTED) -> None:
    c.setStrokeColor(color)
    c.setFillColor(color)
    c.setLineWidth(1.1)
    c.line(x1, y1, x2, y2)
    import math

    angle = math.atan2(y2 - y1, x2 - x1)
    for delta in (2.55, -2.55):
        c.line(
            x2,
            y2,
            x2 + 7 * math.cos(angle + delta),
            y2 + 7 * math.sin(angle + delta),
        )


def draw_cover(deck: Deck) -> None:
    deck.page = 1
    c = deck.c
    c.setFillColor(PAPER)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.setFillColor(BLUE)
    c.rect(0, 0, 12, PAGE_H, fill=1, stroke=0)
    pill(c, "DESIGN REVIEW · V3", 48, PAGE_H - 68, fill=BLUE_SOFT, color=BLUE, size=8.5, height=23)
    c.setFillColor(INK)
    c.setFont(FONT_MEDIUM, 34)
    c.drawString(48, PAGE_H - 132, "hob-agent 完整交互设计稿")
    c.setFillColor(SECONDARY)
    c.setFont(FONT_LIGHT, 16)
    c.drawString(48, PAGE_H - 166, "一个家庭内核，多种可切换的生活方式")

    rounded_box(c, 48, 82, 318, 285, fill=WHITE, stroke=LINE, radius=14)
    draw_contain_image(
        c,
        PROTOTYPE_QA / "implementation-home-1440x1024.png",
        62,
        97,
        290,
        255,
        radius=10,
    )
    rounded_box(c, 390, 82, 404, 285, fill=SURFACE, stroke=LINE, radius=14)
    c.setFillColor(INK)
    c.setFont(FONT_MEDIUM, 13)
    c.drawString(416, 328, "本稿冻结的四个产品判断")
    bullet_list(
        c,
        [
            "生活视图与控制视图是同一产品的两个 View Provider，不是两套前端。",
            "模糊意图交给对话，精确确认交给结构化界面；语音不获得额外权限。",
            "运行时放行与持久提案使用两种入口、两套过期与拒绝语义。",
            "Host Shell 永远拥有安全告警、身份、切换、放行、提案与安全回退。",
        ],
        416,
        295,
        350,
        size=10.3,
        gap=12,
    )
    c.setFillColor(MUTED)
    c.setFont(FONT_LIGHT, 8.5)
    c.drawString(48, 48, "评审对象：产品结构、流程、状态、权限边界、跨端行为 · 2026-08-21")
    deck.footer("封面")


def build_pdf() -> Path:
    register_fonts()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(OUTPUT), pagesize=(PAGE_W, PAGE_H), pageCompression=1)
    c.setTitle("hob-agent 完整交互设计稿 V3")
    c.setAuthor("hob-agent")
    c.setSubject("Design review: household experience, views, agent, voice and plugin layouts")
    deck = Deck(c)

    # 01
    draw_cover(deck)

    # 02
    deck.start("如何使用这份设计稿", "评审说明", "先评审产品逻辑，再进入高保真视觉与实现；所有画面都服从同一安全与状态契约。")
    x1, x2 = 38, 425
    rounded_box(c, x1, 118, 350, 350, fill=WHITE)
    card_title(c, "本轮请做决定", x1 + 22, 438, 306, tag="需要评审")
    bullet_list(
        c,
        [
            "双视图是否覆盖主要用户：普通成员、家庭管理员、墙面屏与智能家居爱好者。",
            "Host Shell 与 View Provider 的职责是否足够清晰，第三方布局是否有合理自由度。",
            "onboarding 是否能让不懂 HA、Bridge、模型 Provider 的用户独立完成。",
            "建议、一次性动作、媒体播放和持久自动化的确认级别是否符合家庭风险。",
            "设置侧是否完整，同时没有污染日常首页。",
        ],
        x1 + 24,
        400,
        300,
        size=10,
        gap=11,
    )
    rounded_box(c, x2, 118, 378, 350, fill=SURFACE)
    card_title(c, "本稿不冻结", x2 + 22, 438, 334, tag="留给视觉设计")
    bullet_list(
        c,
        [
            "最终品牌命名、Logo、插画与摄影规范。",
            "所有 Card 的像素级样式、图标细节和完整设计 Token。",
            "第三方布局市场的商业规则与审核运营流程。",
            "Phase 0 尚未开放能力的最终发布时间。",
        ],
        x2 + 24,
        400,
        326,
        size=10,
        gap=12,
        bullet_color=VIOLET,
    )
    rounded_box(c, x2 + 22, 148, 334, 92, fill=WHITE, stroke=LINE)
    pill(c, "评审原则", x2 + 38, 200, fill=VIOLET_SOFT, color=VIOLET, size=8, height=20)
    draw_text(c, "如果某条路径需要设计师猜测系统状态、权限或失败后怎么办，就视为交互稿尚未闭环。", x2 + 38, 183, 300, size=10.2, color=INK)

    # 03
    deck.start("产品北极星：先理解家，再控制设备", "产品原则", "hob-agent 不是更漂亮的设备后台；它将家庭事实、意图、建议和受治理动作组织成一个可理解的产品。")
    principles = [
        ("01", "家先于设备", "首页回答“现在怎样、为什么、要不要处理”，设备清单进入下一层。"),
        ("02", "意图先于路径", "用户可以说目标；系统补齐缺失信息，不要求先学会导航结构。"),
        ("03", "事实先于推断", "事实、未知、推测和建议在视觉与文案上明确分层。"),
        ("04", "准备不等于执行", "Agent 搜索、解析和生成精确动作后，仍需进入 policy 与确认。"),
        ("05", "可恢复比完美重要", "等待可后台、错误有出口、结果未知不宣称成功。"),
        ("06", "多种视图，一个家庭", "布局可以变化；身份、状态、Turn、审批与审计只有一份。"),
    ]
    for i, (num, title, body) in enumerate(principles):
        col = i % 3
        row = i // 3
        x = 38 + col * 260
        y = 288 - row * 172
        rounded_box(c, x, y, 235, 145, fill=WHITE)
        number_badge(c, num, x + 26, y + 112)
        c.setFillColor(INK)
        c.setFont(FONT_MEDIUM, 13)
        c.drawString(x + 48, y + 106, title)
        draw_text(c, body, x + 22, y + 76, 190, size=9.5, color=SECONDARY)

    # 04
    deck.start("两种主要视图，各自服务谁", "视图策略", "生活视图是新家庭默认；控制视图是同等级能力，不是隐藏在“高级模式”里的附属页面。")
    columns = [
        (38, "生活视图", "空间、建议与对话优先", BLUE, BLUE_SOFT, ["普通家庭成员", "移动端快速使用", "不知道设备名也能表达目标", "当前最重要的情况优先"]),
        (302, "控制视图", "仪表盘、监控与快捷控制", VIOLET, VIOLET_SOFT, ["家庭管理员与爱好者", "桌面、平板和墙面屏", "同时关注多个指标与设备", "可配置网格与时间范围"]),
        (566, "第三方视图", "由 Plugin 贡献的新信息架构", GREEN, GREEN_SOFT, ["能源、养老、宠物等垂直体验", "声明式 Layout Recipe 优先", "可见数据和 intent 独立授权", "失效后回退到内置视图"]),
    ]
    for x, title, sub, color, soft, items in columns:
        rounded_box(c, x, 110, 238, 357, fill=WHITE, stroke=LINE)
        c.setFillColor(soft)
        c.roundRect(x + 16, 389, 206, 58, 10, fill=1, stroke=0)
        c.setFillColor(color)
        c.setFont(FONT_MEDIUM, 15)
        c.drawString(x + 30, 417, title)
        c.setFont(FONT_LIGHT, 8.6)
        c.drawString(x + 30, 399, sub)
        bullet_list(c, items, x + 24, 354, 190, size=9.6, gap=12, bullet_color=color)
        draw_rule(c, x + 22, 206, 194)
        draw_text(c, "权限结果由 Host 决定；布局只决定如何表达。", x + 24, 184, 188, size=9, color=SECONDARY)
        pill(c, "同一家庭内核", x + 24, 130, fill=soft, color=color, size=8, height=20)

    # 05
    deck.start("一个家庭内核，多种 View Provider", "系统模型", "这是设计约束，不要求用户理解技术术语；它确保布局生态不会复制业务或扩大权限。")
    rounded_box(c, 42, 116, 758, 348, fill=WHITE)
    c.setFillColor(INK)
    c.setFont(FONT_MEDIUM, 12)
    c.drawString(68, 432, "稳定 Host Shell")
    host_items = ["身份 / Onboarding", "视图切换 / 安全回退", "Active Turn / 待确认", "无障碍 / 语言 / 跨端"]
    for i, item in enumerate(host_items):
        x = 68 + i * 176
        flow_node(c, item, x, 366, 152, 42, fill=BLUE_SOFT, stroke=BLUE, color=BLUE)
    c.setStrokeColor(LINE)
    c.line(92, 342, 750, 342)
    c.setFillColor(SECONDARY)
    c.setFont(FONT_MEDIUM, 9)
    c.drawString(68, 320, "Presentation Broker：中立快照、历史、freshness、partial / unknown")
    c.drawRightString(774, 320, "Intent Broker：对话、提案、审批、受治理动作")
    c.setStrokeColor(BLUE)
    c.setLineWidth(1.4)
    c.line(106, 294, 734, 294)
    providers = [
        (74, "builtin.life", "生活视图", BLUE, BLUE_SOFT),
        (258, "builtin.control", "控制视图", VIOLET, VIOLET_SOFT),
        (442, "recipe.*", "声明式第三方布局", GREEN, GREEN_SOFT),
        (626, "isolated.*", "隔离 View App（未来）", AMBER, AMBER_SOFT),
    ]
    for x, pid, label, color, soft in providers:
        rounded_box(c, x, 182, 144, 82, fill=soft, stroke=color)
        c.setFillColor(color)
        c.setFont(FONT_MEDIUM, 8)
        c.drawString(x + 14, 238, pid)
        c.setFillColor(INK)
        c.setFont(FONT_MEDIUM, 9.4)
        c.drawString(x + 14, 211, label)
    draw_text(c, "Cordis 管理插件包和 generation 生命周期；浏览器 Host 管理 View 的 mount / unmount。相同包里的 Skill、Bridge 与 UI 仍分别授权。", 68, 150, 690, size=9.2, color=SECONDARY)

    # 06
    deck.start("稳定外壳与信息架构", "导航", "布局可以重排一级导航；Host 仍拥有身份、安全告警、运行时放行、持久提案与恢复入口。")
    rounded_box(c, 38, 112, 492, 355, fill=WHITE)
    card_title(c, "Host 永远拥有", 60, 435, 448, tag="不可覆盖")
    host_rows = [
        ("家庭身份", "当前家庭、成员与访客权限"),
        ("视图", "切换、设为设备默认、恢复内置布局"),
        ("进行中", "Agent Turn、后台进度、停止与重新进入"),
        ("等待你放行", "精确动作、可批准角色、TTL 与 fail-closed"),
        ("给家的建议", "持久提案、14 天过期、拒绝闩锁与 ≤5"),
        ("安全与连接", "跨布局安全告警、连接、只读与结果未知"),
        ("设置出口", "连接、模型、声音、媒体、隐私与插件"),
    ]
    y = 397
    for i, (title, body) in enumerate(host_rows):
        if i:
            draw_rule(c, 60, y + 10, 440)
        c.setFont(FONT_MEDIUM, 9.5)
        c.setFillColor(INK)
        c.drawString(60, y - 8, title)
        c.setFont(FONT_LIGHT, 9)
        c.setFillColor(SECONDARY)
        c.drawString(144, y - 8, body)
        y -= 47
    rounded_box(c, 550, 112, 253, 355, fill=SURFACE)
    card_title(c, "语义位置", 572, 435, 209)
    routes = [
        ("home", "当前摘要 / 总览 Dashboard"),
        ("space/:id", "空间故事 / 空间监控"),
        ("turn/:id", "对话 Sheet / Turn 侧栏"),
        ("confirmations", "等待你放行 / TTL 与角色"),
        ("proposals", "给家的建议 / 低压力审阅"),
        ("activity", "可读时间线 / 可筛选事件"),
        ("settings", "简化入口 / 完整工作区"),
    ]
    y = 397
    for route, mapping in routes:
        pill(c, route, 572, y - 12, fill=WHITE, color=VIOLET, size=7.4, height=18)
        draw_text(c, mapping, 650, y - 2, 128, size=8.3, color=SECONDARY, max_lines=2)
        y -= 47

    # 07
    deck.start("生活视图：家本身就是界面", "关键画面", "默认首页把空间、当前最重要的情况、已验证事实与对话入口放在同一个连续场景中。")
    draw_contain_image(c, PROTOTYPE_QA / "implementation-home-1440x1024.png", 38, 92, 566, 382, radius=10)
    rounded_box(c, 622, 92, 181, 382, fill=WHITE)
    callouts = [
        ("A", "空间是主导航", "切换空间立即改变事实和下一次输入上下文。"),
        ("B", "关注点先于设备墙", "只突出一个值得注意的问题；无事时明确说暂无。"),
        ("C", "事实与原因分层", "已验证事实、未知与推测使用不同层级。"),
        ("D", "Composer 始终可达", "文字、语音和建议芯片进入同一 Turn。"),
    ]
    y = 430
    for code, title, body in callouts:
        number_badge(c, code, 647, y + 2)
        c.setFillColor(INK)
        c.setFont(FONT_MEDIUM, 9.5)
        c.drawString(668, y, title)
        y = draw_text(c, body, 647, y - 18, 132, size=8.2, color=SECONDARY) - 14

    # 08
    deck.start("移动端：两个时间语义，两个 badge", "跨端", "运行时倒计时区固定在上；持久提案在下并显示独立容量。底部入口不能用一个红点把两者重新合并。")
    draw_contain_image(c, PROTOTYPE_QA / "implementation-home-mobile-390x844.png", 38, 86, 214, 396, radius=13)
    draw_contain_image(c, ASSETS / "mobile-processing-two-lifecycles-v3.png", 272, 86, 214, 396, radius=13)
    rounded_box(c, 512, 86, 291, 396, fill=WHITE)
    card_title(c, "移动端不变量", 536, 448, 243, tag="badge 分家")
    bullet_list(
        c,
        [
            "等待你放行永远在上；每条显示自己的 TTL badge。",
            "给家的建议显示独立 n / 5；snoozed 始终占位。",
            "底部“处理”不显示两类对象相加的红点或数字。",
            "运行时拒绝只结束这次；提案才有“不再建议”。",
            "过期摘要低调可追溯，但不能恢复批准按钮。",
            "触点至少 44px；文字放大不截断倒计时和主动作。",
        ],
        536,
        410,
        235,
        size=9.2,
        gap=10,
    )

    # 09
    deck.start("控制视图：高密度，但不混淆生命周期", "关键画面", "运行时放行与持久提案分开呈现；布局再密集，也不能把倒计时动作和低压力建议塞进同一 badge。")
    draw_contain_image(c, ASSETS / "control-view-desktop-v2.png", 38, 92, 610, 382, radius=10)
    rounded_box(c, 666, 92, 137, 382, fill=WHITE)
    notes = [
        ("01", "等待你放行", "精确动作显示角色、TTL；过期自动拒绝。"),
        ("02", "给家的建议", "无倒计时；14 天自然过期，可稍后处理。"),
        ("03", "按钮仍受治理", "快捷控制提交 typed intent，不继承布局权限。"),
        ("04", "连接语义明确", "安静与失联分开，不只写“更新于多久前”。"),
    ]
    y = 435
    for num, title, body in notes:
        number_badge(c, num, 686, y, VIOLET)
        c.setFillColor(INK)
        c.setFont(FONT_MEDIUM, 9)
        c.drawString(706, y - 3, title)
        y = draw_text(c, body, 686, y - 23, 94, size=7.8, color=SECONDARY) - 16

    deck.start("两个物种，两套生命周期", "治理对象", "运行时确认等待一次动作放行；持久提案等待家庭决定未来行为。相似的卡片外形不能抹掉相反的时间语义。")
    rounded_box(c, 38, 118, 365, 346, fill=WHITE)
    card_title(c, "等待你放行", 60, 432, 321, tag="运行时确认")
    pill(c, "01:42 后自动拒绝", 60, 390, fill=AMBER_SOFT, color=AMBER, size=8, height=21)
    runtime_steps = [
        ("prepared", "精确动作、目标与 revision 完整"),
        ("awaiting approval", "显示 eligible role + 动作专属 TTL"),
        ("approved / rejected", "拒绝只结束本次；不写 dedup 闩锁"),
        ("expired", "活动留痕；下次打开：昨晚 1 项放行已过期，未执行"),
    ]
    y = 344
    for idx, (state, body) in enumerate(runtime_steps):
        number_badge(c, str(idx + 1), 72, y + 2, AMBER)
        c.setFont(FONT_MEDIUM, 8.7)
        c.setFillColor(INK)
        c.drawString(92, y, state)
        draw_text(c, body, 92, y - 19, 270, size=8, color=SECONDARY, max_lines=2)
        y -= 62
    rounded_box(c, 420, 118, 383, 346, fill=SURFACE)
    card_title(c, "给家的建议", 442, 432, 339, tag="持久提案")
    pill(c, "13 天后自然过期", 442, 390, fill=BLUE_SOFT, color=BLUE, size=8, height=21)
    proposal_steps = [
        ("pending review", "最多 5 项；不制造倒计时焦虑"),
        ("snoozed", "明确到今晚 / 明天 / 下周；仍占 1 个容量位"),
        ("approved", "只批准方向；不安装、不启用"),
        ("rejected / expired", "拒绝写闩锁；自然过期可凭新证据再提"),
    ]
    y = 344
    for idx, (state, body) in enumerate(proposal_steps):
        number_badge(c, str(idx + 1), 454, y + 2, BLUE)
        c.setFont(FONT_MEDIUM, 8.7)
        c.setFillColor(INK)
        c.drawString(474, y, state)
        draw_text(c, body, 474, y - 19, 286, size=8, color=SECONDARY, max_lines=2)
        y -= 62

    deck.start("收件箱三纪律：同意、拒绝与容量", "持久提案", "规则只有变成用户看得见的承诺，才会积累信任；后台悄悄去重或限流不够。")
    disciplines = [
        (38, "Consent-first", "方向批准 ≠ 安装启用", BLUE, BLUE_SOFT, ["第一次审阅家庭目标与证据", "精确制品变化使旧批准失效", "Phase 0 明确停在只读准备"]),
        (298, "拒绝闩锁", "不再建议这件事", RED, RED_SOFT, ["按 dedupKey 永久闩锁", "即时承诺：好的，不再提议…", "只有决定历史可显式清除"]),
        (558, "积压 ≤ 5", "稍后也不腾位置", AMBER, AMBER_SOFT, ["pending + snoozed ≤ 5", "不创建第 6 个提案", "满位暂停新增并反思原因"]),
    ]
    for x, title, sub, color, soft, items in disciplines:
        rounded_box(c, x, 162, 238, 302, fill=WHITE)
        pill(c, title, x + 20, 418, fill=soft, color=color, size=8.2, height=21)
        draw_text(c, sub, x + 20, 381, 198, size=11, font=FONT_MEDIUM, color=INK)
        bullet_list(c, items, x + 20, 337, 198, size=8.7, gap=10, bullet_color=color)
    rounded_box(c, 38, 92, 758, 51, fill=SURFACE)
    pill(c, "稍后不是拒绝", 56, 107, fill=WHITE, color=VIOLET, size=8, height=20)
    draw_text(c, "“稍后”保留同一提案且仍占容量；运行时“拒绝”只结束本次；只有“不再建议这件事”写入闩锁。", 168, 120, 604, size=8.8, color=INK)

    deck.start("谁能放行：身份、角色与设备一起判断", "权限", "声音来自家里、屏幕挂在墙上或卡片可见，都不等于拥有高影响批准权。")
    headers = ["角色 / 设备", "普通可逆动作", "高影响动作", "共享设备默认视图"]
    widths = [170, 190, 190, 195]
    x = 48
    for header, width in zip(headers, widths):
        c.setFont(FONT_MEDIUM, 8.6)
        c.setFillColor(INK)
        c.drawString(x + 10, 430, header)
        x += width
    draw_rule(c, 48, 413, sum(widths))
    rows = [
        ("Owner / Admin", "按 policy 放行", "可；卡片标注需要管理员", "可设置"),
        ("Adult Member", "仅获准范围", "默认不可；policy 可缩小开放", "仅个人设备"),
        ("Minor / Guest", "只读或极低风险", "不可；发送到管理员", "不可"),
        ("未认证墙面屏", "展示摘要 / 发起 handoff", "不可直接批准", "管理员 handoff"),
    ]
    y = 374
    for idx, row in enumerate(rows):
        c.setFillColor(WHITE if idx % 2 == 0 else SURFACE)
        c.roundRect(48, y - 35, sum(widths), 44, 5, fill=1, stroke=0)
        x = 48
        for col, (value, width) in enumerate(zip(row, widths)):
            draw_text(c, value, x + 10, y - 4, width - 18, size=8, font=FONT_MEDIUM if col == 0 else FONT_LIGHT, color=INK if col == 0 else SECONDARY, max_lines=2)
            x += width
        y -= 50
    rounded_box(c, 48, 108, 745, 66, fill=RED_SOFT, stroke=RED)
    pill(c, "状态守卫", 66, 132, fill=WHITE, color=RED, size=8, height=20)
    draw_text(c, "expired confirmation → approve、unauthorized actor → approve、两个设备同时获胜，全部必须无副作用失败。", 162, 145, 610, size=8.8, color=INK)

    # 10
    deck.start("同一个对象，在两种视图中如何映射", "视图映射", "切换保存语义位置，不复制 URL；目标布局不支持当前页面时回到总览，但保留对象和草稿。")
    headers = ["语义对象", "生活视图", "控制视图", "切换时必须保留"]
    widths = [126, 212, 212, 200]
    x = 42
    for header, width in zip(headers, widths):
        c.setFillColor(INK)
        c.setFont(FONT_MEDIUM, 9)
        c.drawString(x + 12, 442, header)
        x += width
    draw_rule(c, 42, 426, sum(widths))
    rows = [
        ("家庭首页", "当前空间、关注点、建议", "总览 Dashboard 与指标", "家庭、成员、freshness"),
        ("空间", "空间封面、事实与故事", "设备卡、图表与快捷动作", "spaceId 与当前范围"),
        ("Agent Turn", "对话 Sheet 与回答结构", "侧栏或状态卡", "turnId、进度、草稿"),
        ("运行时放行", "倒计时、角色与影响摘要", "按风险筛选；逐项批准", "TTL、actor、revision"),
        ("持久提案", "家庭语言的价值与证据", "提案影响表；最多 5 项", "dedupKey、snooze、过期"),
        ("活动", "可读时间线", "事件表、趋势和诊断", "同一 audit 投影"),
        ("设置", "常见路径优先", "完整配置工作区", "一份连接与 policy"),
    ]
    y = 390
    for idx, row in enumerate(rows):
        fill = WHITE if idx % 2 == 0 else SURFACE
        c.setFillColor(fill)
        c.roundRect(42, y - 40, sum(widths), 46, 4, fill=1, stroke=0)
        x = 42
        for col, (text, width) in enumerate(zip(row, widths)):
            draw_text(c, text, x + 12, y - 8, width - 20, size=8.5, font=FONT_MEDIUM if col == 0 else FONT_LIGHT, color=INK if col == 0 else SECONDARY, max_lines=2)
            x += width
        y -= 45
    rounded_box(c, 42, 83, 750, 58, fill=AMBER_SOFT, stroke=AMBER)
    pill(c, "回退规则", 58, 103, fill=WHITE, color=AMBER, size=8, height=20)
    draw_text(c, "目标布局没有 turn/:id 时，进入目标总览并保留 Turn 通知；不能丢掉回答、重新运行 Agent 或重复动作。", 148, 116, 620, size=9, color=INK)

    # 11
    deck.start("视图切换器属于 Host Shell", "切换", "当前布局只是列表中的一个 Provider；一次临时切换与“设为这台设备默认”分开，避免意外修改日常首页。")
    draw_contain_image(c, ASSETS / "view-switcher-desktop.png", 38, 92, 598, 382, radius=10)
    rounded_box(c, 654, 92, 149, 382, fill=WHITE)
    items = [
        ("入口", "顶栏显示当前视图名称；移动端使用 bottom sheet。"),
        ("选择", "内置与最近使用布局展示预览、用途、发布者和可用性。"),
        ("预加载", "目标 ready 前当前画面继续可用，切换可取消。"),
        ("偏好", "个人设备本人可改；共享设备默认需要管理员。"),
        ("恢复", "插件失效时回到最近可用内置视图。"),
    ]
    y = 438
    for title, body in items:
        c.setFillColor(BLUE)
        c.setFont(FONT_MEDIUM, 8.5)
        c.drawString(674, y, title)
        y = draw_text(c, body, 674, y - 18, 103, size=7.7, color=SECONDARY) - 12

    # 12
    deck.start("视图切换状态机与失败回退", "切换", "任何状态都有出口；View 生命周期不拥有 Agent Turn、Bridge 连接或设备动作。")
    nodes = [
        (48, 340, 122, 52, "当前视图\nstable", BLUE_SOFT, BLUE),
        (202, 340, 122, 52, "选择布局\nselecting", WHITE, LINE),
        (356, 340, 122, 52, "预加载目标\npreloading", VIOLET_SOFT, VIOLET),
        (510, 340, 122, 52, "预览就绪\nready", GREEN_SOFT, GREEN),
        (664, 340, 122, 52, "目标视图\nstable", BLUE_SOFT, BLUE),
    ]
    for x, y, w, h, text, fill, stroke in nodes:
        flow_node(c, text, x, y, w, h, fill=fill, stroke=stroke, color=stroke if stroke != LINE else INK)
    for i in range(len(nodes) - 1):
        arrow(c, nodes[i][0] + 122, 366, nodes[i + 1][0] - 7, 366)
    c.setFont(FONT_LIGHT, 7.5)
    c.setFillColor(MUTED)
    c.drawString(238, 326, "取消")
    c.drawString(400, 326, "失败")
    arrow(c, 418, 338, 171, 266, AMBER)
    flow_node(c, "保留当前画面\n重试 / 禁用 / 恢复默认", 105, 212, 182, 54, fill=AMBER_SOFT, stroke=AMBER, color=AMBER)
    flow_node(c, "仅切当前会话", 528, 212, 118, 48, fill=WHITE, stroke=LINE)
    flow_node(c, "设为这台设备默认\n共享设备需管理员", 668, 212, 118, 48, fill=WHITE, stroke=LINE)
    arrow(c, 724, 338, 588, 265, BLUE)
    arrow(c, 724, 338, 726, 265, BLUE)
    rounded_box(c, 48, 104, 738, 70, fill=SURFACE)
    bullet_list(c, ["不允许：先卸载当前布局再显示加载器。", "不允许：切换导致 Agent 重新回答或设备动作重复执行。", "不允许：插件自己渲染唯一的恢复入口。"], 68, 150, 690, size=8.8, gap=6, bullet_color=RED)

    # 13
    deck.start("首次设置：hob 在十分钟内活过来", "Onboarding", "它先自我介绍、让家庭命名，再解释地图与观察；人格不弱化隐私、权限和只读边界。")
    steps = [
        ("1", "认识 hob", "第一人称边界 + 为它命名"),
        ("2", "连接家庭", "HA / Xiaomi 平级选择"),
        ("3", "家庭地图", "空间、重复设备、来源"),
        ("4", "空间封面", "可选；权限按需请求"),
        ("5", "连接模型", "保存、测试、启用分离"),
        ("6", "语音与媒体", "可跳过；稍后补充"),
        ("7", "观察偏好", "推荐低频；必须显式同意"),
        ("8", "完成摘要", "真实配置生成第一问"),
    ]
    for i, (num, title, sub) in enumerate(steps):
        col = i % 4
        row = i // 4
        x = 42 + col * 190
        y = 314 - row * 154
        rounded_box(c, x, y, 168, 122, fill=WHITE)
        number_badge(c, num, x + 26, y + 91)
        c.setFillColor(INK)
        c.setFont(FONT_MEDIUM, 11)
        c.drawString(x + 48, y + 86, title)
        draw_text(c, sub, x + 20, y + 57, 128, size=8.7, color=SECONDARY)
        if col < 3:
            arrow(c, x + 168, y + 61, x + 187, y + 61, MUTED)
    rounded_box(c, 42, 87, 738, 52, fill=BLUE_SOFT, stroke=BLUE)
    draw_text(c, "安全检查点：关闭后从上一个完成步骤继续；导入中断不产生半连接状态；示例家庭始终标记为示例。", 62, 119, 700, size=9.2, color=INK)

    # 14
    deck.start("Onboarding 前半程：连接与家庭地图", "Onboarding", "Home Assistant 和 Xiaomi 是平级来源；相同名称不会自动合并，写入能力不会从读取授权继承。")
    cols = [
        (38, "hob 的自我介绍", ["“开始时我只会看，不会动”", "请家庭命名；写入 SOUL.md", "家庭数据默认留在本机"]),
        (296, "连接家庭", ["地址或主动局域网查找", "TLS / Token / 版本 / 延迟预检", "只读范围与凭据保存状态"]),
        (554, "构建家庭地图", ["展示空间与设备数量", "低置信度设备逐项确认", "来自连接 / 你的确认 / Agent 建议"]),
    ]
    for x, title, items in cols:
        rounded_box(c, x, 160, 230, 306, fill=WHITE)
        card_title(c, title, x + 22, 432, 186)
        rounded_box(c, x + 22, 320, 186, 88, fill=SURFACE)
        c.setFillColor(BLUE)
        c.setFont(FONT_MEDIUM, 9)
        c.drawString(x + 38, 377, "页面主动作")
        main_action = {"hob 的自我介绍": "给这只 hob 起名字", "连接家庭": "运行只读预检", "构建家庭地图": "确认现在的家"}[title]
        c.setFillColor(INK)
        c.setFont(FONT_MEDIUM, 12)
        c.drawString(x + 38, 345, main_action)
        bullet_list(c, items, x + 24, 286, 184, size=9.2, gap=10)
        pill(c, "可返回", x + 24, 183, fill=BLUE_SOFT, color=BLUE, size=8, height=20)
    draw_text(c, "异常出口：地址不可达保留输入；TLS 不静默降级；Token 失败删除无效写入；重复设备只形成待确认建议。", 38, 128, 742, size=9.2, color=SECONDARY)

    # 15
    deck.start("Onboarding 后半程：个性化、模型与完成", "Onboarding", "所有秘密只出现一次并进入安全存储；“已保存”“已测试”“已启用”是三个不同状态。")
    draw_contain_image(c, PROTOTYPE_QA / "focus-onboarding-photo-1487x1058.png", 38, 106, 420, 362, radius=10)
    rounded_box(c, 478, 106, 325, 362, fill=WHITE)
    sections = [
        ("空间封面", "拍照 / 相册 / 以后再说；照片不进入 Agent。", BLUE),
        ("模型", "选择 Provider → 保存 Key → 最小探测 → 设为主模型。", VIOLET),
        ("语音与媒体", "首次按麦克风才请求权限；播放器与空间逐项映射。", GREEN),
        ("观察偏好", "推荐每周一次 + 安静时段 + 本地处理；显式同意前不调度。", AMBER),
        ("完成摘要", "列出连接、只读/写入、空间、模型、语音与媒体状态。", BLUE),
    ]
    y = 428
    for title, body, color in sections:
        dot(c, 502, y + 3, color, 3.5)
        c.setFillColor(INK)
        c.setFont(FONT_MEDIUM, 9.5)
        c.drawString(516, y, title)
        y = draw_text(c, body, 502, y - 19, 272, size=8.4, color=SECONDARY) - 10
    rounded_box(c, 498, 128, 284, 57, fill=GREEN_SOFT, stroke=GREEN)
    draw_text(c, "终点不是“配置成功”，而是使用真实首页完成第一问。", 516, 163, 248, size=9.1, font=FONT_MEDIUM, color=GREEN)

    # 16
    deck.start("一个 Agent Turn 的完整生命周期", "Agent 对话", "文字和语音进入同一状态机；等待、后台、取消、重连和纠正都是第一等状态。")
    main = [
        (48, "ready"), (160, "submitted"), (272, "inspecting"), (384, "streaming"), (496, "complete"),
    ]
    for x, label in main:
        fill = BLUE_SOFT if label in ("ready", "complete") else WHITE
        stroke = BLUE if label in ("ready", "complete") else LINE
        flow_node(c, label, x, 354, 88, 42, fill=fill, stroke=stroke, color=stroke if stroke != LINE else INK)
    for i in range(len(main) - 1):
        arrow(c, main[i][0] + 88, 375, main[i + 1][0] - 5, 375)
    branches = [
        (280, 244, "后台继续\n查看进度 / 停止", BLUE_SOFT, BLUE),
        (410, 244, "流断开\n保留 Turn 并重连", AMBER_SOFT, AMBER),
        (540, 244, "纠正理解\n已更新 + 写入位置", VIOLET_SOFT, VIOLET),
        (670, 244, "needs confirmation\n精确影响摘要", GREEN_SOFT, GREEN),
    ]
    for x, y, label, fill, stroke in branches:
        flow_node(c, label, x, y, 112, 58, fill=fill, stroke=stroke, color=stroke)
    arrow(c, 316, 352, 336, 308, BLUE)
    arrow(c, 428, 352, 466, 308, AMBER)
    arrow(c, 540, 352, 596, 308, VIOLET)
    arrow(c, 584, 375, 724, 308, GREEN)
    rounded_box(c, 48, 113, 734, 86, fill=SURFACE)
    card_title(c, "等待反馈契约", 68, 173, 690)
    labels = [("0–100ms", "按压 / 提交反馈"), ("100ms–1s", "已收到"), ("1–10s", "语义阶段 + 取消"), (">10s", "后台继续 + 通知")]
    x = 68
    for time, body in labels:
        pill(c, time, x, 132, fill=WHITE, color=BLUE, size=7.4, height=18)
        draw_text(c, body, x, 123, 155, size=7.7, color=SECONDARY)
        x += 172

    deck.start("纠正不是静默写入：hob 必须说“已更新”", "纠正闭环", "用户要知道纠正已经生效，也要知道它改变的是家庭知识还是一项待审阅的未来行为。")
    correction_cols = [
        (38, "用户纠正", "“周末我们通常九点后才起床。”", BLUE, BLUE_SOFT),
        (298, "知识已更新", "“已更新家庭知识：周末作息通常更晚。”", GREEN, GREEN_SOFT),
        (558, "涉及行为", "“我已据此创建一项建议，尚未改变窗帘规则。”", VIOLET, VIOLET_SOFT),
    ]
    for idx, (x, title, body, color, soft) in enumerate(correction_cols):
        rounded_box(c, x, 208, 238, 238, fill=WHITE)
        number_badge(c, str(idx + 1), x + 28, 408, color)
        c.setFillColor(INK)
        c.setFont(FONT_MEDIUM, 11)
        c.drawString(x + 50, 404, title)
        rounded_box(c, x + 20, 292, 198, 82, fill=soft, stroke=color)
        draw_text(c, body, x + 36, 344, 166, size=9, font=FONT_MEDIUM, color=INK, max_lines=3)
        if idx < len(correction_cols) - 1:
            arrow(c, x + 238, 327, correction_cols[idx + 1][0] - 8, 327, MUTED)
    rounded_box(c, 38, 104, 758, 72, fill=RED_SOFT, stroke=RED)
    pill(c, "不可发生", 58, 130, fill=WHITE, color=RED, size=8, height=20)
    draw_text(c, "correction recorded + no visible acknowledgement；correction → direct behavior change。", 158, 143, 610, size=9, color=INK)

    # 17
    deck.start("示例：窗帘时间忽早忽晚，Agent 应该怎样回答", "家庭建议", "回答不是一句“建议改成 7:30”，而是区分事实、未知、试验和缺失感知能力。")
    cards = [
        (38, 286, 238, 181, "1 · 已验证事实", GREEN, GREEN_SOFT, ["今天 09:42 才打开，平时约 07:15", "09:00 后光照已充足", "客厅温度比常态低 1.3°C"]),
        (298, 286, 238, 181, "2 · 仍然不知道", AMBER, AMBER_SOFT, ["周末作息是否不同", "用户当时是否仍在休息", "阴天时室内实际亮度"]),
        (558, 286, 238, 181, "3 · 可逆试验", BLUE, BLUE_SOFT, ["先试 7 天，不改永久规则", "工作日 7:30；周末看首次活动", "随时撤回并回到原规则"]),
    ]
    for x, y, w, h, title, color, soft, items in cards:
        rounded_box(c, x, y, w, h, fill=WHITE)
        pill(c, title, x + 18, y + h - 38, fill=soft, color=color, size=8, height=20)
        bullet_list(c, items, x + 20, y + h - 70, w - 40, size=8.6, gap=8, bullet_color=color)
    rounded_box(c, 38, 112, 758, 142, fill=SURFACE)
    card_title(c, "4 · 硬件能力建议", 58, 224, 714, tag="可选，不制造焦虑")
    columns = [
        (58, "缺少的信号", "室内照度 + 起床/活动信号"),
        (248, "建议位置", "客厅靠窗但避开直射；卧室仅在同意后启用占用感知"),
        (474, "隐私影响", "存在传感器优先于摄像头；原始数据本地保留"),
        (664, "不购买替代", "使用日出、天气和手动纠正，准确度较低但可用"),
    ]
    for x, title, body in columns:
        c.setFillColor(INK)
        c.setFont(FONT_MEDIUM, 8.8)
        c.drawString(x, 189, title)
        draw_text(c, body, x, 168, 126, size=7.9, color=SECONDARY)

    deck.start("安全级异常不属于普通关注点", "安全", "漏水、烟雾、燃气与 policy 判定的门锁风险由 Host Shell 穿透所有布局；它们没有 snooze。")
    rounded_box(c, 38, 320, 758, 144, fill=RED_SOFT, stroke=RED, radius=12)
    pill(c, "安全级 · 全视图置顶", 58, 422, fill=WHITE, color=RED, size=8.5, height=22)
    c.setFillColor(INK)
    c.setFont(FONT_MEDIUM, 16)
    c.drawString(58, 382, "厨房检测到漏水")
    draw_text(c, "连接正常 · 30 秒前由厨房漏水传感器触发。关闭总水阀需要管理员确认；危险未解除前横幅持续显示。", 58, 356, 540, size=9.2, color=SECONDARY)
    rounded_box(c, 618, 350, 154, 42, fill=RED, stroke=RED, radius=9)
    c.setFillColor(WHITE)
    c.setFont(FONT_MEDIUM, 9)
    c.drawCentredString(695, 367, "查看处置")
    cols = [
        (38, "Host 必须保留", ["严重度与当前危险", "来源、连接与最后联系", "主处置与求助出口"]),
        (298, "允许的用户动作", ["确认已看到", "打开处置步骤", "发起受治理的设备动作"]),
        (558, "绝不允许", ["稍后提醒 / snooze", "第三方布局隐藏或降级", "acknowledged 伪装 resolved"]),
    ]
    for x, title, items in cols:
        rounded_box(c, x, 112, 238, 176, fill=WHITE)
        card_title(c, title, x + 18, 255, 202)
        bullet_list(c, items, x + 18, 222, 198, size=8.5, gap=8, bullet_color=RED if x == 558 else BLUE)

    deck.start("每个结果都能回答：为什么会这样", "可解释性", "CauseRef 是家庭可读因果链，不是模型思维链；活动还要说明动作来自人、hob、外部规则还是未知。")
    rounded_box(c, 38, 238, 758, 226, fill=WHITE)
    card_title(c, "活动条目展开后的因果链", 60, 432, 714, tag="为什么")
    cause_nodes = [
        (58, "客厅灯 03:00 亮了", "结果", BLUE, BLUE_SOFT),
        (298, "HA 自动化\n“夜间感应”", "规则", VIOLET, VIOLET_SOFT),
        (538, "走廊传感器\n检测到移动", "触发", GREEN, GREEN_SOFT),
    ]
    for idx, (x, label, tag, color, soft) in enumerate(cause_nodes):
        rounded_box(c, x, 300, 188, 86, fill=soft, stroke=color)
        pill(c, tag, x + 14, 350, fill=WHITE, color=color, size=7.3, height=18)
        draw_text(c, label, x + 14, 332, 158, size=9, font=FONT_MEDIUM, color=INK, max_lines=2)
        if idx < len(cause_nodes) - 1:
            arrow(c, x + 188, 343, cause_nodes[idx + 1][0] - 8, 343, MUTED)
    rounded_box(c, 38, 112, 365, 96, fill=SURFACE)
    pill(c, "归因 · HA 外部规则", 58, 166, fill=VIOLET_SOFT, color=VIOLET, size=8, height=20)
    draw_text(c, "归因还可以是“手动/物理”“hob”或“未知”；未知时不猜。", 58, 149, 320, size=8.7, color=SECONDARY)
    rounded_box(c, 420, 112, 376, 96, fill=BLUE_SOFT, stroke=BLUE)
    pill(c, "物理开关永远赢", 440, 166, fill=WHITE, color=BLUE, size=8, height=20)
    draw_text(c, "“你手动关了灯，我注意到了。”相反自动动作被取消或抑制，并留下审计。", 440, 149, 330, size=8.7, color=INK)

    # 18
    deck.start("语音助手：有呼吸感，但不制造假能力", "语音", "视觉动画只表达“正在听 / 转写 / 处理 / 朗读”；字幕、停止与文字出口始终可见。")
    draw_contain_image(c, ASSETS / "voice-listening-mobile.png", 38, 86, 244, 396, radius=13)
    rounded_box(c, 306, 86, 497, 396, fill=WHITE)
    card_title(c, "Listening 状态必须同时传达", 330, 448, 449, tag="可立即打断")
    rows = [
        ("当前在做什么", "正在听；不是正在执行音乐播放。"),
        ("理解了什么", "实时字幕可编辑；空间与媒体连接作为上下文 chip。"),
        ("如何停止", "停止、改用文字、关闭 Sheet 都不改变家庭。"),
        ("隐私", "音频仅用于当前对话，不进入活动记录。"),
        ("减少动态", "用静态状态环 + 文本替代呼吸形变；不失去反馈。"),
        ("权限", "语音与文字使用同一权限；转写提交前不搜索、不准备动作。"),
    ]
    y = 406
    for idx, (title, body) in enumerate(rows):
        if idx:
            draw_rule(c, 330, y + 10, 437)
        c.setFillColor(BLUE)
        c.setFont(FONT_MEDIUM, 9.2)
        c.drawString(330, y - 7, title)
        draw_text(c, body, 432, y - 7, 330, size=8.6, color=SECONDARY, max_lines=2)
        y -= 52

    # 19
    deck.start("语音失败不能重复同一句", "语音恢复", "错误提示逐次增加信息；第三次识别失败后必须提供文字出口，权限拒绝不阻塞整个产品。")
    flow_node(c, "请求麦克风", 48, 382, 110, 46, fill=WHITE, stroke=LINE)
    flow_node(c, "正在听", 200, 382, 110, 46, fill=BLUE_SOFT, stroke=BLUE, color=BLUE)
    flow_node(c, "可编辑转写", 352, 382, 110, 46, fill=GREEN_SOFT, stroke=GREEN, color=GREEN)
    flow_node(c, "提交 Turn", 504, 382, 110, 46, fill=WHITE, stroke=LINE)
    flow_node(c, "精确确认", 656, 382, 110, 46, fill=VIOLET_SOFT, stroke=VIOLET, color=VIOLET)
    for a, b in [(158, 193), (310, 345), (462, 497), (614, 649)]:
        arrow(c, a, 405, b, 405)
    errors = [
        (48, 238, "权限拒绝", "解释用途 → 系统权限设置 → 改用文字", RED, RED_SOFT),
        (235, 238, "听不清 #1", "用更短说法重新提示", AMBER, AMBER_SOFT),
        (422, 238, "听不清 #2", "给出当前空间相关示例", AMBER, AMBER_SOFT),
        (609, 238, "听不清 #3", "停止循环 → 文字 / 重新开始", RED, RED_SOFT),
    ]
    for x, y, title, body, color, soft in errors:
        rounded_box(c, x, y, 157, 84, fill=soft, stroke=color)
        c.setFillColor(color)
        c.setFont(FONT_MEDIUM, 9)
        c.drawString(x + 14, y + 57, title)
        draw_text(c, body, x + 14, y + 38, 128, size=7.8, color=INK)
    rounded_box(c, 48, 111, 718, 83, fill=SURFACE)
    pill(c, "部分理解", 66, 150, fill=BLUE_SOFT, color=BLUE, size=8, height=20)
    draw_text(c, "“我知道你想在多媒体室播放音乐，还需要确认：加入当前队列，还是替换并播放？” 只问缺失槽位，不要求用户重说整句。", 158, 166, 580, size=9, color=INK)

    # 20
    deck.start("媒体：搜索不是播放，准备不是执行", "媒体", "Music Assistant 提供搜索和播放器能力；Agent 解析爵士意图，Hub 对精确播放器、来源、队列与音量重新确认。")
    stages = [
        (48, "用户意图", "在多媒体室放一点轻松爵士", BLUE, BLUE_SOFT),
        (192, "补齐槽位", "空间 / 播放器 / 来源 / 队列", VIOLET, VIOLET_SOFT),
        (336, "只读搜索", "展示有限候选，不自动选版本", GREEN, GREEN_SOFT),
        (480, "准备动作", "播放器、曲目、队列、音量", AMBER, AMBER_SOFT),
        (624, "用户确认", "播放 / 换一个 / 取消", BLUE, BLUE_SOFT),
    ]
    for i, (x, title, body, color, soft) in enumerate(stages):
        rounded_box(c, x, 326, 126, 96, fill=soft, stroke=color)
        c.setFillColor(color)
        c.setFont(FONT_MEDIUM, 9.2)
        c.drawString(x + 14, 391, title)
        draw_text(c, body, x + 14, 368, 98, size=7.7, color=INK)
        if i < len(stages) - 1:
            arrow(c, x + 126, 374, stages[i + 1][0] - 6, 374)
    rounded_box(c, 48, 120, 702, 154, fill=WHITE)
    card_title(c, "确认卡必须出现的内容", 68, 242, 658, tag="A2 → A3")
    confirmations = [
        ("空间", "多媒体室"),
        ("播放器", "家庭音响 · 在线"),
        ("媒体", "轻松爵士 Mix · Music Assistant"),
        ("队列", "替换当前队列并播放"),
        ("音量", "24%（当前值）"),
        ("执行后", "重新读取播放状态；未知时不说已播放"),
    ]
    for i, (label, value) in enumerate(confirmations):
        col = i % 3
        row = i // 3
        x = 70 + col * 220
        y = 199 - row * 54
        c.setFillColor(MUTED)
        c.setFont(FONT_MEDIUM, 7.5)
        c.drawString(x, y, label)
        draw_text(c, value, x, y - 18, 190, size=8.7, font=FONT_MEDIUM, color=INK)

    # 21
    deck.start("一次性设备动作：按钮也必须走治理", "动作确认", "控制视图可以更直接，但不能把快捷按钮变成绕过 policy 的捷径。")
    rounded_box(c, 38, 118, 360, 346, fill=WHITE)
    card_title(c, "低风险、可逆且明确", 60, 432, 316, tag="可直接执行或轻确认")
    flow_node(c, "点击“关闭客厅主灯”", 72, 350, 250, 48, fill=BLUE_SOFT, stroke=BLUE, color=BLUE)
    flow_node(c, "Host 解析精确 hwCapabilityId", 72, 278, 250, 48, fill=WHITE, stroke=LINE)
    flow_node(c, "Policy 允许 → 执行 → 重新读取", 72, 222, 250, 48, fill=GREEN_SOFT, stroke=GREEN, color=GREEN)
    flow_node(c, "已关闭 · 撤销（10 秒）", 72, 154, 250, 42, fill=BLUE_SOFT, stroke=BLUE, color=BLUE)
    arrow(c, 197, 350, 197, 330)
    arrow(c, 197, 278, 197, 274)
    arrow(c, 197, 222, 197, 202)
    draw_text(c, "撤销是新的反向动作，仍读取最新状态、经过 policy 并留审计；失败或结果未知不显示。", 72, 132, 250, size=8.2, color=SECONDARY)
    rounded_box(c, 420, 118, 383, 346, fill=SURFACE)
    card_title(c, "高影响、含糊或持久", 442, 432, 339, tag="必须精确确认")
    risky = [
        ("含糊", "“把家里调舒服点”先变成建议或可逆试验。"),
        ("多个目标", "同名设备或跨空间动作先让用户选择。"),
        ("高影响", "门锁、安防、温控上限等显示后果与当前状态。"),
        ("持久行为", "进入 Proposal → 证据/冲突 → 方向批准 → 干跑/再批准。"),
        ("结果未知", "不自动重试可能已执行的动作；进入活动记录并重新验证。"),
    ]
    y = 388
    for title, body in risky:
        pill(c, title, 444, y - 6, fill=WHITE, color=AMBER, size=7.5, height=18)
        draw_text(c, body, 516, y + 3, 250, size=8.5, color=INK, max_lines=2)
        y -= 55

    deck.start("跨设备确认、批量拆分与 freshness", "跨端治理", "语音、高密度按钮和长时间安静是三个最容易制造假确定性的地方；界面必须把路由、部分结果和连接健康说清楚。")
    panels = [
        (38, 278, "语音 → 管理员设备", BLUE, ["音箱不把声音当批准身份", "说明发到谁的已认证设备", "首个合格批准获胜；TTL 后拒绝"]),
        (298, 278, "批量动作先拆分", VIOLET, ["提交前：4 个直接执行", "1 个需要确认，1 个不可用", "逐项验证；不以绿色总结果遮蔽"]),
        (558, 278, "两个 freshness 时间轴", GREEN, ["连接健康 + 最后联系", "最后有意义的家庭变化", "安静不是失联；失联不是 stale 文案"]),
    ]
    for x, y0, title, color, items in panels:
        rounded_box(c, x, y0, 238, 186, fill=WHITE)
        c.setFillColor(color)
        c.setFont(FONT_MEDIUM, 11)
        c.drawString(x + 20, y0 + 145, title)
        bullet_list(c, items, x + 20, y0 + 111, 198, size=8.5, gap=8, bullet_color=color)
    rounded_box(c, 38, 166, 365, 80, fill=GREEN_SOFT, stroke=GREEN)
    pill(c, "正常安静", 58, 203, fill=WHITE, color=GREEN, size=8, height=20)
    draw_text(c, "连接正常 · 家中无变化", 154, 216, 220, size=10, font=FONT_MEDIUM, color=INK)
    rounded_box(c, 420, 166, 376, 80, fill=RED_SOFT, stroke=RED)
    pill(c, "连接异常", 440, 203, fill=WHITE, color=RED, size=8, height=20)
    draw_text(c, "连接中断 · 最后联系 3 小时前", 536, 216, 230, size=10, font=FONT_MEDIUM, color=INK)
    rounded_box(c, 38, 96, 758, 48, fill=SURFACE)
    draw_text(c, "共享墙面屏无认证身份时只显示“发送到管理员设备”；没有合格设备则明确说未执行。", 58, 125, 720, size=8.8, color=INK)

    # 22
    deck.start("持久自动化：两阶段评审", "自动化", "用户先批准方向，再批准精确制品；“同意这个想法”不等于“已经安装并启用”。")
    flow = [
        (42, "Agent 提出方向", BLUE, BLUE_SOFT),
        (174, "事实 / 未知 / 冲突", GREEN, GREEN_SOFT),
        (306, "家庭批准方向", VIOLET, VIOLET_SOFT),
        (438, "编译 / 干跑 / 回滚", AMBER, AMBER_SOFT),
        (570, "精确制品再批准", VIOLET, VIOLET_SOFT),
        (702, "安装 / 验证", GREEN, GREEN_SOFT),
    ]
    for i, (x, label, color, soft) in enumerate(flow):
        flow_node(c, label, x, 360, 108, 54, fill=soft, stroke=color, color=color)
        if i < len(flow) - 1:
            arrow(c, x + 108, 387, flow[i + 1][0] - 5, 387)
    rounded_box(c, 42, 148, 758, 153, fill=WHITE)
    card_title(c, "评审卡信息层级", 62, 268, 714)
    review_cols = [
        (62, "目标", "让窗帘更贴合作息，而不是固定更早。"),
        (238, "证据", "近 7 天打开时间、光照、活动与既有规则覆盖。"),
        (414, "冲突", "与 HA 现有工作日自动化可能重复。"),
        (590, "回滚", "恢复原规则；停止未来调度；保留审计。"),
    ]
    for x, title, body in review_cols:
        pill(c, title, x, 225, fill=SURFACE, color=BLUE, size=7.5, height=18)
        draw_text(c, body, x, 208, 150, size=8.2, color=SECONDARY)
    rounded_box(c, 42, 86, 758, 43, fill=AMBER_SOFT, stroke=AMBER)
    draw_text(c, "Phase 0 只允许建议和评审，不应在 UI 中伪装“已启用”。未来开放执行也必须保留第二次精确批准。", 60, 112, 720, size=8.8, color=INK)

    # 23
    deck.start("第三方布局：安装、授权、启用与回退", "布局 Plugin", "布局贡献和家庭权限分开审批；安装成功、在切换器可见、获得数据、可请求动作是四种状态。")
    lifecycle = [
        (44, "发现", "发布者 / 版本 / 预览", BLUE),
        (178, "验证", "签名 / digest / compatibility", VIOLET),
        (312, "安装", "不可变 generation", GREEN),
        (446, "授权", "数据范围 / intent kinds", AMBER),
        (580, "启用", "进入 View Registry", BLUE),
        (714, "运行", "健康 / 撤销 / 回退", GREEN),
    ]
    for i, (x, title, body, color) in enumerate(lifecycle):
        flow_node(c, title, x, 382, 92, 42, fill=WHITE, stroke=color, color=color)
        draw_text(c, body, x, 360, 92, size=7.3, color=SECONDARY, max_lines=2)
        if i < len(lifecycle) - 1:
            arrow(c, x + 92, 403, lifecycle[i + 1][0] - 6, 403)
    rounded_box(c, 44, 142, 352, 166, fill=WHITE)
    card_title(c, "Layout Recipe · Phase 2", 64, 276, 308, tag="优先")
    bullet_list(c, ["版本化页面、卡片、查询与 intent schema", "Host renderer；无第三方 JavaScript", "适合 Dashboard、能源与空间布局", "可视化编辑：draft → preview → save"], 64, 244, 286, size=8.7, gap=7, bullet_color=GREEN)
    rounded_box(c, 414, 142, 390, 166, fill=SURFACE)
    card_title(c, "Isolated View Application · Phase 3", 434, 276, 346, tag="未来")
    bullet_list(c, ["独立 origin sandbox + CSP + 资源预算", "只通过 Presentation / Intent Broker", "不能访问 DOM、cookie、secret、Bridge、Cordis Context", "崩溃或撤销时 Host 切回内置 View"], 434, 244, 334, size=8.7, gap=7, bullet_color=AMBER)
    rounded_box(c, 44, 86, 760, 38, fill=RED_SOFT, stroke=RED)
    draw_text(c, "布局失效不能把“家”显示成离线；它只意味着当前表达方式不可用。", 62, 109, 720, size=8.8, font=FONT_MEDIUM, color=RED)

    # 24
    deck.start("设置侧完整，日常侧保持简单", "设置", "高级能力一层可达，但凭据、诊断和插件权限不会占据普通成员的首页。")
    categories = [
        (38, 280, "家庭连接", ["Home Assistant", "Xiaomi Home", "重复设备与空间映射", "只读 / 写入范围"]),
        (232, 280, "模型", ["主模型与备用顺序", "API Key / OAuth", "自定义 OpenAI-compatible", "测试、轮换、删除"]),
        (426, 280, "声音与媒体", ["麦克风与朗读", "声音 / 语速 / 试播", "Music Assistant", "播放器与空间映射"]),
        (620, 280, "家庭与隐私", ["角色与高影响批准范围", "观察推荐、显式同意与安静时段", "照片、音频与活动记录", "导出、保留与删除"]),
        (38, 120, "视图与布局", ["默认视图（按设备）", "布局编辑与重置", "安装 / 禁用 / 卸载", "无障碍与响应式预览"]),
        (232, 120, "自动化与审批", ["运行时 TTL 与 eligible roles", "提案 ≤5、snooze 与拒绝闩锁", "现有规则覆盖", "回滚与活动记录"]),
        (426, 120, "高级诊断", ["Bridge 健康", "模型 Probe", "DSH 安全轨迹", "数据覆盖与本地存储"]),
        (620, 120, "凭据原则", ["保存后不回显", "秘密不进 DOM / URL / 日志", "轮换先测试再切换", "删除失败保留可重试清理"]),
    ]
    for x, y, title, items in categories:
        rounded_box(c, x, y, 174, 139, fill=WHITE)
        c.setFillColor(INK)
        c.setFont(FONT_MEDIUM, 10)
        c.drawString(x + 16, y + 108, title)
        bullet_list(c, items, x + 16, y + 82, 144, size=7.7, gap=4, bullet_color=BLUE)

    # 25
    deck.start("加载、部分可用、失败与恢复", "系统状态", "完整外壳永远保留；预期状态不渲染成裸 404、500 或无限 Spinner。")
    headers = ["状态", "用户看到", "主动作", "禁止"]
    widths = [116, 270, 152, 218]
    x = 42
    for header, width in zip(headers, widths):
        c.setFillColor(INK)
        c.setFont(FONT_MEDIUM, 8.8)
        c.drawString(x + 10, 442, header)
        x += width
    draw_rule(c, 42, 426, sum(widths))
    rows = [
        ("连接中", "完成项目 + 当前读取项目", "后台继续 / 进度", "把等待显示成设备离线"),
        ("Agent 工作中", "家庭语义阶段 + 部分答案", "停止 / 后台", "思维链、工具参数、虚假百分比"),
        ("部分可用", "连接健康 + 最后联系 + 缺失范围", "修复 / 只读继续", "把安静和失联混成 stale"),
        ("结果未知", "动作可能已发送，状态尚未验证", "重新验证", "自动重试或宣称成功"),
        ("权限拒绝", "为什么需要 + 仍可用能力", "设置权限 / 替代路径", "反复弹窗或阻塞产品"),
        ("插件失效", "布局不可用，家庭仍在线", "恢复内置 / 诊断", "空白页或删除家庭配置"),
        ("模型不可用", "认证 / 计费 / 限流 / 超时分类", "修复 / 备用 / 保存问题", "回显原始 provider error"),
    ]
    y = 394
    for idx, row in enumerate(rows):
        c.setFillColor(WHITE if idx % 2 == 0 else SURFACE)
        c.roundRect(42, y - 34, sum(widths), 42, 4, fill=1, stroke=0)
        x = 42
        for col, (text, width) in enumerate(zip(row, widths)):
            color = RED if col == 3 else (BLUE if col == 0 else SECONDARY)
            draw_text(c, text, x + 10, y - 4, width - 16, size=7.8, font=FONT_MEDIUM if col == 0 else FONT_LIGHT, color=color, max_lines=2)
            x += width
        y -= 44

    # 26
    deck.start("无障碍、动态与响应式要求", "质量门槛", "这些不是上线前补丁，而是每个 View Provider 的 conformance contract。")
    sections = [
        (38, "输入与导航", BLUE, ["键盘完整可用，焦点始终可见", "主要触点移动端至少 44px", "屏幕阅读器知道当前空间、视图和状态", "语音动作同时有可见文字控制"]),
        (236, "动态与材料", VIOLET, ["默认临界阻尼，约 0.3–0.4 秒", "所有 sheet / 切换可立即打断", "reduced-motion 改为短交叉淡化", "reduced-transparency 使用近实色表面"]),
        (434, "信息与颜色", GREEN, ["颜色不作为唯一状态编码", "未知、部分可用与完成不可混色", "动态字体放大不截断主动作", "图表提供文字摘要和时间范围"]),
        (632, "跨端", AMBER, ["390px 手机、桌面、平板、墙面屏", "软键盘不遮 Composer", "横竖屏切换保持语义位置", "每个布局声明支持的 viewport class"]),
    ]
    for x, title, color, items in sections:
        rounded_box(c, x, 134, 176, 330, fill=WHITE)
        c.setFillColor(color)
        c.setFont(FONT_MEDIUM, 12)
        c.drawString(x + 20, 426, title)
        c.setFillColor(color)
        c.roundRect(x + 20, 401, 44, 4, 2, fill=1, stroke=0)
        bullet_list(c, items, x + 20, 370, 136, size=8.7, gap=10, bullet_color=color)
    rounded_box(c, 38, 86, 770, 34, fill=SURFACE)
    draw_text(c, "验收必须覆盖 loading、empty、failure、reconnecting、completion、cancellation；不能只测 happy path。", 58, 108, 730, size=8.8, font=FONT_MEDIUM, color=INK)

    # 27
    deck.start("页面与状态清单", "交付范围", "设计师排版时应覆盖这些可见表面；同一状态可在不同 viewport 或 View Provider 中复用。")
    groups = [
        (38, "Onboarding · 14", ["hob 自我介绍 / 命名", "连接来源选择", "HA 地址 / TLS / Token", "只读预检", "Xiaomi 可用性", "家庭地图", "重复设备", "空间封面", "模型 Provider", "自定义模型", "语音", "Music Assistant", "观察显式同意", "完成摘要 / 第一问"]),
        (236, "日常 · 14", ["生活首页", "控制总览", "移动端处理双区块", "安全级横幅", "空间详情 × 2", "Agent Composer", "工作中", "后台 Turn", "完整回答", "纠正 + 已更新", "为什么 / CauseRef", "活动 / 过期摘要", "安静 vs 失联"]),
        (434, "动作与语音 · 14", ["正在听", "转写可编辑", "权限拒绝", "No-match × 3", "媒体候选", "媒体确认", "等待你放行 + TTL", "跨设备 handoff", "批量治理拆分", "执行中", "已验证 + 撤销", "结果未知", "角色不允许"]),
        (632, "设置与生态 · 14", ["家庭连接", "模型与备用", "凭据轮换", "声音与朗读", "媒体与播放器", "家庭成员", "隐私与保留", "视图切换", "布局编辑", "Plugin 详情", "权限授权", "更新 / 撤销", "高级诊断", "恢复默认布局"]),
    ]
    for x, title, items in groups:
        rounded_box(c, x, 96, 176, 368, fill=WHITE)
        c.setFillColor(INK)
        c.setFont(FONT_MEDIUM, 11)
        c.drawString(x + 18, 432, title)
        y = 402
        for i, item in enumerate(items, 1):
            c.setFillColor(MUTED)
            c.setFont(FONT_MEDIUM, 7.2)
            c.drawString(x + 18, y, f"{i:02d}")
            c.setFillColor(INK)
            c.setFont(FONT_LIGHT, 8.1)
            c.drawString(x + 42, y, item)
            y -= 20.7
    pill(c, "至少 57 个页面 / 状态条目", 38, 66, fill=BLUE_SOFT, color=BLUE, size=8.5, height=22)

    # 28
    deck.start("状态守卫与不可发生的组合", "交互契约", "这些规则直接转化为测试；任何布局都不能通过视觉实现绕开。")
    invariants = [
        ("Turn", "cancelled + pendingAction", "停止回答后不能保留待执行动作。"),
        ("媒体", "confirm without prepared", "没有精确候选、播放器和队列时确认无副作用。"),
        ("纠正", "correction → authority", "纠正理解不创建规则、不执行设备。"),
        ("纠正", "recorded → no acknowledgement", "写入后必须显示“已更新”和去向。"),
        ("视图", "target loading → current unmounted", "目标 ready 前当前布局必须继续可用。"),
        ("设备", "result unknown → auto retry", "可能已执行的动作不能自动重试。"),
        ("数据", "stale → live completion", "过期数据不能渲染为实时绿色完成。"),
        ("插件", "same package → inherited grants", "UI、Skill、Bridge、Tool 权限分别授权。"),
        ("自动化", "direction approval → enabled", "方向批准不等于安装或启用。"),
        ("放行", "expired confirmation → approve", "TTL 到期即拒绝；只能重新准备。"),
        ("放行", "runtime rejection → dedup latch", "一次拒绝绝不影响未来同类动作。"),
        ("提案", "snoozed → capacity released", "稍后仍占 1 个提案位。"),
    ]
    for i, (scope, impossible, meaning) in enumerate(invariants):
        col = i % 2
        row = i // 2
        x = 38 + col * 387
        y = 396 - row * 58
        rounded_box(c, x, y, 365, 48, fill=WHITE)
        pill(c, scope, x + 16, y + 20, fill=RED_SOFT, color=RED, size=7.3, height=18)
        c.setFillColor(INK)
        c.setFont(FONT_MEDIUM, 8.2)
        c.drawString(x + 84, y + 30, impossible)
        draw_text(c, meaning, x + 84, y + 12, 258, size=7.6, color=SECONDARY, max_lines=1)

    # 29
    deck.start("从设计稿到产品的实现顺序", "交接", "先建立共享 presentation / intent contract，再做两个 built-in View；不要先复制页面再抽象。")
    milestones = [
        ("F0", "交互与视觉原型", "双视图、切换、关键状态、跨端与评审", BLUE),
        ("F1", "Shared Presentation Kernel", "neutral snapshot、Turn/Review projection、typed intent", VIOLET),
        ("F2", "两个内置 Provider", "life / control 同一 registry 与 conformance", GREEN),
        ("F3", "声明式布局生态", "recipe schema、卡片、可视化编辑、签名与 grant", AMBER),
        ("F4", "隔离 View Application", "独立 origin sandbox、broker、崩溃与撤销回退", RED),
    ]
    y = 397
    for idx, (code, title, body, color) in enumerate(milestones):
        number_badge(c, code, 72, y + 4, color)
        c.setFillColor(INK)
        c.setFont(FONT_MEDIUM, 11)
        c.drawString(98, y, title)
        draw_text(c, body, 320, y, 410, size=8.8, color=SECONDARY, max_lines=2)
        if idx < len(milestones) - 1:
            c.setStrokeColor(LINE)
            c.line(72, y - 15, 72, y - 58)
        y -= 70
    rounded_box(c, 520, 98, 260, 72, fill=BLUE_SOFT, stroke=BLUE)
    pill(c, "下一轮设计重点", 540, 129, fill=WHITE, color=BLUE, size=7.5, height=18)
    draw_text(c, "把两类入口、安全横幅、角色路由与 CauseRef 落进可点击原型并做家庭测试。", 540, 120, 218, size=8.4, color=INK)

    # 30
    deck.start("V3 评审边界：四项已经决定", "评审结论", "P0 不再作为开放问题；会议检查它们是否被准确落图。其余问题再记录接受、修改或待验证。")
    accepted = [
        ("A", "拆开两个物种", "运行时放行有 TTL 且 fail-closed；持久提案 14 天自然过期。"),
        ("B", "收件箱三纪律", "方向批准 ≠ 启用；拒绝闩锁；pending + snoozed ≤5。"),
        ("C", "权限接入确认", "高影响需要管理员；共享屏 handoff；过期不可批准。"),
        ("D", "推荐观察但显式同意", "每周一次 + 安静时段 + 本地处理；同意前不创建调度。"),
    ]
    for i, (code, title, body) in enumerate(accepted):
        x = 38 + (i % 2) * 388
        y = 350 - (i // 2) * 110
        rounded_box(c, x, y, 366, 88, fill=GREEN_SOFT, stroke=GREEN)
        number_badge(c, code, x + 24, y + 58, GREEN)
        c.setFillColor(INK)
        c.setFont(FONT_MEDIUM, 10)
        c.drawString(x + 46, y + 56, title)
        draw_text(c, body, x + 46, y + 34, 296, size=8.3, color=SECONDARY, max_lines=2)
    rounded_box(c, 38, 88, 754, 102, fill=WHITE)
    card_title(c, "仍需设计评审", 58, 160, 710, tag="开放")
    draw_text(c, "两类入口的视觉分量是否合适？安全横幅是否既穿透又不遮挡处置？角色与跨设备 handoff 是否清楚？CauseRef 是否像家庭解释而不是日志？hob 的自我介绍是否亲近但不弱化边界？", 58, 135, 710, size=8.8, color=INK)
    pill(c, "完整决议见 design-review-decision-log.md", 38, 52, fill=BLUE_SOFT, color=BLUE, size=8.3, height=22)

    # 31
    deck.start("参考与术语", "附录", "交互稿同时受仓库治理文档与公开可扩展前端案例约束。")
    rounded_box(c, 38, 118, 365, 350, fill=WHITE)
    card_title(c, "仓库内基线", 60, 435, 320)
    refs = [
        "design-review-decision-log.md · V2 已接受决策与验收条件",
        "INTERACTION-SPEC.md · 页面、内容与完整闭环",
        "INTERACTION-LOGIC.md · 状态、事件、守卫与恢复",
        "frontend-layout-extensions.md · View Provider 与 Plugin 布局",
        "extension-governance.md · Plugin trust、grant 与隔离",
        "voice-and-media-interaction.md · 语音与媒体中立契约",
    ]
    bullet_list(c, refs, 60, 399, 310, size=8.7, gap=8)
    rounded_box(c, 425, 118, 378, 350, fill=SURFACE)
    card_title(c, "公开参考项目", 447, 435, 334)
    sources = [
        "Backstage Frontend System — extension tree、page 与 navigation",
        "Grafana App Plugins — custom pages、Scenes 与 extension points",
        "Kibana Application Service — lazy mount / unmount lifecycle",
        "JupyterLab — shell modes 与 layout restoration",
        "Home Assistant — Custom Panels 与 Custom Cards",
        "Apple Design — agency、familiarity、flexibility 与 fluid interaction",
    ]
    bullet_list(c, sources, 447, 399, 320, size=8.7, gap=8, bullet_color=VIOLET)
    draw_rule(c, 447, 222, 318)
    draw_text(c, "术语：Host Shell = 不随布局替换的产品外壳；View Provider = 一套信息架构与呈现；Presentation = 只读中立投影；Intent = 由 Host 重新验证的用户意图。", 447, 197, 320, size=8.4, color=SECONDARY)

    c.save()
    return OUTPUT


if __name__ == "__main__":
    print(build_pdf())
