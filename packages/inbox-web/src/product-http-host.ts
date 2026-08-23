import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const LOOPBACK_HOST = "127.0.0.1";

export interface ProductHttpHostOptions {
  /** Port 0 is accepted only as a test/embedding seam. */
  readonly port: number;
}

export type ProductHttpHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;

/** The one local HTTP listener that switches complete product surfaces. */
export class ProductHttpHost {
  origin = "";
  private readonly server: Server;
  private handler: ProductHttpHandler | undefined;
  private listenPromise: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly options: ProductHttpHostOptions) {
    if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new TypeError("Product HTTP port must be an integer from 0 to 65535");
    }
    this.server = createServer((request, response) => {
      const handler = this.handler;
      if (handler === undefined) {
        response.statusCode = 503;
        response.end("Product surface is not active");
        return;
      }
      void Promise.resolve(handler(request, response)).catch(() => {
        if (!response.writableEnded) {
          response.statusCode = 500;
          response.end("Product surface failed to respond");
        }
      });
    });
  }

  async listen(): Promise<void> {
    if (this.disposed) throw new Error("Product HTTP host is disposed");
    this.listenPromise ??= new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      this.server.once("error", onError);
      this.server.listen(this.options.port, LOOPBACK_HOST, () => {
        this.server.off("error", onError);
        const address = this.server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("Product HTTP listener has no TCP address"));
          return;
        }
        this.origin = `http://${LOOPBACK_HOST}:${address.port}`;
        resolve();
      });
    });
    return await this.listenPromise;
  }

  /** Replaces the active surface for requests accepted after this call. */
  switchTo(handler: ProductHttpHandler): void {
    if (this.origin === "") throw new Error("Product HTTP host must listen before a surface attaches");
    if (typeof handler !== "function") throw new TypeError("Product HTTP handler is required");
    this.handler = handler;
  }

  /** Removes a surface only when it is still the active surface. */
  detach(handler: ProductHttpHandler): void {
    if (this.handler === handler) this.handler = undefined;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.handler = undefined;
    if (this.origin === "") return;
    this.server.closeIdleConnections?.();
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }
}
