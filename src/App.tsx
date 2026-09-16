import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import "./App.css";

type Mode = "mp4" | "mp3";
type Progress = { percent: number; speed: string; eta: string };
type RowState = "wait" | "run" | "ok" | "bad" | "cancel";
type Row = {
  id: number;
  url: string;
  mode: Mode;
  state: RowState;
  text?: string; // 完了時はファイル名、失敗時は理由
  path?: string;
  percent?: number;
};

const MARK: Record<RowState, string> = {
  wait: "○",
  run: "⏳",
  ok: "✅",
  bad: "❌",
  cancel: "－",
};

let nextId = 1;
const newRow = (mode: Mode): Row => ({ id: nextId++, url: "", mode, state: "wait" });
const RESET: Partial<Row> = { state: "wait", text: undefined, path: undefined, percent: undefined };

export default function App() {
  const [mode, setMode] = useState<Mode>("mp4"); // 新しい行の既定。切り替えると全行に適用
  const [rows, setRows] = useState<Row[]>([newRow("mp4")]);
  const [outDir, setOutDir] = useState("");
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [version, setVersion] = useState("");
  const [updating, setUpdating] = useState(false);
  const cancelRef = useRef(false);
  const runningId = useRef<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const focusNew = useRef(false);

  const patchRow = (id: number, p: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));

  useEffect(() => {
    invoke<string>("default_download_dir").then(setOutDir).catch(() => {});
    invoke<string>("ytdlp_version").then(setVersion).catch((e) => setVersion(String(e)));
    const unlisten = [
      listen<Progress>("dl:progress", (e) => {
        if (runningId.current !== null) patchRow(runningId.current, { percent: e.payload.percent });
        setStatus("");
      }),
      listen<string>("dl:status", (e) => setStatus(e.payload)),
      listen<string>("dl:log", (e) => setLog((l) => [...l.slice(-300), e.payload])),
    ];
    return () => {
      unlisten.forEach((p) => p.then((f) => f()));
    };
  }, []);

  // 追加した行の入力欄にフォーカス
  useEffect(() => {
    if (!focusNew.current) return;
    focusNew.current = false;
    const inputs = listRef.current?.querySelectorAll<HTMLInputElement>("input");
    inputs?.[inputs.length - 1]?.focus();
  }, [rows.length]);

  const addRow = () => {
    focusNew.current = true;
    setRows((rs) => [...rs, newRow(mode)]);
  };
  const removeRow = (id: number) =>
    setRows((rs) => (rs.length === 1 ? [newRow(mode)] : rs.filter((r) => r.id !== id)));
  const setUrl = (id: number, url: string) => patchRow(id, { url, ...RESET });
  const setRowMode = (id: number, m: Mode) => patchRow(id, { mode: m, ...RESET });

  // Enter: 最終行なら行を追加、それ以外は次の行へ
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, i: number) => {
    if (e.nativeEvent.isComposing) return;
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      start();
      return;
    }
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (i === rows.length - 1) addRow();
    else listRef.current?.querySelectorAll<HTMLInputElement>("input")[i + 1]?.focus();
  };

  // 保存先を変えたら、完了済みの行も再びダウンロード対象に戻す
  const resetDone = () =>
    setRows((rs) => rs.map((r) => (r.state === "ok" ? { ...r, ...RESET } : r)));

  const pickDir = async () => {
    const dir = await open({ directory: true, defaultPath: outDir || undefined });
    if (typeof dir === "string" && dir !== outDir) {
      setOutDir(dir);
      resetDone();
    }
  };

  // 上段の形式: 全行に適用（形式が変わった行は再ダウンロード対象に戻す）
  const changeMode = (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    setRows((rs) => rs.map((r) => (r.mode === m ? r : { ...r, mode: m, ...RESET })));
  };

  // 未完了（URLあり・完了以外）の行を上から順に落とす
  const targets = rows.filter((r) => r.url.trim() && r.state !== "ok");

  const start = async () => {
    if (targets.length === 0 || running || !outDir) return;
    cancelRef.current = false;
    setRunning(true);
    setLog([]);
    for (const t of targets) {
      if (cancelRef.current) break;
      runningId.current = t.id;
      setStatus("準備中…");
      patchRow(t.id, { state: "run", percent: 0, text: undefined });
      try {
        const path = await invoke<string>("download", { url: t.url.trim(), mode: t.mode, outDir });
        const name = path.split(/[\\/]/).pop() ?? path;
        patchRow(t.id, { state: "ok", text: path === outDir ? "保存しました" : name, path });
      } catch (e) {
        patchRow(t.id, {
          state: cancelRef.current ? "cancel" : "bad",
          text: cancelRef.current ? undefined : String(e),
        });
      }
    }
    runningId.current = null;
    setRunning(false);
    setStatus("");
  };

  const cancel = () => {
    cancelRef.current = true;
    invoke("cancel_download");
  };

  const update = async () => {
    setUpdating(true);
    try {
      const out = await invoke<string>("update_ytdlp");
      setLog((l) => [...l, ...out.split("\n")]);
      setVersion(await invoke<string>("ytdlp_version"));
    } catch (e) {
      setLog((l) => [...l, String(e)]);
    } finally {
      setUpdating(false);
    }
  };

  const doneCount = rows.filter((r) => r.state === "ok").length;

  return (
    <main className="app">
      <div className="settings">
        <div className="field">
          <span>形式（全行に適用）</span>
          <div className="toggle">
            <button className={mode === "mp4" ? "on" : ""} onClick={() => changeMode("mp4")} disabled={running}>
              動画（mp4）
            </button>
            <button className={mode === "mp3" ? "on" : ""} onClick={() => changeMode("mp3")} disabled={running}>
              音声（mp3）
            </button>
          </div>
        </div>
        <div className="field grow">
          <span>保存先</span>
          <div className="row">
            <code className="path">{outDir || "未選択"}</code>
            <button onClick={pickDir} disabled={running}>
              選ぶ
            </button>
          </div>
        </div>
      </div>

      <div className="field">
        <span>動画のURL</span>
        <div className="rows" ref={listRef}>
          {rows.map((r, i) => (
            <div className={`urlrow ${r.state}`} key={r.id}>
              <span className="mark" title={r.state}>
                {MARK[r.state]}
              </span>
              <input
                value={r.url}
                onChange={(e) => setUrl(r.id, e.target.value)}
                onKeyDown={(e) => onKeyDown(e, i)}
                placeholder="https://www.youtube.com/watch?v=..."
                disabled={running}
              />
              <div className="toggle mini">
                <button
                  className={r.mode === "mp4" ? "on" : ""}
                  onClick={() => setRowMode(r.id, "mp4")}
                  disabled={running}
                >
                  mp4
                </button>
                <button
                  className={r.mode === "mp3" ? "on" : ""}
                  onClick={() => setRowMode(r.id, "mp3")}
                  disabled={running}
                >
                  mp3
                </button>
              </div>
              <span className="trail" title={r.text}>
                {r.state === "run" &&
                  (status || (r.percent !== undefined ? `${r.percent.toFixed(0)}%` : ""))}
                {r.state === "ok" && r.text}
                {r.state === "bad" && r.text}
                {r.state === "cancel" && "中止"}
              </span>
              {r.state === "ok" && r.path ? (
                <button className="small" onClick={() => revealItemInDir(r.path!)}>
                  表示
                </button>
              ) : (
                <button
                  className="small del"
                  onClick={() => removeRow(r.id)}
                  disabled={running}
                  aria-label="削除"
                >
                  ×
                </button>
              )}
              {r.state === "run" && (
                <div className="thin">
                  <div className="fill" style={{ width: `${r.percent ?? 0}%` }} />
                </div>
              )}
            </div>
          ))}
        </div>
        <button className="add" onClick={addRow} disabled={running}>
          ＋ URLを追加
        </button>
      </div>

      {running ? (
        <button className="primary cancel" onClick={cancel}>
          中止
        </button>
      ) : (
        <button className="primary" onClick={start} disabled={targets.length === 0 || !outDir}>
          {targets.length === 0 && doneCount > 0
            ? "すべて保存済み"
            : `一括ダウンロード${targets.length > 0 ? `（${targets.length}件）` : ""}`}
        </button>
      )}

      <details className="log">
        <summary>ログ</summary>
        <pre>{log.join("\n")}</pre>
      </details>

      <footer>
        <span>yt-dlp {version}</span>
        <button onClick={update} disabled={running || updating}>
          {updating ? "更新中…" : "yt-dlp を更新"}
        </button>
      </footer>
    </main>
  );
}
