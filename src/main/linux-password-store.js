// Side-effect module (imported by main.js right after pin-app-identity.js, so
// before `ready` and before anything touches safeStorage).
//
// On Linux, Chromium picks safeStorage's keyring from XDG_CURRENT_DESKTOP and
// only knows the big desktops. Under a tiling compositor (Hyprland on
// Omarchy, Sway, i3, niri…) it falls back to `basic_text`, a fixed key: the
// account session is then never saved (main.js writeAccountSession) and
// remote-control pairing is refused (remote-control.js). Those setups almost
// always run a Secret Service (gnome-keyring, KeePassXC), so ask for it
// explicitly. If none answers, Chromium still falls back to basic_text, as before.
// `--password-store=…` on the command line or DURANGO_PASSWORD_STORE wins.
import { app } from 'electron';
import { linuxPasswordStore } from './linux-password-store-policy.js';

const store = linuxPasswordStore({ platform: process.platform, argv: process.argv, env: process.env });
if (store) app.commandLine.appendSwitch('password-store', store);
