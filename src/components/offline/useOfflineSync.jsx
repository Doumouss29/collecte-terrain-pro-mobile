import { useState, useEffect, useCallback } from 'react';
import { base44 } from '@/api/base44Client';
import { offlineDb } from '@/lib/offlineDb';

// Verrou partagé par toutes les instances du hook dans l'application.
// Une seule boucle de synchronisation peut écrire vers le serveur à la fois.
let activeSyncPromise = null;

export const useOfflineSync = () => {
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [pendingCount, setPendingCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState(null);
  const [isReady, setIsReady] = useState(false);

  const updatePendingCount = useCallback(async () => {
    try { setPendingCount((await offlineDb.getPendingCollectes()).length); } catch (e) { console.error(e); }
  }, []);

  useEffect(() => {
    offlineDb.init().then(() => { setIsReady(true); updatePendingCount(); }).catch(() => setIsReady(true));
    const online = () => { setIsOnline(true); setSyncError(null); };
    const offline = () => setIsOnline(false);
    window.addEventListener('online', online); window.addEventListener('offline', offline);
    window.addEventListener('offline-queue-change', updatePendingCount);
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', offline); window.removeEventListener('offline-queue-change', updatePendingCount); };
  }, [updatePendingCount]);

  const saveOffline = useCallback(async (data) => {
    try { const localId = await offlineDb.saveCollecte(data); await updatePendingCount(); return { success: true, localId }; }
    catch (error) { return { success: false, error }; }
  }, [updatePendingCount]);

  const updateOffline = useCallback(async (id, data) => {
    try { const localId = await offlineDb.updateCollecte(id, data); await updatePendingCount(); return { success: true, localId }; }
    catch (error) { return { success: false, error }; }
  }, [updatePendingCount]);

  const syncCollectes = useCallback(async () => {
    if (!navigator.onLine) {
      setSyncError('Pas de connexion internet');
      return { success: false, error: new Error('Pas de connexion internet') };
    }

    // Toutes les pages et tous les composants réutilisent la même promesse.
    // Cela évite que deux hooks synchronisent simultanément la même file locale.
    if (activeSyncPromise) return activeSyncPromise;

    activeSyncPromise = (async () => {
      setIsSyncing(true);
      setSyncError(null);

      try {
        const pending = await offlineDb.getPendingCollectes();
        let syncedCount = 0;
        const errors = [];

        for (const originalItem of pending) {
          // Les anciennes collectes locales créées avant cette correction
          // reçoivent également un identifiant d'idempotence stable.
          const offlineSyncId =
            originalItem.offline_sync_id ||
            await offlineDb.ensureOfflineSyncId(originalItem.localId);

          const item = {
            ...originalItem,
            offline_sync_id: offlineSyncId,
          };

          const {
            localId,
            serverId,
            operation,
            status,
            retryCount,
            lastError,
            createdAt,
            updatedAt,
            syncedAt,
            ...data
          } = item;

          try {
            let result;
            if (operation === 'update' && serverId) {
              result = await base44.entities.Collecte.update(serverId, data);
            } else {
              result = await base44.entities.Collecte.create(data);
            }

            await offlineDb.markSynced(localId, result?.id || serverId);
            syncedCount++;
          } catch (error) {
            const message = error?.message || 'Erreur de synchronisation';
            await offlineDb.markError(localId, message);
            errors.push(`${item.commune || 'Collecte'}: ${message}`);
            if (error?.status === 401) break;
          }
        }

        await updatePendingCount();
        if (errors.length) setSyncError(errors.join('\n'));

        return {
          success: errors.length === 0,
          syncedCount,
          errorCount: errors.length,
          errors,
          message: `${syncedCount} synchronisée${syncedCount > 1 ? 's' : ''}${errors.length ? `, ${errors.length} erreur(s)` : ''}`,
        };
      } finally {
        setIsSyncing(false);
        activeSyncPromise = null;
      }
    })();

    return activeSyncPromise;
  }, [updatePendingCount]);

  useEffect(() => {
    if (isReady && isOnline && pendingCount > 0 && !isSyncing) {
      const timer = setTimeout(() => syncCollectes(), 1200);
      return () => clearTimeout(timer);
    }
  }, [isReady, isOnline, pendingCount, isSyncing, syncCollectes]);

  return { isOnline, pendingCount, isSyncing, syncError, isReady, saveOffline, updateOffline, syncCollectes, offlineStorage: offlineDb };
};
