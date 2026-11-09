import type {
  ApiErrorBody,
  BatchRequest,
  BatchResult,
  MetricsPage,
  Run,
  RunStatus,
} from './protocol.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface Project {
  id: string;
  name: string;
  created_at: string;
}

export interface ApiKey {
  id: string;
  prefix: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
  /** True for the key that made this request. */
  current: boolean;
}

export interface NewApiKey extends ApiKey {
  /** Shown once. Only its hash is stored. */
  secret: string;
}

export interface ClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
}

export async function readError(response: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> = {};
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    // Not JSON: a proxy or a crashed server answered.
  }
  return new ApiError(
    response.status,
    body.error?.code ?? `http_${response.status}`,
    body.error?.message ?? `The server answered ${response.status}.`,
    body.error?.details,
  );
}

export class Client {
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json', ...extraHeaders };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await this.fetchImpl(this.baseUrl + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      // Node's fetch types do not know `cache`, browsers honour it.
      ...({ cache: 'no-store' } as object),
    });
    if (!response.ok) throw await readError(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /** Whether this server lets anyone create a project or asks for an invite code. */
  getConfig() {
    return this.request<{ signup: 'open' | 'token' }>('GET', '/config');
  }
  createProject(name: string, inviteCode?: string) {
    return this.request<{ project: Project; api_key: NewApiKey }>(
      'POST',
      '/projects',
      { name },
      undefined,
      inviteCode ? { 'x-signup-token': inviteCode } : {},
    );
  }
  getProject(signal?: AbortSignal) {
    return this.request<Project>('GET', '/project', undefined, signal);
  }

  listKeys(signal?: AbortSignal) {
    return this.request<{ keys: ApiKey[] }>('GET', '/keys', undefined, signal);
  }
  createKey(label: string) {
    return this.request<NewApiKey>('POST', '/keys', { label });
  }
  rotateKey(id: string) {
    return this.request<NewApiKey>('POST', `/keys/${id}/rotate`);
  }
  revokeKey(id: string) {
    return this.request<void>('DELETE', `/keys/${id}`);
  }

  listRuns(signal?: AbortSignal) {
    return this.request<{ runs: Run[] }>('GET', '/runs', undefined, signal);
  }
  createRun(name?: string) {
    return this.request<Run>('POST', '/runs', name === undefined ? {} : { name });
  }
  getRun(id: string, signal?: AbortSignal) {
    return this.request<Run>('GET', `/runs/${id}`, undefined, signal);
  }
  finishRun(id: string, status: Exclude<RunStatus, 'running'> = 'finished') {
    return this.request<Run>('POST', `/runs/${id}/finish`, { status });
  }

  sendMetrics(runId: string, batch: BatchRequest, signal?: AbortSignal) {
    return this.request<BatchResult>('POST', `/runs/${runId}/metrics`, batch, signal);
  }
  getMetrics(runId: string, after = 0, limit?: number) {
    const query = `?after=${after}${limit ? `&limit=${limit}` : ''}`;
    return this.request<MetricsPage>('GET', `/runs/${runId}/metrics${query}`);
  }
}
