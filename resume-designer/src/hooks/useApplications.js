import { useSyncExternalStore } from 'react';
import { subscribeApplications, getApplicationsSnapshot } from '../applications.js';

/** Reactive read of all application records (stable snapshot, see useVariants). */
export function useApplications() {
  return useSyncExternalStore(subscribeApplications, getApplicationsSnapshot);
}
