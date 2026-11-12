// Side-effect module: main.js imports this right after pin-app-identity.js (so
// userData, where the CLI launchers live, is already pinned) and before any
// window, single-instance lock or helper process exists. When the app binary
// was started as the `durango-code` CLI (cli-argv.js: /usr/bin/durango-code on
// Linux is the app), run the bundled CLI in this terminal and exit with its
// code; the rest of the app never starts.
import { app } from 'electron';
import path from 'node:path';
import { devUserDataPath } from './app-identity.js';
import { cliArgsFromArgv } from './cli-argv.js';
import { runBundledCliInForeground } from './bundled-cli.js';

const cliArgs = cliArgsFromArgv(process.argv, { defaultApp: Boolean(process.defaultApp) });
if (cliArgs) {
  // A dev build writes its launchers into its own profile, as main.js does
  // for dev runs, never over the installed app's (which would then run this
  // checkout's CLI).
  if (!app.isPackaged) {
    app.setPath(
      'userData',
      process.env.ORION_DEV_USER_DATA
        ? path.resolve(process.env.ORION_DEV_USER_DATA)
        : devUserDataPath(app.getPath('userData'))
    );
  }
  process.exit(runBundledCliInForeground(cliArgs));
}
