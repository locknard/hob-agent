# Interaction design image prompts

The three project-bound review mockups were created with the built-in Image
Generation tool and copied into `docs/design/assets/`. They are concept visuals
inside the PDF, not production UI assets.

## Control View desktop

Reference: `prototypes/household-spatial-prototype/qa/implementation-home-1440x1024.png`

> Transform the reference hob-agent Life View into its peer built-in Control
> View. Preserve the exact visual language, Chinese system typography, calm
> off-white surfaces, cobalt-blue accent, thin warm-gray borders, restrained
> shadows, and the same top-level product identity. Use a 1440x1024 desktop
> shell with a Host-owned view switcher, compact navigation, a high-density
> Lovelace-inspired household grid, visible freshness and unknown states,
> governed controls, pending approvals, and the persistent Agent composer.

Output: `assets/control-view-desktop.png`

## Control View desktop V2 - split review lifecycles

Reference/edit target: `assets/control-view-desktop.png`

> Edit only the lower-right review area and matching left navigation labels so
> runtime confirmations and persistent proposals are visibly separate species.
> Use “等待你放行” with one precise temperature action, “需要管理员”, a visible
> `01:42` fail-closed countdown, and “拒绝 / 放行”. Use a separate “给家的建议”
> section for the energy proposal, with “13 天后过期”, “稍后查看”, and
> “不再建议这件事”. Preserve every unrelated dashboard card, chart, media
> control, room control, activity item, composer, dimension and alignment.
> Runtime approval is calm but time-bound in amber; the persistent proposal is
> low-pressure and has no countdown. Do not use a shared badge or active safety
> alert in this example.

Output: `assets/control-view-desktop-v2.png`

## View switcher desktop

Reference: `prototypes/household-spatial-prototype/qa/implementation-home-1440x1024.png`

> Preserve the Life View and open a Host-owned anchored popover titled “选择视图”.
> Show “生活视图”, “控制视图”, and a third-party “能源看板”, each with preview,
> purpose, publisher, and availability. Keep “切换到控制视图”, “管理布局”, and
> “设为这台设备的默认视图” separate. Explain that switching does not interrupt
> Agent answers or device actions. Use the existing calm material and spacing;
> avoid a centered modal, decorative glass, gradients, or unrelated redesign.

Output: `assets/view-switcher-desktop.png`

## Voice listening mobile

Reference: `prototypes/household-spatial-prototype/qa/implementation-home-mobile-390x844.png`

> Preserve the mobile Life View and present an active, bottom-anchored voice
> surface with one restrained cobalt breathing form, live editable transcript,
> “正在听”, “停止”, and “改用文字”. Show the current room and Music Assistant
> connection as context, state that audio is used only for the current turn, and
> do not imply playback has executed. Keep the surface interruptible and provide
> equivalent visible feedback for reduced-motion users.

Output: `assets/voice-listening-mobile.png`

## Mobile processing page V3 - independent lifecycles and badges

Reference/edit target:
`prototypes/household-spatial-prototype/qa/implementation-home-mobile-390x844.png`

> Preserve the mobile hob-agent shell and replace the home content with a
> Host-owned processing page. Put “等待你放行” first with its own amber `1`,
> administrator label, `01:42` fail-closed countdown, one-time “拒绝 / 放行”,
> and the low-key summary “昨晚 1 项放行已过期，未执行”. Below it put
> “给家的建议” with a separate blue `4 / 5` capacity badge. The snoozed
> curtain proposal must say “已稍后至明天 · 仍占 1 个建议位”. The bottom
> navigation entry is “处理” with no aggregate red dot or number. Preserve
> the existing calm off-white surfaces, cobalt accent, system typography,
> spacing, borders and 44px touch targets. Never show one shared “待确认”
> count or let proposal rejection and runtime rejection look interchangeable.

Output: `assets/mobile-processing-two-lifecycles-v3.png`
