/**
 * Centralized API Client
 *
 * Provides fetch wrappers that automatically add Authorization headers
 * for authenticated API calls. Uses PrivyAuthManager for token retrieval,
 * which caches tokens from Privy SDK's getAccessToken().
 *
 * Security features:
 * - CSRF token support for state-changing requests
 * - Automatic credential inclusion for cookie-based auth
 * - Token retrieval via PrivyAuthManager (cached from Privy SDK)
 * - Support for async fresh token retrieval
 *
 * @example
 * ```typescript
 * import { apiClient } from "@/lib/api-client";
 *
 * // GET request with auth
 * const data = await apiClient.get("/api/characters");
 *
 * // POST request with auth
 * const result = await apiClient.post("/api/agents", { name: "MyAgent" });
 *
 * // For requests that don't need auth, use apiClient.fetch with includeAuth: false
 * const publicData = await apiClient.fetch("/api/public", { includeAuth: false });
 * ```
 */

import { GAME_API_URL } from "./api-config";
import { privyAuthManager } from "../auth/PrivyAuthManager";
import { showNetworkErrorNotification } from "../ui/stores/notificationStore";

/** CSRF token cache */
let csrfToken: string | null = null;
let csrfTokenExpiry: number = 0;
const CSRF_TOKEN_TTL = 300000; // 5 minutes

/**
 * Get the current auth token from PrivyAuthManager
 *
 * Uses the cached token from PrivyAuthManager, which is populated by
 * PrivyAuthProvider using Privy SDK's getAccessToken(). This is preferred
 * over direct localStorage access for better security and consistency.
 *
 * @returns The access token or null if not authenticated
 */
function getAuthToken(): string | null {
  try {
    // Use PrivyAuthManager for token retrieval (cached from Privy SDK)
    const token = privyAuthManager.getToken();
    if (token) {
      return token;
    }
    // Fallback to localStorage for backward compatibility during initialization
    // This handles the race condition where PrivyAuthManager hasn't been initialized yet
    return localStorage.getItem("privy_auth_token");
  } catch {
    // localStorage may not be available (SSR, etc.)
    return null;
  }
}

export function getApiAuthorizationHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Async token provider type for fresh token retrieval
 * Use this with components that have access to Privy's usePrivy() hook
 */
export type AsyncTokenProvider = () => Promise<string | null>;

/**
 * Set an async token provider for fresh token retrieval
 * This should be called from PrivyAuthProvider with getAccessToken
 */
let asyncTokenProvider: AsyncTokenProvider | null = null;

/**
 * Register an async token provider (typically Privy's getAccessToken)
 * This allows the API client to fetch fresh tokens when needed
 */
export function setAsyncTokenProvider(provider: AsyncTokenProvider): void {
  asyncTokenProvider = provider;
}

/**
 * Get a fresh auth token using the async provider if available
 * Falls back to cached token if no async provider is set
 */
async function getFreshAuthToken(): Promise<string | null> {
  if (asyncTokenProvider) {
    try {
      const token = await asyncTokenProvider();
      if (token) {
        return token;
      }
    } catch (error) {
      console.warn("[API Client] Failed to get fresh token:", error);
    }
  }
  // Fallback to cached token
  return getAuthToken();
}

/** Whether to enforce CSRF tokens for state-changing requests */
let enforceCsrf = true;

/**
 * Set whether CSRF tokens should be enforced
 * In development mode, this can be disabled if the server doesn't have CSRF endpoint
 * @param enforce - Whether to require CSRF tokens
 */
export function setEnforceCsrf(enforce: boolean): void {
  enforceCsrf = enforce;
}

/**
 * Fetch or return cached CSRF token
 * CSRF tokens are used for state-changing requests (POST, PUT, DELETE, PATCH)
 *
 * @returns CSRF token or throws if enforcement is enabled and token unavailable
 */
async function getCsrfToken(): Promise<string | null> {
  const now = Date.now();

  // Return cached token if still valid
  if (csrfToken && csrfTokenExpiry > now) {
    return csrfToken;
  }

  try {
    // Fetch new CSRF token from server
    const response = await fetch(`${GAME_API_URL}/api/csrf-token`, {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
      },
    });

    if (response.ok) {
      const data = (await response.json()) as {
        csrfToken?: string;
        token?: string;
      };
      const token = data.csrfToken ?? data.token;
      if (token) {
        csrfToken = token;
        csrfTokenExpiry = now + CSRF_TOKEN_TTL;
        return csrfToken;
      }
    }

    // Server returned non-200 or no token
    if (enforceCsrf) {
      console.warn(
        "[API Client] CSRF token fetch failed - state-changing requests may be rejected",
      );
    }
  } catch (error) {
    // CSRF endpoint may not exist yet
    if (enforceCsrf) {
      console.warn(
        "[API Client] CSRF token endpoint unavailable:",
        error instanceof Error ? error.message : "Unknown error",
      );
    }
  }

  return null;
}

/**
 * Clear cached CSRF token (call on logout)
 */
export function clearCsrfToken(): void {
  csrfToken = null;
  csrfTokenExpiry = 0;
}

/**
 * Options for API client requests
 */
export interface ApiClientOptions extends Omit<RequestInit, "body"> {
  /** Request body (will be JSON stringified if object) */
  body?: unknown;
  /** Whether to include Authorization header (default: true) */
  includeAuth?: boolean;
  /** Whether to fetch a fresh token using async provider (default: false for performance) */
  useFreshToken?: boolean;
  /** Base URL override (default: GAME_API_URL) */
  baseUrl?: string;
  /** Whether to show user notification on error (default: false) */
  showErrorNotification?: boolean;
  /** Context for error notification (e.g., "loading inventory") */
  errorContext?: string;
}

/**
 * API response with typed data
 */
export interface ApiResponse<T = unknown> {
  /** Whether the request was successful (2xx status) */
  ok: boolean;
  /** HTTP status code */
  status: number;
  /** Response data (parsed JSON or null) */
  data: T | null;
  /** Error message if request failed */
  error?: string;
}

/**
 * Make an authenticated API request
 *
 * @param endpoint - API endpoint (relative to baseUrl)
 * @param options - Fetch options with extensions
 * @returns Promise resolving to typed API response
 */
async function apiFetch<T = unknown>(
  endpoint: string,
  options: ApiClientOptions = {},
): Promise<ApiResponse<T>> {
  const {
    includeAuth = true,
    useFreshToken = false,
    baseUrl = GAME_API_URL,
    showErrorNotification = false,
    errorContext,
    body,
    headers: customHeaders,
    ...fetchOptions
  } = options;

  // Determine if this is a state-changing request that needs CSRF protection
  const method = (fetchOptions.method || "GET").toUpperCase();
  const needsCsrf = ["POST", "PUT", "PATCH", "DELETE"].includes(method);

  // Build headers
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(customHeaders as Record<string, string>),
  };

  // Add Authorization header if authenticated and requested
  if (includeAuth) {
    // Use fresh token for sensitive operations, cached token for regular requests
    const token = useFreshToken ? await getFreshAuthToken() : getAuthToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }
  }

  // Add CSRF token for state-changing requests
  if (needsCsrf) {
    const csrf = await getCsrfToken();
    if (csrf) {
      headers["X-CSRF-Token"] = csrf;
    } else if (enforceCsrf) {
      // Log warning when CSRF token is unavailable for state-changing request
      console.warn(
        `[API Client] State-changing request to ${endpoint} without CSRF token - request may be rejected`,
      );
    }
  }

  // Build full URL
  const url = endpoint.startsWith("http")
    ? endpoint
    : `${baseUrl}${endpoint.startsWith("/") ? "" : "/"}${endpoint}`;

  try {
    const response = await fetch(url, {
      ...fetchOptions,
      headers,
      credentials: "include", // Always include credentials for cookie-based auth
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    // Try to parse JSON response
    let data: T | null = null;
    let errorMessage: string | undefined;

    try {
      const text = await response.text();
      if (text) {
        data = JSON.parse(text) as T;
      }
    } catch {
      // Response is not JSON, that's okay
    }

    if (!response.ok) {
      // Extract error message from response data
      const errorData = data as { error?: string; message?: string } | null;
      errorMessage =
        errorData?.error ||
        errorData?.message ||
        `HTTP ${response.status}: ${response.statusText}`;

      // Show user notification if requested
      if (showErrorNotification) {
        showNetworkErrorNotification(
          new Error(errorMessage),
          errorContext || endpoint,
        );
      }
    }

    return {
      ok: response.ok,
      status: response.status,
      data: response.ok ? data : null,
      error: errorMessage,
    };
  } catch (error) {
    // Network error or other failure
    const message =
      error instanceof Error ? error.message : "Network request failed";
    console.error(`[API Client] Request failed: ${url}`, error);

    // Show user notification if requested
    if (showErrorNotification) {
      showNetworkErrorNotification(error, errorContext || endpoint);
    }

    return {
      ok: false,
      status: 0,
      data: null,
      error: message,
    };
  }
}

/**
 * Centralized API client with automatic auth headers
 */
export const apiClient = {
  /**
   * Make a generic fetch request
   */
  fetch: apiFetch,

  /**
   * GET request with automatic auth
   */
  async get<T = unknown>(
    endpoint: string,
    options: Omit<ApiClientOptions, "method" | "body"> = {},
  ): Promise<ApiResponse<T>> {
    return apiFetch<T>(endpoint, { ...options, method: "GET" });
  },

  /**
   * POST request with automatic auth
   */
  async post<T = unknown>(
    endpoint: string,
    body?: unknown,
    options: Omit<ApiClientOptions, "method" | "body"> = {},
  ): Promise<ApiResponse<T>> {
    return apiFetch<T>(endpoint, { ...options, method: "POST", body });
  },

  /**
   * PUT request with automatic auth
   */
  async put<T = unknown>(
    endpoint: string,
    body?: unknown,
    options: Omit<ApiClientOptions, "method" | "body"> = {},
  ): Promise<ApiResponse<T>> {
    return apiFetch<T>(endpoint, { ...options, method: "PUT", body });
  },

  /**
   * PATCH request with automatic auth
   */
  async patch<T = unknown>(
    endpoint: string,
    body?: unknown,
    options: Omit<ApiClientOptions, "method" | "body"> = {},
  ): Promise<ApiResponse<T>> {
    return apiFetch<T>(endpoint, { ...options, method: "PATCH", body });
  },

  /**
   * DELETE request with automatic auth
   */
  async delete<T = unknown>(
    endpoint: string,
    options: Omit<ApiClientOptions, "method" | "body"> = {},
  ): Promise<ApiResponse<T>> {
    return apiFetch<T>(endpoint, { ...options, method: "DELETE" });
  },

  /**
   * Check if user is currently authenticated
   */
  isAuthenticated(): boolean {
    return privyAuthManager.isAuthenticated() || getAuthToken() !== null;
  },

  /**
   * Get the user ID from PrivyAuthManager
   */
  getUserId(): string | null {
    return privyAuthManager.getUserId();
  },
};
