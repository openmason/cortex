/**
 * Mock for cloudflare:workers module.
 * Provides stub base classes for unit testing.
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

/**
 * Mock WorkflowEntrypoint for CF Workflows.
 */
export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  protected env: Env;

  constructor(ctx: any, env: Env) {
    this.env = env;
  }

  run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown> {
    throw new Error("Not implemented in mock");
  }
}

/**
 * Mock WorkflowEvent type.
 */
export interface WorkflowEvent<Params = unknown> {
  payload: Params;
  instanceId: string;
  timestamp: Date;
}

/**
 * Mock WorkflowStep interface.
 */
export interface WorkflowStep {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(name: string, config: WorkflowStepConfig, callback: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string | number): Promise<void>;
  sleepUntil(name: string, timestamp: Date | number): Promise<void>;
}

export interface WorkflowStepConfig {
  retries?: {
    limit: number;
    delay: string | number;
    backoff?: "constant" | "linear" | "exponential";
  };
  timeout?: string | number;
}
