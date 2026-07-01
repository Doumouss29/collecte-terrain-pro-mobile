const DB_NAME = 'CollecteTerrainOfflineDB';
const DB_VERSION = 3;
const COLLECTES = 'collectes';
const API_CACHE = 'api_cache';
const META = 'meta';

let dbPromise;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(COLLECTES)) {
        const store = db.createObjectStore(COLLECTES, { keyPath: 'localId', autoIncrement: true });
        store.createIndex('status', 'status', { unique: false });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
        store.createIndex('serverId', 'serverId', { unique: false });
      }
      if (!db.objectStoreNames.contains(API_CACHE)) db.createObjectStore(API_CACHE, { keyPath: 'key' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
  });
  return dbPromise;
}

async function tx(storeName, mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let request;
    try { request = action(store); } catch (e) { reject(e); return; }
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = () => reject(transaction.error || request?.error);
    transaction.onabort = () => reject(transaction.error || new Error('Transaction annulée'));
  });
}

function emitChange() { window.dispatchEvent(new CustomEvent('offline-queue-change')); }

export const offlineDb = {
  init: openDb,
  async saveCollecte(data, options = {}) {
    const now = new Date().toISOString();
    const item = {
      ...structuredClone(data),
      localId: options.localId,
      serverId: options.serverId || data.id || null,
      operation: options.serverId || data.id ? 'update' : 'create',
      status: 'pending',
      retryCount: 0,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
    delete item.id;
    const id = await tx(COLLECTES, 'readwrite', (store) => store.put(item));
    emitChange();
    return id;
  },
  async updateCollecte(localIdOrServerId, data) {
    const all = await this.getAllCollectes();
    const numericId = Number(localIdOrServerId);
    let item = all.find((x) => x.localId === numericId || x.serverId === localIdOrServerId);
    if (!item) {
      return this.saveCollecte(data, { serverId: String(localIdOrServerId) });
    }
    item = { ...item, ...structuredClone(data), status: 'pending', operation: item.serverId ? 'update' : 'create', updatedAt: new Date().toISOString(), lastError: null };
    await tx(COLLECTES, 'readwrite', (store) => store.put(item));
    emitChange();
    return item.localId;
  },
  getAllCollectes() { return tx(COLLECTES, 'readonly', (store) => store.getAll()); },
  async getPendingCollectes() { return (await this.getAllCollectes()).filter((x) => x.status === 'pending' || x.status === 'error'); },
  async getCollecte(id) { return tx(COLLECTES, 'readonly', (store) => store.get(Number(id))); },
  async markSynced(localId, serverId) {
    const item = await this.getCollecte(localId);
    if (!item) return;
    item.status = 'synced'; item.serverId = serverId; item.lastError = null; item.syncedAt = new Date().toISOString(); item.updatedAt = item.syncedAt;
    await tx(COLLECTES, 'readwrite', (store) => store.put(item)); emitChange();
  },
  async markError(localId, error) {
    const item = await this.getCollecte(localId);
    if (!item) return;
    item.status = 'error'; item.retryCount = (item.retryCount || 0) + 1; item.lastError = String(error || 'Erreur'); item.updatedAt = new Date().toISOString();
    await tx(COLLECTES, 'readwrite', (store) => store.put(item)); emitChange();
  },
  async deleteCollecte(localId) { await tx(COLLECTES, 'readwrite', (store) => store.delete(Number(localId))); emitChange(); },
  async clearCollectes() { await tx(COLLECTES, 'readwrite', (store) => store.clear()); emitChange(); },
  async importCollectes(items = [], { replace = false } = {}) {
    if (!Array.isArray(items)) throw new Error('Sauvegarde invalide');
    if (replace) await this.clearCollectes();
    for (const source of items) {
      const item = structuredClone(source);
      if (!item.createdAt) item.createdAt = new Date().toISOString();
      item.updatedAt = item.updatedAt || item.createdAt;
      await tx(COLLECTES, 'readwrite', (store) => store.put(item));
    }
    emitChange();
    return items.length;
  },
  async cacheApi(key, value) { return tx(API_CACHE, 'readwrite', (store) => store.put({ key, value: structuredClone(value), cachedAt: Date.now() })); },
  async getCachedApi(key) { const row = await tx(API_CACHE, 'readonly', (store) => store.get(key)); return row?.value ?? null; },
  async setMeta(key, value) { return tx(META, 'readwrite', (store) => store.put({ key, value })); },
  async getMeta(key) { const row = await tx(META, 'readonly', (store) => store.get(key)); return row?.value ?? null; },
};

export function isNetworkError(error) {
  return !navigator.onLine || error?.name === 'TypeError' || error?.code === 'NETWORK_ERROR' || /fetch|network|connexion/i.test(error?.message || '');
}
