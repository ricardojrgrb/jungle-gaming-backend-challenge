export type LogFields = Record<string, unknown>;

export abstract class AppLogger {
  abstract debug(fields: LogFields, message: string): void;
  abstract info(fields: LogFields, message: string): void;
  abstract warn(fields: LogFields, message: string): void;
  abstract error(fields: LogFields, message: string): void;
  abstract child(bindings: LogFields): AppLogger;
}

export class NoopLogger extends AppLogger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): AppLogger {
    return this;
  }
}
