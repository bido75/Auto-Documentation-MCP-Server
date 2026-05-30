import { copyFile, mkdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export type PublishedScreenshotAsset = {
  publicImageUrl: string;
  storagePath: string;
};

function sanitizeFileStem(inputPath: string): string {
  const name = basename(inputPath, extname(inputPath));
  const normalized = name.replace(/[^a-zA-Z0-9-_]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return normalized.length > 0 ? normalized : "screenshot";
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, "");
}

function normalizePublicDir(raw: string): string {
  return raw.replace(/[\\/]+$/, "");
}

export async function publishScreenshotAsset(localPath: string): Promise<PublishedScreenshotAsset> {
  const baseUrl = process.env.AUTO_DOC_SCREENSHOT_PUBLIC_BASE_URL?.trim();
  const publicDir = process.env.AUTO_DOC_SCREENSHOT_PUBLIC_DIR?.trim();

  if (!baseUrl || !publicDir) {
    throw new Error(
      "Automatic screenshot upload is not configured. Set AUTO_DOC_SCREENSHOT_PUBLIC_BASE_URL and AUTO_DOC_SCREENSHOT_PUBLIC_DIR.",
    );
  }

  const safeBaseUrl = normalizeBaseUrl(baseUrl);
  const safePublicDir = normalizePublicDir(publicDir);
  const ext = extname(localPath) || ".png";
  const stem = sanitizeFileStem(localPath);
  const fileName = `${Date.now()}-${stem}${ext}`;
  const storagePath = join(safePublicDir, fileName);

  await mkdir(safePublicDir, { recursive: true });
  await copyFile(localPath, storagePath);

  return {
    publicImageUrl: `${safeBaseUrl}/${encodeURIComponent(fileName)}`,
    storagePath,
  };
}
