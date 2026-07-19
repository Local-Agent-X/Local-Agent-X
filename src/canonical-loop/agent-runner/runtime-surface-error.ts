export class RuntimeSurfaceMismatchError extends Error {
  constructor(public readonly code: string) {
    super(`delegated runtime surface mismatch: ${code}`);
    this.name = "RuntimeSurfaceMismatchError";
  }
}

export function runtimeSurfaceMismatch(code: string): never {
  throw new RuntimeSurfaceMismatchError(code);
}
