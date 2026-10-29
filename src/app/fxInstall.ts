import { useSyncExternalStore } from 'react';
import { toast } from 'sonner';

// Installing fx (fx's official installer, run by main). Module-level so an
// install keeps its progress when the model picker or Settings panel that
// started it closes, and every mount shows the same state.

type FxInstallState = { installing: boolean; error: string | null };

let state: FxInstallState = { installing: false, error: null };
let pending: Promise<boolean> | null = null;
const listeners = new Set<() => void>();

const update = (next: Partial<FxInstallState>) => {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Resolves true once fx is installed; main then refreshes models and provider status. */
export const installFx = (): Promise<boolean> => {
  pending ??= (async () => {
    update({ installing: true, error: null });
    try {
      const result = await window.orion.installFx();
      if (!result.ok) {
        update({ error: result.error ?? 'Could not install fx' });
        return false;
      }
      toast.success(result.version ? `Installed fx ${result.version}` : 'Installed fx');
      return true;
    } catch (error) {
      update({ error: error instanceof Error ? error.message : 'Could not install fx' });
      return false;
    } finally {
      update({ installing: false });
      pending = null;
    }
  })();
  return pending;
};

export const useFxInstall = () => useSyncExternalStore(subscribe, () => state);
