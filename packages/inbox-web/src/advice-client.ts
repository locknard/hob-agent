/**
 * Same-origin, dependency-free client for a running household advice turn.
 *
 * The HTTP layer serves this module from `/assets/advice.js` and includes it
 * only on a running advice document. EventSource reconnects with Last-Event-ID
 * automatically, so a reload or a brief network gap does not create another
 * question. It intentionally consumes semantic SSE
 * events, never raw DSH events, tool payloads, or hidden reasoning.
 */
export const ADVICE_CLIENT_JS = String.raw`// EventSource reconnects with Last-Event-ID on retry.
const root = document.querySelector("[data-advice-stream=\"sse\"]");

if (root instanceof HTMLElement) {
  const eventsUrl = root.getAttribute("data-advice-events");
  const status = root.querySelector("[data-advice-status]");
  const answer = root.querySelector("[data-advice-answer]");
  const stages = new Map(Array.from(root.querySelectorAll("[data-advice-stage]")).map((element) => [element.dataset.adviceStage, element]));
  const eventNames = ["accepted", "inspecting_home", "reading_inventory", "checking_rules", "evaluating_evidence", "composing_answer", "answer_delta", "completed", "failed", "cancelled"];
  const completedStages = new Set();
  let currentStage;
  let stream;

  const setStatus = (message) => {
    if (status instanceof HTMLElement && typeof message === "string" && message.length > 0) status.textContent = message;
  };

  const setStage = (stage) => {
    if (typeof stage !== "string" || !stages.has(stage)) return;
    if (typeof currentStage === "string" && currentStage !== stage) completedStages.add(currentStage);
    currentStage = stage;
    for (const [id, element] of stages) {
      if (!(element instanceof HTMLElement)) continue;
      const current = id === stage;
      const complete = completedStages.has(id);
      element.dataset.adviceStageState = current ? "current" : complete ? "complete" : "pending";
      if (current) element.setAttribute("aria-current", "step");
      else element.removeAttribute("aria-current");
    }
  };

  const parseEvent = (event) => {
    try {
      const parsed = JSON.parse(event.data);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  };

  const refreshAfterTerminalEvent = () => {
    if (stream) stream.close();
    window.location.reload();
  };

  const handle = (name, event) => {
    const payload = parseEvent(event);
    const stage = typeof payload.stage === "string" ? payload.stage : name;
    if (stages.has(stage)) setStage(stage);
    if (name === "answer_delta" && answer instanceof HTMLElement && typeof payload.text === "string") answer.textContent += payload.text;
    if (name === "accepted") setStatus("Question received. Looking at the information available in your home.");
    if (name === "inspecting_home") setStatus("Getting to know your home.");
    if (name === "reading_inventory") setStatus("Checking the information available in your home.");
    if (name === "checking_rules") setStatus("Reviewing current routines.");
    if (name === "evaluating_evidence") setStatus("Comparing recent patterns.");
    if (name === "composing_answer") setStatus("Writing your answer.");
    if (name === "completed") refreshAfterTerminalEvent();
    if (name === "failed") refreshAfterTerminalEvent();
    if (name === "cancelled") refreshAfterTerminalEvent();
  };

  if (typeof eventsUrl === "string" && eventsUrl.startsWith("/")) {
    stream = new EventSource(eventsUrl);
    for (const name of eventNames) stream.addEventListener(name, (event) => handle(name, event));
    stream.addEventListener("error", () => {
      if (stream.readyState === EventSource.CONNECTING) setStatus("Connection paused. Retrying the answer update.");
      else if (stream.readyState === EventSource.CLOSED) setStatus("The answer update stopped. Refresh to check its status.");
    });
    window.addEventListener("beforeunload", () => stream.close(), { once: true });
  }

  const cancelForm = root.querySelector(".advice-cancel-form");
  if (cancelForm instanceof HTMLFormElement) cancelForm.addEventListener("submit", () => {
    const button = cancelForm.querySelector("button");
    if (button instanceof HTMLButtonElement) button.disabled = true;
    setStatus("Stopping this question.");
  });
}`;
