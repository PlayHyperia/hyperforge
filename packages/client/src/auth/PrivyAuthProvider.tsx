/**
 * Privy Authentication Provider
 * Wraps the application with Privy authentication context.
 * Supports both Ethereum and Solana wallets including Mobile Wallet Adapter (MWA).
 *
 * Config follows latest Privy SDK patterns:
 * - walletChainType: 'ethereum-and-solana' for multi-chain support
 * - Separate detected_ethereum_wallets / detected_solana_wallets (detected_wallets is deprecated)
 * - solana.rpcs for embedded wallet transaction signing
 * - toSolanaWalletConnectors for external Solana wallet connections
 */

import React, { useEffect, useCallback } from "react";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { createSolanaRpc, createSolanaRpcSubscriptions } from "@solana/kit";
import { privyAuthManager } from "./PrivyAuthManager";
import { setAsyncTokenProvider } from "../lib/api-client";
import { logger } from "../lib/logger";
import { GAME_API_URL } from "../lib/api-config";
import {
  getPublicRuntimeEnv,
  isConfiguredPrivyAppId,
  resolvePublicEnvValue,
  resolvePrivyAppId,
} from "../lib/publicEnv";

type PrivyAuthProviderProps = {
  children: React.ReactNode;
};

/**
 * Inner component that handles Privy hooks
 */
function PrivyAuthHandler({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, user, getAccessToken, logout } = usePrivy();

  // Memoize the token provider to avoid unnecessary re-registrations
  const tokenProvider = useCallback(async () => {
    try {
      return await getAccessToken();
    } catch (error) {
      logger.warn("[PrivyAuthHandler] Failed to get access token:", error);
      return null;
    }
  }, [getAccessToken]);

  // Register the async token provider for API client
  // This allows the API client to fetch fresh tokens when needed
  useEffect(() => {
    if (ready && authenticated) {
      setAsyncTokenProvider(tokenProvider);
      logger.debug("[PrivyAuthHandler] Registered async token provider");
    }
  }, [ready, authenticated, tokenProvider]);

  // Set privySdkReady when Privy SDK finishes initializing
  // This gates auth-dependent logic in App to prevent race conditions
  useEffect(() => {
    if (ready) {
      privyAuthManager.setPrivySdkReady(true);
    }
  }, [ready]);

  useEffect(() => {
    const updateAuth = async () => {
      if (ready && authenticated && user) {
        const token = await getAccessToken();
        if (!token) {
          logger.warn("[PrivyAuthProvider] getAccessToken returned null");
          return;
        }
        privyAuthManager.setAuthenticatedUser(user, token);
      } else if (ready && !authenticated) {
        privyAuthManager.clearAuth();
      }
    };

    updateAuth();
  }, [ready, authenticated, user, getAccessToken]);

  // Handle logout
  useEffect(() => {
    const handleLogout = async () => {
      await logout();
      privyAuthManager.clearAuth();
    };

    const windowWithLogout = window as typeof window & {
      privyLogout: () => void;
    };
    windowWithLogout.privyLogout = handleLogout;
  }, [logout]);

  return <>{children}</>;
}

/**
 * Solana wallet connectors for external wallets (Phantom, Solflare, MWA, etc.)
 * See: https://docs.privy.io/wallets/connectors/setup/configuring-external-connector-chains
 */
const solanaConnectors = toSolanaWalletConnectors({
  shouldAutoConnect: true,
});

type SolanaCluster = "mainnet-beta" | "devnet" | "testnet" | "localnet";

function normalizeSolanaCluster(rawValue: string | undefined): SolanaCluster {
  const normalized = (rawValue || "").trim().toLowerCase();
  if (normalized === "mainnet" || normalized === "mainnet-beta") {
    return "mainnet-beta";
  }
  if (normalized === "devnet" || normalized === "testnet") {
    return normalized;
  }
  if (normalized === "localnet" || normalized === "local") {
    return "localnet";
  }
  return "mainnet-beta";
}

function getDefaultRpcUrl(cluster: SolanaCluster): string {
  if (cluster === "mainnet-beta") {
    const base = GAME_API_URL.replace(/\/$/, "");
    return `${base}/api/proxy/solana/rpc?cluster=mainnet-beta`;
  }
  if (cluster === "localnet") {
    return "http://127.0.0.1:8899";
  }
  return `https://api.${cluster}.solana.com`;
}

function getDefaultWsUrl(cluster: SolanaCluster): string {
  if (cluster === "mainnet-beta") {
    const host = GAME_API_URL.replace(/\/$/, "").replace(/^http/, "ws");
    return `${host}/api/proxy/solana/ws?cluster=mainnet-beta`;
  }
  if (cluster === "localnet") {
    return "ws://127.0.0.1:8900";
  }
  return `wss://api.${cluster}.solana.com`;
}

const solanaCluster = normalizeSolanaCluster(
  resolvePublicEnvValue(
    getPublicRuntimeEnv()?.PUBLIC_SOLANA_NETWORK,
    import.meta.env.PUBLIC_SOLANA_NETWORK,
  ),
);
const solanaRpcUrl =
  resolvePublicEnvValue(
    getPublicRuntimeEnv()?.PUBLIC_SOLANA_RPC_URL,
    import.meta.env.PUBLIC_SOLANA_RPC_URL,
  ) || getDefaultRpcUrl(solanaCluster);
const solanaWsUrl =
  resolvePublicEnvValue(
    getPublicRuntimeEnv()?.PUBLIC_SOLANA_WS_URL,
    import.meta.env.PUBLIC_SOLANA_WS_URL,
  ) || getDefaultWsUrl(solanaCluster);

export function PrivyAuthProvider({ children }: PrivyAuthProviderProps) {
  const appId = resolvePrivyAppId(import.meta.env.PUBLIC_PRIVY_APP_ID);
  const isValidAppId = isConfiguredPrivyAppId(appId);

  if (!isValidAppId) {
    logger.warn(
      "[PrivyAuthProvider] No valid Privy App ID configured. Authentication disabled.",
    );
    logger.warn(
      "[PrivyAuthProvider] To enable authentication, set PUBLIC_PRIVY_APP_ID in your .env file",
    );
    logger.warn(
      "[PrivyAuthProvider] Get your App ID from https://dashboard.privy.io/",
    );
    return <>{children}</>;
  }

  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ["wallet", "email", "google", "farcaster"],
        appearance: {
          theme: "dark",
          accentColor: "#d4af37",
          logo: "/images/hyperia-wordmark.svg",
          walletChainType: "ethereum-and-solana",
          walletList: [
            // Solana wallets (prioritized for Saga/Seeker)
            "phantom",
            "solflare",
            "backpack",
            // Ethereum wallets
            "metamask",
            "coinbase_wallet",
            "rainbow",
            // Auto-detect installed wallets (MWA, Wallet Standard, browser extensions)
            "detected_ethereum_wallets",
            "detected_solana_wallets",
            // WalletConnect QR (covers both EVM and Solana via walletChainType)
            "wallet_connect_qr",
          ],
        },
        embeddedWallets: {
          ethereum: {
            createOnLogin: "users-without-wallets" as const,
          },
          solana: {
            createOnLogin: "users-without-wallets" as const,
          },
        },
        // External wallet connectors including Solana MWA
        externalWallets: {
          solana: {
            connectors: solanaConnectors,
          },
        },
        // Solana RPC config for embedded wallet transaction signing
        // See: https://docs.privy.io/basics/react/advanced/configuring-solana-networks
        solana: {
          rpcs: {
            "solana:mainnet": {
              rpc: createSolanaRpc(solanaRpcUrl),
              rpcSubscriptions: createSolanaRpcSubscriptions(solanaWsUrl),
            },
            "solana:devnet": {
              rpc: createSolanaRpc("https://api.devnet.solana.com"),
              rpcSubscriptions: createSolanaRpcSubscriptions(
                "wss://api.devnet.solana.com",
              ),
            },
          },
        },
        mfa: {
          noPromptOnMfaRequired: false,
        },
      }}
    >
      <PrivyAuthHandler>{children}</PrivyAuthHandler>
    </PrivyProvider>
  );
}
