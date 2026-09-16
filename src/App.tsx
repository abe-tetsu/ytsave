import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import "./App.css";

type Mode = "mp4" | "mp3";
type Progress = { percent: number; speed: string; eta: string };

export default function App() {
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<Mode>("mp4");
  const [outDir, setOutDir] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string; path?: string } | null>(null);
  const [done, setDone] = useState<{ url: string; mode: Mode } | null>(null); // 保存済みの組み合わせ
  const [log, setLog] = useState<string[]>([]);
  const [version, setVersion] = useState("");
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    invoke<string>("default_download_dir").then(setOutDir).catch(() => {});
    invoke<string>("ytdlp_version").then(setVersion).catch((e) => setVersion(String(e)));
    const unlisten = [
      listen<Progress>("dl:progress", (e) => {
        setProgress(e.payload);
        setStatus("");
      }),
      listen<string>("dl:status", (e) => setStatus(e.payload)),
      listen<string>("dl:log", (e) => setLog((l) => [...l.slice(-300), e.payload])),
    ];
    return () => {
      unlisten.forEach((p) => p.then((f) => f()));
    };
  }, []);

  const pickDir = async () => {
    const dir = await open({ directory: true, defaultPath: outDir || undefined });
    if (typeof dir === "string") setOutDir(dir);
  };

  const start = async () => {
    const u = url.trim();
    if (!u || running) return;
    setRunning(true);
    setProgress(null);
    setStatus("準備中…");
    setResult(null);
    setLog([]);
    try {
      const path = await invoke<string>("download", { url: u, mode, outDir });
      const name = path.split(/[\\/]/).pop() ?? path;
      setResult({
        ok: true,
        text: path === outDir ? "保存しました" : `保存しました: ${name}`,
        path,
      });
      setDone({ url: u, mode });
    } catch (e) {
      setResult({ ok: false, text: String(e) });
    } finally {
      setRunning(false);
      setStatus("");
    }
  };

  const cancel = () => invoke("cancel_download");

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

  const percent = progress?.percent ?? 0;
  const alreadySaved = done !== null && done.url === url.trim() && done.mode === mode;

  return (
    <main className="app">
      <label className="field">
        <span>動画のURL</span>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && start()}
          placeholder="https://www.youtube.com/watch?v=..."
          disabled={running}
        />
      </label>

      <div className="field">
        <span>形式</span>
        <div className="toggle">
          <button className={mode === "mp4" ? "on" : ""} onClick={() => setMode("mp4")} disabled={running}>
            動画（mp4）
          </button>
          <button className={mode === "mp3" ? "on" : ""} onClick={() => setMode("mp3")} disabled={running}>
            音声（mp3）
          </button>
        </div>
      </div>

      <div className="field">
        <span>保存先</span>
        <div className="row">
          <code className="path">{outDir || "未選択"}</code>
          <button onClick={pickDir} disabled={running}>
            選ぶ
          </button>
        </div>
      </div>

      {running ? (
        <button className="primary cancel" onClick={cancel}>
          中止
        </button>
      ) : (
        <button
          className="primary"
          onClick={start}
          disabled={!url.trim() || !outDir || alreadySaved}
        >
          {alreadySaved ? "保存済み" : "ダウンロード"}
        </button>
      )}

      {(running || progress) && (
        <div className="progress">
          <div className="bar">
            <div className="fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="meta">
            {status ||
              (progress
                ? `${percent.toFixed(1)}%  ${progress.speed}  残り ${progress.eta}`
                : "")}
          </div>
        </div>
      )}

      {result && (
        <div className={`result ${result.ok ? "ok" : "bad"}`}>
          <span>{result.ok ? "✓ " : "✗ "}{result.text}</span>
          {result.ok && result.path && (
            <button onClick={() => revealItemInDir(result.path!)}>フォルダで表示</button>
          )}
        </div>
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
