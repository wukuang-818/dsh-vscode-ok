let counter = 0;

export function uid(prefix = 'id'): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const omitted = text.length - max;
  return `${text.slice(0, max)}\n… (${omitted} chars omitted)`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function toPosixPath(path: string): string {
  return path.replace(/\\/g, '/');
}

export function relativePath(root: string, file: string): string {
  const normalizedRoot = toPosixPath(root).replace(/\/+$/, '');
  const normalizedFile = toPosixPath(file);
  if (normalizedFile.startsWith(`${normalizedRoot}/`)) {
    return normalizedFile.slice(normalizedRoot.length + 1);
  }
  return normalizedFile;
}
