"use client"

import { useCallback, useEffect, useState } from "react"
import dynamic from "next/dynamic"
import { AlertCircle, ExternalLink, RefreshCw, Tag } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { openUrl } from "@/lib/platform"
import { cn } from "@/lib/utils"

// The markdown stack is heavy; keep it off the aux panel's own chunk and pull
// it in only when someone actually opens the Releases tab.
const ReleaseNotes = dynamic(
  async () => {
    const mod = await import("@/components/settings/release-notes")
    return { default: mod.ReleaseNotes }
  },
  { ssr: false }
)

const RELEASES_API =
  "https://api.github.com/repos/xintaofei/codeg/releases?per_page=20"
const RELEASES_PAGE = "https://github.com/xintaofei/codeg/releases"

// Releases come from upstream; the divergence summary compares each release
// against this fork's own branch. Cross-repo compare is a GitHub API feature
// (`{user}:{ref}` head over a fork network), so the whole thing stays client-side.
const UPSTREAM_OWNER = "xintaofei"
const DIFF_REPO = "kentbryan404/codeg"
const DIFF_BRANCH = "master"

interface GitHubRelease {
  id: number
  tag_name: string
  name: string | null
  body: string | null
  html_url: string
  published_at: string | null
  prerelease: boolean
  draft: boolean
}

type LoadState = "idle" | "loading" | "ready" | "error"

interface ReleaseDiff {
  /** Commits `DIFF_BRANCH` has that the release lacks. */
  ahead: number
  /** Commits the release has that `DIFF_BRANCH` lacks. */
  behind: number
  files: number
  additions: number
  deletions: number
}

// `null` = compare failed for that tag. Module-level so reopening the tab (the
// component unmounts on close) does not re-spend the unauthenticated 60/hr
// GitHub budget on the same tags. Cleared on an explicit reload.
const diffCache = new Map<string, ReleaseDiff | null>()

function formatDate(locale: string, iso: string | null): string | null {
  if (!iso) return null
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(parsed)
}

/**
 * The aux panel's "Releases" tab — the upstream release timeline that used to
 * live in a top-right chrome popover. It is a tab rather than a popover so the
 * release notes get the panel's full content area (the popover was cramped),
 * and it sits next to the commits tab in the strip. Lazy: it mounts on first
 * open, so the GitHub fetch runs only when someone asks for it.
 */
export function ReleasesTab() {
  const t = useTranslations("UpstreamReleases")
  const locale = useLocale()
  const [releases, setReleases] = useState<GitHubRelease[] | null>(null)
  const [state, setState] = useState<LoadState>("idle")
  const [diffs, setDiffs] = useState<Record<string, ReleaseDiff | null>>({})

  const load = useCallback(async () => {
    setState("loading")
    diffCache.clear()
    setDiffs({})
    try {
      const res = await fetch(RELEASES_API, {
        headers: { Accept: "application/vnd.github+json" },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as GitHubRelease[]
      const list = Array.isArray(data) ? data.filter((r) => !r.draft) : []
      setReleases(list)
      setState("ready")
    } catch {
      setState("error")
    }
  }, [])

  // The tab is lazy (mounted on first open), so a mount is the "open" signal.
  useEffect(() => {
    if (releases === null) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadDiff = useCallback(
    async (tag: string): Promise<ReleaseDiff | null> => {
      if (diffCache.has(tag)) return diffCache.get(tag) ?? null
      try {
        const res = await fetch(
          `https://api.github.com/repos/${DIFF_REPO}/compare/${DIFF_BRANCH}...${UPSTREAM_OWNER}:${tag}`,
          { headers: { Accept: "application/vnd.github+json" } }
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as {
          ahead_by?: number
          behind_by?: number
          files?: { additions?: number; deletions?: number }[]
        }
        const files = data.files ?? []
        const summary: ReleaseDiff = {
          // base = our branch, head = the release, so the API's `behind_by`
          // counts commits only our branch has, and `ahead_by` the reverse.
          ahead: data.behind_by ?? 0,
          behind: data.ahead_by ?? 0,
          files: files.length,
          additions: files.reduce((n, f) => n + (f.additions ?? 0), 0),
          deletions: files.reduce((n, f) => n + (f.deletions ?? 0), 0),
        }
        diffCache.set(tag, summary)
        return summary
      } catch {
        diffCache.set(tag, null)
        return null
      }
    },
    []
  )

  // Sequential on purpose: the unauthenticated GitHub API allows 60 calls/hr and
  // a full list costs one per release, so bursts are what exhausts it. Cards
  // fill in top-down as each compare lands.
  useEffect(() => {
    if (state !== "ready" || !releases?.length) return
    let cancelled = false
    void (async () => {
      for (const release of releases) {
        const summary = await loadDiff(release.tag_name)
        if (cancelled) return
        setDiffs((prev) => ({ ...prev, [release.tag_name]: summary }))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [state, releases, loadDiff])

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-start justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs font-medium">{t("title")}</span>
          <span className="truncate font-mono text-2xs text-muted-foreground">
            xintaofei/codeg
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => void load()}
            disabled={state === "loading"}
            title={t("retry")}
            aria-label={t("retry")}
          >
            <RefreshCw className={cn(state === "loading" && "animate-spin")} />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => void openUrl(RELEASES_PAGE)}
            title={t("openReleasesPage")}
            aria-label={t("openReleasesPage")}
          >
            <ExternalLink />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-3">
          {state === "loading" && (
            <div className="flex items-center gap-2 py-6 text-2xs text-muted-foreground">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              {t("loading")}
            </div>
          )}

          {state === "error" && (
            <div className="flex flex-col items-start gap-2 py-4">
              <div className="flex items-center gap-1.5 text-2xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5" />
                {t("error")}
              </div>
              <Button size="sm" variant="outline" onClick={() => void load()}>
                <RefreshCw className="h-3.5 w-3.5" />
                {t("retry")}
              </Button>
            </div>
          )}

          {state === "ready" && releases && releases.length === 0 && (
            <div className="py-6 text-center text-2xs text-muted-foreground">
              {t("empty")}
            </div>
          )}

          {state === "ready" && releases && releases.length > 0 && (
            <ol className="relative ml-1.5 border-l border-border/70">
              {releases.map((release, index) => {
                const date = formatDate(locale, release.published_at)
                const diff = diffs[release.tag_name]
                return (
                  <li key={release.id} className="relative ml-4 pb-3 last:pb-0">
                    <span
                      aria-hidden="true"
                      className="absolute -left-[21px] top-1.5 size-2.5 rounded-full border-2 border-background bg-primary"
                    />
                    <div className="rounded-2xl border border-border/70 bg-muted/40 p-3">
                      <div className="flex items-center gap-1.5">
                        <Badge
                          variant="secondary"
                          className="rounded-full font-mono text-2xs"
                        >
                          <Tag className="h-3 w-3" />
                          {release.tag_name}
                        </Badge>
                        {index === 0 && (
                          <Badge className="rounded-full text-2xs">
                            {t("latest")}
                          </Badge>
                        )}
                        {release.prerelease && (
                          <Badge
                            variant="outline"
                            className="rounded-full text-2xs"
                          >
                            {t("prerelease")}
                          </Badge>
                        )}
                        {date && (
                          <time className="ml-auto text-2xs text-muted-foreground">
                            {date}
                          </time>
                        )}
                      </div>
                      {release.name && release.name !== release.tag_name && (
                        <div className="mt-1.5 text-xs font-medium">
                          {release.name}
                        </div>
                      )}
                      <ReleaseNotes
                        notes={release.body ?? ""}
                        emptyLabel={t("noNotes")}
                        className="mt-1.5 max-h-72 overflow-auto text-2xs"
                      />
                      <button
                        type="button"
                        onClick={() => void openUrl(release.html_url)}
                        className="mt-1.5 inline-flex items-center gap-1 text-2xs text-primary hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" />
                        {t("viewOnGitHub")}
                      </button>
                      {diff && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 border-t border-border/60 pt-1.5 text-2xs text-muted-foreground">
                          {diff.ahead === 0 && diff.behind === 0 ? (
                            <span>
                              {t("compareIdentical", { branch: DIFF_BRANCH })}
                            </span>
                          ) : (
                            <>
                              <span className="text-muted-foreground/70">
                                {t("compareVsMaster", { branch: DIFF_BRANCH })}
                              </span>
                              <span className="text-green-600 dark:text-green-400">
                                {t("compareAhead", { count: diff.ahead })}
                              </span>
                              <span className="text-red-600 dark:text-red-400">
                                {t("compareBehind", { count: diff.behind })}
                              </span>
                              <span>
                                {t("compareFiles", { count: diff.files })}
                              </span>
                              <span className="font-mono text-green-600 dark:text-green-400">
                                +{diff.additions}
                              </span>
                              <span className="font-mono text-red-600 dark:text-red-400">
                                −{diff.deletions}
                              </span>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
