export class WorkerTaskExecutionError extends Error {
  readonly providerCommentUrl?: string;
  readonly gitStatus?: Record<string, unknown>;

  constructor(
    message: string,
    params?: {
      providerCommentUrl?: string;
      gitStatus?: Record<string, unknown>;
      cause?: unknown;
    }
  ) {
    super(message);
    this.name = 'WorkerTaskExecutionError';
    this.providerCommentUrl = params?.providerCommentUrl;
    this.gitStatus = params?.gitStatus;
    if (params?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = params.cause;
    }
  }
}
