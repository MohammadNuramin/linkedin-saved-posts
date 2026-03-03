import { useEffect, useState, useCallback } from "react";
import { RefreshCw, Calendar, CheckCircle2, XCircle, AlertCircle, Play, Trash2, Clock } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

// ─── Types ─────────────────────────────────────────────────────────────────
interface SchedulerStatus {
  enabled: boolean;
  nextRun: string | null;
  lastRun: string | null;
  status: string | null;
  hour: number;
  minute: number;
}

interface SyncLogEntry {
  date: string;
  status: "success" | "error";
  newPosts: number;
  totalPosts: number;
  elapsed?: number;
  reason?: string;
}

interface SyncStatus {
  running: boolean;
  output: string;
}

// ─── API helpers ────────────────────────────────────────────────────────────
async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json() as Promise<T>;
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = [0, 15, 30, 45];

function fmtHour(h: number) {
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:00 ${ampm}`;
}

function fmtMinute(m: number) {
  return String(m).padStart(2, "0");
}

// ─── Sync log table ─────────────────────────────────────────────────────────
function SyncLogTable({ entries }: { entries: SyncLogEntry[] }) {
  if (entries.length === 0)
    return <p className="text-sm text-muted-foreground text-center py-6">No sync history yet.</p>;

  return (
    <div className="space-y-1">
      {entries.map((e, i) => (
        <div key={i} className="flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-muted/50">
          {e.status === "success" ? (
            <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
          ) : (
            <XCircle className="h-4 w-4 text-destructive shrink-0" />
          )}
          <span className="text-muted-foreground shrink-0 w-36 text-xs">
            {new Date(e.date).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
          </span>
          <span className="flex-1 truncate">
            {e.status === "success" ? (
              e.newPosts > 0 ? (
                <span className="text-green-600 dark:text-green-400 font-medium">+{e.newPosts} new</span>
              ) : (
                <span className="text-muted-foreground">No new posts</span>
              )
            ) : (
              <span className="text-destructive text-xs truncate">{e.reason ?? "Error"}</span>
            )}
          </span>
          <span className="text-xs text-muted-foreground shrink-0">{e.totalPosts} total</span>
          {e.elapsed != null && (
            <span className="text-xs text-muted-foreground shrink-0">{e.elapsed}s</span>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────
interface Props {
  open: boolean;
  onClose: () => void;
}

export function SchedulerSettings({ open, onClose }: Props) {
  const [scheduler, setScheduler] = useState<SchedulerStatus | null>(null);
  const [log, setLog] = useState<SyncLogEntry[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ running: false, output: "" });
  const [selectedHour, setSelectedHour] = useState(8);
  const [selectedMinute, setSelectedMinute] = useState(0);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);

  // Check if API server is reachable
  const [apiAvailable, setApiAvailable] = useState<boolean | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const [sched, entries] = await Promise.all([
        apiFetch<SchedulerStatus>("/api/scheduler"),
        apiFetch<SyncLogEntry[]>("/api/sync-log"),
      ]);
      setScheduler(sched);
      setLog(entries);
      setSelectedHour(sched.hour);
      setSelectedMinute(sched.minute);
      setApiAvailable(true);
      setApiError(null);
    } catch (e) {
      setApiAvailable(false);
      setApiError(e instanceof Error ? e.message : "API unavailable");
    }
  }, []);

  useEffect(() => {
    if (open) fetchAll();
  }, [open, fetchAll]);

  // Poll sync status while running
  useEffect(() => {
    if (!syncStatus.running) return;
    const id = setInterval(async () => {
      try {
        const s = await apiFetch<SyncStatus>("/api/sync/status");
        setSyncStatus(s);
        if (!s.running) { fetchAll(); }
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(id);
  }, [syncStatus.running, fetchAll]);

  const handleSetup = async () => {
    setSaving(true);
    setApiError(null);
    try {
      await apiFetch("/api/scheduler", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hour: selectedHour, minute: selectedMinute }),
      });
      await fetchAll();
    } catch (e) {
      setApiError(e instanceof Error ? e.message : "Failed");
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    setApiError(null);
    try {
      await apiFetch("/api/scheduler", { method: "DELETE" });
      await fetchAll();
    } catch (e) {
      setApiError(e instanceof Error ? e.message : "Failed");
    } finally {
      setRemoving(false);
    }
  };

  const handleSyncNow = async () => {
    setApiError(null);
    try {
      await apiFetch("/api/sync", { method: "POST" });
      setSyncStatus({ running: true, output: "" });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed";
      setApiError(msg.includes("409") ? "Sync already running" : msg);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col p-0">
        <DialogHeader className="px-6 pt-5 pb-3">
          <div className="flex items-center gap-2">
            <Calendar className="h-5 w-5 text-primary" />
            <DialogTitle>Scheduler &amp; Sync</DialogTitle>
          </div>
        </DialogHeader>

        <ScrollArea className="flex-1 px-6 pb-6">
          <div className="space-y-5">

            {/* API unavailable warning */}
            {apiAvailable === false && (
              <div className="flex items-start gap-2 rounded-md border border-yellow-300 bg-yellow-50 dark:bg-yellow-900/20 dark:border-yellow-700 p-3 text-sm text-yellow-800 dark:text-yellow-300">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <div>
                  <p className="font-medium">API server not running</p>
                  <p className="text-xs mt-0.5 opacity-80">
                    Start it with: <code className="font-mono">npm run viewer</code>
                  </p>
                </div>
              </div>
            )}

            {/* Status */}
            {scheduler && (
              <div className="rounded-lg border p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">Scheduled task</span>
                  <Badge variant={scheduler.enabled ? "default" : "secondary"}>
                    {scheduler.enabled ? "Active" : "Inactive"}
                  </Badge>
                </div>
                {scheduler.enabled && (
                  <>
                    {scheduler.nextRun && (
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Clock className="h-3.5 w-3.5" />
                        Next run: {scheduler.nextRun}
                      </div>
                    )}
                    {scheduler.lastRun && (
                      <div className="text-xs text-muted-foreground pl-5">
                        Last run: {scheduler.lastRun}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Time picker */}
            <div className="space-y-2">
              <p className="text-sm font-medium">Run daily at</p>
              <div className="flex items-center gap-2">
                <Select
                  value={String(selectedHour)}
                  onValueChange={(v) => setSelectedHour(parseInt(v))}
                  disabled={apiAvailable === false}
                >
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HOURS.map((h) => (
                      <SelectItem key={h} value={String(h)}>{fmtHour(h)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-sm text-muted-foreground">:</span>
                <Select
                  value={String(selectedMinute)}
                  onValueChange={(v) => setSelectedMinute(parseInt(v))}
                  disabled={apiAvailable === false}
                >
                  <SelectTrigger className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MINUTES.map((m) => (
                      <SelectItem key={m} value={String(m)}>{fmtMinute(m)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Button
                  size="sm"
                  onClick={handleSetup}
                  disabled={saving || apiAvailable !== true}
                  className="ml-auto"
                >
                  {saving ? (
                    <RefreshCw className="h-3.5 w-3.5 animate-spin mr-1" />
                  ) : null}
                  {scheduler?.enabled ? "Update schedule" : "Enable schedule"}
                </Button>

                {scheduler?.enabled && (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={handleRemove}
                    disabled={removing || apiAvailable !== true}
                  >
                    {removing ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                If the PC is off at that time, the sync runs automatically when it turns back on.
              </p>
            </div>

            {apiError && (
              <p className="text-xs text-destructive">{apiError}</p>
            )}

            <Separator />

            {/* Manual sync */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Manual sync</p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleSyncNow}
                  disabled={syncStatus.running || apiAvailable !== true}
                >
                  <Play className={cn("h-3.5 w-3.5 mr-1", syncStatus.running && "animate-pulse")} />
                  {syncStatus.running ? "Syncing…" : "Sync now"}
                </Button>
              </div>
              {syncStatus.running && syncStatus.output && (
                <pre className="rounded-md bg-muted p-3 text-xs font-mono overflow-x-auto whitespace-pre-wrap max-h-32">
                  {syncStatus.output.split("\r").pop()}
                </pre>
              )}
            </div>

            <Separator />

            {/* Sync log */}
            <div className="space-y-2">
              <p className="text-sm font-medium">Sync history</p>
              <SyncLogTable entries={log} />
            </div>

          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
