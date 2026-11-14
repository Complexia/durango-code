import { app } from 'electron';
import path from 'node:path';

export const storageFileName = 'orion-store.json';
export const threadsFileName = 'orion-threads.json';
export const threadsDirectoryName = 'orion-threads';
export const accountSessionFileName = 'orion-account-session.json';
// Workspace sync's record of the projects and threads this machine has synced.
export const syncLedgerFileName = 'orion-sync-ledger.json';
export const attachmentDirectoryName = 'attachments';
// Working directory for agents started with "No project" selected.
export const noProjectDirectoryName = 'chats';
export const attachmentProtocol = 'orion-attachment';
export const appProtocol = 'orion';
export const getStorageFilePath = () => path.join(app.getPath('userData'), storageFileName);
export const getThreadsFilePath = () => path.join(app.getPath('userData'), threadsFileName);
export const getThreadsDirectoryPath = () => path.join(app.getPath('userData'), threadsDirectoryName);
export const getAccountSessionFilePath = () => path.join(app.getPath('userData'), accountSessionFileName);
export const getSyncLedgerFilePath = () => path.join(app.getPath('userData'), syncLedgerFileName);
export const getAttachmentDirectoryPath = () => path.join(app.getPath('userData'), attachmentDirectoryName);
export const getNoProjectDirectoryPath = () => path.join(app.getPath('userData'), noProjectDirectoryName);
