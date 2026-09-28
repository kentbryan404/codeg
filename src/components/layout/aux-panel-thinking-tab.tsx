"use client"

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  Copy,
  Database,
  FileText,
  ListChevronsDownUp,
  ListChevronsUpDown,
  Plug,
  type LucideIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import {
  listDirectoryWithFiles,
  mcpScanLocal,
  readFilePreview,
} from "@/lib/api"
import type {
  AgentType,
  FolderDetail,
  LocalMcpServer,
  McpAppType,
  MessageTurn,
} from "@/lib/types"
import { expandHomePath } from "@/lib/file-open-target"
import { joinFsPath } from "@/lib/path-utils"
import { useTabStore } from "@/contexts/tab-context"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useWorkspaceActions } from "@/contexts/workspace-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  selectTimelineTurns,
  useConversationRuntimeStore,
  type ConversationTimelineTurn,
} from "@/stores/conversation-runtime-store"
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
  useReasoning,
} from "@/components/ai-elements/reasoning"
import { Shimmer } from "@/components/ai-elements/shimmer"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

// Stable empty reference so the store selector never re-renders on a fresh `[]`
// when there is no active session.
const EMPTY_TIMELINE: ConversationTimelineTurn[] = []

/** Distance from the bottom (px) that still counts as "following the tail". */
const STICK_THRESHOLD_PX = 32

/**
 * One reasoning episode: a single `thinking` block, in timeline order.
 *
 * `live` is true only while its turn is the streaming one — the block the agent
 * is writing RIGHT NOW. History blocks keep their settled text.
 */
export interface ThinkingSegment {
  key: string
  text: string
  live: boolean
  /**
   * True once the host turn is DONE — no longer streaming, and not an
   * in-flight round a passive viewer is still watching the agent write.
   * Stats render only on settled episodes: a live turn's usage grows per
   * delta and its totals land on a later DB roundtrip, so showing them early
   * is showing a half-measured number.
   */
  settled: boolean
  /** 1-based position of this episode in the whole reasoning stream. */
  episode: number
  at: string | null
  /** The host turn's measured numbers (shared by every block of that turn). */
  metrics: TurnMetrics
}

/**
 * Every number one turn can report today, derived ONCE per turn object.
 *
 * Honest about gaps: fields no agent writes (TTFT, cache pricing, finish
 * reason) are `null` here and render as "not collected" — not as zeros. The
 * char-based `thinkingCharShare` is an ESTIMATE (no per-block token counts are
 * persisted) and is labelled as such in the UI.
 */
export interface TurnMetrics {
  model: string | null
  durationMs: number | null
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  /** cache_read / (input + cache_read + cache_write), when the prompt is non-zero. */
  cacheHitRate: number | null
  /** output_tokens per second of wall-clock turn duration. */
  tokensPerSecond: number | null
  thinkingChars: number
  outputChars: number
  /** thinking chars / (thinking + text) chars — an approximation, see above. */
  thinkingCharShare: number | null
  toolCalls: number
  toolFailures: number
  startedAt: string | null
  completedAt: string | null
}

const turnMetricsCache = new WeakMap<MessageTurn, TurnMetrics>()

/** Derived, cached per turn object (WeakMap → replaced turns fall away). */
export function turnMetrics(turn: MessageTurn): TurnMetrics {
  const cached = turnMetricsCache.get(turn)
  if (cached) return cached

  const usage = turn.usage ?? null
  const inputTokens = usage?.input_tokens ?? null
  const outputTokens = usage?.output_tokens ?? null
  const cacheReadTokens = usage?.cache_read_input_tokens ?? null
  const cacheWriteTokens = usage?.cache_creation_input_tokens ?? null
  const promptTotal =
    (inputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
  const cacheHitRate =
    promptTotal > 0 && cacheReadTokens != null
      ? cacheReadTokens / promptTotal
      : null
  const durationMs = turn.duration_ms ?? null
  const tokensPerSecond =
    durationMs != null && durationMs > 0 && outputTokens != null
      ? outputTokens / (durationMs / 1000)
      : null

  let thinkingChars = 0
  let outputChars = 0
  let toolCalls = 0
  let toolFailures = 0
  for (const block of turn.blocks) {
    if (block.type === "thinking") thinkingChars += block.text.length
    else if (block.type === "text") outputChars += block.text.length
    else if (block.type === "tool_use") toolCalls += 1
    // `tool_result.is_error` is the persisted signal; `tool_use.status` is
    // live-only and omitted by the DB parsers.
    else if (block.type === "tool_result" && block.is_error) toolFailures += 1
  }
  const textTotal = thinkingChars + outputChars

  const metrics: TurnMetrics = {
    model: turn.model ?? null,
    durationMs,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheHitRate,
    tokensPerSecond,
    thinkingChars,
    outputChars,
    thinkingCharShare: textTotal > 0 ? thinkingChars / textTotal : null,
    toolCalls,
    toolFailures,
    startedAt: turn.timestamp ?? null,
    completedAt: turn.completed_at ?? null,
  }
  turnMetricsCache.set(turn, metrics)
  return metrics
}

/** Compact token count for the always-visible strip: 12400 → "12.4k". */
export function formatCompactTokens(value: number | null): string {
  if (value == null) return "--"
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return String(value)
}

/** A thinking episode WITHOUT its stream position, cached per turn object. */
interface TurnThinking {
  key: string
  text: string
  at: string | null
  metrics: TurnMetrics
}

/**
 * Per-turn episode cache. The hot path is a streaming delta: the store hands us
 * a fresh timeline whose ONLY new object is the streaming turn, so every
 * finished turn hits this cache and its blocks are never rescanned. Keyed by
 * the turn object (WeakMap → no leak as turns are replaced), and the key
 * derives from `turn.id` — stable across the turn's life — so an episode keeps
 * its React key when the turn settles from streaming to finished.
 */
const turnThinkingCache = new WeakMap<MessageTurn, TurnThinking[]>()

function turnThinking(turn: MessageTurn): TurnThinking[] {
  const cached = turnThinkingCache.get(turn)
  if (cached) return cached
  const out: TurnThinking[] = []
  const metrics = turnMetrics(turn)
  let blockIndex = 0
  for (const block of turn.blocks) {
    if (block.type !== "thinking") continue
    const text = block.text
    const key = `${turn.id}:${blockIndex}`
    blockIndex += 1
    if (!text || !text.trim()) continue
    out.push({ key, text, at: turn.timestamp ?? null, metrics })
  }
  turnThinkingCache.set(turn, out)
  return out
}

/**
 * Flatten every `thinking` block of a timeline, in order, into the episode
 * list the view renders. Pure and exported so the ordering / live / empty-block
 * rules are unit-testable without mounting the panel.
 *
 * `live` is per-TURN: only blocks on a `streaming`-phase turn are still being
 * written. Empty/whitespace-only blocks are dropped — models emit them as
 * separators — but the block INDEX still advances, so a later delta that fills
 * one in does not renumber its siblings (keys stay stable across renders).
 *
 * Cost per streaming delta is O(turns), not O(blocks): the block scan is cached
 * per turn (`turnThinking`), and only the streaming turn misses.
 */
export function collectThinkingSegments(
  timeline: ConversationTimelineTurn[]
): ThinkingSegment[] {
  const out: ThinkingSegment[] = []
  for (const entry of timeline) {
    const live = entry.phase === "streaming"
    // `persisted` does NOT mean finished: a passive viewer reads rounds the
    // backend still marks in flight (`isInFlightRound`), and their stats must
    // stay hidden exactly like the local streaming case.
    const settled = !live && !entry.isInFlightRound
    for (const episode of turnThinking(entry.turn)) {
      out.push({
        key: episode.key,
        text: episode.text,
        live,
        settled,
        episode: out.length + 1,
        at: episode.at,
        metrics: episode.metrics,
      })
    }
  }
  return out
}

/**
 * The clickable header of one episode card: episode number, clock, live state,
 * and the fold chevron. Reads `isOpen` from the Reasoning context so the
 * chevron tracks external (expand-all / collapse-all) changes too.
 */
function EpisodeHeader({
  episode,
  live,
  at,
}: {
  episode: number
  live: boolean
  at: string | null
}) {
  const tReasoning = useTranslations("Folder.chat.reasoning")
  const { isOpen } = useReasoning()
  const clock = formatClock(at)
  return (
    <>
      <span className="shrink-0 font-mono text-[0.6875rem] tabular-nums text-muted-foreground/70">
        #{episode}
      </span>
      {/* The clock lives in the header (it used to be the rail's gutter label)
          so the cards can run the panel's full width. */}
      {clock && (
        <span className="shrink-0 font-mono text-[0.625rem] tabular-nums text-muted-foreground/50">
          {clock}
        </span>
      )}
      {live && (
        <Shimmer
          duration={1}
          shineColor="var(--primary)"
          className="text-[0.6875rem]"
        >
          {tReasoning("thinking")}
        </Shimmer>
      )}
      <ChevronRight
        aria-hidden
        className={cn(
          "ml-auto size-3.5 shrink-0 transition-transform",
          isOpen && "rotate-90"
        )}
      />
    </>
  )
}

/**
 * First-line preview for a FOLDED episode: markdown decoration stripped, hard
 * capped. Readability is mostly scannability — a folded row must still say what
 * was thought, not merely that something was thought at 14:22.
 */
export function previewLine(text: string, max = 160): string {
  const line =
    text
      .slice(0, 400)
      .split("\n")
      .find((l) => l.trim()) ?? ""
  const stripped = line.replace(/^[\s>#*\-+`]+/, "").trim()
  return stripped.length > max ? `${stripped.slice(0, max)}…` : stripped
}

/**
 * One timeline card: a foldable header, the full markdown body (rendered
 * through the SAME pipeline the transcript's folded reasoning uses —
 * `ReasoningContent` → Streamdown + the codeg link / mermaid plugins; the text
 * is complete, no clamp, no truncation), and the turn's measured numbers as a
 * compact footer strip.
 *
 * `open` is CONTROLLED by the tab so "expand all / collapse all" can drive every
 * card at once; `memo` means a streaming delta re-renders only the live card —
 * and `metrics` is a per-turn cached object, so finished cards bail out even
 * when the stream dispatches ~60 times a second.
 */
const ThinkingEpisode = memo(function ThinkingEpisode({
  text,
  live,
  settled,
  open,
  onOpenChange,
  episode,
  at,
  metrics,
}: {
  text: string
  live: boolean
  settled: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  episode: number
  at: string | null
  metrics: TurnMetrics
}) {
  const t = useTranslations("Folder.auxPanel.thinking.metrics")
  const tEpisode = useTranslations("Folder.auxPanel.thinking")
  const tUsage = useTranslations("TokenUsage")
  const [copied, setCopied] = useState(false)
  const preview = useMemo(() => previewLine(text), [text])
  const handleCopy = useCallback(() => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1200)
      })
      .catch(() => {
        // Clipboard denied — the button simply does nothing.
      })
  }, [text])
  return (
    <Reasoning
      isStreaming={live}
      open={open}
      onOpenChange={onOpenChange}
      className="flex flex-col"
    >
      <ReasoningTrigger
        className="order-1 items-center gap-2 rounded px-1 py-0.5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        title={open ? tEpisode("collapse") : tEpisode("expand")}
      >
        <EpisodeHeader episode={episode} live={live} at={at} />
      </ReasoningTrigger>
      {/* Folded rows keep a one-line gist: the stream stays scannable. */}
      {!open && preview ? (
        <p className="order-2 truncate px-1 pt-0.5 text-[0.75rem] leading-5 text-muted-foreground/80">
          {preview}
        </p>
      ) : null}
      {/* The turn's measured numbers as the card's FOOTER — one compact strip
          instead of a separate info-card grid. The numbers appear only once
          the turn SETTLES (a live turn's usage grows per delta and its totals
          arrive later); the copy button does not depend on them. */}
      <div className="order-last mt-1 px-1 text-[0.625rem] text-muted-foreground/80">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono">
          {settled && (
            <>
              <span title={tUsage("inputTokens")}>
                ↓{formatCompactTokens(metrics.inputTokens)}
              </span>
              <span title={tUsage("outputTokens")}>
                ↑{formatCompactTokens(metrics.outputTokens)}
              </span>
              <span title={tUsage("cacheRead")}>
                ⚡r{formatCompactTokens(metrics.cacheReadTokens)}
              </span>
              <span title={tUsage("cacheWrite")}>
                ⚡w{formatCompactTokens(metrics.cacheWriteTokens)}
              </span>
              <span title={tUsage("cacheHitCaption")}>
                ⚡
                {metrics.cacheHitRate == null
                  ? "--"
                  : `${Math.round(metrics.cacheHitRate * 100)}%`}
              </span>
              <span title={t("duration")}>
                {metrics.durationMs == null
                  ? "--"
                  : `${(metrics.durationMs / 1000).toFixed(1)}s`}
              </span>
              <span title={t("throughput")}>
                {metrics.tokensPerSecond == null
                  ? "--"
                  : `${metrics.tokensPerSecond.toFixed(1)}/s`}
              </span>
              <span title={t("toolCalls")}>⚙{metrics.toolCalls}</span>
              <span title={t("toolFailures")}>✗{metrics.toolFailures}</span>
            </>
          )}
          <button
            type="button"
            onClick={handleCopy}
            title={copied ? tEpisode("copied") : tEpisode("copy")}
            aria-label={copied ? tEpisode("copied") : tEpisode("copy")}
            className="ml-auto inline-flex h-4 shrink-0 items-center gap-1 rounded px-1 text-[0.625rem] text-muted-foreground/80 transition-colors hover:text-foreground"
          >
            {copied ? (
              <Check className="h-3 w-3" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
          </button>
        </div>
        {settled && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-muted-foreground/60">
            {metrics.model && (
              <span className="max-w-full truncate" title={metrics.model}>
                {metrics.model}
              </span>
            )}
            <span title={t("thinkingOfReply")}>
              {metrics.thinkingCharShare == null
                ? "--"
                : `${Math.round(metrics.thinkingCharShare * 100)}% ${t("approx")}`}
            </span>
            <span
              className="tabular-nums"
              title={`${t("startedAt")} / ${t("completedAt")}`}
            >
              {formatClock(metrics.startedAt) ?? "--"} →{" "}
              {formatClock(metrics.completedAt) ?? "--"}
            </span>
          </div>
        )}
      </div>
      <ReasoningContent
        className={cn(
          "order-2 mt-1 px-1 text-xs leading-relaxed",
          // Thinking flows are multi-paragraph by nature (~7 segments a block,
          // 96% blank-line separated) — a tighter rhythm than Streamdown's
          // default keeps a long block scannable.
          "[&_p]:my-1.5 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0",
          // Lists show up in about two thirds of blocks; inside markers keep
          // them readable in this narrow panel (same call as the tool cards).
          "[&_ul]:my-1.5 [&_ul]:list-inside [&_ol]:my-1.5 [&_ol]:list-inside [&_li]:my-0.5",
          // Inline code (76% of blocks: paths, commands) must wrap — a long
          // path otherwise overflows the panel. A <p>/<li> can only contain
          // inline code, so fenced blocks are never touched.
          "[&_p_code]:break-words [&_li_code]:break-words"
        )}
      >
        {text}
      </ReasoningContent>
    </Reasoning>
  )
})

/**
 * Per-agent project instruction files, most authoritative first. The row shows
 * the SAME file the agent itself loads — each agent has its own convention, so
 * this cannot be one hard-coded name.
 */
const RULES_CANDIDATES: Record<string, string[]> = {
  claude_code: ["CLAUDE.md", "AGENTS.md"],
  gemini: ["GEMINI.md", "AGENTS.md"],
  cline: [".clinerules", "AGENTS.md"],
  cursor: [".cursorrules", "AGENTS.md"],
}
/** Agents without a specific convention (and custom agents) fall back to these. */
const DEFAULT_RULES_CANDIDATES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"]

function candidateRules(agentType: AgentType | null): string[] {
  if (agentType && RULES_CANDIDATES[agentType]) {
    return RULES_CANDIDATES[agentType]
  }
  return DEFAULT_RULES_CANDIDATES
}

/** First candidate present in the folder — the file the agent actually reads. */
export function firstPresentRule(
  candidates: readonly string[],
  names: ReadonlySet<string>
): string | null {
  return candidates.find((candidate) => names.has(candidate)) ?? null
}

/**
 * Resolve the first candidate that exists as a FILE in `absDir`.
 *
 * `list_directory_with_files` skips dot-prefixed entries, so hidden candidates
 * (`.clinerules`, `.cursorrules`) can never appear in its result; for those we
 * fall back to a direct read probe — the file is tiny, and this runs only when
 * the conversation/folder changes.
 */
export async function resolveFileInDir(
  absDir: string,
  candidates: readonly string[]
): Promise<{ name: string; path: string } | null> {
  let names = new Set<string>()
  try {
    const items = await listDirectoryWithFiles(absDir)
    names = new Set(
      items.filter((item) => !item.isDir).map((item) => item.name)
    )
  } catch {
    return null
  }
  const listed = firstPresentRule(candidates, names)
  if (listed) return { name: listed, path: joinFsPath(absDir, listed) }

  for (const hidden of candidates.filter((c) => c.startsWith("."))) {
    try {
      await readFilePreview(absDir, hidden)
      return { name: hidden, path: joinFsPath(absDir, hidden) }
    } catch {
      // Not present.
    }
  }
  return null
}

export type ResolvedRules = { name: string; path: string }

/**
 * Resolve the active rules file for a folder+agent exactly once, for every
 * surface that needs it (the row and the context dialog). `key` pins each
 * result to the folder+agent it was resolved for, so a stale async settle (or a
 * folder switch) never shows the previous folder's rules — and no synchronous
 * setState is needed to clear it.
 */
function useRulesFile(
  folderId: number | null,
  agentType: AgentType | null
): {
  folder: FolderDetail | undefined
  rules: ResolvedRules | null
} {
  const folder = useAppWorkspaceStore((s) =>
    folderId != null ? s.allFolders.find((f) => f.id === folderId) : undefined
  )
  const folderPath = folder?.path ?? null
  const resolveKey =
    folderPath != null ? `${folderPath}\u0000${agentType ?? ""}` : null
  const [resolved, setResolved] = useState<{
    key: string
    name: string | null
    path: string | null
  } | null>(null)

  useEffect(() => {
    if (folderPath == null || resolveKey == null) return
    let cancelled = false
    void resolveFileInDir(folderPath, candidateRules(agentType))
      .then((hit) => {
        if (cancelled) return
        setResolved({
          key: resolveKey,
          name: hit?.name ?? null,
          path: hit?.path ?? null,
        })
      })
      .catch(() => {
        if (!cancelled) {
          setResolved({ key: resolveKey, name: null, path: null })
        }
      })
    return () => {
      cancelled = true
    }
  }, [folderPath, resolveKey, agentType])

  const rules =
    resolved != null && resolved.key === resolveKey && resolved.path != null
      ? { name: resolved.name as string, path: resolved.path }
      : null
  return { folder, rules }
}

/**
 * Per-agent discipline files OUTSIDE the project: the agent's own global rules
 * and its base config. [directory, filename] candidates, most authoritative
 * first; the first one that exists in that directory is the one shown.
 *
 * Honest scope: these are the well-known paths of each CLI. An agent with no
 * entry here (or an unknown custom agent) simply shows nothing for global /
 * system — the project rules still show.
 */
const DISCIPLINE_FILES: Record<
  string,
  {
    global: [string, string][]
    system: [string, string][]
  }
> = {
  claude_code: {
    global: [["~/.claude", "CLAUDE.md"]],
    system: [["~/.claude", "settings.json"]],
  },
  codex: {
    global: [["~/.codex", "AGENTS.md"]],
    system: [["~/.codex", "config.toml"]],
  },
  open_code: {
    // opencode reads its own global AGENTS.md first and still honours the
    // shared ~/.claude/CLAUDE.md as a fallback (the two are independent files,
    // so both are listed and the first that exists wins per the resolver).
    global: [
      ["~/.config/opencode", "AGENTS.md"],
      ["~/.claude", "CLAUDE.md"],
    ],
    system: [["~/.config/opencode", "opencode.json"]],
  },
  gemini: {
    global: [["~/.gemini", "GEMINI.md"]],
    system: [["~/.gemini", "settings.json"]],
  },
}

type DisciplineKind = "global" | "system"

/**
 * Resolve the agent's global + base-config files, each only if it actually
 * exists (a missing directory is not an error — it means "not in effect").
 * Keyed by agent so a switch never shows the previous agent's files.
 */
function useDisciplineFiles(agentType: AgentType | null): {
  global: ResolvedRules | null
  system: ResolvedRules | null
} {
  const spec = agentType ? DISCIPLINE_FILES[agentType] : undefined
  const key = agentType ?? ""
  const [resolved, setResolved] = useState<{
    key: string
    files: Record<DisciplineKind, ResolvedRules | null>
  } | null>(null)

  useEffect(() => {
    if (!spec) return
    let cancelled = false
    void Promise.all(
      (["global", "system"] as const).map(async (kind) => {
        for (const [dir, name] of spec[kind]) {
          try {
            const absDir = await expandHomePath(dir)
            const hit = await resolveFileInDir(absDir, [name])
            if (hit) return [kind, hit] as const
          } catch {
            // Directory missing / unreadable: try the next candidate.
          }
        }
        return [kind, null] as const
      })
    )
      .then((pairs) => {
        if (cancelled) return
        setResolved({
          key,
          files: {
            global: pairs.find(([k]) => k === "global")?.[1] ?? null,
            system: pairs.find(([k]) => k === "system")?.[1] ?? null,
          },
        })
      })
      .catch(() => {
        if (!cancelled) {
          setResolved({ key, files: { global: null, system: null } })
        }
      })
    return () => {
      cancelled = true
    }
  }, [key, spec])

  if (resolved == null || resolved.key !== key) {
    return { global: null, system: null }
  }
  return resolved.files
}

/**
 * "Rules discipline": every rule file in effect for THIS conversation —
 * <ol>
 *   <li>the agent's GLOBAL rules (e.g. ~/.claude/CLAUDE.md)</li>
 *   <li>the PROJECT rules (AGENTS.md / CLAUDE.md … in the folder)</li>
 *   <li>the agent's BASE config (e.g. ~/.claude/settings.json)</li>
 * </ol>
 * in that order, each opening as a file tab. Entries that do not exist are
 * omitted; when NONE is in effect the group keeps its title and says so — a
 * stable top-of-tab structure tells the reader "there is none" instead of
 * leaving them wondering whether the feature exists.
 */
/**
 * The one fold affordance every panel in this tab uses: a full-width, dense
 * header row (icon + title + optional trailing chip + chevron) with a 1px top
 * rule, exactly like the memory panel. Bodies are NOT styled here — each panel
 * keeps its own content untouched.
 */
function FoldHeader({
  icon: Icon,
  title,
  open,
  onToggle,
  trailing,
}: {
  icon: LucideIcon
  title: string
  open: boolean
  onToggle: () => void
  trailing?: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="flex h-8 w-full shrink-0 items-center gap-1.5 border-t px-3 text-left transition-colors hover:bg-muted/40"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-xs font-medium">{title}</span>
      {trailing}
      <ChevronDown
        aria-hidden
        className={cn(
          "ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
          open && "rotate-180"
        )}
      />
    </button>
  )
}

/**
 * Directories holding an agent's own DEFINITION files (`*.md`), best effort per
 * CLI convention. These are not "rules" in the prompt sense — they are the
 * custom agents/prompts the CLI can invoke — so they get their own labelled
 * group inside rules discipline. Unknown/custom agents simply list nothing.
 */
const AGENT_DEF_DIRS: Record<string, string[]> = {
  claude_code: ["~/.claude/agents"],
  codex: ["~/.codex/agents", "~/.codex/prompts"],
  open_code: ["~/.config/opencode/agent", "~/.config/opencode/agents"],
  gemini: ["~/.gemini/agents"],
  cursor: ["~/.cursor/agents"],
  cline: ["~/.cline/agents"],
  kimi_code: ["~/.kimi/agents"],
}

/** All non-hidden `*.md` files in one directory (non-recursive). */
async function listMarkdownFiles(
  absDir: string
): Promise<{ name: string; path: string }[]> {
  try {
    const items = await listDirectoryWithFiles(absDir)
    return items
      .filter((item) => !item.isDir && /\.md$/i.test(item.name))
      .map((item) => ({ name: item.name, path: item.path }))
  } catch {
    return []
  }
}

/** The agent-definition docs in effect for this agent, keyed by agent. */
function useAgentDocs(
  agentType: AgentType | null
): { name: string; path: string }[] {
  const dirs = agentType ? AGENT_DEF_DIRS[agentType] : undefined
  const key = agentType ?? ""
  const [resolved, setResolved] = useState<{
    key: string
    files: { name: string; path: string }[]
  } | null>(null)

  useEffect(() => {
    if (!dirs) return
    let cancelled = false
    void Promise.all(
      dirs.map(async (dir) => listMarkdownFiles(await expandHomePath(dir)))
    )
      .then((groups) => {
        if (cancelled) return
        setResolved({ key, files: groups.flat().slice(0, 24) })
      })
      .catch(() => {
        if (!cancelled) setResolved({ key, files: [] })
      })
    return () => {
      cancelled = true
    }
  }, [key, dirs])

  if (resolved == null || resolved.key !== key) return []
  return resolved.files
}

function RulesDiscipline({
  folder,
  projectRules,
  agentType,
}: {
  folder: FolderDetail | undefined
  projectRules: ResolvedRules | null
  agentType: AgentType | null
}) {
  const t = useTranslations("Folder.auxPanel.thinking.discipline")
  const { openFilePreview } = useWorkspaceActions()
  const extra = useDisciplineFiles(agentType)
  const agentDocs = useAgentDocs(agentType)
  const [open, setOpen] = useState(true)

  const entries: {
    kind: "global" | "project" | "system"
    file: ResolvedRules
  }[] = []
  if (extra.global) entries.push({ kind: "global", file: extra.global })
  if (projectRules) entries.push({ kind: "project", file: projectRules })
  if (extra.system) entries.push({ kind: "system", file: extra.system })
  return (
    <div className="shrink-0">
      <FoldHeader
        icon={FileText}
        title={t("title")}
        open={open}
        onToggle={() => setOpen((prev) => !prev)}
        trailing={
          <span className="shrink-0 text-[0.6875rem] text-muted-foreground/70">
            {entries.length > 0 ? entries.length : null}
          </span>
        }
      />
      {!open ? null : entries.length === 0 ? (
        <div className="px-3 pb-1 text-[0.625rem] text-muted-foreground/60">
          {t("none")}
        </div>
      ) : null}
      {open &&
        entries.map((entry) => (
          <button
            key={entry.kind}
            type="button"
            title={entry.file.path}
            onClick={() =>
              void openFilePreview(entry.file.path, { folderId: folder?.id })
            }
            className="flex w-full items-center gap-1.5 border-b border-border/50 px-2 py-[0.1875rem] text-left transition-colors last:border-b-0 hover:bg-muted"
          >
            <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="truncate font-mono text-[0.71875rem] text-foreground/80">
              {entry.file.name}
            </span>
            <span className="ml-auto shrink-0 text-[0.625rem] text-muted-foreground/70">
              {t(entry.kind)}
            </span>
          </button>
        ))}
      {open && agentDocs.length > 0 ? (
        <>
          <div className="border-t border-border/50 px-2 pt-1 text-[0.625rem] text-muted-foreground/60">
            {t("agents")}
          </div>
          {agentDocs.map((doc) => (
            <button
              key={`agent-doc-${doc.path}`}
              type="button"
              title={doc.path}
              onClick={() =>
                void openFilePreview(doc.path, { folderId: folder?.id })
              }
              className="flex w-full items-center gap-1.5 px-2 py-[0.1875rem] text-left transition-colors hover:bg-muted"
            >
              <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono text-[0.71875rem] text-foreground/80">
                {doc.name}
              </span>
              <span className="ml-auto shrink-0 text-[0.625rem] text-muted-foreground/70">
                {t("definition")}
              </span>
            </button>
          ))}
        </>
      ) : null}
    </div>
  )
}

/** One entry of the session's memory index: a turn the model is given. */
export interface MemoryEntry {
  key: string
  role: string
  at: string | null
  preview: string
}

/**
 * The current session's memory as the model sees it: every turn of the live
 * timeline (persisted history + local + the streaming one), oldest → newest,
 * each reduced to a one-line preview. Pure and exported for tests.
 *
 * This is the LLM's memory FOR THIS CONVERSATION — the context it is re-sent
 * every turn. There is no cross-session memory store in codeg today; if one
 * lands, this is where its rows would join the list.
 */
export function collectMemoryEntries(
  timeline: ConversationTimelineTurn[]
): MemoryEntry[] {
  const out: MemoryEntry[] = []
  for (const entry of timeline) {
    const turn = entry.turn
    let preview = ""
    for (const block of turn.blocks) {
      if (block.type === "text" || block.type === "thinking") {
        const line = block.text.split("\n").find((l) => l.trim())
        if (line) {
          preview = line.trim()
          break
        }
      }
    }
    out.push({
      key: turn.id,
      role: turn.role,
      at: turn.timestamp ?? null,
      preview,
    })
  }
  return out
}

/**
 * "Memory store" section, pinned under the thinking stream (the user asked for
 * it below the content area). Collapsed by default: it is a reference index,
 * not a live surface. Explicitly NOT virtualized — it is a compact one-line
 * list, and it only renders while the user has it open.
 */
function MemoryPanel({ timeline }: { timeline: ConversationTimelineTurn[] }) {
  const t = useTranslations("Folder.auxPanel.thinking.memory")
  // Folded by default, like every other panel in this tab: the header shows the
  // count, one click opens the list.
  const [open, setOpen] = useState(false)
  const entries = useMemo(() => collectMemoryEntries(timeline), [timeline])

  return (
    <div className="shrink-0">
      <FoldHeader
        icon={Database}
        title={t("title")}
        open={open}
        onToggle={() => setOpen((prev) => !prev)}
        trailing={
          <span className="shrink-0 text-[0.6875rem] text-muted-foreground/70">
            {t("count", { count: entries.length })}
          </span>
        }
      />
      {open &&
        (entries.length === 0 ? (
          <div className="px-3 pb-3 text-[0.6875rem] text-muted-foreground/70">
            {t("empty")}
          </div>
        ) : (
          <ScrollArea className="max-h-56">
            <ul className="px-3 pb-2">
              {entries.map((entry) => (
                <li
                  key={entry.key}
                  data-memory-entry
                  // PERF: open by default means a long session lists every
                  // turn; `content-visibility` keeps the off-screen rows out of
                  // layout + paint (native virtualization) with a remembered
                  // one-line intrinsic height.
                  className="flex items-start gap-2 border-b border-border/50 py-1 text-[0.6875rem] last:border-b-0 [content-visibility:auto] [contain-intrinsic-size:auto_1.25rem]"
                >
                  <span
                    className={cn(
                      "shrink-0 font-mono",
                      entry.role === "user"
                        ? "text-primary/80"
                        : "text-muted-foreground/70"
                    )}
                  >
                    {entry.role}
                  </span>
                  <time className="shrink-0 tabular-nums text-muted-foreground/50">
                    {formatClock(entry.at) ?? "--:--:--"}
                  </time>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {entry.preview}
                  </span>
                </li>
              ))}
            </ul>
          </ScrollArea>
        ))}
    </div>
  )
}

function formatClock(at: string | null): string | null {
  if (!at) return null
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

/**
 * The MCP servers the CURRENT agent has configured, under the memory panel.
 *
 * Scope note: this is the agent's own MCP configuration (the same scan the
 * Settings → MCP page reads), i.e. what the session loads. Per-server CONNECTION
 * state is not on the ACP wire — an agent that spawns an MCP server reports
 * nothing back about it — so each row states "configured" and nothing more.
 * Inventing a green dot here would be a lie.
 */
function McpPanel({ agentType }: { agentType: AgentType | null }) {
  const t = useTranslations("Folder.auxPanel.thinking.mcp")
  const [open, setOpen] = useState(false)
  const [servers, setServers] = useState<LocalMcpServer[] | null>(null)

  // Fetched on first expand only — the scan reads the agents' config files.
  useEffect(() => {
    if (!open || servers != null) return
    let cancelled = false
    mcpScanLocal()
      .then((scan) => {
        if (!cancelled) setServers(scan.servers)
      })
      .catch(() => {
        if (!cancelled) setServers([])
      })
    return () => {
      cancelled = true
    }
  }, [open, servers])

  const mine = useMemo(
    () =>
      (servers ?? []).filter(
        (server) =>
          agentType != null && server.apps.includes(agentType as McpAppType)
      ),
    [servers, agentType]
  )

  const summary = (server: LocalMcpServer): string => {
    const spec = server.spec as Record<string, unknown>
    const command = typeof spec.command === "string" ? spec.command : null
    const url = typeof spec.url === "string" ? spec.url : null
    return command ?? url ?? "--"
  }

  return (
    <div className="shrink-0">
      <FoldHeader
        icon={Plug}
        title={t("title")}
        open={open}
        onToggle={() => setOpen((prev) => !prev)}
        trailing={
          servers == null ? null : (
            <span className="shrink-0 text-[0.6875rem] text-muted-foreground/70">
              {t("count", { count: mine.length })}
            </span>
          )
        }
      />
      {open &&
        (servers == null ? (
          <div className="px-3 pb-1 text-[0.625rem] text-muted-foreground/60">
            {t("loading")}
          </div>
        ) : mine.length === 0 ? (
          <div className="px-3 pb-1 text-[0.625rem] text-muted-foreground/60">
            {t("empty")}
          </div>
        ) : (
          <ul className="pb-1">
            {mine.map((server) => (
              <li
                key={server.id}
                className="flex items-center gap-2 px-3 py-[0.1875rem] text-[0.6875rem]"
              >
                <span className="shrink-0 font-mono text-foreground/80">
                  {server.id}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground/60">
                  {summary(server)}
                </span>
                <span className="shrink-0 text-[0.625rem] text-muted-foreground/70">
                  {t("configured")}
                </span>
              </li>
            ))}
          </ul>
        ))}
    </div>
  )
}

/**
 * The aux-panel "Thinking" tab: the active conversation's COMPLETE reasoning
 * stream, live.
 *
 * Why a single vertical stream, in timeline order: the data is an append-only,
 * time-ordered log, and the panel is a narrow, user-resizable column — columns
 * or a graph would cost horizontal room the log does not have and break the one
 * relationship that matters (what was thought before what). Each episode keeps
 * its full markdown, so the view answers "what did it actually think", not just
 * "that it thought".
 *
 * Live behaviour: while the agent streams, the view sticks to the bottom
 * (newest thought stays visible). Scrolling up detaches the stick — the reader
 * keeps their place — and a "jump to latest" control re-attaches. This is the
 * same contract as a terminal tail, chosen because auto-scroll that cannot be
 * escaped is unusable for reading a long reasoning chain mid-turn.
 *
 * Scope: the tab follows the ACTIVE conversation tab (same resolution as
 * Session Details), not the folder. Thinking is a property of one session.
 */
export function ThinkingTab() {
  const t = useTranslations("Folder.auxPanel.thinking")
  const tDetails = useTranslations("Folder.sessionDetails")
  const { isOpen, activeTab } = useAuxPanelContext()

  const tabs = useTabStore((s) => s.tabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const activeConversationTab = useMemo(
    () =>
      tabs.find(
        (tab) => tab.id === activeTabId && tab.conversationId != null
      ) ?? null,
    [tabs, activeTabId]
  )
  // A brand-new conversation streams under its virtual `runtimeConversationId`
  // until it reconciles; key the live-session lookup on it first (mirrors the
  // detail panel / SessionDetailsTab).
  const activeRuntimeId =
    activeConversationTab?.runtimeConversationId ??
    activeConversationTab?.conversationId ??
    null

  // Whether this tab is the one on screen. Everything below keys off it.
  const active = isOpen && activeTab === "thinking"

  // PERF: while the tab is not the visible one, the selector returns the stable
  // empty array — so the ~60/s streaming dispatches never re-render a hidden
  // panel. The subscription re-reads live state the moment `active` flips true,
  // and the timeline is derived state, so nothing is lost by not holding it.
  // When active, the selector is `computeTimeline`-memoized: it returns the SAME
  // array for unrelated dispatches and a new one only when this conversation
  // streams.
  const timeline = useConversationRuntimeStore((s) =>
    active && activeRuntimeId != null
      ? selectTimelineTurns(s, activeRuntimeId)
      : EMPTY_TIMELINE
  )

  // Flatten every `thinking` block, in order, into the episode list. A turn that
  // produced no reasoning contributes nothing (user turns never do). The block
  // scan is per-turn cached, so a streaming delta only rescans the live turn.
  const segments = useMemo(() => collectThinkingSegments(timeline), [timeline])

  const isStreaming = useMemo(
    () => segments.some((segment) => segment.live),
    [segments]
  )

  // ── Tail-follow ───────────────────────────────────────────────────────────
  const viewportRef = useRef<HTMLElement | null>(null)
  const stickRef = useRef(true)
  const [detached, setDetached] = useState(false)

  const handleViewportRef = useCallback((el: HTMLElement | null) => {
    viewportRef.current = el
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  const handleScroll = useCallback(() => {
    const el = viewportRef.current
    if (!el) return
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD_PX
    stickRef.current = atBottom
    setDetached((prev) => (prev === !atBottom ? prev : !atBottom))
  }, [])

  const jumpToLatest = useCallback(() => {
    const el = viewportRef.current
    stickRef.current = true
    setDetached(false)
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  useEffect(() => {
    if (!active || !stickRef.current) return
    const el = viewportRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [segments, active])

  // ── Fold state ────────────────────────────────────────────────────────────
  // Folded by default, EXCEPT the newest episode while the thinking area itself
  // is open: the live tail then streams expanded, so the reader watches the
  // current thought arrive without touching anything. Older rows stay one line;
  // a manual click (or Expand all) overrides this, and collapsing the whole
  // area folds everything.
  // The whole thinking area (header strip + timeline) folds like the memory
  // panel below it.
  const [thinkingOpen, setThinkingOpen] = useState(true)
  const [allExpanded, setAllExpanded] = useState(false)
  const [openOverrides, setOpenOverrides] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map())
  const episodeOpen = useCallback(
    (key: string, latest: boolean) =>
      openOverrides.get(key) ?? (allExpanded || (latest && thinkingOpen)),
    [openOverrides, allExpanded, thinkingOpen]
  )
  const setEpisodeOpen = useCallback((key: string, open: boolean) => {
    setOpenOverrides((prev) => {
      const next = new Map(prev)
      next.set(key, open)
      return next
    })
  }, [])
  const toggleAllExpanded = useCallback(() => {
    setAllExpanded((prev) => !prev)
    setOpenOverrides(new Map())
  }, [])

  // Resolved once for the rules row AND the context dialog (the hook must run
  // before the no-session early return, so it takes nullable inputs).
  const { folder: rulesFolder, rules } = useRulesFile(
    activeConversationTab?.folderId ?? null,
    activeConversationTab?.agentType ?? null
  )

  if (!activeConversationTab) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {tDetails("noActiveSession")}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* Top of the tab, in order: what the agent is bound by (its rules file),
          then the standing instruction the user adds (the creed). Both are
          "how to think" inputs sitting above the thinking itself. */}
      <RulesDiscipline
        folder={rulesFolder}
        projectRules={rules}
        agentType={activeConversationTab.agentType}
      />

      {/* Stream header: what the stream is doing right now, where it is, and the
          fold for the WHOLE thinking area (like the memory panel below).
          Kept pinned so the live state is visible even after scrolling away. */}
      <div className="flex h-8 shrink-0 items-center border-t pr-1">
        <button
          type="button"
          onClick={() => setThinkingOpen((prev) => !prev)}
          aria-expanded={thinkingOpen}
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-3 text-left transition-colors hover:bg-muted/40"
        >
          <Brain className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="shrink-0 text-xs font-medium">{t("title")}</span>
          {/* Same shape as the memory panel: title, then the count. While the
              agent is streaming, the COUNT carries the shimmer — the live
              state shows on the number instead of replacing the row with a
              differently-worded status. */}
          {segments.length === 0 ? (
            <span className="truncate text-[0.6875rem] text-muted-foreground/70">
              {t("empty")}
            </span>
          ) : isStreaming ? (
            <Shimmer
              duration={1}
              shineColor="var(--primary)"
              className="shrink-0 text-[0.6875rem]"
            >
              {t("count", { count: segments.length })}
            </Shimmer>
          ) : (
            <span className="shrink-0 text-[0.6875rem] text-muted-foreground/70">
              {t("count", { count: segments.length })}
            </span>
          )}
        </button>
        {segments.length > 0 && (
          <button
            type="button"
            onClick={toggleAllExpanded}
            title={allExpanded ? t("collapseAll") : t("expandAll")}
            aria-label={allExpanded ? t("collapseAll") : t("expandAll")}
            className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
          >
            {allExpanded ? (
              <ListChevronsDownUp className="h-3.5 w-3.5" />
            ) : (
              <ListChevronsUpDown className="h-3.5 w-3.5" />
            )}
          </button>
        )}
        {detached && (
          <button
            type="button"
            onClick={jumpToLatest}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full border bg-background px-2 py-0.5",
              "text-[0.6875rem] text-muted-foreground transition-colors",
              "hover:text-foreground"
            )}
          >
            <ChevronsDown className="h-3 w-3" />
            {t("jumpToLatest")}
          </button>
        )}
        <button
          type="button"
          onClick={() => setThinkingOpen((prev) => !prev)}
          aria-expanded={thinkingOpen}
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronDown
            aria-hidden
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              thinkingOpen && "rotate-180"
            )}
          />
        </button>
      </div>

      {thinkingOpen &&
        (segments.length === 0 ? (
          <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
            {t("empty")}
          </div>
        ) : (
          <ScrollArea
            className="min-h-0 flex-1"
            onScroll={handleScroll}
            onViewportRef={handleViewportRef}
          >
            {/* Timeline, oldest → newest, in the same shape as the Releases tab:
              a rail with one dot per episode, each episode a foldable card. The
              rail is what makes "thought before thought" legible now that cards
              have their own header row.
              PERF: `content-visibility: auto` makes the browser skip layout +
              paint of episodes scrolled out of view (native virtualization);
              `contain-intrinsic-size` keeps the scrollbar and the tail-follow
              honest by remembering each episode's real height once rendered. */}
            <ol className="relative ml-1.5 border-l border-border/70 pt-2 pb-1 pr-1">
              {segments.map((segment, index) => {
                const isLatest = index === segments.length - 1
                return (
                  <li
                    key={segment.key}
                    data-thinking-episode={segment.episode}
                    className="relative ml-4 pb-3 last:pb-0 [content-visibility:auto] [contain-intrinsic-size:auto_8rem]"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "absolute -left-[23px] top-1.5 size-3 rounded-full border-2 border-background",
                        segment.live ? "bg-primary" : "bg-muted-foreground/40"
                      )}
                    />
                    {/* Episode card, same shape as the Releases timeline's. */}
                    <div className="rounded-2xl border border-border/70 bg-muted/40 px-2 py-1.5">
                      <ThinkingEpisode
                        text={segment.text}
                        live={segment.live}
                        settled={segment.settled}
                        open={episodeOpen(segment.key, isLatest)}
                        onOpenChange={(open) =>
                          setEpisodeOpen(segment.key, open)
                        }
                        episode={segment.episode}
                        at={segment.at}
                        metrics={segment.metrics}
                      />
                    </div>
                  </li>
                )
              })}
            </ol>
          </ScrollArea>
        ))}

      {/* Below the stream, as asked: the current session's memory index. */}
      <MemoryPanel timeline={timeline} />
      <McpPanel agentType={activeConversationTab.agentType} />
    </div>
  )
}
