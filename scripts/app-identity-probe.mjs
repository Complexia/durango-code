// Electron main for scripts/test-app-identity.mjs. Bundled to CommonJS (like
// the production Vite main bundle) and run inside a throwaway app directory
// whose package.json sets the productName under test.
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import { pinInternalAppIdentity } from '../src/main/app-identity.js';

const config = JSON.parse(process.env.ORION_IDENTITY_PROBE || '{}');
const startupName = app.getName();
if (config.pin) pinInternalAppIdentity(app, { internalName: config.internalName });

const writeResult = (result) => {
  fs.writeFileSync(config.resultPath, JSON.stringify(result, null, 2));
  app.exit(0);
};

app.whenReady().then(() => {
  const result = {
    startupName,
    name: app.getName(),
    userData: app.getPath('userData'),
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
  };
  try {
    if (config.mode === 'encrypt') {
      result.ciphertext = safeStorage.encryptString(config.plaintext).toString('base64');
    } else {
      result.plaintext = safeStorage.decryptString(Buffer.from(config.ciphertext, 'base64'));
    }
  } catch (error) {
    result.error = String(error?.message || error);
  }
  writeResult(result);
});
