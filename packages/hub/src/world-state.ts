import type { DeviceDescriptor, StateEvent } from "./bridge/bridge-ingest-types.js";

export type WorldDeviceValidity = "valid" | "stale" | "invalid-source" | "present-but-invalid";

export interface WorldDeviceView {
  descriptor: DeviceDescriptor;
  states: Map<string, StateEvent>;
  validity: WorldDeviceValidity;
}

interface ReplayShadow {
  snapshotId: string;
  descriptors: Map<string, DeviceDescriptor>;
  states: Map<string, StateEvent>;
  invalidPresence: Set<string>;
  invalidState: Set<string>;
}

/** The last atomically exchanged world plus a private replay shadow. */
export class WorldState {
  readonly devices = new Map<string, WorldDeviceView>();
  readonly quarantinedPresence = new Set<string>();
  private shadow: ReplayShadow | undefined;
  private replayPriorPresence: Set<string> | undefined;

  beginReplay(snapshotId: string): void {
    this.replayPriorPresence = new Set(this.quarantinedPresence);
    this.shadow = {
      snapshotId,
      descriptors: new Map(),
      states: new Map(),
      invalidPresence: new Set(),
      invalidState: new Set(),
    };
  }

  replaySnapshotId(): string | undefined {
    return this.shadow?.snapshotId;
  }

  applyDescriptor(device: DeviceDescriptor, valid: boolean): void {
    if (this.shadow) {
      if (valid) {
        this.shadow.descriptors.set(device.nativeId, cloneDescriptor(device));
        this.shadow.invalidPresence.delete(device.nativeId);
        this.quarantinedPresence.delete(device.nativeId);
      }
      else {
        this.shadow.invalidPresence.add(device.nativeId);
        this.quarantinedPresence.add(device.nativeId);
      }
      return;
    }
    if (valid) {
      const prior = this.devices.get(device.nativeId);
      this.devices.set(device.nativeId, {
        descriptor: cloneDescriptor(device),
        states: prior?.states ?? new Map(),
        validity: prior?.validity === "present-but-invalid" ? "valid" : (prior?.validity ?? "valid"),
      });
      this.quarantinedPresence.delete(device.nativeId);
    } else {
      this.quarantinedPresence.add(device.nativeId);
      const prior = this.devices.get(device.nativeId);
      if (prior) prior.validity = "present-but-invalid";
    }
  }

  applyState(event: StateEvent, valid: boolean): void {
    const key = stateKey(event);
    if (this.shadow) {
      if (valid) {
        this.shadow.states.set(key, cloneState(event));
        this.shadow.invalidState.delete(key);
      }
      else this.shadow.invalidState.add(key);
      return;
    }
    if (!valid) {
      const current = this.devices.get(event.nativeId);
      if (current) current.validity = "invalid-source";
      return;
    }
    const current = this.devices.get(event.nativeId);
    if (current) current.states.set(event.nativeInstanceId, cloneState(event));
  }

  remove(nativeId: string): void {
    if (this.shadow) return;
    this.devices.delete(nativeId);
    this.quarantinedPresence.delete(nativeId);
  }

  /** Exchanges the shadow only after manifest checks have already passed. */
  completeReplay(snapshotId: string): { removed: string[] } {
    const shadow = this.shadow;
    if (!shadow || shadow.snapshotId !== snapshotId) throw new Error("replay snapshot does not match");
    const prior = new Map(this.devices);
    const next = new Map<string, WorldDeviceView>();
    const nextPresence = new Set<string>();
    for (const [nativeId, descriptor] of shadow.descriptors) {
      const states = new Map<string, StateEvent>();
      for (const state of shadow.states.values()) {
        if (state.nativeId === nativeId) states.set(state.nativeInstanceId, cloneState(state));
      }
      next.set(nativeId, {
        descriptor: cloneDescriptor(descriptor),
        states,
        validity: [...shadow.invalidState].some((key) => key.startsWith(`${nativeId}\u0000`)) ? "invalid-source" : "valid",
      });
    }
    for (const nativeId of shadow.invalidPresence) {
      nextPresence.add(nativeId);
      const previous = prior.get(nativeId);
      if (previous) {
        next.set(nativeId, {
          descriptor: cloneDescriptor(previous.descriptor),
          states: new Map([...previous.states].map(([key, value]) => [key, cloneState(value)])),
          validity: "present-but-invalid",
        });
      } else {
        next.set(nativeId, {
          descriptor: { nativeId, capabilities: [] },
          states: new Map(),
          validity: "present-but-invalid",
        });
      }
    }
    const removed = [...prior.keys()].filter((nativeId) => !next.has(nativeId) && !nextPresence.has(nativeId));
    this.devices.clear();
    for (const [nativeId, device] of next) this.devices.set(nativeId, device);
    this.quarantinedPresence.clear();
    for (const nativeId of nextPresence) this.quarantinedPresence.add(nativeId);
    this.shadow = undefined;
    this.replayPriorPresence = undefined;
    return { removed };
  }

  abandonReplay(): void {
    this.shadow = undefined;
    this.quarantinedPresence.clear();
    for (const nativeId of this.replayPriorPresence ?? []) this.quarantinedPresence.add(nativeId);
    this.replayPriorPresence = undefined;
  }

  snapshot(): Map<string, WorldDeviceView> {
    return new Map([...this.devices].map(([id, value]) => [id, {
      descriptor: cloneDescriptor(value.descriptor),
      states: new Map([...value.states].map(([key, state]) => [key, cloneState(state)])),
      validity: value.validity,
    }]));
  }
}

function stateKey(state: StateEvent): string {
  return `${state.nativeId}\u0000${state.nativeInstanceId}`;
}

function cloneDescriptor(value: DeviceDescriptor): DeviceDescriptor {
  return {
    nativeId: value.nativeId,
    ...(value.name === undefined ? {} : { name: value.name }),
    capabilities: value.capabilities.map((capability) => ({ ...capability })),
    ...(value.via === undefined ? {} : { via: [...value.via] }),
    ...(value.identityClaims === undefined ? {} : { identityClaims: [...value.identityClaims] }),
  };
}

function cloneState(value: StateEvent): StateEvent {
  return {
    nativeId: value.nativeId,
    nativeInstanceId: value.nativeInstanceId,
    attrs: JSON.parse(JSON.stringify(value.attrs)) as StateEvent["attrs"],
    time: { ...value.time },
    origin: value.origin,
  };
}
