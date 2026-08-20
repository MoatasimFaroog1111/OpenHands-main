import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  extractBaseHost,
  extractPathPrefix,
  buildHttpBaseUrl,
  buildWebSocketUrl,
} from "#/utils/websocket-url";

describe("websocket-url utilities", () => {
  beforeEach(() => {
    vi.stubGlobal("location", {
      host: "localhost:3001",
      protocol: "https:",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("extractBaseHost", () => {
    it("should extract host from a standard URL", () => {
      const result = extractBaseHost(
        "https://example.com/api/conversations/123",
      );
      expect(result).toBe("example.com");
    });

    it("should extract host with port from URL", () => {
      const result = extractBaseHost(
        "http://localhost:3000/api/conversations/123",
      );
      expect(result).toBe("localhost:3000");
    });

    it("should extract host from proxy deployment URL", () => {
      const result = extractBaseHost(
        "https://openhands.example.com/runtime/55313/api/conversations/abc123",
      );
      expect(result).toBe("openhands.example.com");
    });

    it("should return window.location.host for relative URLs", () => {
      const result = extractBaseHost("/api/conversations/123");
      expect(result).toBe("localhost:3001");
    });

    it("should return window.location.host for null, undefined, or invalid URL", () => {
      expect(extractBaseHost(null)).toBe("localhost:3001");
      expect(extractBaseHost(undefined)).toBe("localhost:3001");
      expect(extractBaseHost("not-a-valid-url")).toBe("localhost:3001");
    });
  });

  describe("extractPathPrefix", () => {
    it("should return empty string for URL without path prefix", () => {
      const result = extractPathPrefix(
        "https://example.com/api/conversations/123",
      );
      expect(result).toBe("");
    });

    it("should extract path prefix from proxy deployment URL", () => {
      const result = extractPathPrefix(
        "https://openhands.example.com/runtime/55313/api/conversations/abc123",
      );
      expect(result).toBe("/runtime/55313");
    });

    it("should handle multiple path segments before /api/conversations", () => {
      const result = extractPathPrefix(
        "https://example.com/prefix/sub/path/api/conversations/123",
      );
      expect(result).toBe("/prefix/sub/path");
    });

    it("should remove trailing slash from path prefix", () => {
      // This test ensures the function handles URLs where the path ends with /
      const result = extractPathPrefix(
        "https://example.com/runtime/55313/api/conversations/123",
      );
      expect(result).not.toMatch(/\/$/);
    });

    it("should return empty string for relative URLs, null, undefined, or invalid URL", () => {
      expect(extractPathPrefix("/api/conversations/123")).toBe("");
      expect(extractPathPrefix(null)).toBe("");
      expect(extractPathPrefix(undefined)).toBe("");
      expect(extractPathPrefix("not-a-valid-url")).toBe("");
    });

    it("should extract the prefix from a root relative same origin URL", () => {
      // Single port hosts (Railway, Render, Fly, ...) reverse proxy the
      // sandbox under the app origin and hand the web client a relative URL.
      expect(extractPathPrefix("/runtime/8000/api/conversations/abc123")).toBe(
        "/runtime/8000",
      );
    });
  });

  describe("buildHttpBaseUrl", () => {
    it("should build HTTP URL without path prefix", () => {
      const result = buildHttpBaseUrl(
        "https://example.com/api/conversations/123",
      );
      expect(result).toBe("https://example.com");
    });

    it("should build HTTP URL with path prefix for proxy deployment", () => {
      const result = buildHttpBaseUrl(
        "https://openhands.example.com/runtime/55313/api/conversations/abc123",
      );
      expect(result).toBe("https://openhands.example.com/runtime/55313");
    });

    it("should use http protocol when window.location.protocol is http:", () => {
      vi.stubGlobal("location", {
        host: "localhost:3001",
        protocol: "http:",
      });

      const result = buildHttpBaseUrl(
        "http://localhost:3000/api/conversations/123",
      );
      expect(result).toBe("http://localhost:3000");
    });

    it("should fallback to window.location for null URL", () => {
      const result = buildHttpBaseUrl(null);
      expect(result).toBe("https://localhost:3001");
    });

    it("should build a same origin URL from a root relative conversation URL", () => {
      const result = buildHttpBaseUrl("/runtime/8000/api/conversations/abc123");
      expect(result).toBe("https://localhost:3001/runtime/8000");
    });
  });

  describe("buildWebSocketUrl", () => {
    it("should return null when conversationId is undefined or empty", () => {
      expect(
        buildWebSocketUrl(
          undefined,
          "https://example.com/api/conversations/123",
        ),
      ).toBeNull();
      expect(
        buildWebSocketUrl("", "https://example.com/api/conversations/123"),
      ).toBeNull();
    });

    it("should build WebSocket URL without path prefix", () => {
      const result = buildWebSocketUrl(
        "conv-123",
        "https://example.com/api/conversations/conv-123",
      );
      expect(result).toBe("wss://example.com/sockets/events/conv-123");
    });

    it("should build WebSocket URL with path prefix for proxy deployment", () => {
      const result = buildWebSocketUrl(
        "abc123",
        "https://openhands.example.com/runtime/55313/api/conversations/abc123",
      );
      expect(result).toBe(
        "wss://openhands.example.com/runtime/55313/sockets/events/abc123",
      );
    });

    it("should keep the sandbox reachable when the conversation URL is root relative", () => {
      // Regression: single port hosts only publish the app server port, so a
      // loopback conversation URL produced an unreachable wss://host:8000/...
      // and the UI hung on "Disconnected". The app server now advertises a
      // same origin /runtime/{port} path instead.
      const result = buildWebSocketUrl(
        "abc123",
        "/runtime/8000/api/conversations/abc123",
      );
      expect(result).toBe(
        "wss://localhost:3001/runtime/8000/sockets/events/abc123",
      );
    });

    it("should use ws protocol when window.location.protocol is http:", () => {
      vi.stubGlobal("location", {
        host: "localhost:3001",
        protocol: "http:",
      });

      const result = buildWebSocketUrl(
        "conv-123",
        "http://localhost:3000/api/conversations/conv-123",
      );
      expect(result).toBe("ws://localhost:3000/sockets/events/conv-123");
    });

    it("should fallback to window.location.host for null URL", () => {
      const result = buildWebSocketUrl("conv-123", null);
      expect(result).toBe("wss://localhost:3001/sockets/events/conv-123");
    });

    it("should handle complex path prefixes", () => {
      const result = buildWebSocketUrl(
        "test-conv",
        "https://app.example.com/org/team/runtime/12345/api/conversations/test-conv",
      );
      expect(result).toBe(
        "wss://app.example.com/org/team/runtime/12345/sockets/events/test-conv",
      );
    });
  });
});
