export const VOICE_SURFACE_STATES = Object.freeze([
  "idle",
  "requesting_permission",
  "permission_denied",
  "listening",
  "no_input",
  "partial_transcript",
  "transcribing",
  "thinking",
  "presenting_choice",
  "awaiting_confirmation",
  "acting",
  "verifying",
  "speaking",
  "playback_failed",
  "cancelled",
  "failed",
  "indeterminate",
  "model_unavailable",
  "text_mode",
] as const);

export type VoiceSurfaceState = (typeof VOICE_SURFACE_STATES)[number];
export interface VoiceSurfaceIntent {
  readonly room?: string;
  readonly player?: string;
  readonly selection?: string;
  readonly queue?: string;
  readonly volume?: string;
}
export type PrivateVoiceAvailability =
  | { readonly status: "active" }
  | { readonly status: "recovering" | "retryable" | "unavailable" };
export interface VoiceSurfaceRenderOptions {
  readonly transcript?: string;
  readonly transcriptKind?: "partial" | "final";
  readonly intent?: VoiceSurfaceIntent;
  readonly privateVoice?: PrivateVoiceAvailability;
  readonly notice?: "recovered" | "unavailable";
}

interface StateCopy {
  readonly eyebrow: string;
  readonly heading: string;
  readonly status: string;
  readonly detail: string;
  readonly recovery: { readonly href: string; readonly label: string };
}
const STATE_COPY: Readonly<Record<VoiceSurfaceState, StateCopy>> =
  Object.freeze({
    idle: {
      eyebrow: "语音助手",
      heading: "想说的时候，我在这里",
      status: "等待开始",
      detail: "开始后只会采集这一次要说的话。",
      recovery: { href: "/settings", label: "查看语音设置" },
    },
    requesting_permission: {
      eyebrow: "麦克风权限",
      heading: "允许这台设备听取本次请求",
      status: "等待浏览器授权",
      detail: "麦克风只服务当前对话，结束后立即停止采集。",
      recovery: { href: "/conversation", label: "改用文字" },
    },
    permission_denied: {
      eyebrow: "麦克风权限",
      heading: "在浏览器设置中打开麦克风权限",
      status: "语音等待授权",
      detail: "权限开启后可以回到这里继续；文字对话现在就能使用。",
      recovery: { href: "/conversation", label: "改用文字" },
    },
    listening: {
      eyebrow: "正在听",
      heading: "说出你想问家里的事",
      status: "麦克风正在聆听",
      detail: "一句话说明你想了解的家庭情况；最多 15 秒。",
      recovery: { href: "/conversation", label: "改用文字" },
    },
    no_input: {
      eyebrow: "这次很安静",
      heading: "刚才没有听到清楚的内容",
      status: "等待下一步",
      detail: "没有听清。再说一次就好。",
      recovery: { href: "/voice", label: "再试一次" },
    },
    partial_transcript: {
      eyebrow: "正在听",
      heading: "继续说就好",
      status: "继续说就好",
      detail: "正在等待完整请求。",
      recovery: { href: "/conversation", label: "改用文字" },
    },
    transcribing: {
      eyebrow: "整理语音",
      heading: "正在确认刚才听到的内容",
      status: "转成文字",
      detail: "录音已完成，正在转成文字；完成后显示全文。原始录音只用于这次转写，请求结束后从内存丢弃。",
      recovery: { href: "/conversation", label: "改用文字" },
    },
    thinking: {
      eyebrow: "理解请求",
      heading: "正在查看家里的情况",
      status: "整理下一步",
      detail: "处理进度会显示在这里；你可以随时取消等待。",
      recovery: { href: "/conversation", label: "改用文字" },
    },
    presenting_choice: {
      eyebrow: "需要你选择",
      heading: "请选择一个结果",
      status: "等待选择",
      detail: "对话会展示真实候选项，并保留你的选择。",
      recovery: { href: "/conversation", label: "改用文字" },
    },
    awaiting_confirmation: {
      eyebrow: "等待确认",
      heading: "等待你确认这项动作",
      status: "等待确认",
      detail: "确认卡会展示真实目标、效果和时限。",
      recovery: { href: "/review-center", label: "查看并确认" },
    },
    acting: {
      eyebrow: "正在执行",
      heading: "正在执行已确认的动作",
      status: "动作进行中",
      detail: "这项已确认的动作正在进行。完成后会显示结果。",
      recovery: { href: "/conversation", label: "改用文字" },
    },
    verifying: {
      eyebrow: "确认结果",
      heading: "正在确认动作结果",
      status: "确认结果",
      detail: "正在检查动作是否完成。确认后会显示结果。",
      recovery: { href: "/conversation", label: "改用文字" },
    },
    speaking: {
      eyebrow: "已完成",
      heading: "已收到真实结果",
      status: "正在播报",
      detail: "结果也会保留在活动记录中。",
      recovery: { href: "/conversation", label: "改用文字" },
    },
    playback_failed: {
      eyebrow: "回答已完成",
      heading: "文字回答已经准备好",
      status: "播报暂时不可用",
      detail: "文字回答已经保留。可以重新播报，或直接查看文字回答。",
      recovery: { href: "/conversation", label: "查看文字回答" },
    },
    cancelled: {
      eyebrow: "已停止",
      heading: "这次请求已经取消",
      status: "对话已经停止",
      detail: "这次对话已停止。已经开始的动作会继续在活动记录中显示结果。",
      recovery: { href: "/conversation", label: "改用文字" },
    },
    failed: {
      eyebrow: "语音暂时没有完成",
      heading: "这次没有得到可用结果",
      status: "等待重试",
      detail: "可以再试一次，或直接用文字继续。",
      recovery: { href: "/conversation", label: "改用文字" },
    },
    indeterminate: {
      eyebrow: "结果待确认",
      heading: "正在确认实际状态",
      status: "结果尚未确认",
      detail: "结果确认前会如实显示为尚未确认。结果会显示在活动记录中。",
      recovery: { href: "/conversation", label: "改用文字" },
    },
    model_unavailable: {
      eyebrow: "家庭助手模型",
      heading: "模型连接正在恢复",
      status: "等待模型恢复",
      detail: "家庭助手模型正在恢复，本次语音尚未转写。请恢复模型后重试，或直接改用文字。",
      recovery: { href: "/settings#operational-model", label: "检查模型连接" },
    },
    text_mode: {
      eyebrow: "文字对话",
      heading: "用文字继续和家沟通",
      status: "文字对话可用",
      detail: "私人语音暂时不可用。文字对话现在就能继续。",
      recovery: { href: "/conversation", label: "打开文字对话" },
    },
  });

/** Same-origin bounded private-voice adapter. It never invokes device or media control. */
export const VOICE_INTERACTION_JS = String.raw`for (const voiceRoot of document.querySelectorAll("[data-voice-surface]")) {
  if (!(voiceRoot instanceof HTMLElement)) continue;
  const eyebrowNode = voiceRoot.querySelector("[data-voice-eyebrow]");
  const headingNode = voiceRoot.querySelector("[data-voice-heading]");
  const statusNode = voiceRoot.querySelector("[data-voice-status]");
  const detailNode = voiceRoot.querySelector("[data-voice-detail]");
  const transcriptNode = voiceRoot.querySelector("[data-voice-transcript]");
  const captureProgressNode = voiceRoot.querySelector("[data-voice-capture-progress]");
  const startButton = voiceRoot.querySelector("[data-voice-start]");
  const stopButton = voiceRoot.querySelector("[data-voice-stop]");
  const cancelButton = voiceRoot.querySelector("[data-voice-cancel]");
  const backgroundButton = voiceRoot.querySelector("[data-voice-background]");
  const restartButton = voiceRoot.querySelector("[data-voice-restart]");
  const speechStopButton = voiceRoot.querySelector("[data-voice-speech-stop]");
  const recoveryNode = voiceRoot.querySelector("[data-voice-recovery]");
  const textExitNode = voiceRoot.querySelector("[data-voice-text-exit]");
  const answerNode = voiceRoot.querySelector("[data-voice-answer]");
  const conversationNode = voiceRoot.querySelector("[data-voice-conversation]");
  const availability = voiceRoot.getAttribute("data-private-voice-status");
  const maxTurnMs = 15000;
  const longWaitMs = 10000;
  const maxPcmBytes = 5 * 1024 * 1024;
  let state = voiceRoot.getAttribute("data-voice-state") || "idle";
  let stream;
  let recorder;
  let audioContext;
  let processor;
  let source;
  let chunks = [];
  let pcmChunks = [];
  let pcmBytes = 0;
  let captureHasSound = false;
  let pcmRate = 0;
  let timer;
  let requestController;
  let eventStream;
  let audio;
  let audioUrl;
  let generation = 0;
  let activeLeaseId;
  let activeLeaseGeneration;
  let leaseController;
  let leaseGeneration;
  let disposed = false;
  let captureMode;
  let activeAdviceId;
  let answerText = "";
  let longWaitTimer;
  let longWait = false;
  let backgroundPending = false;
  let backgrounded = false;
  const noInputBackoffStorageKey = "hob.private-voice.no-input.v1";
  const noInputBackoffMs = 10 * 60 * 1000;
  let noInputBackoffTimer;
  let noInputAttempt = 0;
  const copy = {
    idle: ["等待开始", "开始后只会采集这一次要说的话。"],
    requesting_permission: [
      "等待浏览器授权",
      "允许后才会开始聆听；你可以随时停止。",
    ],
    permission_denied: [
      "语音等待授权",
      "麦克风权限没有打开。请在浏览器设置中允许，或直接改用文字。",
    ],
    listening: ["麦克风正在聆听", "说完按停止；最长 15 秒。"],
    no_input: [
      "等待下一步",
      "没有听清。再说一次就好。",
    ],
    transcribing: ["转成文字", "录音已完成，正在转成文字；完成后显示全文。"],
    thinking: ["正在处理", "正在查看家里的信息；你可以取消等待。"],
    speaking: ["正在播报", "可以停止播报，或直接再次说话。"],
    playback_failed: [
      "播报暂时不可用",
      "文字回答已经保留。可以重新播报，或直接查看文字回答。",
    ],
    cancelled: [
      "已停止",
      "这次对话已停止。已经开始的动作会继续在活动记录中显示结果。",
    ],
    failed: ["语音暂时没有完成", "可以再试一次，或直接改用文字。"],
    model_unavailable: ["等待模型恢复", "私人语音已经完成转写。请先检查家庭助手模型连接。"],
    text_mode: ["文字对话可用", "私人语音暂时不可用。文字对话现在就能继续。"],
  };
  const labels = {
    idle: ["语音助手", "想说的时候，我在这里"],
    requesting_permission: ["麦克风权限", "允许这台设备听取本次请求"],
    permission_denied: ["麦克风权限", "在浏览器设置中打开麦克风权限"],
    listening: ["正在听", "说出你想让家里做的事"],
    no_input: ["这次很安静", "刚才没有听到清楚的内容"],
    transcribing: ["整理语音", "正在确认刚才听到的内容"],
    thinking: ["理解请求", "正在查看家里的情况"],
    speaking: ["已完成", "已收到真实结果"],
    playback_failed: ["回答已完成", "文字回答已经准备好"],
    cancelled: ["已停止", "这次请求已经取消"],
    failed: ["语音暂时没有完成", "这次没有得到可用结果"],
    model_unavailable: ["家庭助手模型", "模型连接正在恢复"],
    text_mode: ["文字对话", "用文字继续和家沟通"],
  };
  const noInputStore = () => {
    try {
      return typeof sessionStorage !== "undefined" &&
        typeof sessionStorage.getItem === "function" &&
        typeof sessionStorage.setItem === "function" &&
        typeof sessionStorage.removeItem === "function"
        ? sessionStorage
        : undefined;
    } catch {
      return undefined;
    }
  };
  const readNoInputBackoff = () => {
    const store = noInputStore();
    if (!store) return undefined;
    try {
      const raw = store.getItem(noInputBackoffStorageKey);
      if (!raw) return { count: 0 };
      const value = JSON.parse(raw);
      if (!value || !Number.isInteger(value.count) || value.count < 0 || value.count > 3 ||
        (value.until !== undefined && (!Number.isSafeInteger(value.until) || value.until < 0))) {
        store.removeItem(noInputBackoffStorageKey);
        return { count: 0 };
      }
      if (typeof value.until === "number") {
        if (value.until > Date.now()) return { count: value.count, until: value.until };
        store.removeItem(noInputBackoffStorageKey);
        return { count: 0 };
      }
      return { count: value.count };
    } catch {
      return undefined;
    }
  };
  const clearNoInputBackoff = () => {
    if (noInputBackoffTimer !== undefined) {
      try { clearTimeout(noInputBackoffTimer); } catch {}
      noInputBackoffTimer = undefined;
    }
    noInputAttempt = 0;
    const store = noInputStore();
    try { store?.removeItem(noInputBackoffStorageKey); } catch {}
  };
  const backoffDetail = () => "连续三次没有听到内容，语音已暂停 10 分钟。你可以改用文字。";
  const noInputDetail = (record) => {
    if (record?.attempt === 1) return "没有听清。再说一次就好。";
    if (record?.attempt === 2) return "可以说‘客厅现在怎么样’，也可以改用文字。";
    if (record?.attempt === 3 && record.paused) return backoffDetail();
    if (record?.attempt === 3) return "这次仍然没有听清。可以再试一次，也可以改用文字。";
    return copy.no_input[1];
  };
  const scheduleNoInputRecovery = (until) => {
    try {
      const delay = until - Date.now();
      if (!Number.isSafeInteger(delay) || delay < 1 || delay > noInputBackoffMs) return false;
      if (noInputBackoffTimer !== undefined) clearTimeout(noInputBackoffTimer);
      const scheduledTimer = setTimeout(() => {
        noInputBackoffTimer = undefined;
        const backoff = readNoInputBackoff();
        if (backoff?.until !== undefined) return;
        if (!disposed && state === "no_input") setState("idle", "语音现在可以再次开始。", { href: "/conversation", label: "改用文字" });
      }, delay);
      if (scheduledTimer === undefined || scheduledTimer === null) return false;
      noInputBackoffTimer = scheduledTimer;
      return true;
    } catch {
      return false;
    }
  };
  const recordNoInput = () => {
    const store = noInputStore();
    const current = readNoInputBackoff();
    const count = Math.min((current?.count ?? noInputAttempt) + 1, 3);
    noInputAttempt = count;
    if (!store || !current) return { attempt: count, paused: false };
    try {
      if (count < 3) {
        store.setItem(noInputBackoffStorageKey, JSON.stringify({ count }));
        return { attempt: count, paused: false };
      }
      const until = Date.now() + noInputBackoffMs;
      store.setItem(noInputBackoffStorageKey, JSON.stringify({ count, until }));
      if (scheduleNoInputRecovery(until)) return { attempt: count, paused: true };
      clearNoInputBackoff();
      return { attempt: count, paused: false };
    } catch {
      return { attempt: count, paused: false };
    }
  };
  const setText = (node, value) => {
    if (node instanceof HTMLElement && typeof value === "string")
      node.textContent = value;
  };
  const setCaptureProgress = (stage) => {
    if (!(captureProgressNode instanceof HTMLElement)) return;
    if (stage === "recording") {
      setText(captureProgressNode, "正在录音；还没有收到声音。");
    } else if (stage === "recording_heard") {
      setText(captureProgressNode, "正在录音；已收到声音。");
    } else if (stage === "uploading") {
      setText(captureProgressNode, "录音已完成，正在转成文字；完成后显示全文。");
    } else {
      setText(captureProgressNode, "");
    }
    captureProgressNode.dataset.voiceCaptureStage = stage;
  };
  const markCaptureHeard = () => {
    if (captureHasSound) return;
    captureHasSound = true;
    setCaptureProgress("recording_heard");
  };
  const setState = (next, detail, recovery) => {
    state = next;
    voiceRoot.dataset.voiceState = next;
    const item = copy[next] || copy.idle;
    const title = labels[next] || labels.idle;
    setText(eyebrowNode, title[0]);
    setText(headingNode, title[1]);
    setText(statusNode, item[0]);
    setText(detailNode, detail || item[1]);
    if (recoveryNode instanceof HTMLAnchorElement) {
      recoveryNode.href = recovery?.href || "/conversation";
      recoveryNode.textContent = recovery?.label || "改用文字";
      recoveryNode.className =
        next === "text_mode"
          ? "product-primary-action"
          : "product-secondary-action";
      recoveryNode.hidden =
        next === "thinking" &&
        conversationNode instanceof HTMLAnchorElement &&
        !conversationNode.hidden;
    }
    if (textExitNode instanceof HTMLElement)
      textExitNode.hidden = next === "text_mode" || next === "model_unavailable";
    if (transcriptNode instanceof HTMLElement)
      transcriptNode.hidden =
        (next === "text_mode" || next === "model_unavailable") &&
        transcriptNode.dataset.voiceTranscriptKind === "empty";
    if (captureProgressNode instanceof HTMLElement)
      captureProgressNode.hidden = next !== "listening" && next !== "transcribing";
    if (startButton instanceof HTMLButtonElement)
      startButton.hidden =
        availability !== "active" ||
        !(
          next === "idle" ||
          next === "permission_denied" ||
          next === "no_input" ||
          next === "failed" ||
          next === "speaking"
        );
    const noInputBackoff = next === "no_input" ? readNoInputBackoff()?.until : undefined;
    if (startButton instanceof HTMLButtonElement)
      startButton.disabled = noInputBackoff !== undefined;
    if (stopButton instanceof HTMLButtonElement)
      stopButton.hidden =
        next !== "listening" && next !== "requesting_permission";
    if (stopButton instanceof HTMLButtonElement)
      stopButton.textContent =
        next === "requesting_permission" ? "取消" : "停止并转写";
    if (cancelButton instanceof HTMLButtonElement)
      cancelButton.hidden =
        (next !== "transcribing" && next !== "thinking") || backgrounded;
    if (backgroundButton instanceof HTMLButtonElement)
      backgroundButton.hidden =
        next !== "thinking" || !longWait || backgroundPending || backgrounded;
    if (restartButton instanceof HTMLButtonElement)
      restartButton.hidden = next !== "no_input" && next !== "failed" && next !== "playback_failed";
    if (restartButton instanceof HTMLButtonElement)
      restartButton.textContent = next === "playback_failed" ? "重新播报" : "再试一次";
    if (restartButton instanceof HTMLButtonElement)
      restartButton.disabled = noInputBackoff !== undefined;
    if (speechStopButton instanceof HTMLButtonElement)
      speechStopButton.hidden = next !== "speaking";
  };
  const showTranscript = (text) => {
    const value = typeof text === "string" ? text.trim().slice(0, 2000) : "";
    setText(transcriptNode, value || "还没有转写");
    if (transcriptNode instanceof HTMLElement)
      transcriptNode.dataset.voiceTranscriptKind = value ? "final" : "empty";
  };
  const showAnswer = (text, append = false) => {
    const next = typeof text === "string" ? text.trim().slice(0, 4000) : "";
    answerText = append ? (answerText + next).slice(0, 4000) : next;
    setText(answerNode, answerText);
    if (answerNode instanceof HTMLElement) answerNode.hidden = answerText.length === 0;
  };
  const showConversation = (adviceId) => {
    if (!(conversationNode instanceof HTMLAnchorElement)) return;
    conversationNode.href = "/conversation/" + encodeURIComponent(adviceId);
    conversationNode.hidden = false;
  };
  const stopTracks = () => {
    for (const track of stream?.getTracks?.() || []) track.stop();
    stream = undefined;
  };
  const discardAudio = () => {
    chunks = [];
    pcmChunks = [];
    pcmBytes = 0;
    captureHasSound = false;
    setCaptureProgress("empty");
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const stopPlayback = () => {
    try {
      audio?.pause();
    } catch {}
    if (audioUrl) {
      try {
        URL.revokeObjectURL(audioUrl);
      } catch {}
    }
    audio = undefined;
    audioUrl = undefined;
  };
  const closeEvents = (target = eventStream) => {
    try {
      target?.close();
    } catch {}
    if (eventStream === target) eventStream = undefined;
  };
  const clearLongWait = () => {
    if (longWaitTimer !== undefined) {
      try { clearTimeout(longWaitTimer); } catch {}
      longWaitTimer = undefined;
    }
    longWait = false;
    backgroundPending = false;
    backgrounded = false;
  };
  const scheduleLongWait = (turnGeneration) => {
    if (longWaitTimer !== undefined) {
      try { clearTimeout(longWaitTimer); } catch {}
      longWaitTimer = undefined;
    }
    try {
      const scheduledTimer = setTimeout(() => {
        longWaitTimer = undefined;
        if (
          generation !== turnGeneration ||
          state !== "thinking" ||
          typeof activeAdviceId !== "string" ||
          backgroundPending ||
          backgrounded
        ) return;
        longWait = true;
        setState("thinking", "仍在处理。你可以稍后处理，也可以取消等待。", {
          href: "/conversation/" + encodeURIComponent(activeAdviceId),
          label: "打开文字对话",
        });
      }, longWaitMs);
      if (scheduledTimer !== undefined && scheduledTimer !== null)
        longWaitTimer = scheduledTimer;
    } catch {}
  };
  const releaseLease = (leaseId = activeLeaseId, leaseOwnerGeneration = activeLeaseGeneration) => {
    if (typeof leaseId !== "string") return;
    if (activeLeaseId === leaseId && activeLeaseGeneration === leaseOwnerGeneration) {
      activeLeaseId = undefined;
      activeLeaseGeneration = undefined;
      captureMode = undefined;
    }
    void fetch("/voice/turns/" + encodeURIComponent(leaseId) + "/release", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
      keepalive: true,
    }).catch(() => undefined);
  };
  const cancelLeaseAcquisition = (ownerGeneration) => {
    if (leaseController === undefined || leaseGeneration !== ownerGeneration) return;
    try {
      leaseController.abort();
    } catch {}
    leaseController = undefined;
    leaseGeneration = undefined;
  };
  const stopCapture = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    try {
      recorder?.stop();
    } catch {}
    try {
      processor?.disconnect();
      source?.disconnect();
      audioContext?.close?.();
    } catch {}
    recorder = undefined;
    processor = undefined;
    source = undefined;
    audioContext = undefined;
    stopTracks();
  };
  const resetTurn = () => {
    const previousGeneration = generation;
    generation += 1;
    clearLongWait();
    cancelLeaseAcquisition(previousGeneration);
    activeAdviceId = undefined;
    showAnswer("");
    if (conversationNode instanceof HTMLAnchorElement) conversationNode.hidden = true;
    stopCapture();
    discardAudio();
    requestController?.abort();
    requestController = undefined;
    closeEvents();
    stopPlayback();
    releaseLease();
    return generation;
  };
  const backgroundTurn = async () => {
    const adviceId = activeAdviceId;
    if (
      !longWait ||
      backgroundPending ||
      backgrounded ||
      typeof adviceId !== "string"
    ) return;
    const backgroundGeneration = generation;
    backgroundPending = true;
    setState("thinking", "正在把这次请求转到后台。", {
      href: "/conversation/" + encodeURIComponent(adviceId),
      label: "打开文字对话",
    });
    try {
      const response = await fetch(
        "/conversation/" + encodeURIComponent(adviceId) + "/background",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "",
          redirect: "follow",
        },
      );
      if (
        generation !== backgroundGeneration ||
        activeAdviceId !== adviceId
      ) return;
      if (
        !response.ok ||
        response.redirected !== true ||
        redirectedPath(response) !== "/home"
      )
        throw new Error("background_unconfirmed");
      clearLongWait();
      backgrounded = true;
      closeEvents();
      requestController?.abort();
      requestController = undefined;
      stopPlayback();
      releaseLease();
      setState("thinking", "已转到后台。完成后会在文字对话中通知。", {
        href: "/conversation/" + encodeURIComponent(adviceId),
        label: "打开文字对话",
      });
    } catch {
      if (
        generation === backgroundGeneration &&
        activeAdviceId === adviceId
      ) {
        backgroundPending = false;
        longWait = true;
        setState("thinking", "暂时无法转到后台。你可以继续等待、取消等待，或打开文字对话。", {
          href: "/conversation/" + encodeURIComponent(adviceId),
          label: "打开文字对话",
        });
      }
    }
  };
  const cancelTurn = async () => {
    const adviceId = activeAdviceId;
    const cancelledGeneration = resetTurn();
    if (typeof adviceId !== "string") {
      setState("cancelled");
      return;
    }
    showConversation(adviceId);
    setState("thinking", "正在向家庭服务确认这次请求已经停止。", {
      href: "/conversation/" + encodeURIComponent(adviceId),
      label: "打开文字对话",
    });
    try {
      const response = await fetch(
        "/conversation/" + encodeURIComponent(adviceId) + "/stop",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "",
          redirect: "follow",
        },
      );
      if (generation !== cancelledGeneration) return;
      if (
        response.ok &&
        response.redirected === true &&
        redirectedPath(response) === "/conversation/" + encodeURIComponent(adviceId)
      ) {
        setState("cancelled");
        return;
      }
    } catch {}
    if (generation === cancelledGeneration)
      setState("thinking", "这次请求仍在继续处理。请在文字对话中查看进度。", {
        href: "/conversation/" + encodeURIComponent(adviceId),
        label: "打开文字对话",
      });
  };
  const responseJson = async (response) => {
    try {
      const value = await response.json();
      return value && typeof value === "object" ? value : undefined;
    } catch {
      return undefined;
    }
  };
  const redirectedPath = (response) => {
    if (typeof response?.url !== "string") return "";
    try {
      const base =
        typeof window !== "undefined" && typeof window.location?.href === "string"
          ? window.location.href
          : "/voice";
      return new URL(response.url, base).pathname;
    } catch {
      return "";
    }
  };
  const speak = async (adviceId, turnGeneration) => {
    if (generation !== turnGeneration) return;
    setState("speaking", "正在准备播报；你可以停止或直接再次说话。");
    const controller = new AbortController();
    requestController = controller;
    try {
      const response = await fetch(
        "/voice/turns/" + encodeURIComponent(activeLeaseId || "") + "/speech",
        { signal: controller.signal },
      );
      if (generation !== turnGeneration) return;
      if (!response.ok) throw new Error("speech_unavailable");
      const blob = await response.blob();
      if (generation !== turnGeneration) return;
      if (!blob.size) throw new Error("speech_empty");
      const nextAudioUrl = URL.createObjectURL(blob);
      const nextAudio = new Audio(nextAudioUrl);
      audioUrl = nextAudioUrl;
      audio = nextAudio;
      nextAudio.onended = () => {
        if (generation !== turnGeneration || audio !== nextAudio) return;
        stopPlayback();
        releaseLease();
        setState("idle", "播报结束。想继续时可以再说一句。");
      };
      nextAudio.onerror = () => {
        if (generation !== turnGeneration || audio !== nextAudio) return;
        stopPlayback();
        setState("playback_failed", "文字回答已经保留。可以重新播报，或直接查看文字回答。", {
          href: "/conversation/" + encodeURIComponent(adviceId),
          label: "查看文字回答",
        });
      };
      await nextAudio.play();
    } catch (error) {
      if (generation === turnGeneration && error?.name !== "AbortError")
        setState("playback_failed", "文字回答已经保留。可以重新播报，或直接查看文字回答。", {
          href: "/conversation/" + encodeURIComponent(adviceId),
          label: "查看文字回答",
        });
    } finally {
      if (generation === turnGeneration && requestController === controller)
        requestController = undefined;
    }
  };
  const beginEvents = (adviceId, turnGeneration) => {
    if (generation !== turnGeneration) return;
    closeEvents();
    if (
      typeof adviceId !== "string" ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(adviceId)
    ) {
      setState(
        "failed",
        "这次语音没有得到可继续的请求。请再试一次或改用文字。",
      );
      return;
    }
    activeAdviceId = adviceId;
    showConversation(adviceId);
    longWait = false;
    backgroundPending = false;
    backgrounded = false;
    setState("thinking");
    scheduleLongWait(turnGeneration);
    const nextEventStream = new EventSource(
      "/conversation/" + encodeURIComponent(adviceId) + "/events",
    );
    eventStream = nextEventStream;
    const stages = {
      inspecting_home: "正在查看家里的当前状态。",
      reading_inventory: "正在查看房间和设备。",
      checking_rules: "正在确认家里已有的安排。",
      evaluating_evidence: "正在核对相关记录。",
      composing_answer: "正在整理回答。",
    };
    for (const name of Object.keys(stages))
      nextEventStream.addEventListener(name, () => {
        if (generation === turnGeneration && eventStream === nextEventStream)
          setState("thinking", stages[name]);
      });
    nextEventStream.addEventListener("progress", () => {
      if (generation === turnGeneration && eventStream === nextEventStream)
        setState("thinking", "正在处理。");
    });
    const eventText = (event) => {
      try {
        const data = JSON.parse(event.data);
        return typeof data?.text === "string" ? data.text : "";
      } catch {
        return "";
      }
    };
    for (const name of ["delta", "answer_delta"])
      nextEventStream.addEventListener(name, (event) => {
        if (generation === turnGeneration && eventStream === nextEventStream)
          showAnswer(eventText(event), true);
      });
    nextEventStream.addEventListener("answer", (event) => {
      if (generation === turnGeneration && eventStream === nextEventStream)
        showAnswer(eventText(event));
    });
    nextEventStream.addEventListener("completed", () => {
      if (generation !== turnGeneration || eventStream !== nextEventStream) return;
      clearLongWait();
      closeEvents(nextEventStream);
      void speak(adviceId, turnGeneration);
    });
    nextEventStream.addEventListener("failed", () => {
      if (generation !== turnGeneration || eventStream !== nextEventStream) return;
      clearLongWait();
      closeEvents(nextEventStream);
      releaseLease();
      setState("failed", "这次处理没有完成。可以再试一次或改用文字。");
    });
    nextEventStream.addEventListener("cancelled", () => {
      if (generation !== turnGeneration || eventStream !== nextEventStream) return;
      clearLongWait();
      closeEvents(nextEventStream);
      releaseLease();
      setState("cancelled");
    });
    nextEventStream.addEventListener("error", () => {
      if (
        generation === turnGeneration &&
        eventStream === nextEventStream &&
        nextEventStream.readyState === EventSource.CONNECTING
      )
        setState("thinking", "连接正在恢复，处理会继续更新。");
    });
  };
  const upload = async (body, mimeType, format, turnGeneration) => {
    if (generation !== turnGeneration) return;
    if (!body || body.size === 0) {
      discardAudio();
      releaseLease();
      setState("no_input", noInputDetail(recordNoInput()));
      return;
    }
    setState("transcribing");
    setCaptureProgress("uploading");
    const controller = new AbortController();
    requestController = controller;
    const headers = {
      "Content-Type": mimeType,
      ...(format
        ? {
            "X-Audio-Rate": String(format.rate),
            "X-Audio-Width": "2",
            "X-Audio-Channels": "1",
          }
        : {}),
    };
    try {
      const leaseId = activeLeaseId;
      if (typeof leaseId !== "string") throw new Error("voice_lease_missing");
      const response = await fetch("/voice/turns/" + encodeURIComponent(leaseId) + "/transcribe", {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (generation !== turnGeneration) return;
      const result = await responseJson(response);
      if (generation !== turnGeneration) return;
      discardAudio();
      if (response.status === 429) {
        const retryAfter = Number(response.headers?.get?.("retry-after"));
        const seconds = Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60
          ? retryAfter
          : 1;
        setState("failed", "语音服务正在处理上一句，请在 " + seconds + " 秒后再试一次，或改用文字。");
        return;
      }
      if (result === undefined)
        throw new Error("asr_unavailable");
      if (
        result.status === "accepted" &&
        typeof result.adviceId === "string" &&
        typeof result.transcript === "string"
      ) {
        clearNoInputBackoff();
        showTranscript(result.transcript);
        beginEvents(result.adviceId, turnGeneration);
      } else if (
        result.status === "active" &&
        typeof result.adviceId === "string"
      )
        beginEvents(result.adviceId, turnGeneration);
      else if (result.status === "no_input") {
        releaseLease();
        setState("no_input", noInputDetail(recordNoInput()));
      } else if (result.status === "unavailable") {
        releaseLease();
        setState("text_mode", "私人语音暂时不可用；可以直接改用文字。");
      } else if (result.status === "model_unavailable") {
        releaseLease();
        setState("model_unavailable", "家庭助手模型正在恢复。请先检查模型连接。", {
          href: "/settings#operational-model",
          label: "检查模型连接",
        });
      } else if (result.status === "failed") {
        releaseLease();
        setState("failed");
      }
      else throw new Error("invalid_asr_response");
    } catch (error) {
      if (generation !== turnGeneration) return;
      discardAudio();
      releaseLease();
      if (error?.name !== "AbortError")
        setState("failed", "语音服务暂时没有完成。请再试一次或改用文字。");
    } finally {
      if (generation === turnGeneration && requestController === controller)
        requestController = undefined;
    }
  };
  const finishCapture = (turnGeneration = generation) => {
    if (generation !== turnGeneration) return;
    if (captureMode === "encoded_audio") {
      try {
        recorder?.stop();
      } catch {
        setState("failed");
      }
      return;
    }
    const pcm = new Uint8Array(pcmBytes);
    let offset = 0;
    for (const part of pcmChunks) {
      pcm.set(part, offset);
      offset += part.length;
    }
    stopCapture();
    void upload(new Blob([pcm], { type: "audio/l16" }), "audio/l16", {
      rate: pcmRate,
      width: 2,
      channels: 1,
    }, turnGeneration);
  };
  const beginLease = async (turnGeneration) => {
    const controller = new AbortController();
    leaseController = controller;
    leaseGeneration = turnGeneration;
    try {
      const response = await fetch("/voice/turns", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "",
        signal: controller.signal,
      });
      const result = await responseJson(response);
      const leased = response.ok && result?.status === "leased" &&
        typeof result.voiceTurnId === "string" &&
        /^[A-Za-z0-9_-]{16,128}$/.test(result.voiceTurnId) &&
        (result.captureMode === "encoded_audio" || result.captureMode === "pcm_s16le");
      const current = generation === turnGeneration &&
        leaseController === controller && !controller.signal.aborted;
      if (!current) {
        if (leased) releaseLease(result.voiceTurnId, turnGeneration);
        return undefined;
      }
      if (!leased) return undefined;
      activeLeaseId = result.voiceTurnId;
      activeLeaseGeneration = turnGeneration;
      captureMode = result.captureMode;
      return result;
    } finally {
      if (leaseController === controller) {
        leaseController = undefined;
        leaseGeneration = undefined;
      }
    }
  };
  const startCapture = async () => {
    if (disposed) return;
    const persistedNoInputBackoff = readNoInputBackoff();
    if (persistedNoInputBackoff?.until !== undefined) {
      if (scheduleNoInputRecovery(persistedNoInputBackoff.until)) {
        setState("no_input", backoffDetail());
        return;
      }
      clearNoInputBackoff();
    }
    const turnGeneration = resetTurn();
    showTranscript("");
    if (availability !== "active") {
      setState("text_mode");
      return;
    }
    setState("requesting_permission", "正在准备麦克风；你可以随时停止。");
    try {
      const lease = await beginLease(turnGeneration);
      if (generation !== turnGeneration) return;
      if (lease === undefined) {
        setState("text_mode", "私人语音暂时不可用；可以直接改用文字。");
        return;
      }
    } catch {
      if (generation === turnGeneration)
        setState("text_mode", "私人语音暂时不可用；可以直接改用文字。");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      releaseLease();
      setState("text_mode", "这台设备不能提供麦克风；请改用文字。");
      return;
    }
    setState("requesting_permission");
    try {
      const capturedStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation !== turnGeneration) {
        for (const track of capturedStream.getTracks?.() || []) track.stop();
        return;
      }
      stream = capturedStream;
      if (captureMode === "encoded_audio") {
        chunks = [];
        const capturedRecorder = new MediaRecorder(capturedStream);
        recorder = capturedRecorder;
        capturedRecorder.ondataavailable = (event) => {
          if (
            generation === turnGeneration &&
            recorder === capturedRecorder &&
            event.data?.size > 0
          ) {
            chunks.push(event.data);
            markCaptureHeard();
          }
        };
        capturedRecorder.onstop = () => {
          if (generation !== turnGeneration || recorder !== capturedRecorder) return;
          const type = capturedRecorder.mimeType || chunks[0]?.type || "audio/webm";
          const body = new Blob(chunks, { type });
          recorder = undefined;
          stopTracks();
          void upload(body, type, undefined, turnGeneration);
        };
        capturedRecorder.start();
      } else {
        const capturedAudioContext = new AudioContext();
        audioContext = capturedAudioContext;
        pcmRate = capturedAudioContext.sampleRate;
        const pcmLimit = Math.min(15 * pcmRate * 2, maxPcmBytes);
        source = capturedAudioContext.createMediaStreamSource(capturedStream);
        processor = capturedAudioContext.createScriptProcessor(4096, 1, 1);
        const capturedProcessor = processor;
        capturedProcessor.onaudioprocess = (event) => {
          if (
            generation !== turnGeneration ||
            processor !== capturedProcessor ||
            pcmBytes >= pcmLimit
          )
            return;
          const input = event.inputBuffer.getChannelData(0);
          const bytes = new Uint8Array(
            Math.min(input.length * 2, pcmLimit - pcmBytes),
          );
          const view = new DataView(bytes.buffer);
          for (let i = 0; i < bytes.length / 2; i += 1) {
            const sample = Math.max(-1, Math.min(1, input[i] || 0));
            view.setInt16(
              i * 2,
              sample < 0 ? sample * 32768 : sample * 32767,
              true,
            );
          }
          pcmChunks.push(bytes);
          pcmBytes += bytes.length;
          markCaptureHeard();
        };
        source.connect(processor);
        processor.connect(capturedAudioContext.destination);
      }
      setState("listening");
      setCaptureProgress("recording");
      timer = setTimeout(() => finishCapture(turnGeneration), maxTurnMs);
    } catch (error) {
      if (generation !== turnGeneration) return;
      stopCapture();
      releaseLease();
      if (error?.name === "NotAllowedError" || error?.name === "SecurityError")
        setState("permission_denied");
      else setState("failed", "麦克风暂时无法使用。请再试一次或改用文字。");
    }
  };
  startButton?.addEventListener("click", () => {
    void startCapture();
  });
  restartButton?.addEventListener("click", () => {
    if (state === "playback_failed" && typeof activeAdviceId === "string")
      void speak(activeAdviceId, generation);
    else void startCapture();
  });
  stopButton?.addEventListener("click", () => {
    if (state === "requesting_permission") {
      resetTurn();
      setState("cancelled", "麦克风没有开始采集。想继续时可以再试一次。");
      return;
    }
    finishCapture();
  });
  cancelButton?.addEventListener("click", () => {
    void cancelTurn();
  });
  backgroundButton?.addEventListener("click", () => {
    void backgroundTurn();
  });
  speechStopButton?.addEventListener("click", () => {
    generation += 1;
    activeAdviceId = undefined;
    requestController?.abort();
    requestController = undefined;
    stopPlayback();
    releaseLease();
    setState("idle", "播报已停止。想继续时可以再说一句。");
  });
  const disposeVoiceSurface = () => {
    if (disposed) return;
    disposed = true;
    if (noInputBackoffTimer !== undefined) {
      try { clearTimeout(noInputBackoffTimer); } catch {}
      noInputBackoffTimer = undefined;
    }
    resetTurn();
  };
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", disposeVoiceSurface, { once: true });
    window.addEventListener("beforeunload", disposeVoiceSurface, { once: true });
  }
  if (availability !== "active") setState("text_mode");
  else setState(state);
}`;

export function renderVoiceSurface(
  requestedState = "idle",
  options: VoiceSurfaceRenderOptions = {},
): string | undefined {
  if (!isVoiceSurfaceState(requestedState)) return undefined;
  const privateVoice = options.privateVoice ?? {
    status: "unavailable" as const,
  };
  const renderedState =
    privateVoice.status !== "active" && requestedState === "idle"
      ? "text_mode"
      : requestedState;
  const copy = STATE_COPY[renderedState];
  const safeTranscript = normalizeSurfaceText(options.transcript);
  const transcriptKind =
    options.transcriptKind === "partial" ? "partial" : "final";
  const initialTranscript = safeTranscript
    ? escapeHtml(safeTranscript)
    : "还没有转写";
  const initialTranscriptKind = safeTranscript ? transcriptKind : "empty";
  const transcriptMarkup =
    (renderedState === "text_mode" || renderedState === "model_unavailable") && !safeTranscript
      ? ""
      : `<p class="product-voice-transcript" data-voice-transcript data-voice-transcript-kind="${initialTranscriptKind}" aria-live="polite" aria-atomic="true">${initialTranscript}</p>`;
  const textExitHidden = renderedState === "text_mode" || renderedState === "model_unavailable" ? " hidden" : "";
  const recoveryClass =
    renderedState === "text_mode" || renderedState === "model_unavailable"
      ? "product-primary-action"
      : "product-secondary-action";
  const fallbackMarkup =
    renderedState === "text_mode"
      ? ""
      : '<p class="product-voice-fallback" data-voice-fallback hidden>麦克风权限开启后，可以在这里继续说话；文字对话始终可用。</p>';
  const intentMarkup = renderVoiceIntent(
    safeTranscript,
    transcriptKind,
    options.intent,
  );
  const voiceStartHidden =
    privateVoice.status !== "active" || renderedState === "text_mode" || renderedState === "model_unavailable"
      ? " hidden"
      : "";
  const retry = privateVoice.status === "retryable"
    ? '<form class="product-action-form" method="post" action="/voice/retry"><button class="product-primary-action" type="submit">重新连接私人语音</button></form>'
    : "";
  const recovery = privateVoice.status === "recovering"
    ? '<p class="product-notice" role="status" aria-live="polite">正在恢复私人语音。文字对话始终可用。</p><form class="product-action-form" method="post" action="/voice/cancel-retry"><button class="product-secondary-action" type="submit">停止这次恢复</button></form>'
    : "";
  const notice = options.notice === "recovered"
    ? '<p class="product-notice" data-one-shot-notice role="status">私人语音已重新连接。现在可以开始说话。</p>'
    : options.notice === "unavailable"
      ? '<p class="product-notice" data-one-shot-notice role="status">私人语音仍在恢复中。文字对话现在就能继续。</p>'
      : "";
  return `<section class="product-voice" data-voice-surface data-voice-state="${renderedState}" data-private-voice-status="${privateVoice.status}" aria-labelledby="voice-heading"><header class="product-page-header product-voice-header"><div><p class="product-kicker" data-voice-eyebrow>${copy.eyebrow}</p><h1 id="voice-heading" data-voice-heading>${copy.heading}</h1></div><a class="product-view-switcher" data-voice-text-exit href="/conversation"${textExitHidden}>改用文字</a></header>${notice}<section class="product-card product-voice-stage" aria-describedby="voice-detail"><span class="product-voice-indicator" data-voice-indicator aria-hidden="true"></span><p class="product-voice-status" data-voice-status role="status" aria-live="polite">${copy.status}</p><p class="product-muted" id="voice-detail" data-voice-detail>${copy.detail}</p><p class="product-muted product-voice-progress" data-voice-capture-progress aria-live="polite" hidden></p>${recovery}${transcriptMarkup}<article class="product-voice-answer" data-voice-answer aria-live="polite" aria-atomic="false" hidden></article><a class="product-secondary-action" data-voice-conversation href="/conversation" hidden>打开完整文字对话</a><div class="product-card-actions"><button class="product-primary-action" type="button" data-voice-start${voiceStartHidden}>开始聆听</button><button class="product-secondary-action" type="button" data-voice-stop hidden>停止并转写</button><button class="product-secondary-action" type="button" data-voice-cancel hidden>取消等待</button><button class="product-secondary-action" type="button" data-voice-background hidden>稍后处理</button><button class="product-secondary-action" type="button" data-voice-speech-stop hidden>停止播报</button><button class="product-secondary-action" type="button" data-voice-restart hidden>再试一次</button>${retry}<a class="${recoveryClass}" data-voice-recovery href="${copy.recovery.href}">${copy.recovery.label}</a></div>${fallbackMarkup}<p class="product-voice-privacy">原始录音不写入磁盘，只用于本次转写，请求结束后从内存丢弃。回答播报音频只在本机内存中保留最多 30 秒，便于当前对话重播。当前语音只用于家庭问答，不会直接发起设备或媒体动作；如需动作，请在文字对话中明确选择相应入口。</p></section>${intentMarkup}<noscript><p class="product-card product-voice-fallback">浏览器未启用脚本，无法使用语音。请改用文字。</p><a class="product-primary-action" href="/conversation">改用文字</a></noscript></section>`;
}
function renderVoiceIntent(
  transcript: string,
  transcriptKind: "partial" | "final",
  intent?: VoiceSurfaceIntent,
): string {
  const fields = [
    ["房间", normalizeSurfaceText(intent?.room)],
    ["播放器", normalizeSurfaceText(intent?.player)],
    ["选择", normalizeSurfaceText(intent?.selection)],
    ["队列", normalizeSurfaceText(intent?.queue)],
    ["音量", normalizeSurfaceText(intent?.volume)],
  ] as Array<[string, string]>;
  const visible = fields.filter((entry) => entry[1].length > 0);
  if (!transcript && visible.length === 0) return "";
  const quote = transcript
    ? `<blockquote lang="zh-CN" data-voice-intent-transcript data-voice-transcript-kind="${transcriptKind}">${escapeHtml(transcript)}</blockquote>`
    : "";
  const values =
    visible.length > 0
      ? `<dl class="product-side-list">${visible.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`
      : "";
  return `<section class="product-card product-voice-intent" data-voice-intent-source="real" aria-label="当前理解"><p class="product-kicker">当前理解</p>${quote}${values}<p class="product-muted">语音内容会进入这次对话；需要确认的动作会先等待你的确认，结果会保留在活动记录中。</p></section>`;
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
