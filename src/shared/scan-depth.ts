export const DEFAULT_SCAN_DEPTH = 3;
export const MAX_SCAN_DEPTH = 20;
export function validateScanDepth(value: unknown = DEFAULT_SCAN_DEPTH): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_SCAN_DEPTH)
    throw new Error(`Scan depth must be a whole number from 0 to ${MAX_SCAN_DEPTH}.`);
  return value;
}
