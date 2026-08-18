import { Context, Service } from "@deepseek-ai/cordis";

import {
  HomeAssistantBridge,
  type HomeAssistantBridgeOptions,
  type HomeAssistantSnapshot,
} from "./home-assistant-bridge.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    homeAssistant: HomeAssistantService;
  }
}

/** Cordis-owned Home Assistant connection and its initial household snapshot. */
export class HomeAssistantService extends Service {
  readonly bridge: HomeAssistantBridge;
  snapshot!: HomeAssistantSnapshot;

  constructor(ctx: Context, options: HomeAssistantBridgeOptions) {
    super(ctx, "homeAssistant");
    this.bridge = new HomeAssistantBridge(options);
  }

  protected async [Service.init](): Promise<void> {
    this.ctx.effect(() => () => this.bridge.close(), "home-assistant.close");
    this.snapshot = await this.bridge.connect();
  }
}
