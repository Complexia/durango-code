import React, { useEffect, useState } from 'react';
import { Folder } from 'lucide-react';

export const projectIconCache = new Map<string, string | null>();
export const projectIconRequestCache = new Map<string, Promise<string | null>>();
export const ProjectIcon: React.FC<{
  projectPath: string;
  size?: number;
  className?: string;
  /** Shown when the project has no icon of its own (default: a folder). */
  fallback?: React.ReactNode;
}> = ({ projectPath, size = 14, className, fallback }) => {
  const [iconUrl, setIconUrl] = useState<string | null | undefined>(
    () => projectIconCache.get(projectPath)
  );

  useEffect(() => {
    if (!projectPath) {
      setIconUrl(null);
      return;
    }

    if (projectIconCache.has(projectPath)) {
      setIconUrl(projectIconCache.get(projectPath) ?? null);
      return;
    }

    let cancelled = false;
    if (!window.orion?.findProjectIcon) {
      setIconUrl(null);
      return;
    }

    let request = projectIconRequestCache.get(projectPath);
    if (!request) {
      const iconRequest = window.orion.findProjectIcon(projectPath).then((url) => {
        projectIconCache.set(projectPath, url);
        return url;
      });
      const sharedRequest = iconRequest.finally(() => {
        if (projectIconRequestCache.get(projectPath) === sharedRequest) {
          projectIconRequestCache.delete(projectPath);
        }
      });
      projectIconRequestCache.set(projectPath, sharedRequest);
      request = sharedRequest;
    }

    void request
      .then((url) => {
        if (!cancelled) setIconUrl(url);
      })
      .catch(() => {
        if (!cancelled) setIconUrl(null);
      });

    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  if (iconUrl) {
    return (
      <img
        src={iconUrl}
        alt=""
        className={`project-icon ${className ?? ''}`}
        width={size}
        height={size}
        draggable={false}
      />
    );
  }

  if (fallback !== undefined) return <>{fallback}</>;
  return <Folder size={size} className={className} />;
};
