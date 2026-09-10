const RESERVED_HTTP_NAMESPACES = [
  "/admin",
  "/api",
  "/assets",
  "/debug",
  "/dist",
  "/game-assets",
  "/health",
  "/icons",
  "/live",
  "/manifests",
  "/status",
  "/ws",
] as const;

export function getRequestPathname(url: string): string {
  const queryIndex = url.indexOf("?");
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

export function isReservedHttpPath(pathname: string): boolean {
  return RESERVED_HTTP_NAMESPACES.some(
    (namespace) =>
      pathname === namespace || pathname.startsWith(`${namespace}/`),
  );
}

export function shouldServeSpaForRequestUrl(url: string): boolean {
  const pathname = getRequestPathname(url);
  return !isReservedHttpPath(pathname) && !/\.[a-zA-Z0-9]+$/.test(pathname);
}
