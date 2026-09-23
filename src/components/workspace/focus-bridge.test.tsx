import { act, render, waitFor, cleanup } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"

// The workspace half lives in the real zustand store: tests seed it via
// setState in beforeEach and flip hydration with act(setState). The tab half
// is still a mutable hook mock — the mock reads this module-level var, so
// reassigning + rerendering simulates the provider state changing.
let tabs: { tabsHydrated: boolean; openTab: ReturnType<typeof vi.fn> }
let addFolderToWorkspaceById: ReturnType<typeof vi.fn>
let handlers: Map<string, (p: unknown) => void>
let takePendingDeepLink: ReturnType<typeof vi.fn>

const PENDING = "workspace://deep-link-pending"

vi.mock("@/contexts/tab-context", () => ({
  useTabStore: (selector: (s: typeof tabs) => unknown) => selector(tabs),
  useTabActions: () => tabs,
}))
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({
    subscribe: async (event: string, cb: (p: unknown) => void) => {
      handlers.set(event, cb)
      return () => handlers.delete(event)
    },
  }),
}))
vi.mock("@/lib/deep-link", () => ({
  takePendingDeepLink: () => takePendingDeepLink(),
}))

import { FocusBridge } from "./deep-link-bootstrap"

/** One-shot backend slot, mirroring `PENDING_FOCUS`'s atomic take. */
function parkOne(target: unknown) {
  let slot: unknown = target
  return vi.fn(async () => {
    const taken = slot
    slot = null
    return taken
  })
}

describe("FocusBridge", () => {
  beforeEach(() => {
    handlers = new Map()
    takePendingDeepLink = vi.fn(async () => null)
    addFolderToWorkspaceById = vi.fn()
    resetAppWorkspaceStore()
    useAppWorkspaceStore.setState({
      foldersHydrated: false,
      folders: [{ id: 7 }] as never,
      addFolderToWorkspaceById,
    })
    tabs = { tabsHydrated: false, openTab: vi.fn() }
  })
  afterEach(() => cleanup())

  // A `codeg://session/<id>` that reaches the backend before this component
  // subscribes (macOS cold start) is parked there, and the nudge that went with
  // it was dropped — the mount drain is what finds it.
  it("opens the tab for a deep link parked before it subscribed", async () => {
    takePendingDeepLink = parkOne({
      folderId: 7,
      conversationId: 314,
      agent: "grok",
    })
    const { rerender } = render(<FocusBridge />)

    // Still queued while hydrating, exactly like a live request.
    await waitFor(() => expect(takePendingDeepLink).toHaveBeenCalled())
    expect(tabs.openTab).not.toHaveBeenCalled()

    tabs = { ...tabs, tabsHydrated: true }
    rerender(<FocusBridge />)
    act(() => {
      useAppWorkspaceStore.setState({ foldersHydrated: true })
    })
    await waitFor(() =>
      expect(tabs.openTab).toHaveBeenCalledWith(7, 314, "grok", true)
    )
  })

  it("opens the tab when a warm link nudges after it subscribed", async () => {
    useAppWorkspaceStore.setState({ foldersHydrated: true })
    tabs = { ...tabs, tabsHydrated: true }
    render(<FocusBridge />)
    await waitFor(() => expect(handlers.has(PENDING)).toBe(true))

    takePendingDeepLink = parkOne({
      folderId: 7,
      conversationId: 55,
      agent: "codex",
    })
    handlers.get(PENDING)!(null)
    await waitFor(() =>
      expect(tabs.openTab).toHaveBeenCalledWith(7, 55, "codex", true)
    )
  })

  // The slot is the only channel and the take is atomic, so a nudge racing the
  // mount drain cannot open the same conversation twice…
  it("opens a parked target exactly once when the nudge races the mount drain", async () => {
    useAppWorkspaceStore.setState({ foldersHydrated: true })
    tabs = { ...tabs, tabsHydrated: true }
    takePendingDeepLink = parkOne({
      folderId: 7,
      conversationId: 77,
      agent: "grok",
    })
    render(<FocusBridge />)
    await waitFor(() => expect(handlers.has(PENDING)).toBe(true))

    await act(async () => {
      handlers.get(PENDING)!(null)
    })

    await waitFor(() => expect(tabs.openTab).toHaveBeenCalledTimes(1))
    expect(tabs.openTab).toHaveBeenCalledWith(7, 77, "grok", true)
    // Two drains ran (mount + nudge) but only one target came back.
    expect(takePendingDeepLink.mock.calls.length).toBeGreaterThan(1)
  })

  // …and a link consumed on one mount cannot reappear on the next.
  it("does not replay a consumed deep link on a later mount", async () => {
    useAppWorkspaceStore.setState({ foldersHydrated: true })
    tabs = { ...tabs, tabsHydrated: true }
    takePendingDeepLink = parkOne({
      folderId: 7,
      conversationId: 88,
      agent: "grok",
    })
    const first = render(<FocusBridge />)
    await waitFor(() => expect(tabs.openTab).toHaveBeenCalledTimes(1))
    first.unmount()

    tabs = { ...tabs, openTab: vi.fn() }
    render(<FocusBridge />)
    await waitFor(() => expect(handlers.has(PENDING)).toBe(true))
    await act(async () => {})
    expect(tabs.openTab).not.toHaveBeenCalled()
  })
})
