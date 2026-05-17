import type { ViewResult, AIPlan } from '../../api'

export default function AIContent({ data }: { data: ViewResult }) {
  const plans: AIPlan[] = data.aiPlans || []

  if (plans.length === 0) {
    return <div className="empty-state">No AI plans found.</div>
  }

  return (
    <div>
      <h2 className="section-heading" style={{ fontSize: 18, marginBottom: 8 }}>
        🤖 AI Behavior Profile
      </h2>
      <p style={{ color: 'var(--text-secondary)', marginBottom: 20, fontSize: 14 }}>
        Unit build weights determine priority when the AI selects which units to produce.
        Build limits cap the maximum number of each unit type.
      </p>

      {plans.map((plan, pi) => {
        const maxWeight = plan.Weights
          ? Math.max(...plan.Weights.map(w => Math.abs(w.Weight)), 1)
          : 1

        return (
          <div key={pi} className="ai-plan-card">
            <h3 className="ai-plan-name">📋 {plan.Name} Difficulty</h3>

            {plan.Weights && plan.Weights.length > 0 && (
              <div className="ai-section">
                <h4 className="ai-section-title">⚖️ Unit Weights</h4>
                <div className="ai-weight-list">
                  {plan.Weights.map((w, wi) => (
                    <div key={wi} className="ai-weight-row">
                      <span className="ai-unit-name">{w.UnitName}</span>
                      <div className="ai-bar-container">
                        <div
                          className="ai-bar"
                          style={{ width: `${Math.max((Math.abs(w.Weight) / maxWeight) * 100, 2)}%` }}
                        >
                          <span className="ai-bar-value">{w.Weight}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {plan.Limits && plan.Limits.length > 0 && (
              <div className="ai-section">
                <h4 className="ai-section-title">🔢 Build Limits</h4>
                <div className="ai-limits-list">
                  {plan.Limits.map((l, li) => (
                    <div key={li} className="ai-limit-row">
                      <span className="ai-unit-name">{l.UnitName}</span>
                      <span className={`ai-limit-value ${l.Maximum === 0 ? 'disabled' : ''}`}>
                        {l.Maximum === -1 ? '∞' : l.Maximum === 0 ? 'Disabled' : `Max: ${l.Maximum}`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
