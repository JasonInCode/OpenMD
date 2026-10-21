import { useState } from "react";
import { LuX } from "react-icons/lu";
import LicensePage from "./LicensePage";

interface ModeSelectPageProps {
  onQuick: () => void;
  onCustom: () => void;
  isUpgrade: boolean;
  ready: boolean;
}

export default function ModeSelectPage({ onQuick, onCustom, isUpgrade, ready }: ModeSelectPageProps) {
  const [agreed, setAgreed] = useState(true);
  const [showLicense, setShowLicense] = useState(false);

  const enabled = agreed && ready;

  return (
    <div
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}
    >
      {/* Logo 由外壳固定渲染（中间略偏上），按钮位于中下部 */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div className="mode-buttons">
          <button
            type="button"
            className={`btn-primary mode-btn${enabled ? "" : " disabled"}`}
            disabled={!enabled}
            onClick={onQuick}
          >
            {isUpgrade ? "更新" : "快速安装"}
          </button>

          <button
            type="button"
            className={`btn-primary mode-btn${enabled ? "" : " disabled"}`}
            disabled={!enabled}
            onClick={onCustom}
          >
            自定义安装
          </button>
        </div>
      </div>

      <div className="agree-row">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
          />
          <span className="checkbox-mark" />
          <span>我已阅读并同意</span>
        </label>
        <span
          className="agree-link"
          role="link"
          onClick={() => setShowLicense(true)}
        >
          《用户协议》
        </span>
      </div>

      {showLicense && (
        <div className="modal-overlay" onClick={() => setShowLicense(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <button
              className="modal-close"
              onClick={() => setShowLicense(false)}
              aria-label="关闭"
            >
              <LuX size={18} />
            </button>
            <LicensePage onAgreed={() => {}} />
          </div>
        </div>
      )}
    </div>
  );
}
