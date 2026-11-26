import type { NextConfig } from "next";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(projectRoot, "../..");

const config: NextConfig = {
  agentRules: false,
  output: "export",
  turbopack: {
    root: workspaceRoot,
  },
  images: {
    unoptimized: true,
    qualities: [75, 90],
  },
  trailingSlash: true,
  transpilePackages: [
    "three",
    "@react-three/fiber",
    "@react-three/drei",
    "@react-three/postprocessing",
  ],
  typescript: {
    // R3F types don't work with jsx: preserve (Next.js requirement)
    // The code works at runtime, but tsc has issues with JSX.IntrinsicElements
    ignoreBuildErrors: true,
  },
};

export default config;
