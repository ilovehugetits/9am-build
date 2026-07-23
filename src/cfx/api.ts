const THIRTY_TWO_MB = 33_554_432;
const EIGHT_MB = 8_388_608;
const TEN_KB = 10_240;

export function computeChunking(fileSize: number): { chunkSize: number; chunkCount: number } {
  const chunkSize = fileSize > THIRTY_TWO_MB || fileSize < TEN_KB ? EIGHT_MB : Math.ceil(fileSize / 4);
  const chunkCount = Math.ceil(fileSize / chunkSize);
  return { chunkSize, chunkCount };
}

export function extractErrorCode(status: number, body: unknown): string | null {
  if (status === 409 && body && typeof body === "object" && "error_code" in body) {
    return String((body as { error_code: unknown }).error_code);
  }
  return null;
}

export const API_BASE = "https://portal-api.cfx.re";

export interface HttpResponse {
  status: number;
  ok: boolean;
  json(): Promise<any>;
  text(): Promise<string>;
}

export interface MultipartField {
  name: string;
  value: string | { buffer: Buffer; fileName: string; mimeType: string };
}

export interface Requester {
  get(url: string): Promise<HttpResponse>;
  postJson(url: string, body: unknown): Promise<HttpResponse>;
  postMultipart(url: string, fields: MultipartField[]): Promise<HttpResponse>;
  del(url: string): Promise<HttpResponse>;
}

export interface AssetVersion {
  id: number;
  version: string;
  state: string;
  is_release_candidate: boolean;
  created_at: string;
}

export interface AssetDetail {
  id: number;
  name: string;
  versions: AssetVersion[];
}

export interface ReUploadBody {
  name: string;
  chunk_count: number;
  chunk_size: number;
  total_size: number;
  original_file_name: string;
  release_candidate: boolean;
  version: string;
  changelog: string;
}

export class PortalApiError extends Error {
  code: string | null;
  status: number;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "PortalApiError";
    this.status = status;
    this.code = code;
  }
}

async function ensureOk(res: HttpResponse, context: string): Promise<HttpResponse> {
  if (res.ok) return res;
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error body */
  }
  const code = extractErrorCode(res.status, body);
  throw new PortalApiError(`${context} failed (${res.status})${code ? `: ${code}` : ""}`, res.status, code);
}

export async function isAuthenticated(req: Requester): Promise<boolean> {
  const res = await req.get(`${API_BASE}/v1/me`);
  return res.status === 200;
}

export async function getAsset(req: Requester, id: number): Promise<AssetDetail> {
  const res = await ensureOk(await req.get(`${API_BASE}/v1/assets/${id}`), `getAsset(${id})`);
  return (await res.json()) as AssetDetail;
}

export async function reUpload(
  req: Requester,
  id: number,
  body: ReUploadBody
): Promise<{ asset_id: number; version_id: number }> {
  const res = await ensureOk(await req.postJson(`${API_BASE}/v1/assets/${id}/re-upload`, body), `reUpload(${id})`);
  return (await res.json()) as { asset_id: number; version_id: number };
}

export async function uploadChunk(
  req: Requester,
  assetId: number,
  versionId: number,
  chunkId: number,
  chunk: Buffer
): Promise<void> {
  const url = `${API_BASE}/v1/assets/${assetId}/versions/${versionId}/upload-chunk`;
  await ensureOk(
    await req.postMultipart(url, [
      { name: "chunk_id", value: String(chunkId) },
      { name: "chunk", value: { buffer: chunk, fileName: "chunk", mimeType: "application/octet-stream" } },
    ]),
    `uploadChunk(${assetId},${versionId},${chunkId})`
  );
}

export async function completeUpload(req: Requester, assetId: number, versionId: number): Promise<void> {
  await ensureOk(
    await req.postJson(`${API_BASE}/v1/assets/${assetId}/versions/${versionId}/complete-upload`, {}),
    `completeUpload(${assetId},${versionId})`
  );
}

export async function deleteVersion(req: Requester, assetId: number, versionId: number): Promise<void> {
  await ensureOk(
    await req.del(`${API_BASE}/v1/assets/${assetId}/versions/${versionId}`),
    `deleteVersion(${assetId},${versionId})`
  );
}
