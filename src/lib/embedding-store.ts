import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getOptionalRuntimeConfig } from "../config.js";

export type EmbeddingEntry = {
  featureKey: string;
  vector: number[];
};

function isEmbeddingEntry(value: unknown): value is EmbeddingEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const entry = value as { featureKey?: unknown; vector?: unknown };
  return typeof entry.featureKey === "string" && Array.isArray(entry.vector) && entry.vector.every((item) => typeof item === "number");
}

export class EmbeddingStore {
  private entries: EmbeddingEntry[] = [];
  private dirty = false;
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }

    const runtime = getOptionalRuntimeConfig();
    try {
      const raw = await readFile(runtime.embedding.indexPath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      this.entries = Array.isArray(parsed) ? parsed.filter(isEmbeddingEntry) : [];
    } catch {
      this.entries = [];
    }

    this.loaded = true;
  }

  async save(): Promise<void> {
    if (!this.dirty) {
      return;
    }

    const runtime = getOptionalRuntimeConfig();
    await mkdir(dirname(runtime.embedding.indexPath), { recursive: true });
    await writeFile(runtime.embedding.indexPath, JSON.stringify(this.entries, null, 2), "utf8");
    this.dirty = false;
  }

  upsert(entry: EmbeddingEntry): void {
    const index = this.entries.findIndex((item) => item.featureKey === entry.featureKey);
    if (index >= 0) {
      this.entries[index] = entry;
    } else {
      this.entries.push(entry);
    }

    this.dirty = true;
  }

  findSimilar(vector: number[], threshold = getOptionalRuntimeConfig().embedding.similarityThreshold): EmbeddingEntry | null {
    let best: EmbeddingEntry | null = null;
    let bestScore = -1;

    for (const entry of this.entries) {
      const score = cosineSimilarity(vector, entry.vector);
      if (score > bestScore && score >= threshold) {
        best = entry;
        bestScore = score;
      }
    }

    return best;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }

  const dot = a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);
  const magA = Math.sqrt(a.reduce((sum, value) => sum + value * value, 0));
  const magB = Math.sqrt(b.reduce((sum, value) => sum + value * value, 0));
  return magA && magB ? dot / (magA * magB) : 0;
}

export const embeddingStore = new EmbeddingStore();
