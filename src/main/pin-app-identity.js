// Side-effect module: main.js imports this FIRST so the internal "Orion" app
// name and legacy userData path are in place before any other module's
// top-level code runs (ES module bodies evaluate in import order). See
// app-identity.js and docs/durango-rebrand.md.
import { app } from 'electron';
import { APP_BUNDLE_ID, pinInternalAppIdentity } from './app-identity.js';

pinInternalAppIdentity(app);
app.setAppUserModelId(APP_BUNDLE_ID);
