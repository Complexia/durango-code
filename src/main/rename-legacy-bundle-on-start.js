// Side-effect module: main.js imports this right after pin-app-identity.js so
// a legacy /Applications/Orion.app renames itself to "Durango Code.app" and
// relaunches before any window, lock or helper process exists. See
// legacy-bundle-rename.js.
import { app } from 'electron';
import { renameLegacyBundleAndRelaunch } from './legacy-bundle-rename.js';

renameLegacyBundleAndRelaunch(app);
