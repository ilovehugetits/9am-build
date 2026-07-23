import { readFile } from "fs/promises";
import path from "path";
import chalk from "chalk";
import {
  computeChunking, getAsset, reUpload, uploadChunk, completeUpload, deleteVersion,
  PortalApiError, type Requester, type AssetDetail,
} from "./api.js";

export interface UploadOptions {
  assetId: number;
  zipPath: string;
  version: string;
  changelog?: string;
  releaseCandidate?: boolean;
  label: string;
}

export function oldestVersionId(detail: AssetDetail): number | null {
  if (detail.versions.length === 0) return null;
  return [...detail.versions].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  )[0].id;
}

export function hasVersion(detail: AssetDetail, version: string): boolean {
  return detail.versions.some((v) => v.version === version);
}

export async function uploadAsset(req: Requester, opts: UploadOptions): Promise<void> {
  const { assetId, zipPath, version, label } = opts;
  console.log(chalk.blue(`[${label}] Uploading asset ${assetId} (v${version})...`));

  const detail = await getAsset(req, assetId);
  if (hasVersion(detail, version)) {
    throw new Error(`[${label}] Version ${version} already exists for asset ${assetId}. Bump fxmanifest.lua.`);
  }

  const buffer = Buffer.from(await readFile(zipPath));
  const { chunkSize, chunkCount } = computeChunking(buffer.length);
  const body = {
    name: detail.name,
    chunk_count: chunkCount,
    chunk_size: chunkSize,
    total_size: buffer.length,
    original_file_name: path.basename(zipPath),
    release_candidate: opts.releaseCandidate ?? false,
    version,
    changelog: opts.changelog ?? "",
  };

  let ids: { asset_id: number; version_id: number };
  try {
    ids = await reUpload(req, assetId, body);
  } catch (err) {
    if (err instanceof PortalApiError && err.code === "MAX_VERSIONS_REACHED") {
      const oldest = oldestVersionId(detail);
      if (oldest == null) throw err;
      console.log(chalk.yellow(`[${label}] 5/5 versions — deleting oldest (id ${oldest})...`));
      await deleteVersion(req, assetId, oldest);
      ids = await reUpload(req, assetId, body);
    } else {
      throw err;
    }
  }

  for (let i = 0; i < chunkCount; i++) {
    const chunk = buffer.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, buffer.length));
    await uploadChunk(req, ids.asset_id, ids.version_id, i, chunk);
    console.log(chalk.gray(`[${label}] chunk ${i + 1}/${chunkCount}`));
  }

  await completeUpload(req, ids.asset_id, ids.version_id);
  console.log(chalk.green(`[${label}] Asset ${assetId} uploaded (v${version}).`));
}
