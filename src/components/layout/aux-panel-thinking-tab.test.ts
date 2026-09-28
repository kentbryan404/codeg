import { describe, expect, it, vi } from "vitest"
import { listDirectoryWithFiles, readFilePreview } from "@/lib/api"

vi.mock("@/lib/api", () => ({
  listDirectoryWithFiles: vi.fn(),
  readFilePreview: vi.fn(),
}))

import type { ContentBlock, MessageTurn } from "@/lib/types"
import type { ConversationTimelineTurn } from "@/stores/conversation-runtime-store"
import {
  collectMemoryEntries,
  collectThinkingSegments,
  firstPresentRule,
  formatCompactTokens,
  previewLine,
  resolveFileInDir,
  turnMetrics,
} from "./aux-panel-thinking-tab"

function assistantTurn(id: string, blocks: ContentBlock[]): MessageTurn {
  return {
    id,
    role: "assistant",
    blocks,
    timestamp: "2026-01-01T10:00:00.000Z",
  }
}

function entry(
  key: string,
  turn: MessageTurn,
  phase: ConversationTimelineTurn["phase"]
): ConversationTimelineTurn {
  return { key, turn, phase }
}

describe("collectThinkingSegments", () => {
  it("collects thinking blocks in timeline order and numbers episodes", () => {
    const segments = collectThinkingSegments([
      entry(
        "a",
        assistantTurn("t1", [
          { type: "thinking", text: "first thought" },
          { type: "text", text: "answer" },
          { type: "thinking", text: "second thought" },
        ]),
        "persisted"
      ),
      entry(
        "b",
        assistantTurn("t2", [{ type: "thinking", text: "third thought" }]),
        "persisted"
      ),
    ])

    expect(segments.map((s) => s.text)).toEqual([
      "first thought",
      "second thought",
      "third thought",
    ])
    expect(segments.map((s) => s.episode)).toEqual([1, 2, 3])
  })

  it("marks only the streaming turn's blocks live", () => {
    const segments = collectThinkingSegments([
      entry(
        "done",
        assistantTurn("t1", [{ type: "thinking", text: "settled" }]),
        "persisted"
      ),
      entry(
        "live",
        assistantTurn("t2", [{ type: "thinking", text: "still writing" }]),
        "streaming"
      ),
    ])

    expect(segments.map((s) => s.live)).toEqual([false, true])
  })

  it("drops blank blocks without renumbering later siblings", () => {
    // A model emits empty thinking blocks as separators; the skipped block's
    // slot must not shift its siblings' keys (a later delta filling it in
    // would otherwise remount the wrong episode).
    const segments = collectThinkingSegments([
      entry(
        "a",
        assistantTurn("t1", [
          { type: "thinking", text: "kept" },
          { type: "thinking", text: "  " },
          { type: "thinking", text: "also kept" },
        ]),
        "streaming"
      ),
    ])

    expect(segments.map((s) => s.text)).toEqual(["kept", "also kept"])
    // Keyed by the TURN id (stable across a settle), with the skipped block's
    // index still consumed: "t1:0" then "t1:2", never "t1:1".
    expect(segments.map((s) => s.key)).toEqual(["t1:0", "t1:2"])
  })
})

describe("firstPresentRule", () => {
  it("returns the first candidate the folder actually has", () => {
    // Claude's own convention wins over the generic fallback even though both
    // are present — the order of `candidates` is the priority.
    expect(
      firstPresentRule(
        ["CLAUDE.md", "AGENTS.md"],
        new Set(["AGENTS.md", "CLAUDE.md"])
      )
    ).toBe("CLAUDE.md")
  })

  it("falls through to the next candidate when the first is absent", () => {
    expect(
      firstPresentRule(["CLAUDE.md", "AGENTS.md"], new Set(["AGENTS.md"]))
    ).toBe("AGENTS.md")
  })

  it("returns null when the folder has none of them", () => {
    expect(firstPresentRule(["AGENTS.md"], new Set(["README.md"]))).toBeNull()
  })
})

describe("turnMetrics", () => {
  it("derives cache share, throughput and tool/failure counts", () => {
    const metrics = turnMetrics({
      id: "t1",
      role: "assistant",
      blocks: [
        { type: "thinking", text: "12345" },
        { type: "text", text: "12345" },
        {
          type: "tool_use",
          tool_use_id: "a",
          tool_name: "Read",
          input_preview: null,
        },
        {
          type: "tool_result",
          tool_use_id: "a",
          output_preview: null,
          is_error: true,
        },
      ],
      timestamp: "2026-01-01T10:00:00.000Z",
      completed_at: "2026-01-01T10:00:08.000Z",
      duration_ms: 8000,
      model: "m1",
      usage: {
        input_tokens: 100,
        output_tokens: 400,
        cache_read_input_tokens: 700,
        cache_creation_input_tokens: 200,
      },
    })

    expect(metrics.model).toBe("m1")
    // 700 / (100 + 700 + 200)
    expect(metrics.cacheHitRate).toBeCloseTo(0.7)
    // 400 tokens over 8s
    expect(metrics.tokensPerSecond).toBeCloseTo(50)
    expect(metrics.toolCalls).toBe(1)
    expect(metrics.toolFailures).toBe(1)
    // Chars, not tokens — the share is an approximation by construction.
    expect(metrics.thinkingCharShare).toBeCloseTo(0.5)
    expect(metrics.completedAt).toBe("2026-01-01T10:00:08.000Z")
  })

  it("keeps absent numbers as null instead of inventing zeros", () => {
    const metrics = turnMetrics({
      id: "t2",
      role: "assistant",
      blocks: [{ type: "thinking", text: "x" }],
      timestamp: "2026-01-01T10:00:00.000Z",
    })
    expect(metrics.inputTokens).toBeNull()
    expect(metrics.cacheHitRate).toBeNull()
    expect(metrics.tokensPerSecond).toBeNull()
    expect(metrics.durationMs).toBeNull()
    // The char-based share still works from the blocks that exist.
    expect(metrics.thinkingCharShare).toBe(1)
  })

  it("formats compact token counts", () => {
    expect(formatCompactTokens(null)).toBe("--")
    expect(formatCompactTokens(999)).toBe("999")
    expect(formatCompactTokens(12400)).toBe("12.4k")
  })
})

describe("collectMemoryEntries", () => {
  function userTurn(id: string, text: string): MessageTurn {
    return {
      id,
      role: "user",
      blocks: [{ type: "text", text }],
      timestamp: "2026-01-01T10:00:00.000Z",
    }
  }

  it("lists every turn, oldest → newest, with role, time and a one-line preview", () => {
    const entries = collectMemoryEntries([
      entry("a", userTurn("t1", "hello"), "persisted"),
      entry(
        "b",
        assistantTurn("t2", [
          { type: "thinking", text: "\n  first real line\nsecond" },
        ]),
        "streaming"
      ),
    ])

    expect(entries.map((e) => [e.role, e.preview, e.at])).toEqual([
      ["user", "hello", "2026-01-01T10:00:00.000Z"],
      // Leading blank line skipped; preview is the first non-empty line.
      ["assistant", "first real line", "2026-01-01T10:00:00.000Z"],
    ])
  })

  it("keeps a turn with no text at all as an empty-preview memory row", () => {
    const entries = collectMemoryEntries([
      entry("a", assistantTurn("t1", []), "persisted"),
    ])
    expect(entries).toEqual([
      {
        key: "t1",
        role: "assistant",
        at: "2026-01-01T10:00:00.000Z",
        preview: "",
      },
    ])
  })
})

describe("resolveFileInDir", () => {
  it("finds a regular FILE (the dir-only lister would have skipped it)", async () => {
    vi.mocked(listDirectoryWithFiles).mockResolvedValue([
      {
        name: "src",
        path: "/repo/src",
        isDir: true,
        hasChildren: true,
        size: null,
      },
      {
        name: "CLAUDE.md",
        path: "/repo/CLAUDE.md",
        isDir: false,
        hasChildren: false,
        size: 12,
      },
    ])
    await expect(
      resolveFileInDir("/repo", ["CLAUDE.md", "AGENTS.md"])
    ).resolves.toEqual({ name: "CLAUDE.md", path: "/repo/CLAUDE.md" })
  })

  it("probes dot-prefixed candidates the lister skips", async () => {
    vi.mocked(listDirectoryWithFiles).mockResolvedValue([])
    vi.mocked(readFilePreview).mockResolvedValue({
      path: "/repo/.clinerules",
      content: "x",
    })
    await expect(resolveFileInDir("/repo", [".clinerules"])).resolves.toEqual({
      name: ".clinerules",
      path: "/repo/.clinerules",
    })
  })

  it("returns null when neither the listing nor the probe finds the file", async () => {
    vi.mocked(listDirectoryWithFiles).mockResolvedValue([])
    vi.mocked(readFilePreview).mockRejectedValue(new Error("nope"))
    await expect(resolveFileInDir("/repo", ["AGENTS.md"])).resolves.toBeNull()
  })
})

describe("previewLine", () => {
  it("strips markdown decoration and takes the first real line", () => {
    expect(previewLine("\n## Step one\nmore")).toBe("Step one")
    expect(previewLine("- `read` the file")).toBe("read` the file")
  })

  it("caps the line so a folded row stays one row", () => {
    expect(previewLine("x".repeat(500)).length).toBe(161)
  })
})
