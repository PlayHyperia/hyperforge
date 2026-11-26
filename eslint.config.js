import js from "@eslint/js";
import typescript from "@typescript-eslint/eslint-plugin";
import typescriptParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  js.configs.recommended,
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/public/**",
      "**/libs/**",
      "**/core/libs/**",
      "packages/hyperia/src/core/libs/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
        warnOnUnsupportedTypeScriptVersion: false,
      },
      globals: {
        // Node.js globals
        global: "readonly",
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        setInterval: "readonly",
        clearTimeout: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        clearImmediate: "readonly",
        // WebAPI and Browser globals
        XRSession: "readonly",
        AudioContext: "readonly",
        GainNode: "readonly",
        AudioListener: "readonly",
        AudioNode: "readonly",
        MediaStream: "readonly",
        MediaStreamAudioSourceNode: "readonly",
        File: "readonly",
        HTMLElement: "readonly",
        HTMLCanvasElement: "readonly",
        HTMLDivElement: "readonly",
        HTMLInputElement: "readonly",
        HTMLTextAreaElement: "readonly",
        HTMLVideoElement: "readonly",
        CanvasRenderingContext2D: "readonly",
        CanvasGradient: "readonly",
        CanvasPattern: "readonly",
        CanvasImageSource: "readonly",
        MouseEvent: "readonly",
        KeyboardEvent: "readonly",
        PointerEvent: "readonly",
        TouchEvent: "readonly",
        DragEvent: "readonly",
        WheelEvent: "readonly",
        Event: "readonly",
        CustomEvent: "readonly",
        MessageEvent: "readonly",
        CloseEvent: "readonly",
        ErrorEvent: "readonly",
        PromiseRejectionEvent: "readonly",
        SecurityPolicyViolationEvent: "readonly",
        EventListener: "readonly",
        EventTarget: "readonly",
        Node: "readonly",
        Element: "readonly",
        DOMRect: "readonly",
        SVGGElement: "readonly",
        WebSocket: "readonly",
        WebGL2RenderingContext: "readonly",
        Worker: "readonly",
        Blob: "readonly",
        FormData: "readonly",
        AbortController: "readonly",
        Image: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        performance: "readonly",
        PerformanceObserver: "readonly",
        PerformanceObserverCallback: "readonly",
        PerformanceObserverEntryList: "readonly",
        PerformanceObserverInit: "readonly",
        PerformanceEntryList: "readonly",
        PerformanceResourceTiming: "readonly",
        // IndexedDB
        indexedDB: "readonly",
        IDBFactory: "readonly",
        IDBDatabase: "readonly",
        IDBOpenDBRequest: "readonly",
        IDBTransaction: "readonly",
        IDBObjectStore: "readonly",
        IDBRequest: "readonly",
        ResizeObserver: "readonly",
        MutationObserver: "readonly",
        ScrollBehavior: "readonly",
        DataTransferItem: "readonly",
        Transferable: "readonly",
        AudioBufferSourceNode: "readonly",
        PannerNode: "readonly",
        OffscreenCanvas: "readonly",
        btoa: "readonly",
        atob: "readonly",
        crypto: "readonly",
        structuredClone: "readonly",
        screen: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        self: "readonly",
        NodeJS: "readonly",
        React: "readonly",
        SVGCircleElement: "readonly",
        // requestIdleCallback API
        requestIdleCallback: "readonly",
        cancelIdleCallback: "readonly",
        IdleDeadline: "readonly",
        // WebGPU types
        GPUBindGroup: "readonly",
        GPUBindGroupEntry: "readonly",

        // Browser globals
        window: "readonly",
        Window: "readonly",
        document: "readonly",
        navigator: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        Storage: "readonly",
        fetch: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        HTMLImageElement: "readonly",
        HTMLButtonElement: "readonly",
        HTMLAnchorElement: "readonly",
        HTMLFormElement: "readonly",
        HTMLSelectElement: "readonly",
        HTMLIFrameElement: "readonly",
        alert: "readonly",
        confirm: "readonly",
        prompt: "readonly",
        ImageBitmap: "readonly",
        FileReader: "readonly",
        TexImageSource: "readonly",
        AudioBuffer: "readonly",
        AudioContextState: "readonly",
        DistanceModelType: "readonly",
        PanningModelType: "readonly",
        CSSStyleDeclaration: "readonly",

        // Cloudflare Workers / Web Platform API globals
        Request: "readonly",
        RequestInit: "readonly",
        Response: "readonly",
        Headers: "readonly",
        ReadableStream: "readonly",
        Touch: "readonly",
        TouchList: "readonly",

        // Common testing globals
        describe: "readonly",
        test: "readonly",
        it: "readonly",
        expect: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        jest: "readonly",
        vi: "readonly",

        // PhysX global
        PHYSX: "readonly",

        // WebGPU globals
        GPUAdapter: "readonly",
        GPUAdapterInfo: "readonly",
        GPUBuffer: "readonly",
        GPUBufferUsage: "readonly",
        GPUBufferUsageFlags: "readonly",
        GPUCanvasContext: "readonly",
        GPUCommandEncoder: "readonly",
        GPUComputePipeline: "readonly",
        GPUDevice: "readonly",
        GPUMapMode: "readonly",
        GPUPowerPreference: "readonly",
        GPUQueue: "readonly",
        GPURenderPipeline: "readonly",
        GPUShaderModule: "readonly",
        GPUTexture: "readonly",
        GPUTextureFormat: "readonly",
        GPUTextureUsage: "readonly",

        // WebAssembly globals
        WebAssembly: "readonly",

        // Additional DOM globals
        AbortSignal: "readonly",
        DOMException: "readonly",
        ImageData: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": typescript,
      "react-hooks": reactHooks,
    },
    rules: {
      // TypeScript rules
      "@typescript-eslint/no-unused-vars": "off",
      // TODO(AUDIT-005): Change to "error" after fixing remaining ~46 explicit any types.
      // Reduced from 142 after audit cleanup. Remaining are in: Three.js integrations, Web3 code.
      // Priority: Medium - core game logic types are now clean.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-dupe-class-members": "error", // TypeScript-aware duplicate member checking
      "@typescript-eslint/ban-ts-comment": [
        "warn",
        {
          "ts-expect-error": "allow-with-description",
          "ts-ignore": "allow-with-description",
          "ts-nocheck": "allow-with-description",
        },
      ],

      // React hooks - disabled as Three.js scenes intentionally omit deps
      "react-hooks/exhaustive-deps": "off",
      "react-hooks/rules-of-hooks": "error",

      // JavaScript rules
      "no-unused-vars": "off", // Handled by TypeScript
      "no-dupe-class-members": "off", // Handled by TypeScript - allows method overloads
      "no-undef": "warn",
      "prefer-const": "off",
      "no-var": "warn",
      "no-console": "off", // Allow console in this project
      "no-empty": ["warn", { allowEmptyCatch: true }],
      // TypeScript handles const+type pattern with same name
      "no-redeclare": "off",
      // Intentional regex for security validation (matching control characters)
      "no-control-regex": "off",

      // Common issues
      "no-constant-condition": "warn",
      "no-cond-assign": "warn",
      "no-fallthrough": "warn",
    },
  },
  {
    // Relax rules for build and configuration files
    files: [
      "**/*.config.{js,mjs,ts}",
      "**/build/**/*.{js,mjs,ts}",
      "**/scripts/**/*.{js,mjs,ts}",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-var-requires": "off",
      "no-undef": "off",
    },
  },
  {
    // Special handling for generated/vendor files
    files: [
      "**/*.d.ts",
      "**/node_modules/**/*",
      "**/dist/**/*",
      "**/build/**/*",
    ],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "no-undef": "off",
      "prefer-const": "off",
      "no-var": "off",
    },
  },
  {
    // DOM types in generics trigger no-undef in ESLint (TypeScript handles these)
    files: ["**/useEventListener.ts"],
    rules: {
      "no-undef": "off",
    },
  },
  {
    // Test files can use require() for JSON imports
    files: ["**/*.test.ts", "**/*.test.tsx", "**/__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];
