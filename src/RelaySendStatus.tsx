import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";
import { Check, LoaderCircle, Send, X } from "lucide-react";
import type {
  RelaySendComplete,
  RelaySendError,
  RelaySendProgress,
  RelaySendState,
} from "./types";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index]}`;
}

function notify(title: string, body: string) {
  void isPermissionGranted()
    .then((allowed) => {
      if (allowed) sendNotification({ title, body });
    })
    .catch(() => {
      // Notifications are optional; the in-app status remains authoritative.
    });
}

export function useRelaySendStatus() {
  const [transfer, setTransfer] = useState<RelaySendState | null>(null);
  const dismissTimer = useRef<number | undefined>(undefined);

  const scheduleDismiss = useCallback((transferId: string) => {
    window.clearTimeout(dismissTimer.current);
    dismissTimer.current = window.setTimeout(() => {
      setTransfer((current) => current?.transferId === transferId ? null : current);
    }, 6000);
  }, []);

  useEffect(() => {
    let disposed = false;
    let cleanup: Array<() => void> = [];

    void Promise.all([
      listen<RelaySendProgress>("relay-send-progress", (event) => {
        const progress = event.payload;
        window.clearTimeout(dismissTimer.current);
        setTransfer({
          transferId: progress.transferId,
          target: progress.target,
          filename: progress.filename,
          fileIndex: progress.fileIndex,
          fileCount: progress.fileCount,
          totalSent: progress.totalSent,
          totalBytes: progress.totalBytes,
          phase: progress.phase,
        });
      }),
      listen<RelaySendComplete>("relay-send-complete", (event) => {
        const complete = event.payload;
        setTransfer((current) => ({
          transferId: complete.transferId,
          target: complete.target,
          filename: current?.transferId === complete.transferId ? current.filename : "",
          fileIndex: complete.fileCount,
          fileCount: complete.fileCount,
          totalSent: complete.totalBytes,
          totalBytes: complete.totalBytes,
          phase: "complete",
        }));
        notify("发送完成", `${complete.fileCount} 个文件已发送给 ${complete.target}`);
        scheduleDismiss(complete.transferId);
      }),
      listen<RelaySendError>("relay-send-error", (event) => {
        const failed = event.payload;
        setTransfer((current) => ({
          transferId: failed.transferId,
          target: failed.target,
          filename: current?.transferId === failed.transferId ? current.filename : "",
          fileIndex: current?.transferId === failed.transferId ? current.fileIndex : 0,
          fileCount: current?.transferId === failed.transferId ? current.fileCount : 0,
          totalSent: current?.transferId === failed.transferId ? current.totalSent : 0,
          totalBytes: current?.transferId === failed.transferId ? current.totalBytes : 0,
          phase: "error",
          error: failed.cancelled ? "发送已取消" : failed.error,
        }));
        if (!failed.cancelled) notify("发送失败", failed.error);
        scheduleDismiss(failed.transferId);
      }),
    ])
      .then((unlistens) => {
        if (disposed) unlistens.forEach((unlisten) => unlisten());
        else cleanup = unlistens;
      })
      .catch(() => {
        // Tauri event bridge unavailable outside the desktop runtime.
      });

    return () => {
      disposed = true;
      cleanup.forEach((unlisten) => unlisten());
      window.clearTimeout(dismissTimer.current);
    };
  }, [scheduleDismiss]);

  const cancel = useCallback(async (transferId: string) => {
    setTransfer((current) => current?.transferId === transferId
      ? { ...current, phase: "cancelling" }
      : current);
    try {
      await invoke("cancel_relay_send", { transferId });
    } catch (error) {
      setTransfer((current) => current?.transferId === transferId
        ? { ...current, phase: "error", error: String(error) }
        : current);
      scheduleDismiss(transferId);
    }
  }, [scheduleDismiss]);

  const dismiss = useCallback((transferId: string) => {
    window.clearTimeout(dismissTimer.current);
    setTransfer((current) => current?.transferId === transferId ? null : current);
  }, []);

  return { transfer, onCancel: cancel, onDismiss: dismiss };
}

interface RelaySendStatusProps {
  transfer: RelaySendState | null;
  onCancel: (transferId: string) => Promise<void>;
  onDismiss: (transferId: string) => void;
}

export function RelaySendStatus({ transfer, onCancel, onDismiss }: RelaySendStatusProps) {
  if (!transfer) return null;

  const active = transfer.phase === "waiting" || transfer.phase === "uploading" || transfer.phase === "cancelling";
  const percentage = transfer.totalBytes > 0
    ? Math.min(100, Math.round((transfer.totalSent / transfer.totalBytes) * 100))
    : transfer.phase === "complete" ? 100 : 0;
  const title = transfer.phase === "waiting"
    ? `等待 ${transfer.target} 确认`
    : transfer.phase === "uploading"
      ? `正在发送给 ${transfer.target}`
      : transfer.phase === "cancelling"
        ? "正在取消发送"
        : transfer.phase === "complete"
          ? `已发送给 ${transfer.target}`
          : transfer.error || "发送失败";
  const detail = transfer.phase === "waiting"
    ? `${transfer.fileCount} 个文件 · ${formatBytes(transfer.totalBytes)}`
    : transfer.phase === "uploading"
      ? `${transfer.filename} · ${transfer.fileIndex}/${transfer.fileCount}`
      : transfer.phase === "complete"
        ? `${transfer.fileCount} 个文件 · ${formatBytes(transfer.totalBytes)}`
        : transfer.error || "发送任务未完成";

  return (
    <aside className={`relay-send-status relay-send-${transfer.phase}`} role="status" aria-live="polite">
      <div className="relay-send-heading">
        {transfer.phase === "complete" ? <Check size={14} /> : active ? <LoaderCircle className="relay-send-spinner" size={14} /> : <Send size={14} />}
        <strong title={title}>{title}</strong>
        {active ? (
          <button disabled={transfer.phase === "cancelling"} onClick={() => void onCancel(transfer.transferId)}>
            取消
          </button>
        ) : (
          <button aria-label="关闭发送状态" onClick={() => onDismiss(transfer.transferId)}>
            <X size={12} />
          </button>
        )}
      </div>
      <div className="relay-send-detail" title={detail}>{detail}</div>
      <div
        className="relay-send-track"
        role="progressbar"
        aria-label="发送进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percentage}
      >
        <i style={{ width: `${percentage}%` }} />
      </div>
    </aside>
  );
}
