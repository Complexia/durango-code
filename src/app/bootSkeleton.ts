// The boot skeleton in index.html covers the window from its first frame
// until the store has hydrated, so startup never shows an empty, project-less
// app. App removes it on hydration; a store that never finishes hydrating
// still gets the app after the fallback.
const BOOT_SKELETON_FALLBACK_MS = 10_000;

export const removeBootSkeleton = () => {
  const skeleton = document.getElementById('boot-skeleton');
  if (!skeleton || skeleton.classList.contains('boot-done')) return;
  skeleton.classList.add('boot-done');
  window.setTimeout(() => skeleton.remove(), 200);
};

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.setTimeout(removeBootSkeleton, BOOT_SKELETON_FALLBACK_MS);
}
