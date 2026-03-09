/**
 * Mock for cloudflare:workers module.
 * Provides a stub DurableObject base class for unit testing.
 */
export class DurableObject<Env = unknown> {
  protected ctx: any;
  protected env: Env;

  constructor(ctx: any, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  fetch(request: Request): Response | Promise<Response> {
    return new Response("Not implemented", { status: 501 });
  }

  alarm(): void | Promise<void> {}
}
