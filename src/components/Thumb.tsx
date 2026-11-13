import clsx from "clsx";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import { assetUrl, fileUrl } from "../api";
import { holdFont } from "../lib/fonts";
import { t } from "../lib/i18n";
import { watchOnScreen } from "../lib/onScreen";
import { requestThumbnail } from "../lib/thumbs";
import type { Asset } from "../types";

/** Sprites this small are pixel art: scale them up crisp instead of blurry. */
export const isTiny = (a: Asset) => !!a.width && !!a.height && a.width <= 64 && a.height <= 64;

/** Label sizes for the design's placeholder tiles: card, list row, filmstrip. A row has no extension: it'd be too small to read. */
const sizes: Record<"card" | "row" | "strip", { font: string; ext?: string }> = {
  card: { font: "text-[38px]", ext: "text-[11px]" },
  row: { font: "text-[15px]" },
  strip: { font: "text-[22px]", ext: "text-[10px]" },
};

/**
 * Square preview: the real thumbnail on a checkerboard for images, models and videos, "Aa" in the font itself for fonts,
 * and the design's striped tile with the extension for everything else. Decorative: every use sits next to the
 * asset's name, so screen readers skip it.
 */
export function Thumb({
  asset,
  pixelated,
  size = "card",
  className,
}: {
  asset: Asset;
  pixelated?: boolean;
  size?: keyof typeof sizes;
  className?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [family, setFamily] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [onScreen, setOnScreen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => (box.current ? watchOnScreen(box.current, setOnScreen) : undefined), []);

  useEffect(() => {
    setSrc(asset.kind === "image" && asset.ext === "svg" ? assetUrl(asset) : null);
    setFamily(null);
    setFailed(false);
  }, [asset.id, asset.mtime, asset.size, asset.kind, asset.ext, asset.path]);

  // Ask only while the card is on screen (or about to be), and withdraw when it leaves: a fast scroll or a long
  // non-virtualized list (collections, duplicates, filmstrip) then costs only the thumbnails you can actually see.
  useEffect(() => {
    if (!onScreen || (asset.kind === "image" && asset.ext === "svg")) return;
    let live = true;
    let withdraw = () => {};
    if (asset.kind === "image" || asset.kind === "model" || asset.kind === "video")
      withdraw = requestThumbnail(asset, (p) => live && (p ? setSrc(convertFileSrc(p)) : setFailed(true)));
    else if (asset.kind === "font")
      withdraw = holdFont(asset, fileUrl(asset.path), (f) => (f ? setFamily(f) : setFailed(true)));
    return () => {
      live = false;
      withdraw();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onScreen, asset.id, asset.mtime, asset.size, asset.kind, asset.ext, asset.path]);

  const picture = src && !failed;
  return (
    <div
      ref={box}
      aria-hidden
      data-kind={asset.kind}
      className={clsx(
        "flex items-center justify-center overflow-hidden",
        picture || asset.kind === "image" ? "checker" : "stripes",
        className,
      )}
    >
      {picture ? (
        <img
          src={src}
          alt=""
          draggable={false}
          loading="lazy"
          onError={() => setFailed(true)}
          className={clsx("h-full w-full object-contain", (pixelated || isTiny(asset)) && "pixelated")}
        />
      ) : asset.kind === "font" ? (
        <span style={family ? { fontFamily: family } : undefined} className={clsx("leading-none text-fg", sizes[size].font)}>
          {t("thumb.fontSample")}
        </span>
      ) : (
        sizes[size].ext && (
          <span className={clsx("k-text font-mono tracking-[.04em] uppercase", sizes[size].ext)}>{asset.ext || t("thumb.noExt")}</span>
        )
      )}
    </div>
  );
}
