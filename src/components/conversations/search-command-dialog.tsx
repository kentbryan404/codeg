"use client"

import { useState, useEffect, useRef, useCallback, useMemo } from "react"
import { formatDistanceToNow } from "date-fns"
import { enUS, zhCN, zhTW } from "date-fns/locale"
import { File, Folder, MessageSquareText } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabActions } from "@/contexts/tab-context"
import { useWorkbenchRoute } from "@/contexts/workbench-route-context"
import { useWorkspaceActions } from "@/contexts/workspace-context"
import {
  conversationSearchIndex,
  conversationSearchQuery,
  listAllConversations,
  type ConversationSearchHit,
} from "@/lib/api"
import type {
  AgentType,
  ConversationStatus,
  DbConversationSummary,
} from "@/lib/types"
import { useFileTree, type FlatFileEntry } from "@/hooks/use-file-tree"
import { rankFileMatches } from "@/lib/file-search-match"
import { compareAgentType } from "@/lib/types"
import { getAgentLabel } from "@/lib/custom-agents"
import { AgentIcon } from "@/components/agent-icon"
import { ConversationStatusDot } from "@/components/conversations/conversation-status-dot"
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from "@/components/ui/command"
import { cn } from "@/lib/utils"
import { formatConversationTitle } from "@/lib/conversation-title"

type SearchTab = "conversations" | "files"

/**
 * Render an FTS5 snippet with its `‹…›` match markers as inline highlights.
 * Only PAIRED markers highlight — a raw `‹` in the message body must stay
 * literal text.
 */
function SnippetText({ snippet }: { snippet: string }) {
  const parts: Array<{ text: string; hit: boolean }> = []
  const re = /‹([^›]*)›/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(snippet)) !== null) {
    if (m.index > last) {
      parts.push({ text: snippet.slice(last, m.index), hit: false })
    }
    parts.push({ text: m[1], hit: true })
    last = m.index + m[0].length
  }
  if (last < snippet.length) {
    parts.push({ text: snippet.slice(last), hit: false })
  }
  return (
    <>
      {parts.map((part, i) =>
        part.hit ? (
          <mark
            key={i}
            className="rounded-[3px] bg-primary/15 px-0.5 text-foreground"
          >
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </>
  )
}

interface SearchCommandDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function SearchCommandDialog({
  open,
  onOpenChange,
}: SearchCommandDialogProps) {
  const t = useTranslations("Folder.search")
  const locale = useLocale()
  const dateFnsLocale =
    locale === "zh-CN" ? zhCN : locale === "zh-TW" ? zhTW : enUS
  const { activeFolder: folder, activeFolderId } = useActiveFolder()
  const allConversations = useAppWorkspaceStore((s) => s.conversations)
  const folderId = activeFolderId ?? 0
  const conversations = useMemo(
    () =>
      activeFolderId == null
        ? []
        : allConversations.filter((c) => c.folder_id === activeFolderId),
    [allConversations, activeFolderId]
  )
  const { openTab } = useTabActions()
  const { openConversations } = useWorkbenchRoute()
  const { openFilePreview } = useWorkspaceActions()
  const { revealInFileTree } = useAuxPanelContext()

  const [activeTab, setActiveTab] = useState<SearchTab>("conversations")
  const [query, setQuery] = useState("")
  const [agentFilter, setAgentFilter] = useState<AgentType | null>(null)
  const [results, setResults] = useState<DbConversationSummary[]>([])
  // Message-content hits from the FTS index (see conversation_search_service):
  // title search is a DB LIKE, content search is the indexed transcript.
  const [contentHits, setContentHits] = useState<ConversationSearchHit[]>([])
  const [searching, setSearching] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)

  const folderPath = folder?.path ?? ""

  // Full-text index maintenance rides on the dialog's open: an incremental
  // pass (message-count watermark) indexes whatever changed since last time.
  // Fire-and-forget — search still answers from whatever is already indexed.
  useEffect(() => {
    if (!open || folderId <= 0) return
    void conversationSearchIndex({ folderId }).catch(() => {
      // Non-fatal: the dialog works against the existing index.
    })
  }, [open, folderId])

  const conversationById = useMemo(
    () => new Map(conversations.map((c) => [c.id, c])),
    [conversations]
  )

  // File search via shared hook (lazy-loaded when files tab is active)
  const {
    allFiles,
    loading: filesLoading,
    reset: resetFileTree,
  } = useFileTree({
    folderPath: folderPath || undefined,
    enabled: activeTab === "files",
  })

  // Compute which agent types exist in current folder
  const availableAgents = Array.from(
    new Set(conversations.map((c) => c.agent_type))
  ).sort(compareAgentType)

  // Rank files by relevance (name/path tiers + fuzzy subsequence), scanning the
  // full list so a deeply nested match isn't crowded out by shallower ones.
  const filteredFiles = useMemo(
    () => rankFileMatches(query, allFiles, 100),
    [allFiles, query]
  )

  // Content hits follow the agent chip too: the chip means "only this agent",
  // and a message row from another agent would break that contract.
  const visibleContentHits = useMemo(
    () =>
      agentFilter
        ? contentHits.filter((h) => h.agent_type === agentFilter)
        : contentHits,
    [contentHits, agentFilter]
  )

  const doSearch = useCallback(
    async (q: string, agent: AgentType | null) => {
      const trimmed = q.trim()
      if (!trimmed && !agent) {
        setResults([])
        setContentHits([])
        setSearching(false)
        return
      }
      setSearching(true)
      try {
        // Two searches in flight: the existing title/DB path, and the
        // message-content match over the FTS index (short queries are handled
        // server-side with the LIKE fallback). A failed content search must
        // not sink the title results, hence the per-promise catch.
        const [data, hits] = await Promise.all([
          listAllConversations({
            folder_ids: folderId > 0 ? [folderId] : null,
            search: trimmed || null,
            agent_type: agent,
          }),
          trimmed
            ? conversationSearchQuery({
                query: trimmed,
                folderId: folderId > 0 ? folderId : null,
                limit: 40,
              }).catch(() => [] as ConversationSearchHit[])
            : Promise.resolve([] as ConversationSearchHit[]),
        ])
        setResults(data)
        setContentHits(hits)
      } catch {
        setResults([])
        setContentHits([])
      } finally {
        setSearching(false)
      }
    },
    [folderId]
  )

  // Debounced search on query change (conversations tab only)
  useEffect(() => {
    if (activeTab !== "conversations") return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      doSearch(query, agentFilter)
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, agentFilter, doSearch, activeTab])

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setQuery("")
      setAgentFilter(null)
      setResults([])
      setContentHits([])
      setActiveTab("conversations")
      resetFileTree()
    }
  }, [open, resetFileTree])

  const handleSelectConversation = useCallback(
    (conv: DbConversationSummary) => {
      // Leave any workbench route (e.g. Automations) so the picked conversation
      // isn't stranded behind the route overlay — covers re-selecting the
      // already-active tab, which doesn't change activeTabId.
      openConversations()
      openTab(conv.folder_id, conv.id, conv.agent_type, true)
      onOpenChange(false)
    },
    [openTab, onOpenChange, openConversations]
  )

  // A content hit carries everything openTab needs (folder, conversation,
  // agent) — no store lookup required even for a conversation the sidebar
  // hasn't loaded a summary for.
  const handleSelectHit = useCallback(
    (hit: ConversationSearchHit) => {
      openConversations()
      openTab(
        hit.folder_id,
        hit.conversation_id,
        hit.agent_type as AgentType,
        true
      )
      onOpenChange(false)
    },
    [openTab, onOpenChange, openConversations]
  )

  const handleSelectFile = useCallback(
    (entry: FlatFileEntry) => {
      if (entry.kind === "dir") {
        revealInFileTree(entry.relativePath)
      } else {
        // Reveal parent directory in file tree, then open the file
        const lastSlash = entry.relativePath.lastIndexOf("/")
        if (lastSlash > 0) {
          revealInFileTree(entry.relativePath.slice(0, lastSlash))
        }
        openFilePreview(entry.relativePath)
      }
      onOpenChange(false)
    },
    [revealInFileTree, openFilePreview, onOpenChange]
  )

  const placeholder =
    activeTab === "conversations" ? t("placeholder") : t("filePlaceholder")

  return (
    <CommandDialog
      title={
        folder
          ? t("dialogTitleWithFolder", { name: folder.name })
          : t("dialogTitle")
      }
      open={open}
      onOpenChange={onOpenChange}
      shouldFilter={activeTab === "conversations"}
    >
      {/* Folder context header */}
      {folder && (
        <div className="flex items-center gap-2 border-b px-4 py-2.5">
          <Folder className="w-4 h-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium truncate">
            {t("dialogTitleWithFolder", { name: folder.name })}
          </span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-0 border-b px-3">
        <button
          onClick={() => setActiveTab("conversations")}
          className={cn(
            "relative h-9 px-3 text-sm font-medium transition-colors",
            activeTab === "conversations"
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {t("tabConversations")}
          {activeTab === "conversations" && (
            <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-foreground rounded-full" />
          )}
        </button>
        <button
          onClick={() => setActiveTab("files")}
          className={cn(
            "relative h-9 px-3 text-sm font-medium transition-colors",
            activeTab === "files"
              ? "text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {t("tabFiles")}
          {activeTab === "files" && (
            <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-foreground rounded-full" />
          )}
        </button>
      </div>

      <CommandInput
        placeholder={placeholder}
        value={query}
        onValueChange={setQuery}
      />

      {/* Agent filter (conversations tab only). Wraps: one chip per agent type
          present in the folder, each carrying a full name, so a workspace with
          a dozen enabled agents runs past the dialog — which is
          `overflow-hidden`, so the tail chips were clipped away and simply
          could not be clicked. Wrapping keeps every filter reachable and lets
          the block grow by a row instead of hiding options. */}
      {activeTab === "conversations" && availableAgents.length > 1 && (
        <div className="flex flex-wrap items-center gap-1 px-3 py-2 border-b">
          <button
            onClick={() => setAgentFilter(null)}
            className={cn(
              "h-6 shrink-0 text-xs px-2 rounded-md transition-colors",
              agentFilter === null
                ? "bg-secondary text-secondary-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {t("allAgents")}
          </button>
          {availableAgents.map((at) => (
            <button
              key={at}
              onClick={() => setAgentFilter(at)}
              className={cn(
                "flex shrink-0 items-center gap-1.5 h-6 text-xs px-2 rounded-md transition-colors",
                agentFilter === at
                  ? "bg-secondary text-secondary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <AgentIcon agentType={at} className="w-3.5 h-3.5" />
              {getAgentLabel(at)}
            </button>
          ))}
        </div>
      )}

      <CommandList className="min-h-96">
        {/* Conversations tab */}
        {activeTab === "conversations" && (
          <>
            <CommandEmpty>
              {searching
                ? t("searching")
                : !query.trim() && !agentFilter
                  ? t("typeToSearch")
                  : t("noResults")}
            </CommandEmpty>
            {results.length > 0 && (
              <CommandGroup>
                {results.map((conv) => (
                  <CommandItem
                    key={conv.id}
                    value={`${conv.id}-${formatConversationTitle(conv.title)}`}
                    onSelect={() => handleSelectConversation(conv)}
                  >
                    <ConversationStatusDot
                      status={conv.status as ConversationStatus}
                    />
                    <span className="flex-1 truncate">
                      {formatConversationTitle(conv.title) ||
                        t("untitledConversation")}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {getAgentLabel(conv.agent_type)}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {formatDistanceToNow(new Date(conv.created_at), {
                        addSuffix: true,
                        locale: dateFnsLocale,
                      })}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {visibleContentHits.length > 0 && (
              <CommandGroup heading={t("contentMatches")}>
                {visibleContentHits.map((hit) => {
                  const conv = conversationById.get(hit.conversation_id)
                  return (
                    <CommandItem
                      key={`msg-${hit.conversation_id}-${hit.at}-${hit.role}`}
                      // The value carries the query verbatim so cmdk's built-in
                      // filter (on for this tab) keeps the row — the server
                      // already decided the match.
                      value={`message-hit ${query} ${hit.conversation_id} ${hit.at}`}
                      onSelect={() => handleSelectHit(hit)}
                    >
                      <MessageSquareText className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-xs font-medium">
                            {conv
                              ? formatConversationTitle(conv.title) ||
                                t("untitledConversation")
                              : `#${hit.conversation_id}`}
                          </span>
                          <span className="shrink-0 text-[0.6875rem] text-muted-foreground">
                            {getAgentLabel(hit.agent_type as AgentType)}
                          </span>
                        </div>
                        <div className="truncate text-xs text-muted-foreground">
                          <SnippetText snippet={hit.snippet} />
                        </div>
                      </div>
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            )}
          </>
        )}

        {/* Files tab */}
        {activeTab === "files" && (
          <>
            <CommandEmpty>
              {filesLoading
                ? t("searching")
                : !query.trim()
                  ? t("typeToSearchFiles")
                  : t("noResults")}
            </CommandEmpty>
            {filteredFiles.length > 0 && (
              <CommandGroup>
                {filteredFiles.map((entry) => (
                  <CommandItem
                    key={entry.relativePath}
                    value={entry.relativePath}
                    onSelect={() => handleSelectFile(entry)}
                  >
                    {entry.kind === "dir" ? (
                      <Folder className="w-4 h-4 shrink-0 text-blue-500" />
                    ) : (
                      <File className="w-4 h-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="flex-1 truncate">{entry.name}</span>
                    <span className="text-xs text-muted-foreground shrink-0 truncate max-w-48">
                      {entry.relativePath}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </>
        )}
      </CommandList>
    </CommandDialog>
  )
}
