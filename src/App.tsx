import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import "./App.css";

type Mode = "mp4" | "mp3";
type Progress = { percent: number; speed: string; eta: string };
type ItemState = "wait" | "run" | "ok" | "bad" | "cancel";
type Item = { url: string; state: ItemState; text?: string; path?: string };

const STATE_MARK: Record<ItemState, string> = {
  wait: "・",
  run: "▶",
  ok: "✓",
  bad: "✗",
  cancel: "－",
};

// 1行1URL。空行と重複は除く
const parseUrls = (text: string) =>
  Array.from(new Set(text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)));

export default function App() {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<Mode>("mp4");
  const [outDir, setOutDir] = useState("");
  const [running, setRunning] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [current, setCurrent] = useState(0);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [status, setStatus] = useState("");
  const [done, setDone] = useState<{ text: string; mode: Mode } | null>(null); // 保存済みの組み合わせ
  const [log, setLog] = useState<string[]>([]);
  const [version, setVersion] = useState("");
  const [updating, setUpdating] = useState(false);
  const cancelRef = useRef(false);

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

  const patchItem = (i: number, p: Partial<Item>) =>
    setItems((list) => list.map((it, j) => (j === i ? { ...it, ...p } : it)));

  const start = async () => {
    const urls = parseUrls(text);
    if (urls.length === 0 || running) return;
    cancelRef.current = false;
    setRunning(true);
    setItems(urls.map((url) => ({ url, state: "wait" })));
    setLog([]);

    for (let i = 0; i < urls.length; i++) {
      if (cancelRef.current) {
        setItems((list) =>
          list.map((it) => (it.state === "wait" ? { ...it, state: "cancel" } : it)),
        );
        break;
      }
      setCurrent(i);
      setProgress(null);
      setStatus("準備中…");
      patchItem(i, { state: "run" });
      try {
        const path = await invoke<string>("download", { url: urls[i], mode, outDir });
        const name = path.split(/[\\/]/).pop() ?? path;
        patchItem(i, { state: "ok", text: path === outDir ? "保存しました" : name, path });
      } catch (e) {
        patchItem(i, {
          state: cancelRef.current ? "cancel" : "bad",
          text: cancelRef.current ? undefined : String(e),
        });
      }
    }
    setRunning(false);
    setStatus("");
    setDone({ text: text.trim(), mode });
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

  const urlCount = parseUrls(text).length;
  const percent = progress?.percent ?? 0;
  const alreadySaved = done !== null && done.text === text.trim() && done.mode === mode;

  return (
    <main className="app">
      <label className="field">
        <span>動画のURL（1行に1つ、複数可）</span>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === "Enter" && start()}
          placeholder={"https://www.youtube.com/watch?v=...\nhttps://youtu.be/..."}
          rows={4}
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
          disabled={urlCount === 0 || !outDir || alreadySaved}
        >
          {alreadySaved
            ? "保存済み"
            : urlCount > 1
              ? `${urlCount}件をダウンロード`
              : "ダウンロード"}
        </button>
      )}

      {running && (
        <div className="progress">
          <div className="bar">
            <div className="fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="meta">
            {items.length > 1 && <span className="count">{current + 1} / {items.length} 件目　</span>}
            {status ||
              (progress ? `${percent.toFixed(1)}%  ${progress.speed}  残り ${progress.eta}` : "")}
          </div>
        </div>
      )}

      {items.length > 0 && (
        <ul className="items">
          {items.map((it, i) => (
            <li key={i} className={it.state}>
              <span className="mark">{STATE_MARK[it.state]}</span>
              <span className="label" title={it.url}>
                {it.text ?? it.url}
              </span>
              {it.state === "ok" && it.path && (
                <button onClick={() => revealItemInDir(it.path!)}>表示</button>
              )}
            </li>
          ))}
        </ul>
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
