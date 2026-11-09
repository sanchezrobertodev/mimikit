import clsx from "clsx";
import {
  ChartNoAxesColumn,
  ChevronRight,
  CircleArrowUp,
  Copy,
  Folder,
  FolderOpen,
  FolderSearch,
  FolderX,
  Heart,
  House,
  Keyboard,
  LayoutGrid,
  LibraryBig,
  LoaderCircle,
  Monitor,
  Moon,
  Palette,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Sun,
  X,
  type LucideIcon,
} from "lucide-react";
import { openUpdates, useAppUpdate } from "../appUpdate";
import { AnalysisProgress, MeaningProgress } from "./Analysis";
import { TaggingProgress } from "./SuggestTags";
import { UpdateNotice } from "./AppUpdate";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { rulesWantColors, smartMembers } from "../lib/filter";
import { treeFor, type FolderNode } from "../lib/folders";
import { baseName, rootLabel } from "../lib/format";
import { bytes, kindLabel, num } from "../lib/fmt";
import { t } from "../lib/i18n";
import type { Theme } from "../lib/prefs";
import { shortcut } from "../lib/shortcuts";
import { themeName } from "../lib/themes";
import { sidebarRail, useStore } from "../store";
import { KINDS, type ViewName } from "../types";
import { api } from "../api";
import { Button, IconButton, Label, Modal, T } from "./ui";
import logo24 from "../../icon/24.png";
import logo48 from "../../icon/48.png";

/** Collection colors from the design, by position. */
const COLL_HUES = [75, 25, 250, 152, 300];
export const collColor = (i: number) => `oklch(var(--coll-l) var(--coll-c) ${COLL_HUES[i % COLL_HUES.length]})`;

/** The sidebar button cycles System, Dark and Light; any other theme goes back to System. */
const nextTheme = (theme: Theme): Theme => (theme === "system" ? "dark" : theme === "dark" ? "light" : "system");

function NavItem({
  label,
  icon: Icon,
  active,
  onClick,
  count,
  badge,
  rail,
}: {
  label: string;
  icon: LucideIcon;
  active: boolean;
  onClick: () => void;
  count?: number;
  badge?: number;
  /** Icon only, with the label as its tooltip; screen readers still get the label and count. */
  rail: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={rail ? label : undefined}
      aria-current={active ? "page" : undefined}
      className={clsx(
        "group relative flex items-center gap-2 rounded-lg text-left transition-colors duration-150",
        rail ? "size-9 justify-center" : "justify-between px-3 py-[9px]",
        active ? "bg-active font-medium text-fg" : "text-fg-2 hover:bg-hover hover:text-fg",
      )}
    >
      <span className="flex min-w-0 items-center gap-2.5">
        {/* Accent when active, like the open folder's icon in the tree below. */}
        <Icon aria-hidden className={clsx("size-4 flex-none", active ? "text-accent" : "text-muted group-hover:text-fg-2")} />
        <span className={rail ? "sr-only" : "truncate"}>{label}</span>
      </span>
      {badge ? (
        <span
          className={clsx(
            "rounded-[9px] bg-warn-bg text-[11px] font-semibold text-warn-fg",
            rail ? "absolute -top-1 -right-1 min-w-4 px-1 text-center leading-4" : "px-[7px] py-px",
          )}
        >
          {badge}
        </span>
      ) : count !== undefined ? (
        <span className={rail ? "sr-only" : "font-mono text-[11px] text-faint"}>{num(count)}</span>
      ) : null}
    </button>
  );
}

function Row({ active, onClick, title, children, trailing }: { active: boolean; onClick: () => void; title?: string; children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onClick}
        title={title}
        aria-current={active ? "true" : undefined}
        className={clsx(
          "flex w-full items-center justify-between gap-2 rounded-lg px-3 py-[7px] text-left text-fg-2 -outline-offset-2",
          active ? "bg-hover" : "hover:bg-hover",
        )}
      >
        {children}
      </button>
      {trailing && (
        <div className="absolute top-0 right-1 hidden h-full items-center gap-0.5 group-focus-within:flex group-hover:flex">{trailing}</div>
      )}
    </div>
  );
}

export function Sidebar() {
  const s = useStore();
  const { favorites, byKind, total } = useMemo(() => {
    const byKind = new Map<string, number>();
    let favorites = 0;
    let total = 0;
    for (const a of s.assets) {
      byKind.set(a.kind, (byKind.get(a.kind) ?? 0) + a.size);
      if (a.favorite) favorites++;
      total += a.size;
    }
    return { favorites, byKind, total };
  }, [s.assets]);
  // Colours only matter to a colour rule; otherwise each batch of analysed images would recount every collection.
  const palettes = rulesWantColors(s.collections) ? s.palettes : null;
  const smart = useMemo(() => smartMembers(s.collections, s.assets, s.notes, palettes), [s.collections, s.assets, s.notes, palettes]);

  const nav: { view: ViewName; label: string; icon: LucideIcon; count?: number; badge?: number }[] = [
    { view: "home", label: t("sidebar.home"), icon: House },
    { view: "library", label: t("sidebar.library"), icon: LibraryBig, count: s.assets.length },
    { view: "favorites", label: t("sidebar.favorites"), icon: Heart, count: favorites },
    // The same icon as a collection's card on Home.
    { view: "collections", label: t("sidebar.collections"), icon: LayoutGrid, count: s.collections.length },
    // The same icon as Home's "sets of duplicates" row.
    { view: "duplicates", label: t("sidebar.duplicates"), icon: Copy, badge: s.dups?.length || undefined },
    { view: "insights", label: t("sidebar.insights"), icon: ChartNoAxesColumn },
  ];
  const ThemeIcon = s.theme === "dark" ? Moon : s.theme === "light" ? Sun : s.theme === "system" ? Monitor : Palette;
  const updatesSupported = useAppUpdate((u) => u.supported);
  // The rail has no room for the update notice, so its button says it instead.
  const updateReady = useAppUpdate((u) => ((u.phase === "available" || u.phase === "installing") && u.update?.version) || null);
  const rail = sidebarRail(s);
  const control = rail ? "size-9" : "size-7";
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    getVersion().then(setVersion, () => {});
  }, []);

  return (
    <aside aria-label={t("sidebar.library")} className={clsx("flex min-h-0 flex-col border-r border-line", rail ? "px-2" : "px-2.5")}>
      <div className={clsx("flex h-[60px] flex-none items-center gap-2.5", rail ? "justify-center" : "pr-0.5 pl-2")}>
        {!rail && (
          <>
            {/* The hand-drawn 24 px frame of the app icon, and the 48 px one on HiDPI screens. */}
            <img src={logo24} srcSet={`${logo24} 1x, ${logo48} 2x`} alt="" className="size-6 flex-none" />
            <span className="mr-auto text-[15px] font-semibold tracking-[-.01em]">Mimikit</span>
          </>
        )}
        <IconButton label={t(rail ? "sidebar.expand" : "sidebar.collapse", { keys: shortcut("sidebar").keys })} className={control} onClick={s.toggleSidebar}>
          {rail ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </IconButton>
      </div>
      <nav className={clsx("flex flex-col gap-0.5", rail && "items-center")}>
        {nav.map((n) => (
          <NavItem
            key={n.view}
            label={n.label}
            icon={n.icon}
            count={n.count}
            badge={n.badge}
            active={s.view === n.view}
            onClick={() => s.go(n.view)}
            rail={rail}
          />
        ))}
      </nav>

      {rail ? (
        <div className="flex flex-1 flex-col items-center justify-end pb-2">
          <AnalysisProgress compact />
          <MeaningProgress compact />
          <TaggingProgress compact />
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="flex items-center justify-between px-3 pt-[22px] pb-1.5">
              <Label>{t("sidebar.collections")}</Label>
              <IconButton label={t("sidebar.newCollection")} className="size-6" onClick={() => void s.newCollection()}>
                <Plus className="size-4" />
              </IconButton>
            </div>
            <div className="flex flex-col gap-px">
              {s.collections.map((c, i) => (
                <Row key={c.id} active={s.view === "collections" && s.colSel === c.id} onClick={() => s.go("collections", { colSel: c.id })}>
                  <span className="flex min-w-0 items-center gap-2">
                    {c.rule ? (
                      <Sparkles role="img" aria-label={t("sidebar.smartCollection")} className="keep-color size-3 flex-none" style={{ color: collColor(i) }} />
                    ) : (
                      <span aria-hidden className="keep-color size-2 flex-none rounded-[2px]" style={{ background: collColor(i) }} />
                    )}
                    <span className="truncate">{c.name}</span>
                  </span>
                  <span className="font-mono text-[11px] text-faint">{num(smart.get(c.id)?.length ?? c.assetIds.length)}</span>
                </Row>
              ))}
              {!s.collections.length && <p className="px-3 py-1 text-xs text-faint">{t("sidebar.noCollections")}</p>}
            </div>

            <div className="flex items-center justify-between px-3 pt-[22px] pb-1.5">
              <Label>{t("sidebar.folders")}</Label>
              <IconButton label={t("sidebar.importFolder")} className="size-6" onClick={() => void s.importFolder()}>
                <Plus className="size-4" />
              </IconButton>
            </div>
            <FolderTree />
            {!s.roots.length && (
              <button type="button" onClick={() => void s.importFolder()} className="px-3 py-1 text-left text-xs text-muted hover:text-fg">
                {t("sidebar.importFolderLink")}
              </button>
            )}
          </div>

          <div className="flex flex-none flex-col gap-2 px-3 pt-4 pb-3">
            <AnalysisProgress />
            <MeaningProgress />
            <TaggingProgress />
            <UpdateNotice />
            <div className="flex min-w-0 flex-col gap-0.5 text-xs">
              <span className="truncate text-fg-2" title={s.roots.map((r) => r.path).join("\n")}>
                {s.roots.length === 1 ? baseName(s.roots[0].path) : t("sidebar.folderCount", { count: s.roots.length })}
              </span>
              <span className="font-mono text-[11px] whitespace-nowrap text-faint">
                {t("sidebar.librarySize", { size: bytes(total), count: s.assets.length })}
              </span>
            </div>
            <div className="flex h-[5px] gap-0.5 overflow-hidden rounded-[3px] bg-line-soft" role="img" aria-label={t("sidebar.sizeByType")}>
              {KINDS.filter((k) => byKind.get(k)).map((k) => (
                <div key={k} data-kind={k} title={t("sidebar.kindSize", { kind: kindLabel[k], size: bytes(byKind.get(k)!) })} className="k-bar" style={{ width: `${Math.max(0.6, (byKind.get(k)! / (total || 1)) * 100)}%` }} />
              ))}
            </div>
          </div>
        </>
      )}
      {/* App controls live in their own bar so they never squeeze the library name; the rail stacks them. */}
      <div className={clsx("flex flex-none items-center gap-0.5 border-t border-line-soft", rail ? "-mx-2 flex-col py-2" : "-mx-2.5 h-11 px-3")}>
        {!rail && (
          <span className="mr-auto min-w-0 truncate font-mono text-[11px] text-faint" title={version ? t("sidebar.version", { version }) : undefined}>
            {version ? t("sidebar.versionShort", { version }) : ""}
          </span>
        )}
        {updatesSupported && (
          <IconButton
            label={rail && updateReady ? t("sidebar.updateReady", { version: updateReady }) : t("sidebar.checkUpdates")}
            className={clsx(control, "relative")}
            onClick={openUpdates}
          >
            {/* On the icon: IconButton's own text colour wins over a class passed to it. */}
            <CircleArrowUp className={clsx("size-4", rail && updateReady && "text-accent")} />
            {rail && updateReady && <span aria-hidden className="absolute top-1.5 right-1.5 size-2 rounded-full bg-accent" />}
          </IconButton>
        )}
        <IconButton label={t("sidebar.theme", { name: themeName(s.theme) })} className={control} onClick={() => s.setTheme(nextTheme(s.theme))}>
          <ThemeIcon className="size-4" />
        </IconButton>
        <IconButton label={t("sidebar.shortcuts", { keys: shortcut("help").keys })} className={control} onClick={() => s.setModal("shortcuts")}>
          <Keyboard className="size-4" />
        </IconButton>
        <IconButton label={t("sidebar.settings")} className={control} onClick={() => s.setModal("settings")}>
          <Settings className="size-4" />
        </IconButton>
      </div>
    </aside>
  );
}

/** Expandable folder tree: roots at the top level, then their folders. Only open branches are rendered. */
function FolderTree() {
  const s = useStore();
  const tree = treeFor(s.assets, s.roots);
  const rows: { node: FolderNode; depth: number }[] = [];
  const walk = (n: FolderNode, depth: number) => {
    rows.push({ node: n, depth });
    if (s.expanded.has(n.key)) n.children.forEach((c) => walk(c, depth + 1));
  };
  // Roots with nothing indexed yet still get a row (e.g. while their first scan runs).
  s.roots.forEach((r) => walk(tree.find((node) => node.rootId === r.id) ?? { key: `${r.id}:`, rootId: r.id, path: "", name: rootLabel(s.roots, r.id), count: 0, bytes: 0, children: [] }, 0));
  // A relink whose new folder lacks some of the files, waiting for the user to confirm.
  const [relink, setRelink] = useState<{ id: number; name: string; path: string; found: number; checked: number } | null>(null);
  // A library folder whose X was clicked, waiting for the user to confirm.
  const [removing, setRemoving] = useState<{ id: number; name: string } | null>(null);
  const removeCount = removing ? s.assets.filter((a) => a.rootId === removing.id).length : 0;

  const locate = async (id: number, name: string) => {
    const path = await api.pickFolder(t("sidebar.folder.locateTitle", { name }));
    if (!path) return;
    try {
      const m = await api.checkRelink(id, path);
      if (m.found === m.checked) void s.relinkRoot(id, path);
      else setRelink({ id, name, path, ...m });
    } catch (e) {
      s.setError(e);
    }
  };

  const items = rows.map(({ node: n, depth }) => {
    const isRoot = depth === 0;
    const open = s.expanded.has(n.key);
    const active = s.view === "library" && s.folder?.rootId === n.rootId && s.folder.path === n.path;
    const scanning = isRoot ? s.scanning[n.rootId] : undefined;
    const missing = isRoot && s.missing[n.rootId];
    const Icon = active ? FolderOpen : Folder;
    const rootPath = isRoot ? (s.roots.find((r) => r.id === n.rootId)?.path ?? "") : "";
    return (
      <div key={n.key} role="listitem" className="group relative flex items-center">
        <span className="flex w-6 flex-none justify-center" style={{ marginLeft: depth * 14 }}>
          {n.children.length > 0 && (
            <button
              type="button"
              aria-label={t("sidebar.folder.subfolders", { name: n.name })}
              aria-expanded={open}
              onClick={() => s.toggleExpanded(n.key)}
              className="flex size-6 items-center justify-center rounded text-muted -outline-offset-2 hover:bg-active hover:text-fg"
            >
              <ChevronRight aria-hidden className={clsx("size-3.5 transition-transform duration-150", open && "rotate-90")} />
            </button>
          )}
        </span>
        <button
          type="button"
          title={isRoot ? (missing ? t("sidebar.folder.unreachableTitle", { path: rootPath }) : rootPath) : n.path}
          onClick={() => s.go("library", { folder: { rootId: n.rootId, path: n.path } })}
          onDoubleClick={() => n.children.length && s.toggleExpanded(n.key)}
          aria-current={active ? "page" : undefined}
          className={clsx(
            "flex h-[30px] min-w-0 flex-1 items-center gap-1.5 rounded-lg pr-3 pl-1 text-left -outline-offset-2",
            active ? "bg-active font-medium text-fg" : isRoot ? "text-fg hover:bg-hover" : "text-fg-2 hover:bg-hover",
            isRoot && !active && "font-medium",
          )}
        >
          {missing ? (
            <FolderX role="img" aria-label={t("sidebar.folder.unreachable")} className="size-3.5 flex-none text-warn-fg" />
          ) : (
            <Icon aria-hidden className={clsx("size-3.5 flex-none", active ? "text-accent" : "text-muted")} />
          )}
          <span className="min-w-0 flex-1 truncate">{n.name}</span>
          <span className={clsx("flex items-center gap-1 font-mono text-[11px] text-faint", isRoot && "group-hover:invisible group-focus-within:invisible")}>
            {scanning !== undefined && <LoaderCircle role="img" aria-label={t("sidebar.folder.scanning")} className="size-3 animate-spin" />}
            {num(scanning ?? n.count)}
          </span>
        </button>
        {isRoot && (
          // Faded, not display:none, so a confirm dialog can hand focus back to its button after Cancel.
          <div className="absolute top-0 right-1 flex h-full items-center gap-0.5 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100">
            {missing && (
              <IconButton label={t("sidebar.folder.locate", { name: n.name })} className="size-6 -outline-offset-2" onClick={() => void locate(n.rootId, n.name)}>
                <FolderSearch className="size-3.5" />
              </IconButton>
            )}
            <IconButton label={t("sidebar.folder.rescan", { name: n.name })} className="size-6 -outline-offset-2" onClick={() => void s.rescan(n.rootId)}>
              <RefreshCw className="size-3.5" />
            </IconButton>
            <IconButton label={t("sidebar.folder.remove", { name: n.name })} className="size-6 -outline-offset-2 hover:text-danger" onClick={() => setRemoving({ id: n.rootId, name: n.name })}>
              <X className="size-3.5" />
            </IconButton>
          </div>
        )}
      </div>
    );
  });

  return (
    <>
      <div role="list" aria-label={t("sidebar.folders")} className="flex flex-col gap-px">
        {items}
      </div>
      {relink && (
        <Modal
          title={t(relink.found ? "sidebar.relink.someTitle" : "sidebar.relink.noneTitle", { name: relink.name })}
          onClose={() => setRelink(null)}
          footer={
            <>
              <Button data-autofocus onClick={() => setRelink(null)}>
                {t("sidebar.cancel")}
              </Button>
              <Button
                variant="invert"
                onClick={() => {
                  setRelink(null);
                  void s.relinkRoot(relink.id, relink.path);
                }}
              >
                {t("sidebar.relink.confirm")}
              </Button>
            </>
          }
        >
          <p className="leading-relaxed">
            <T k="sidebar.relink.body" vars={{ count: relink.checked, found: relink.found, path: relink.path }} tags={[<span className="text-fg" />]} />
          </p>
        </Modal>
      )}
      {removing && (
        <Modal
          title={t("sidebar.removeRoot.title", { name: removing.name })}
          onClose={() => setRemoving(null)}
          footer={
            <>
              <Button data-autofocus onClick={() => setRemoving(null)}>
                {t("sidebar.cancel")}
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setRemoving(null);
                  void s.removeRoot(removing.id);
                }}
              >
                {t("sidebar.removeRoot.confirm")}
              </Button>
            </>
          }
        >
          <p className="leading-relaxed">{t("sidebar.removeRoot.body", { count: removeCount })}</p>
        </Modal>
      )}
    </>
  );
}
