interface StepIndicatorProps {
  currentStep: number;
}

const steps = ["欢迎", "许可协议", "安装位置", "安装中", "完成"] as const;

export default function StepIndicator({ currentStep }: StepIndicatorProps) {
  return (
    <div>
      {steps.map((stepLabel, index) => {
        const stepNum = index + 1;
        const isActive = currentStep === stepNum;
        const isDone = currentStep > stepNum;

        return (
          <div key={stepLabel} className={`step-item ${isActive ? "active" : ""} ${isDone ? "done" : ""}`}>
            <div className="step-number">
              {isDone ? "✓" : stepNum}
            </div>
            <div className="step-label">{stepLabel}</div>
          </div>
        );
      })}
    </div>
  );
}
