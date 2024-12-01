export type TargetStatus = 'loading' | 'success' | 'error' | 'warning';

export interface TargetOptions {
  statusMatchers: Record<string, TargetStatus>;
}

export interface DevExecutorSchema {
  targets: Record<string, boolean | TargetOptions>;
}
