import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatNumber } from "@/lib/format";

export default function NpvView({ engagementId, deliverables }: any) {
  if (!deliverables?.npv) return <div className="p-8 text-center text-muted-foreground">No NPV analysis available.</div>;

  const data = deliverables.npv;
  const base = data.scenarios.base;

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-serif font-bold text-foreground">Business Case (NPV)</h2>
          <p className="text-muted-foreground">Financial modeling for agentic transformation.</p>
        </div>
        <Badge variant={deliverables.statuses.npv === 'locked' ? 'default' : 'outline'} className="uppercase tracking-widest text-xs">
          {deliverables.statuses.npv}
        </Badge>
      </div>

      <div className="grid md:grid-cols-3 gap-6 mb-8">
        <Card className="bg-primary text-primary-foreground">
          <CardHeader className="pb-2">
            <CardTitle className="text-primary-foreground/80 text-sm uppercase tracking-wider font-medium">3-Year NPV (Base Case)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold font-mono">{formatCurrency(base.npv3yr)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-sm uppercase tracking-wider font-medium">Payback Period</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold font-mono text-foreground">{base.paybackMonths} <span className="text-xl text-muted-foreground">months</span></div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-muted-foreground text-sm uppercase tracking-wider font-medium">Internal Rate of Return</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-bold font-mono text-foreground">{Math.round(base.irr * 100)}<span className="text-xl text-muted-foreground">%</span></div>
          </CardContent>
        </Card>
      </div>

      <div className="grid md:grid-cols-2 gap-8">
        <div>
          <h3 className="font-serif text-lg font-bold mb-4 border-b pb-2">Assumptions (Inputs)</h3>
          <div className="bg-muted/20 rounded-md border p-0 overflow-hidden">
            <table className="w-full text-sm">
              <tbody>
                <tr className="border-b"><td className="p-3 font-medium text-muted-foreground w-1/2">Fully Loaded Cost</td><td className="p-3 text-right font-mono font-medium">{formatCurrency(data.inputs.fullyLoadedCost)}/FTE</td></tr>
                <tr className="border-b"><td className="p-3 font-medium text-muted-foreground">Team Count</td><td className="p-3 text-right font-mono font-medium">{data.inputs.teamCount}</td></tr>
                <tr className="border-b"><td className="p-3 font-medium text-muted-foreground">Baseline Cycle Time</td><td className="p-3 text-right font-mono font-medium">{data.inputs.baselineCycleTimeDays} days</td></tr>
                <tr className="border-b"><td className="p-3 font-medium text-muted-foreground">AI Acceptance Rate</td><td className="p-3 text-right font-mono font-medium">{Math.round(data.inputs.aiAcceptanceRate * 100)}%</td></tr>
                <tr className="border-b"><td className="p-3 font-medium text-muted-foreground">Rework Rate</td><td className="p-3 text-right font-mono font-medium">{Math.round(data.inputs.reworkRate * 100)}%</td></tr>
                <tr><td className="p-3 font-medium text-muted-foreground">Discount Rate</td><td className="p-3 text-right font-mono font-medium">{Math.round(data.inputs.discountRate * 100)}%</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        <div>
          <h3 className="font-serif text-lg font-bold mb-4 border-b pb-2">Value Levers</h3>
          <div className="space-y-4 pt-2">
            {data.leverBreakdown.map((lever: any) => (
              <div key={lever.lever}>
                <div className="flex justify-between text-sm mb-1">
                  <span className="font-medium text-foreground">{lever.lever}</span>
                  <span className="font-mono text-muted-foreground">{formatCurrency(lever.savings)}</span>
                </div>
                <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
                  <div className="bg-primary h-full" style={{ width: `${Math.min(100, Math.max(10, (lever.savings / 2000000) * 100))}%` }}></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
