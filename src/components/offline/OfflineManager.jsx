import React from 'react';
import OfflineIndicator from './OfflineIndicator';
import { useOfflineSync } from './useOfflineSync';
import { toast } from 'sonner';

export default function OfflineManager() {
  const state = useOfflineSync();
  const sync = async () => { const result = await state.syncCollectes(); result.success ? toast.success(result.message) : toast.error('Synchronisation incomplète'); };
  return <OfflineIndicator {...state} onSync={sync} />;
}
