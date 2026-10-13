import fs from 'node:fs/promises';

export const missingAgentWorkspaceError = (projectPath) =>
  `This thread's workspace no longer exists: ${projectPath}. Recreate the Rift or start a new thread in an existing project.`;

const inaccessibleAgentWorkspaceError = (projectPath, error) =>
  `Durango Code could not access this thread's workspace: ${projectPath}. ${error instanceof Error ? error.message : String(error)}`;

export const validateAgentWorkspace = async (projectPath, stat = fs.stat) => {
  try {
    const result = await stat(projectPath);
    return result?.isDirectory?.() ? null : missingAgentWorkspaceError(projectPath);
  } catch (error) {
    return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
      ? missingAgentWorkspaceError(projectPath)
      : inaccessibleAgentWorkspaceError(projectPath, error);
  }
};
