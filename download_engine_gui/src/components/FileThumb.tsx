import { useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { FileCategory } from "../types";
import { allowPreview, fileIconUrl, previewKind } from "../lib/fileIcon";
import { categoryIcon } from "../lib/ui";
import Icon from "./Icon";

interface Props {
  name: string;
  /** Full path of the file on disk once it exists; empty while unknown. */
  path: string;
  /** Media previews are only attempted for a finished file. */
  done: boolean;
  category: FileCategory;
  /** Tile size in px. */
  size?: number;
  className?: string;
}

/**
 * What the file actually looks like: a finished image or video shows itself,
 * anything else the icon Windows uses for it. The category glyph is only the
 * placeholder while that loads, or the fallback when it can't.
 */
export default function FileThumb({ name, path, done, category, size = 56, className = "" }: Props) {
  const kind = previewKind(name);
  const wantsMedia = done && path !== "" && kind !== "icon";
  const [mediaSrc, setMediaSrc] = useState<string | null>(null);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [iconSrc, setIconSrc] = useState<string | null>(null);

  useEffect(() => {
    setMediaSrc(null);
    setMediaFailed(false);
    if (!wantsMedia) return;
    let live = true;
    void allowPreview(path).then((ok) => {
      if (!live) return;
      if (ok) setMediaSrc(convertFileSrc(path));
      else setMediaFailed(true);
    });
    return () => {
      live = false;
    };
  }, [wantsMedia, path]);

  const showMedia = wantsMedia && !mediaFailed;

  useEffect(() => {
    if (showMedia) return;
    let live = true;
    void fileIconUrl(name, done ? path : "").then((url) => {
      if (live) setIconSrc(url);
    });
    return () => {
      live = false;
    };
  }, [showMedia, name, path, done]);

  const box = `relative grid shrink-0 place-items-center overflow-hidden rounded-full ${className}`;
  const style = { width: size, height: size };

  if (showMedia && mediaSrc) {
    return (
      <div className={box} style={style} aria-hidden="true">
        {kind === "image" ? (
          <img src={mediaSrc} alt="" draggable={false} loading="lazy" onError={() => setMediaFailed(true)} className="h-full w-full object-cover" />
        ) : (
          <>
            <video
              src={mediaSrc}
              muted
              playsInline
              preload="metadata"
              onLoadedMetadata={(e) => {
                // The very first frame is often black; a moment in reads better.
                const v = e.currentTarget;
                v.currentTime = Math.min(1, (v.duration || 0) / 10);
              }}
              onError={() => setMediaFailed(true)}
              className="h-full w-full object-cover"
            />
            <span className="absolute inset-0 grid place-items-center bg-black/15">
              <span className="grid h-6 w-6 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm">
                <Icon name="play" className="text-[11px]" />
              </span>
            </span>
          </>
        )}
      </div>
    );
  }

  return (
    <div className={box} style={style} aria-hidden="true">
      {iconSrc ? (
        <img src={iconSrc} alt="" draggable={false} style={{ width: Math.round(size * 0.9), height: Math.round(size * 0.9) }} className="object-contain" />
      ) : (
        <span className="text-ink-2" style={{ fontSize: Math.round(size * 0.6) }}>
          <Icon name={categoryIcon(category)} />
        </span>
      )}
    </div>
  );
}
