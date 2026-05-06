import type { CacheEntry, CacheStore } from "./types.js";

interface MemEntry {
  entry: CacheEntry;
  expiresAt: number;
}

export class MemoryCacheStore implements CacheStore {
  private store = new Map<string, MemEntry>();

  async get(key: string): Promise<CacheEntry | null> {
    const item = this.store.get(key);
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return item.entry;
  }

  async set(key: string, entry: CacheEntry, ttlSec: number): Promise<void> {
    this.store.set(key, {
      entry,
      expiresAt: Date.now() + ttlSec * 1000,
    });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async clear(prefix?: string): Promise<void> {
    if (!prefix) {
      this.store.clear();
      return;
    }
    for (const k of this.store.keys()) {
      if (k.startsWith(prefix)) this.store.delete(k);
    }
  }
}

export const cache: CacheStore = new MemoryCacheStore();
