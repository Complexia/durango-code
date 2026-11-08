// Which --password-store Durango Code asks Chromium for on Linux
// (linux-password-store.js). Pure, for tests.

const KNOWN_DESKTOPS = /(gnome|unity|kde|plasma|xfce|cinnamon|pantheon|deepin|ukui|lxqt|budgie|mate)/;
const STORES = new Set(['basic', 'gnome-libsecret', 'kwallet', 'kwallet5', 'kwallet6']);

/** The --password-store to set, or null to leave Chromium's choice. */
export const linuxPasswordStore = ({ platform, argv = [], env = {} }) => {
  if (platform !== 'linux') return null;
  if (argv.some((arg) => arg === '--password-store' || arg.startsWith('--password-store='))) return null;
  const override = String(env.DURANGO_PASSWORD_STORE ?? '').trim();
  if (override) return STORES.has(override) ? override : null;
  const desktop = `${env.XDG_CURRENT_DESKTOP ?? ''}:${env.DESKTOP_SESSION ?? ''}`.toLowerCase();
  if (KNOWN_DESKTOPS.test(desktop)) return null;
  return 'gnome-libsecret';
};
