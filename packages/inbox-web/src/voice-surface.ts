export const VOICE_SURFACE_STATES = Object.freeze([
  "idle", "requesting_permission", "permission_denied", "listening", "no_input", "partial_transcript",
  "transcribing", "thinking", "presenting_choice", "awaiting_confirmation", "acting", "verifying",
  "speaking", "cancelled", "failed", "indeterminate", "text_mode",
] as const);

export type VoiceSurfaceState = typeof VOICE_SURFACE_STATES[number];

export interface VoiceSurfaceIntent {
  readonly room?: string;
  readonly player?: string;
  readonly selection?: string;
  readonly queue?: string;
  readonly volume?: string;
}

export interface VoiceSurfaceRenderOptions {
  readonly transcript?: string;
  readonly transcriptKind?: "partial" | "final";
  readonly intent?: VoiceSurfaceIntent;
}

interface StateCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly status: string;
  readonly detail: string;
  readonly recovery: { readonly href: string; readonly label: string };
}

const STATE_COPY: Readonly<Record<VoiceSurfaceState, StateCopy>> = Object.freeze({
  idle: { eyebrow: "语音助手", heading: "想说的时候，我在这里", status: "等待开始", detail: "点击开始后，浏览器会请求本次麦克风权限；语音只服务当前请求。", recovery: { href: "/settings", label: "查看语音设置" } },
  requesting_permission: { eyebrow: "麦克风权限", heading: "允许这台设备听取本次请求", status: "等待浏览器授权", detail: "麦克风只服务当前对话，结束后立即停止采集。", recovery: { href: "/conversation", label: "改用文字" } },
  permission_denied: { eyebrow: "麦克风权限", heading: "在浏览器设置中打开麦克风权限", status: "语音等待授权", detail: "权限开启后可以回到这里继续；文字对话现在就能使用。", recovery: { href: "/conversation", label: "改用文字" } },
  listening: { eyebrow: "正在听", heading: "说出你想让家里做的事", status: "麦克风正在聆听", detail: "一句话说明房间、内容和动作即可。", recovery: { href: "/conversation", label: "改用文字" } },
  no_input: { eyebrow: "这次很安静", heading: "刚才没有听到清楚的内容", status: "等待下一步", detail: "你可以再试一次，也可以直接输入文字。", recovery: { href: "/voice", label: "再试一次" } },
  partial_transcript: { eyebrow: "正在听", heading: "继续说就好", status: "继续说就好", detail: "已经听到一部分内容，正在等待完整请求。", recovery: { href: "/conversation", label: "改用文字" } },
  transcribing: { eyebrow: "整理语音", heading: "正在确认刚才听到的内容", status: "转成文字", detail: "完成后会先展示理解结果。", recovery: { href: "/conversation", label: "改用文字" } },
  thinking: { eyebrow: "理解请求", heading: "正在查看房间、音乐和现有安排", status: "整理下一步", detail: "结果会区分已确认事实、未知信息和建议。", recovery: { href: "/conversation", label: "改用文字" } },
  presenting_choice: { eyebrow: "需要你选择", heading: "请选择一个结果", status: "等待选择", detail: "对话会展示真实候选项，并保留你的选择。", recovery: { href: "/conversation", label: "改用文字" } },
  awaiting_confirmation: { eyebrow: "等待确认", heading: "等待你确认这项动作", status: "等待确认", detail: "确认卡会展示真实目标、效果和时限。", recovery: { href: "/review-center", label: "查看并确认" } },
  acting: { eyebrow: "正在执行", heading: "正在执行已确认的动作", status: "动作进行中", detail: "Hub 正在处理这项已确认请求。", recovery: { href: "/conversation", label: "改用文字" } },
  verifying: { eyebrow: "确认结果", heading: "正在确认动作结果", status: "验证结果", detail: "只有读回真实状态后，界面才会报告完成。", recovery: { href: "/conversation", label: "改用文字" } },
  speaking: { eyebrow: "已完成", heading: "已收到真实结果", status: "正在播报", detail: "结果也会保留在活动记录中。", recovery: { href: "/conversation", label: "改用文字" } },
  cancelled: { eyebrow: "已停止", heading: "这次请求已经取消", status: "家庭状态保持原样", detail: "可以随时发起新的请求。", recovery: { href: "/conversation", label: "改用文字" } },
  failed: { eyebrow: "动作未完成", heading: "家庭连接已经返回失败", status: "等待重试", detail: "当前状态已经保留，可以在连接恢复后再次尝试。", recovery: { href: "/conversation", label: "改用文字" } },
  indeterminate: { eyebrow: "结果待确认", heading: "正在重新确认播放器状态", status: "保持诚实等待", detail: "确认结果前，界面会持续显示真实的不确定状态。", recovery: { href: "/conversation", label: "改用文字" } },
  text_mode: { eyebrow: "文字对话", heading: "输入文字，继续这次请求", status: "已改用文字", detail: "当前浏览器无法使用 Web Speech API；这次请求可以安全地继续用文字。", recovery: { href: "/conversation", label: "打开文字对话" } },
});

/**
 * Same-origin, dependency-free browser adapter for the bounded push-to-talk
 * seam. It deliberately uses the browser Web Speech API only. A final,
 * bounded transcript is posted to the canonical conversation form; there is
 * no direct media/device call and no alternate authority path in this code.
 */
export const VOICE_INTERACTION_JS = String.raw`const voiceSpeechConstructor = () => window.SpeechRecognition || window.webkitSpeechRecognition;
for (const voiceRoot of document.querySelectorAll("[data-voice-surface]")) {
  if (!(voiceRoot instanceof HTMLElement)) continue;
  const eyebrowNode = voiceRoot.querySelector("[data-voice-eyebrow]");
  const headingNode = voiceRoot.querySelector("[data-voice-heading]");
  const statusNode = voiceRoot.querySelector("[data-voice-status]");
  const detailNode = voiceRoot.querySelector("[data-voice-detail]");
  const transcriptNode = voiceRoot.querySelector("[data-voice-transcript]");
  const intentTranscriptNode = voiceRoot.querySelector("[data-voice-intent-transcript]");
  const startButton = voiceRoot.querySelector("[data-voice-start]");
  const stopButton = voiceRoot.querySelector("[data-voice-stop]");
  const submitButton = voiceRoot.querySelector("[data-voice-submit]");
  const restartButton = voiceRoot.querySelector("[data-voice-restart]");
  const recoveryNode = voiceRoot.querySelector("[data-voice-recovery]");
  const fallbackNode = voiceRoot.querySelector("[data-voice-fallback]");
  const transcriptInput = voiceRoot.querySelector("[data-voice-transcript-input]");
  const submitForm = voiceRoot.querySelector("[data-voice-submit-form]");
  const canonicalConversationAction = "/conversation";
  const configuredSubmitAction = voiceRoot.getAttribute("data-voice-submit-action");
  const failureLimit = Math.max(1, Number(voiceRoot.getAttribute("data-voice-failure-limit") || "3"));
  const maxTranscriptLength = 2000;
  let state = voiceRoot.getAttribute("data-voice-state") || "idle";
  let failureCount = 0;
  let finalTranscript = "";
  let recognition;
  let stoppedByHousehold = false;

  const copy = {
    idle: ["等待开始", "点击开始后，浏览器会请求本次麦克风权限；语音只服务当前请求。"],
    requesting_permission: ["等待浏览器授权", "允许后才会开始聆听；你可以随时停止。"],
    permission_denied: ["语音等待授权", "麦克风权限没有打开。请在浏览器设置中允许，或直接改用文字。"],
    listening: ["麦克风正在聆听", "说出房间、内容和动作；说完后会先展示完整转写。"],
    partial_transcript: ["继续说就好", "已经听到一部分内容，完整请求只会在说完后进入对话。"],
    no_input: ["等待下一步", "可以再试一次，也可以直接输入文字。"],
    transcribing: ["转写已完成", "请确认这句话，再把它交给文字对话。"],
    thinking: ["已交给对话", "家里的处理会沿用现有对话、Hub 策略和确认流程。"],
    cancelled: ["已停止", "这次请求没有提交，家庭状态保持原样。"],
    failed: ["识别失败", "已经连续三次没有得到可用转写。先用文字继续，语音会暂时停下来。"],
    text_mode: ["已改用文字", "当前浏览器无法使用 Web Speech API；这次请求可以安全地继续用文字。"]
  };
  const eyebrow = {
    idle: "语音助手",
    requesting_permission: "麦克风权限",
    permission_denied: "麦克风权限",
    listening: "正在听",
    partial_transcript: "正在听",
    no_input: "这次很安静",
    transcribing: "整理语音",
    thinking: "理解请求",
    cancelled: "已停止",
    failed: "识别失败",
    text_mode: "文字对话"
  };
  const heading = {
    idle: "想说的时候，我在这里",
    requesting_permission: "允许这台设备听取本次请求",
    permission_denied: "在浏览器设置中打开麦克风权限",
    listening: "说出你想让家里做的事",
    partial_transcript: "继续说就好",
    no_input: "刚才没有听到清楚的内容",
    transcribing: "确认刚才听到的内容",
    thinking: "已交给文字对话",
    cancelled: "这次请求已经取消",
    failed: "连续三次没有识别成功",
    text_mode: "输入文字，继续这次请求"
  };
  const recovery = {
    idle: ["/settings", "查看语音设置"],
    requesting_permission: ["/conversation", "改用文字"],
    permission_denied: ["/conversation", "改用文字"],
    listening: ["/conversation", "改用文字"],
    partial_transcript: ["/conversation", "改用文字"],
    no_input: ["/voice", "再试一次"],
    transcribing: ["/conversation", "改用文字"],
    thinking: ["/conversation", "查看对话"],
    cancelled: ["/conversation", "改用文字"],
    failed: ["/conversation", "改用文字"],
    text_mode: ["/conversation", "打开文字对话"]
  };

  const setText = (node, value) => {
    if (node instanceof HTMLElement && typeof value === "string") node.textContent = value;
  };
  const setState = (next, detail) => {
    state = next;
    voiceRoot.dataset.voiceState = next;
    const stateCopy = copy[next] || copy.idle;
    if (eyebrowNode instanceof HTMLElement && eyebrow[next]) eyebrowNode.textContent = eyebrow[next];
    if (headingNode instanceof HTMLElement && heading[next]) headingNode.textContent = heading[next];
    setText(statusNode, stateCopy[0]);
    setText(detailNode, detail || stateCopy[1]);
    const recoveryCopy = recovery[next] || recovery.idle;
    if (recoveryNode instanceof HTMLAnchorElement) {
      recoveryNode.href = recoveryCopy[0];
      recoveryNode.textContent = recoveryCopy[1];
    }
    voiceRoot.setAttribute("data-voice-failure-count", String(failureCount));
    if (fallbackNode instanceof HTMLElement) fallbackNode.hidden = next !== "text_mode" && next !== "permission_denied" && next !== "failed";
    if (startButton instanceof HTMLButtonElement) startButton.hidden = !(next === "idle" || next === "permission_denied");
    if (stopButton instanceof HTMLButtonElement) stopButton.hidden = !(next === "requesting_permission" || next === "listening" || next === "partial_transcript");
    if (restartButton instanceof HTMLButtonElement) restartButton.hidden = next !== "no_input";
    if (submitButton instanceof HTMLButtonElement) submitButton.hidden = !(next === "transcribing" && finalTranscript.length > 0);
  };
  const normalize = (value) => typeof value === "string" ? value.trim().slice(0, maxTranscriptLength) : "";
  const showTranscript = (value, partial) => {
    const text = normalize(value);
    const display = text || (partial ? "正在等待完整请求……" : "还没有转写");
    setText(transcriptNode, display);
    setText(intentTranscriptNode, text ? display : "还没有转写");
    if (transcriptNode instanceof HTMLElement) transcriptNode.dataset.voiceTranscriptKind = partial ? "partial" : "final";
    if (intentTranscriptNode instanceof HTMLElement) intentTranscriptNode.dataset.voiceTranscriptKind = partial ? "partial" : "final";
  };
  const failAttempt = (message) => {
    failureCount = Math.min(failureLimit, failureCount + 1);
    finalTranscript = "";
    showTranscript("", false);
    if (failureCount >= failureLimit) {
      let resting = false;
      try {
        const lastTriple = Number(window.sessionStorage.getItem("hob-voice-last-triple") || "0");
        resting = Date.now() - lastTriple < 600000;
        window.sessionStorage.setItem("hob-voice-last-triple", String(Date.now()));
      } catch {}
      if (resting) setState("failed", "10 分钟内又连续三次没识别成功，语音先休息一会儿 —— 先用文字继续，重新开始不会清零。");
      else setState("failed", "连续三次没有识别成功，先用文字继续。");
    }
    else setState("no_input", message || (failureCount === 1 ? "第 1 次没有听清，可以说得更短一些。" : "第 2 次还是没有听清，试试和当前空间相关的说法。"));
  };
  const stopRecognition = () => {
    stoppedByHousehold = true;
    try { recognition?.abort(); } catch { /* browser cleanup is best effort */ }
    recognition = undefined;
  };
  const startRecognition = () => {
    const Constructor = voiceSpeechConstructor();
    if (typeof Constructor !== "function") {
      setState("text_mode", "当前浏览器没有 Web Speech API，请改用文字对话。");
      return;
    }
    try { recognition?.abort(); } catch { /* a previous session may already be closed */ }
    recognition = undefined;
    stoppedByHousehold = false;
    finalTranscript = "";
    showTranscript("", false);
    setState("requesting_permission");
    try {
      const nextRecognition = new Constructor();
      recognition = nextRecognition;
      nextRecognition.lang = voiceRoot.getAttribute("data-voice-language") || "zh-CN";
      nextRecognition.interimResults = true;
      nextRecognition.continuous = false;
      nextRecognition.maxAlternatives = 1;
      nextRecognition.onstart = () => setState("listening");
      nextRecognition.onresult = (event) => {
        if (recognition !== nextRecognition) return;
        let partial = "";
        let final = "";
        const resultIndex = Number.isInteger(event?.resultIndex) ? event.resultIndex : 0;
        for (let index = resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const value = normalize(result?.[0]?.transcript);
          if (!value) continue;
          if (result.isFinal) final += value; else partial += value;
        }
        if (partial && !final) {
          showTranscript(partial, true);
          setState("partial_transcript");
        }
        const completed = normalize(final);
        if (completed) {
          finalTranscript = completed;
          showTranscript(completed, false);
          setState("transcribing");
        }
      };
      nextRecognition.onerror = (event) => {
        if (recognition !== nextRecognition) return;
        const code = typeof event?.error === "string" ? event.error : "";
        if (code === "not-allowed" || code === "permission-denied") {
          finalTranscript = "";
          setState("permission_denied");
        } else if (code === "service-not-allowed" || code === "speech-unavailable") {
          setState("text_mode", "浏览器的语音服务不可用，请改用文字对话。");
        } else if (code !== "aborted" && !stoppedByHousehold) {
          failAttempt(code === "no-speech" ? undefined : "这次语音没有完成，可以再试一次。");
        }
      };
      nextRecognition.onend = () => {
        if (recognition !== nextRecognition) return;
        recognition = undefined;
        if (!stoppedByHousehold && !finalTranscript && (state === "listening" || state === "partial_transcript")) failAttempt();
      };
      nextRecognition.start();
    } catch (error) {
      if (error && typeof error === "object" && "name" in error && error.name === "NotAllowedError") setState("permission_denied");
      else setState("text_mode", "浏览器没有开始语音服务，请改用文字对话。");
    }
  };

  startButton?.addEventListener("click", startRecognition);
  restartButton?.addEventListener("click", startRecognition);
  stopButton?.addEventListener("click", () => {
    stopRecognition();
    finalTranscript = "";
    showTranscript("", false);
    setState("cancelled");
  });
  submitButton?.addEventListener("click", () => {
    const text = normalize(finalTranscript);
    if (!text || !(transcriptInput instanceof HTMLInputElement) || !(submitForm instanceof HTMLFormElement)) return;
    transcriptInput.value = text;
    setState("thinking");
    if (typeof submitForm.requestSubmit === "function") submitForm.requestSubmit();
  });

  if (configuredSubmitAction !== canonicalConversationAction) setState("text_mode", "这次语音无法安全交给对话，请改用文字对话。");
  else if (typeof voiceSpeechConstructor() !== "function") setState("text_mode", "当前浏览器没有 Web Speech API，请改用文字对话。");
  else if (copy[state]) setState(state);
}`;

export function renderVoiceSurface(requestedState = "idle", options: VoiceSurfaceRenderOptions = {}): string | undefined {
  if (!isVoiceSurfaceState(requestedState)) return undefined;
  const copy = STATE_COPY[requestedState];
  const safeTranscript = normalizeSurfaceText(options.transcript);
  const transcriptKind = options.transcriptKind === "partial" ? "partial" : "final";
  const initialTranscript = safeTranscript ? escapeHtml(safeTranscript) : "还没有转写";
  const initialTranscriptKind = safeTranscript ? transcriptKind : "empty";
  const intentMarkup = renderVoiceIntent(safeTranscript, transcriptKind, options.intent);
  const guideMarkup = requestedState === "idle" && !intentMarkup
    ? `<section class="product-card product-voice-guide" aria-label="语音使用方法"><p class="product-kicker">怎么开始</p><p>点击“开始聆听”，允许本次麦克风权限，然后说出房间、内容和动作。</p></section>`
    : "";
  return `<section class="product-voice" data-voice-surface data-voice-state="${requestedState}" data-voice-failure-limit="3" data-voice-submit-action="/conversation" data-voice-language="zh-CN" aria-labelledby="voice-heading">
    <header class="product-page-header product-voice-header"><div><p class="product-kicker" data-voice-eyebrow>${copy.eyebrow}</p><h1 id="voice-heading" data-voice-heading>${copy.heading}</h1></div><a class="product-view-switcher" data-voice-text-exit href="/conversation">改用文字</a></header>
    <section class="product-card product-voice-stage" aria-describedby="voice-detail"><span class="product-voice-indicator" data-voice-indicator aria-hidden="true"></span><p class="product-voice-status" data-voice-status role="status" aria-live="polite">${copy.status}</p><p class="product-muted" id="voice-detail" data-voice-detail>${copy.detail}</p><p class="product-voice-transcript" data-voice-transcript data-voice-transcript-kind="${initialTranscriptKind}" aria-live="polite" aria-atomic="true">${initialTranscript}</p><div class="product-card-actions"><button class="product-primary-action" type="button" data-voice-start>开始聆听</button><button class="product-secondary-action" type="button" data-voice-stop hidden>停止</button><button class="product-primary-action" type="button" data-voice-submit hidden>继续对话</button><button class="product-secondary-action" type="button" data-voice-restart hidden>再试一次</button><a class="product-secondary-action" data-voice-recovery href="${copy.recovery.href}">${copy.recovery.label}</a></div><p class="product-voice-fallback" data-voice-fallback hidden>语音服务不可用或权限未打开。文字对话仍然可用。</p><p class="product-voice-privacy">不保存音频；说出的动作照常写入活动记录。动画只表示“正在听”，不表示“正在执行”。</p></section>
    ${guideMarkup}
    ${intentMarkup}
    <form class="product-voice-submit-form" data-voice-submit-form method="post" action="/conversation" hidden><input type="hidden" name="question" data-voice-transcript-input></form>
    <noscript><p class="product-card product-voice-fallback">浏览器未启用脚本，无法使用语音。请改用文字对话。</p><a class="product-primary-action" href="/conversation">改用文字</a></noscript>
  </section>`;
}

function renderVoiceIntent(transcript: string, transcriptKind: "partial" | "final", intent?: VoiceSurfaceIntent): string {
  const fields = [
    ["房间", normalizeSurfaceText(intent?.room)],
    ["播放器", normalizeSurfaceText(intent?.player)],
    ["选择", normalizeSurfaceText(intent?.selection)],
    ["队列", normalizeSurfaceText(intent?.queue)],
    ["音量", normalizeSurfaceText(intent?.volume)],
  ] as Array<[string, string]>;
  const visibleFields = fields.filter((entry) => entry[1].length > 0);
  if (!transcript && visibleFields.length === 0) return "";

  const transcriptMarkup = transcript
    ? `<blockquote lang="zh-CN" data-voice-intent-transcript data-voice-transcript-kind="${transcriptKind}">${escapeHtml(transcript)}</blockquote>`
    : "";
  const fieldsMarkup = visibleFields.length > 0
    ? `<dl class="product-side-list">${visibleFields.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`
    : "";
  return `<section class="product-card product-voice-intent" data-voice-intent-source="real" aria-label="当前理解"><p class="product-kicker">当前理解</p>${transcriptMarkup}${fieldsMarkup}<p class="product-muted">语音转写只会进入现有对话；媒体或高影响动作仍由 Hub 负责确认和执行。</p></section>`;
}

function normalizeSurfaceText(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 2_000) : "";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isVoiceSurfaceState(value: string): value is VoiceSurfaceState {
  return (VOICE_SURFACE_STATES as readonly string[]).includes(value);
}
