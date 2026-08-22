# V4 design QA

Status: release verification passed
Source: `HobAgentUI设计稿评审包v4.zip`
Viewports: 390 × 844 and 1440 × 900

This record evaluates the production `packages/inbox-web` Host Shell. The V4
PNG files are the visual source. Product state comes from the real Hub-owned
projections; a disconnected or empty home renders an explicit empty state
instead of sample household facts.

## Comparison history

| Surface | Source state | Product state | Result |
| --- | --- | --- | --- |
| Home | `01首页-正常.png`, `01首页-失联.png`, `10Web-总览.png` | realistic connected household plus explicit quiet/disconnected projections | Responsive space cards, status, two review summaries, energy and the canonical composer follow the source hierarchy. |
| Review center | `04处理中心-两区块.png`, `04提案精读-两次点头.png`, `04暂缓-选时间.png`, `10Web-处理中心.png` | live TTL confirmation plus two-slot proposal projection | Two lifecycles, headings, expiry language, capacity, consent steps, snooze choices and badges stay independent. |
| Control | `03批量-逐项收场.png`, `03直接控制-撤销与结果未知.png`, `09控制视图-墙面屏平板.png` | mixed direct/confirmation/administrator targets | Per-target classification is visible before submission; selection updates the policy summary and result rows preserve partial outcomes. |
| Onboarding | all eight `07首次设置` screens | fresh durable step 1 plus renderer/HTTP states for steps 2–8 | Mobile presentation focuses one checkpoint, retains the assistant voice and carries each effect through the Hub coordinator. |
| Conversation and voice | `02对话-*`, `02语音-*`, `10Web-对话.png` | idle, streaming, completion, correction and Web Speech states | Text and voice share the same conversation destination; progress, recovery and correction remain visible. |

## Browser evidence

- All canonical destinations render through one authenticated Host Shell:
  `/home`, `/conversation`, `/review-center`, `/activity`, `/control`,
  `/settings`, `/onboarding`, and `/voice`.
- Every checked mobile destination has one `main` landmark, the expected heading
  and zero horizontal overflow at 390 × 844.
- Runtime confirmation TTL changed from 42 to 41 seconds during the live check.
- Batch submission started disabled; selecting one direct target enabled it and
  updated the preview to total 1, direct 1, confirmation 0, administrator 0.
- The desktop shell exposes the sidebar and hides mobile navigation at
  1440 × 900. The document has zero horizontal overflow.
- The browser console contains zero warning or error entries across the checked
  routes.

## Root-cause corrections

1. `productDocument` now supplies document metadata and assets only. The Host
   Shell is the sole owner of navigation, skip links, safety and product chrome.
2. Mobile overview uses its page heading as the single household identity.
3. The common Home composer remains a single row and stays immediately above
   mobile navigation.
4. Onboarding uses a focused setup surface. Household navigation returns after
   setup.

## Release gate

The V4 gate passed after Web voice, onboarding effects, governed media and batch
actions entered the canonical runtime. The final release run contains 1,184
passing tests plus successful type, instruction-sync, diff and secret checks.
