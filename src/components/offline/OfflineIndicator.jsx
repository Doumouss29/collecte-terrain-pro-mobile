import React from 'react';
import { Cloud, CloudOff, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function OfflineIndicator({
  isOnline,
  pendingCount = 0,
  isSyncing,
  syncError,
  onSync,
}) {
  const hasPending = pendingCount > 0;
  const title = syncError
    ? `Erreur de synchronisation : ${syncError}`
    : !isOnline
      ? `${pendingCount} collecte(s) stockée(s) hors ligne`
      : hasPending
        ? `${pendingCount} collecte(s) à synchroniser`
        : 'Synchronisation à jour';

  return (
    <button
      type="button"
      onClick={() => isOnline && hasPending && !isSyncing && onSync?.()}
      title={title}
      aria-label={title}
      className={cn(
        'fixed top-14 right-3 z-[1000] h-10 w-10 rounded-full border shadow-md',
        'flex items-center justify-center transition-transform active:scale-95',
        isOnline ? 'bg-white border-slate-200' : 'bg-orange-50 border-orange-300',
        syncError && 'bg-red-50 border-red-300',
        isOnline && hasPending && !isSyncing && 'cursor-pointer hover:shadow-lg'
      )}
    >
      {isSyncing ? (
        <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
      ) : isOnline ? (
        <Cloud className={cn('h-5 w-5', syncError ? 'text-red-600' : hasPending ? 'text-blue-700' : 'text-green-600')} />
      ) : (
        <CloudOff className="h-5 w-5 text-orange-700" />
      )}

      {hasPending && !isSyncing && (
        <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-red-600 text-white text-[10px] font-bold leading-5 text-center border-2 border-white">
          {pendingCount > 99 ? '99+' : pendingCount}
        </span>
      )}
    </button>
  );
}
