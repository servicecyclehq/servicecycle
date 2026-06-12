// ─────────────────────────────────────────────────────────────────────────────
// FlywheelExplainer.jsx — gem R5: make the two-sided contractor flywheel
// obvious. Sits atop the Fleet Dashboard and names the motion the product
// already supports: onboard a facility with your own reports → their program
// fills in → they send you quote requests → you see the fleet-wide
// modernization pipeline → you win the work. A buyer purchases the CHANNEL.
//
// Props: { onOnboard: fn, onPipeline: fn, accountCount?: number }
// ─────────────────────────────────────────────────────────────────────────────

import { UserPlus, FileText, Send, TrendingUp } from 'lucide-react';

const STEPS = [
  { icon: UserPlus,   title: 'Onboard',  text: 'Invite a facility — their NETA reports seed the program.' },
  { icon: FileText,   title: 'Program',  text: 'Assets, schedules & compliance fill in automatically.' },
  { icon: Send,       title: 'Quote',    text: 'They send quote requests back — straight to your inbox.' },
  { icon: TrendingUp, title: 'Pipeline', text: 'See the fleet-wide 3-year modernization forecast.' },
];

export default function FlywheelExplainer({ onOnboard, onPipeline, accountCount }) {
  return (
    <div style={{
      border: '1px solid var(--color-border)', borderRadius: 12, marginBottom: 20, overflow: 'hidden',
      background: 'linear-gradient(135deg, var(--color-bg-secondary, #f8fafc), var(--color-bg, #fff))',
    }}>
      <div style={{ padding: '16px 18px 6px' }}>
        <div style={{ fontWeight: 800, fontSize: 16 }}>Your customer flywheel</div>
        <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', marginTop: 2, maxWidth: 760 }}>
          Every report you already hand customers is an onboarding funnel. ServiceCycle reads it, hands back the
          fix list, and the facility&rsquo;s quote requests and modernization spend flow back to you
          {typeof accountCount === 'number' && accountCount > 0 ? ` — across your ${accountCount} connected account${accountCount !== 1 ? 's' : ''}.` : '.'}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 18px', alignItems: 'stretch' }}>
        {STEPS.map((s, i) => {
          const Icon = s.icon;
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '1 1 180px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '10px 12px', borderRadius: 8,
                background: 'var(--color-bg, #fff)', border: '1px solid var(--color-border)', flex: 1, minHeight: 78 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 700, fontSize: 13 }}>
                  <Icon size={15} /> {s.title}
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.4 }}>{s.text}</div>
              </div>
              {i < STEPS.length - 1 && <span style={{ color: 'var(--color-text-secondary)', fontWeight: 700 }}>→</span>}
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: 8, padding: '4px 18px 16px', flexWrap: 'wrap' }}>
        <button className="btn btn-primary btn-sm" onClick={onOnboard}>Onboard a customer →</button>
        <button className="btn btn-secondary btn-sm" onClick={onPipeline}>See quote-request pipeline →</button>
      </div>
    </div>
  );
}
