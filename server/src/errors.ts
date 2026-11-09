export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// One constructor per answer, so the same situation always produces the same
// bytes. A run in another project and a run that does not exist both end here.
export const notFound = () => new HttpError(404, 'not_found', 'Not found.');

// Missing, malformed, unknown and revoked keys are not told apart.
export const unauthorized = () =>
  new HttpError(401, 'unauthorized', 'Missing or invalid API key.');

export const invalid = (message: string, details?: unknown) =>
  new HttpError(422, 'invalid_request', message, details);
