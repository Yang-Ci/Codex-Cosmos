import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";
import { Check, ShieldAlert, X } from "lucide-react";
import type { RelayIncomingRequest } from "./types";

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

export function useRelayIncomingRequests() {
  const [requests, setRequests] = useState<RelayIncomingRequest[]>([]);
  const [respondingTo, setRespondingTo] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let cleanup: Array<() => void> = [];

    void Promise.all([
      listen<RelayIncomingRequest>("relay-incoming-request", (event) => {
        const request = event.payload;
        setRequests((current) => [
          ...current.filter((item) => item.requestId !== request.requestId),
          request,
        ]);

        const appWindow = getCurrentWindow();
        void Promise.allSettled([
          appWindow.show(),
          appWindow.unminimize(),
          appWindow.setFocus(),
          isPermissionGranted().then((allowed) => {
            if (!allowed) return;
            sendNotification({
              title: `来自 ${request.sender} 的投递请求`,
              body: `${request.files.length} 个文件 · ${formatBytes(request.totalBytes)}，需要你的确认`,
            });
          }),
        ]);
      }),
      listen<{ requestId: string }>("relay-incoming-expired", (event) => {
        setRequests((current) => current.filter((item) => item.requestId !== event.payload.requestId));
      }),
    ])
      .then((unlistens) => {
        if (disposed) {
          unlistens.forEach((unlisten) => unlisten());
        } else {
          cleanup = unlistens;
        }
      })
      .catch(() => {
        // Tauri event bridge unavailable; the backend still rejects on timeout.
      });

    return () => {
      disposed = true;
      cleanup.forEach((unlisten) => unlisten());
    };
  }, []);

  const respond = useCallback(async (requestId: string, accept: boolean) => {
    setRespondingTo(requestId);
    try {
      await invoke("respond_relay_request", { requestId, accept });
    } catch {
      // The backend may have timed out just before the click; remove the stale prompt.
    } finally {
      setRequests((current) => current.filter((item) => item.requestId !== requestId));
      setRespondingTo(null);
    }
  }, []);

  return { requests, respondingTo, onRespond: respond };
}

interface RelayIncomingPromptProps {
  requests: RelayIncomingRequest[];
  respondingTo: string | null;
  onRespond: (requestId: string, accept: boolean) => Promise<void>;
}

export function RelayIncomingPrompt({ requests, respondingTo, onRespond }: RelayIncomingPromptProps) {
  const request = requests[0];
  if (!request) return null;

  const firstFile = request.files[0];
  const busy = respondingTo === request.requestId;

  return (
    <div className="relay-incoming-overlay" role="alertdialog" aria-modal="true" aria-labelledby="relay-incoming-title">
      <section className="relay-incoming-card">
        <div className="relay-incoming-copy">
          <div className="relay-incoming-title" id="relay-incoming-title">
            <ShieldAlert size={15} />
            <strong>{request.sender} 请求投递</strong>
          </div>
          <div className="relay-incoming-summary">
            <span>{request.files.length} 个文件 · {formatBytes(request.totalBytes)}</span>
            {requests.length > 1 ? <b>另有 {requests.length - 1} 个请求</b> : null}
          </div>
          {firstFile ? (
            <div className="relay-incoming-file" title={firstFile.fileName}>
              {firstFile.fileName}{request.files.length > 1 ? ` 等 ${request.files.length} 个` : ""}
            </div>
          ) : null}
        </div>
        <div className="relay-incoming-actions">
          <button autoFocus disabled={busy} onClick={() => void onRespond(request.requestId, false)}>
            <X size={13} />拒绝
          </button>
          <button className="accept" disabled={busy} onClick={() => void onRespond(request.requestId, true)}>
            <Check size={13} />接收
          </button>
        </div>
      </section>
    </div>
  );
}
