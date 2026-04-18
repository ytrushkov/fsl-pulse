import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

export default function ActionPlanView({ engagementId, deliverables }: any) {
  if (!deliverables?.actionPlan?.length) return <div className="p-8 text-center text-muted-foreground">No action plan available.</div>;

  return (
    <div className="p-8">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Strategic Action Plan</h2>
          <p className="text-muted-foreground">Prioritized initiatives to reach target state.</p>
        </div>
        <Badge variant={deliverables.statuses.actionPlan === 'locked' ? 'default' : 'outline'} className="uppercase tracking-widest text-xs">
          {deliverables.statuses.actionPlan}
        </Badge>
      </div>

      <div className="border rounded-md shadow-sm overflow-hidden">
        <Table>
          <TableHeader className="bg-muted/50">
            <TableRow>
              <TableHead className="w-24">Priority</TableHead>
              <TableHead>Initiative</TableHead>
              <TableHead>Dimension</TableHead>
              <TableHead>Effort</TableHead>
              <TableHead>Impact</TableHead>
              <TableHead>Owner</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {deliverables.actionPlan.map((item: any) => (
              <TableRow key={item.id} className="bg-card">
                <TableCell>
                  <Badge variant={item.priority === 'P0' ? 'destructive' : item.priority === 'P1' ? 'default' : 'secondary'} className="font-mono">
                    {item.priority}
                  </Badge>
                </TableCell>
                <TableCell className="font-medium text-base">{item.initiative}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="capitalize">{item.dimension}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className="font-mono bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 border-0">{item.effort}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant="secondary" className="font-mono bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300 border-0">{item.impact}</Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{item.ownerRole || "Unassigned"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
