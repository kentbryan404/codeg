"use client"

import { useCallback, useState } from "react"
import dynamic from "next/dynamic"
import { AlertCircle, ExternalLink, RefreshCw, Tag } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { openUrl } from "@/lib/platform"
import { cn } from "@/lib/utils"

// The markdown stack is heavy; keep it out of the workspace's first load and
// pull it in only when the popover is actually opened.
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

function formatDate(locale: string, iso: string | null): string | null {
  if (!iso) return null
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(parsed)
}

/**
 * Upstream release timeline in the window's top-right chrome, beside the
 * terminal toggle. Fetches `xintaofei/codeg`'s published releases from the
 * public GitHub API (unauthenticated, so rate-limited) the first time it opens,
 * then caches them for the lifetime of the chrome overlay. Renders each release
 * as a rounded card on a vertical time axis — version tag, date, pre-release
 * marker, and the release notes.
 */
export function UpstreamReleases() {
  const t = useTranslations("UpstreamReleases")
  const locale = useLocale()
  const [open, setOpen] = useState(false)
  const [releases, setReleases] = useState<GitHubRelease[] | null>(null)
  const [state, setState] = useState<LoadState>("idle")

  const load = useCallback(async () => {
    setState("loading")
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

  const handleOpenChange = (next: boolean) => {
    setOpen(next)
    if (next && releases === null && state !== "loading") void load()
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 hover:bg-foreground/10 hover:text-foreground/80 dark:hover:bg-foreground/10"
          title={t("buttonTitle")}
          aria-label={t("buttonTitle")}
        >
          <Tag className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end" className="w-96 gap-3 p-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex flex-col">
            <span className="text-xs font-medium">{t("title")}</span>
            <span className="font-mono text-2xs text-muted-foreground">
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
              <RefreshCw
                className={cn(state === "loading" && "animate-spin")}
              />
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

        <div className="max-h-[60vh] overflow-y-auto pr-1">
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
                return (
                  <li key={release.id} className="relative ml-4 pb-3 last:pb-0">
                    <span
                      aria-hidden="true"
                      className="absolute -left-[21px] top-1.5 size-2.5 rounded-full border-2 border-popover bg-primary"
                    />
                    <div className="rounded-2xl border border-border/70 bg-muted/40 p-3">
                      <div className="flex items-center gap-1.5">
                        <Badge
                          variant="secondary"
                          className="rounded-full font-mono text-2xs"
                        >
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
                        className="mt-1.5 max-h-40 overflow-auto text-2xs"
                      />
                      <button
                        type="button"
                        onClick={() => void openUrl(release.html_url)}
                        className="mt-1.5 inline-flex items-center gap-1 text-2xs text-primary hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" />
                        {t("viewOnGitHub")}
                      </button>
                    </div>
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
