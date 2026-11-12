export type DocumentOpenParams = {
  requestId: 'library';
  assetId: string;
  type: string;
};

export function isDocumentOpenParams(value: unknown): value is DocumentOpenParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const params = value as Record<string, unknown>;
  return (
    Object.keys(params).sort().join(',') === 'assetId,requestId,type' &&
    params.requestId === 'library' &&
    typeof params.assetId === 'string' &&
    /^[0-9a-f]{64}$/.test(params.assetId) &&
    typeof params.type === 'string' &&
    params.type.length <= 255 &&
    !/[^\x20-\x7e]/.test(params.type)
  );
}
