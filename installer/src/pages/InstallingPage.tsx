import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface InstallingPageProps {
  associateMd: boolean;
  folderVerb: boolean;
  targetDir: string;
  createDesktopShortcut: boolean;
  onComplete: () => void;
  onError: (msg: string) => void;
}

export default function InstallingPage({
  targetDir,
  createDesktopShortcut,
  associateMd,
  folderVerb,
  onComplete,
  onError,
}: InstallingPageProps) {
  const [progress, setProgress] = useState(0);
  const hasStarted = useRef(false);

  useEffect(() => {
    if (hasStarted.current) return;
    hasStarted.current = true;

    const doInstall = async () => {
      try {
        for (let i = 0; i <= 70; i += 5) {
          setProgress(i);
          await new Promise((r) => setTimeout(r, 30));
        }

        await invoke("install", {
          targetDir,
          createDesktopShortcut,
        });

        if (associateMd) {
          await invoke("associate_md_files", { installDir: targetDir });
        }

        if (folderVerb) {
          await invoke("register_folder_verb", { installDir: targetDir });
        }

        for (let i = 70; i <= 85; i += 3) {
          setProgress(i);
          await new Promise((r) => setTimeout(r, 20));
        }

        for (let i = 85; i < 100; i += 2) {
          setProgress(i);
          await new Promise((r) => setTimeout(r, 15));
        }

        setProgress(100);
        await new Promise((r) => setTimeout(r, 400));
        onComplete();
      } catch (err: any) {
        onError(String(err));
      }
    };

    doInstall();
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        flex: 1,
        minHeight: 0,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Logo 正下方：细白进度条 + 上方小字（左状态、右百分比） */}
      <div className="install-progress">
        <div className="progress-meta">
          <span className="progress-label">正在安装OpenMD，请稍候...</span>
          <span className="progress-value">{progress}%</span>
        </div>
        <div className="progress-bar">
          <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
        </div>
      </div>
    </div>
  );
}
