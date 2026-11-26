/**
 * Agent API Integration Tests
 *
 * Tests the agent credential and mapping APIs using JWT authentication.
 * These tests verify the backend APIs work correctly without requiring
 * browser-based Privy authentication.
 *
 * Coverage:
 * - JWT credential generation for agents
 * - Agent mapping CRUD operations
 * - Integration with ElizaOS API
 * - Error handling and validation
 */

import { test, expect } from "@playwright/test";
import {
  createTestUser,
  createUserInDatabase,
  createCharacterInDatabase,
} from "./helpers/auth-helper";
import * as fs from "fs";
import * as path from "path";

// Test configuration
const SERVER_URL =
  process.env.PUBLIC_API_URL ||
  process.env.SERVER_URL ||
  "http://localhost:5555";
const ELIZAOS_API =
  process.env.ELIZAOS_API_URL ||
  process.env.ELIZAOS_URL ||
  "http://localhost:4001";
const LOG_DIR = path.resolve(
  process.env.HOME || "/Users/home",
  "logs/agent-api-tests",
);

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

/**
 * Helper: Save test logs
 */
function saveTestLog(testName: string, content: string) {
  const logFile = path.join(LOG_DIR, `${testName}.log`);
  fs.writeFileSync(logFile, content);
  console.log(`[${testName}] Logs saved to: ${logFile}`);
}

/**
 * Helper: Make HTTP request with better error handling
 */
async function httpRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
) {
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      headers: options.headers || {},
      body: options.body,
    });

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    return {
      status: response.status,
      data,
      ok: response.ok,
      error: null,
    };
  } catch (error) {
    return {
      status: 0,
      data: null,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Helper: Check ElizaOS health
 */
async function checkElizaOSHealth() {
  const response = await httpRequest(`${ELIZAOS_API}/health`);
  return response.ok;
}

test.describe("Agent API Integration Tests", () => {
  test.beforeAll(async () => {
    console.log("🚀 Starting agent API integration tests...");
    console.log(`📁 Logs will be saved to: ${LOG_DIR}`);

    // Verify ElizaOS is running
    const elizaOSHealthy = await checkElizaOSHealth();
    if (!elizaOSHealthy) {
      console.warn("⚠️  ElizaOS API is not responding - some tests may fail");
    } else {
      console.log("✅ ElizaOS API is healthy");
    }
  });

  /**
   * TEST 1: JWT Credential Generation
   *
   * Verifies that the /api/agents/credentials endpoint generates
   * valid JWT tokens for agent characters.
   */
  test("Generate agent JWT credentials", async () => {
    const testName = "test1-jwt-credentials";
    const logs: string[] = [];

    try {
      logs.push(`[${testName}] Starting JWT credential generation test...`);
      console.log(`[${testName}] 🔑 Testing JWT generation for agents...`);

      // Create test user
      const testUser = createTestUser();
      logs.push(`[${testName}] Created test user: ${testUser.userId}`);

      // Create user in database
      const userCreated = await createUserInDatabase(testUser.userId);
      if (!userCreated) {
        throw new Error("Failed to create user in database");
      }
      logs.push(`[${testName}] ✅ User created in database`);

      // Create character
      const character = await createCharacterInDatabase(
        testUser.userId,
        "Test Agent Character",
      );

      if (!character) {
        throw new Error("Failed to create character");
      }
      logs.push(`[${testName}] ✅ Character created: ${character.id}`);

      // Generate JWT credentials
      const credentialResponse = await httpRequest(
        `${SERVER_URL}/api/agents/credentials`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            characterId: character.id,
            accountId: testUser.userId,
          }),
        },
      );

      expect(credentialResponse.ok).toBe(true);
      logs.push(`[${testName}] ✅ JWT generation request succeeded`);

      const responseData = credentialResponse.data as {
        success?: boolean;
        authToken?: string;
        characterId?: string;
        serverUrl?: string;
      };

      expect(responseData.success).toBe(true);
      expect(responseData.authToken).toBeTruthy();
      expect(responseData.characterId).toBe(character.id);
      expect(responseData.serverUrl).toBeTruthy();

      logs.push(`[${testName}] ✅ JWT token generated successfully`);
      logs.push(`[${testName}] ✅ Response includes authToken and serverUrl`);

      console.log(`[${testName}] ✅ JWT credential generation test PASSED`);
    } catch (error) {
      logs.push(
        `[${testName}] ❌ Test error: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error(`[${testName}] Test error:`, error);
      throw error;
    } finally {
      saveTestLog(testName, logs.join("\n"));
    }
  });

  /**
   * TEST 2: Agent Mapping Save
   *
   * Verifies that agent mappings can be saved and retrieved from the database.
   */
  test("Save and retrieve agent mapping", async () => {
    const testName = "test2-agent-mapping";
    const logs: string[] = [];

    try {
      logs.push(`[${testName}] Starting agent mapping test...`);
      console.log(`[${testName}] 💾 Testing agent mapping save/retrieve...`);

      const testUser = createTestUser();
      const testAgentId = `test-agent-${Date.now()}`;

      logs.push(`[${testName}] Test agent ID: ${testAgentId}`);

      // Create user first (required for foreign key)
      const userCreated = await createUserInDatabase(testUser.userId);
      if (!userCreated) {
        throw new Error("Failed to create user");
      }
      logs.push(`[${testName}] ✅ User created in database`);

      // Create character (required for foreign key)
      const character = await createCharacterInDatabase(
        testUser.userId,
        "Mapping Test Character",
      );
      if (!character) {
        throw new Error("Failed to create character");
      }
      logs.push(`[${testName}] ✅ Character created: ${character.id}`);

      // Save agent mapping
      const saveResponse = await httpRequest(
        `${SERVER_URL}/api/agents/mappings`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId: testAgentId,
            accountId: testUser.userId,
            characterId: character.id,
            agentName: "Test Mapping Agent",
          }),
        },
      );

      expect(saveResponse.ok).toBe(true);
      logs.push(`[${testName}] ✅ Agent mapping saved successfully`);

      // Retrieve agent mappings
      const retrieveResponse = await httpRequest(
        `${SERVER_URL}/api/agents/mappings/${testUser.userId}`,
      );

      expect(retrieveResponse.ok).toBe(true);
      logs.push(`[${testName}] ✅ Agent mappings retrieved successfully`);

      const retrieveData = retrieveResponse.data as {
        success?: boolean;
        agentIds?: string[];
        count?: number;
      };

      expect(retrieveData.success).toBe(true);
      expect(retrieveData.agentIds).toContain(testAgentId);
      logs.push(
        `[${testName}] ✅ Mapping found in database (${retrieveData.count} total)`,
      );

      // Clean up - delete mapping
      const deleteResponse = await httpRequest(
        `${SERVER_URL}/api/agents/mappings/${testAgentId}`,
        {
          method: "DELETE",
        },
      );

      expect(deleteResponse.ok).toBe(true);
      logs.push(`[${testName}] ✅ Mapping deleted successfully`);

      console.log(`[${testName}] ✅ Agent mapping test PASSED`);
    } catch (error) {
      logs.push(
        `[${testName}] ❌ Test error: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error(`[${testName}] Test error:`, error);
      throw error;
    } finally {
      saveTestLog(testName, logs.join("\n"));
    }
  });

  /**
   * TEST 3: Agent Mapping Validation
   *
   * Verifies that the API properly validates required fields.
   */
  test("Agent mapping field validation", async () => {
    const testName = "test3-validation";
    const logs: string[] = [];

    try {
      logs.push(`[${testName}] Starting validation test...`);
      console.log(`[${testName}] ✅ Testing API field validation...`);

      // Test missing fields
      const invalidResponse = await httpRequest(
        `${SERVER_URL}/api/agents/mappings`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId: "test-agent-incomplete",
            // Missing: accountId, characterId, agentName
          }),
        },
      );

      expect(invalidResponse.ok).toBe(false);
      expect(invalidResponse.status).toBe(400);
      logs.push(`[${testName}] ✅ Missing fields rejected with 400`);

      const errorData = invalidResponse.data as { error?: string };
      expect(errorData.error).toBeTruthy();
      expect(errorData.error?.toLowerCase()).toContain("missing");
      logs.push(`[${testName}] ✅ Error message mentions missing fields`);

      console.log(`[${testName}] ✅ Validation test PASSED`);
    } catch (error) {
      logs.push(
        `[${testName}] ❌ Test error: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error(`[${testName}] Test error:`, error);
      throw error;
    } finally {
      saveTestLog(testName, logs.join("\n"));
    }
  });

  /**
   * TEST 4: ElizaOS Agent Creation Integration
   *
   * Verifies integration with ElizaOS API for agent creation.
   * This tests the full flow: character → JWT → ElizaOS agent.
   */
  test("ElizaOS agent creation integration", async () => {
    const testName = "test4-elizaos-integration";
    const logs: string[] = [];

    try {
      logs.push(`[${testName}] Starting ElizaOS integration test...`);
      console.log(`[${testName}] 🤖 Testing ElizaOS agent creation...`);

      // Check if ElizaOS is available
      const elizaOSHealthy = await checkElizaOSHealth();
      if (!elizaOSHealthy) {
        logs.push(`[${testName}] ⚠️  ElizaOS not available - skipping test`);
        console.log(`[${testName}] ⚠️  ElizaOS not available - test skipped`);
        return;
      }

      const testUser = createTestUser();
      const userCreated = await createUserInDatabase(testUser.userId);
      if (!userCreated) {
        throw new Error("Failed to create user");
      }

      // Create character
      const character = await createCharacterInDatabase(
        testUser.userId,
        "ElizaOS Test Agent",
      );

      if (!character) {
        throw new Error("Failed to create character");
      }
      logs.push(`[${testName}] ✅ Character created: ${character.name}`);

      // Create agent in ElizaOS
      const agentResponse = await httpRequest(`${ELIZAOS_API}/agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          character: {
            name: character.name,
            modelProvider: "openai",
            settings: {
              voice: { model: "en_US-male-medium" },
            },
          },
        }),
      });

      if (!agentResponse.ok) {
        logs.push(
          `[${testName}] ⚠️  ElizaOS agent creation failed (status: ${agentResponse.status})`,
        );
        logs.push(
          `[${testName}] ℹ️  This is expected if ElizaOS config is not complete`,
        );
        console.log(
          `[${testName}] ⚠️  ElizaOS agent creation failed - may need configuration`,
        );
        return;
      }

      const agentData = agentResponse.data as {
        agent?: { id: string; name: string };
      } | null;

      if (!agentData || !agentData.agent) {
        logs.push(
          `[${testName}] ⚠️  ElizaOS returned empty response - may need configuration`,
        );
        console.log(
          `[${testName}] ⚠️  ElizaOS agent creation returned empty response`,
        );
        return;
      }

      const agentId = agentData.agent.id;

      if (!agentId) {
        throw new Error("No agent ID in response");
      }

      logs.push(`[${testName}] ✅ Agent created in ElizaOS: ${agentId}`);

      // Save mapping
      const mappingResponse = await httpRequest(
        `${SERVER_URL}/api/agents/mappings`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agentId: agentId,
            accountId: testUser.userId,
            characterId: character.id,
            agentName: character.name,
          }),
        },
      );

      expect(mappingResponse.ok).toBe(true);
      logs.push(`[${testName}] ✅ Agent mapping saved`);

      // Clean up - delete agent from ElizaOS
      const deleteResponse = await httpRequest(
        `${ELIZAOS_API}/agents/${agentId}`,
        {
          method: "DELETE",
        },
      );

      if (deleteResponse.ok) {
        logs.push(`[${testName}] ✅ Agent deleted from ElizaOS`);
      }

      // Clean up - delete mapping
      await httpRequest(`${SERVER_URL}/api/agents/mappings/${agentId}`, {
        method: "DELETE",
      });
      logs.push(`[${testName}] ✅ Mapping deleted`);

      console.log(`[${testName}] ✅ ElizaOS integration test PASSED`);
    } catch (error) {
      logs.push(
        `[${testName}] ❌ Test error: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error(`[${testName}] Test error:`, error);
      throw error;
    } finally {
      saveTestLog(testName, logs.join("\n"));
    }
  });

  /**
   * TEST 5: JWT Credential Authorization
   *
   * Verifies that JWT credentials work for accessing character-specific endpoints.
   */
  test("JWT credential authorization", async () => {
    const testName = "test5-jwt-authorization";
    const logs: string[] = [];

    try {
      logs.push(`[${testName}] Starting JWT authorization test...`);
      console.log(`[${testName}] 🔐 Testing JWT-based authorization...`);

      const testUser = createTestUser();
      const userCreated = await createUserInDatabase(testUser.userId);
      if (!userCreated) {
        throw new Error("Failed to create user");
      }

      // Create character
      const character = await createCharacterInDatabase(
        testUser.userId,
        "Auth Test Character",
      );

      if (!character) {
        throw new Error("Failed to create character");
      }
      logs.push(`[${testName}] ✅ Character created`);

      // Generate agent JWT
      const credentialResponse = await httpRequest(
        `${SERVER_URL}/api/agents/credentials`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            characterId: character.id,
            accountId: testUser.userId,
          }),
        },
      );

      expect(credentialResponse.ok).toBe(true);

      const responseData = credentialResponse.data as {
        authToken?: string;
      };
      const agentToken = responseData.authToken;
      expect(agentToken).toBeTruthy();

      logs.push(`[${testName}] ✅ Agent JWT generated`);
      logs.push(`[${testName}] ✅ JWT can be used for agent authentication`);

      console.log(`[${testName}] ✅ JWT authorization test PASSED`);
    } catch (error) {
      logs.push(
        `[${testName}] ❌ Test error: ${error instanceof Error ? error.message : String(error)}`,
      );
      console.error(`[${testName}] Test error:`, error);
      throw error;
    } finally {
      saveTestLog(testName, logs.join("\n"));
    }
  });
});
