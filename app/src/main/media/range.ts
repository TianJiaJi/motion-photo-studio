export type ByteRange = { start: number; end: number; partial: boolean };
export function parseRange(header: string | null, size: number): ByteRange {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid file size');
  if (header === null) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || !size || !match[1] && !match[2]) throw new Error('Unsatisfiable range');
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new Error('Unsatisfiable suffix');
    return { start: Math.max(0, size - suffix), end: size - 1, partial: true };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)
    || start >= size || requestedEnd < start) throw new Error('Unsatisfiable range');
  return { start, end: Math.min(requestedEnd, size - 1), partial: true };
}
