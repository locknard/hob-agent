import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";

/** Cordis service surface consumed by this read-only adapter. */
interface HomeAssistantSnapshotLike {
  states: readonly HomeAssistantStateLike[];
  health: {
    bridge: "up";
    devices: Readonly<Record<string, "reachable" | "unreachable" | "unknown">>;
  };
}

interface HomeAssistantStateLike {
  entity_id: string;
  state: string;
  attributes: Readonly<Record<string, unknown>>;
}

type HomeAssistantContext = Context & { homeAssistant: { snapshot: HomeAssistantSnapshotLike } };

interface HomeSnapshotToolValue {
  states: Array<{
    entity_id: string;
    state: string;
    attributes: Record<string, JsonValue>;
  }>;
  health: {
    bridge: "up";
    devices: Record<string, "reachable" | "unreachable" | "unknown">;
  };
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const name = "dsh-home-snapshot-tool";
export const inject = ["tools", "homeAssistant"];

const HOME_SNAPSHOT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    states: {
      type: "array",
      required: true,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          entity_id: { type: "string", required: true },
          state: { type: "string", required: true },
          attributes: {
            type: "object",
            required: true,
            additionalProperties: true,
          },
        },
      },
    },
    health: {
      type: "object",
      required: true,
      additionalProperties: false,
      properties: {
        bridge: { type: "string", required: true, enum: ["up"] },
        devices: {
          type: "object",
          required: true,
          additionalProperties: true,
        },
      },
    },
  },
} as const;

/**
 * Register the model-facing home read. Registry payloads are intentionally
 * excluded: they are unbounded external data and are not needed for this
 * first deterministic state summary.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: "get_home_snapshot",
    description: "Read the current Home Assistant household state snapshot. This tool is read-only.",
    parameters: {},
    output: {
      schema: HOME_SNAPSHOT_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: "text" as const, text: JSON.stringify(value) }],
    },
    execute: async () => projectHomeSnapshot((ctx as HomeAssistantContext).homeAssistant.snapshot),
  }));
}

function projectHomeSnapshot(snapshot: HomeAssistantSnapshotLike): HomeSnapshotToolValue {
  const states = snapshot.states
    .map((state) => ({
      entity_id: state.entity_id,
      state: state.state,
      attributes: stableRecord(state.attributes),
    }))
    .sort((left, right) => {
      const byEntity = compareStrings(left.entity_id, right.entity_id);
      if (byEntity !== 0) return byEntity;
      return compareStrings(left.state, right.state);
    });

  const devices = Object.fromEntries(
    Object.entries(snapshot.health.devices).sort(([left], [right]) => compareStrings(left, right)),
  );

  return {
    states,
    health: {
      bridge: snapshot.health.bridge,
      devices,
    },
  };
}

function stableRecord(value: Readonly<Record<string, unknown>>): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value).sort(([left], [right]) => compareStrings(left, right))) {
    const normalized = stableValue(item, new WeakSet<object>());
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}

function stableValue(value: unknown, seen: WeakSet<object>): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const item of value) {
      const normalized = stableValue(item, seen);
      if (normalized !== undefined) result.push(normalized);
    }
    seen.delete(value);
    return result;
  }

  const result: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(value).sort(([left], [right]) => compareStrings(left, right))) {
    const normalized = stableValue(item, seen);
    if (normalized !== undefined) result[key] = normalized;
  }
  seen.delete(value);
  return result;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
