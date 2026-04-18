import { useState } from "react";
import { useParams } from "wouter";
import { useGetSurveyByToken, useSubmitSurveyResponse } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, CheckCircle2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function PublicSurveyForm() {
  const params = useParams();
  const token = params.token as string;
  const { toast } = useToast();
  
  const [answers, setAnswers] = useState<Record<string, string | number>>({});
  const [submitted, setSubmitted] = useState(false);

  const { data: survey, isLoading, error } = useGetSurveyByToken(token, {
    query: { enabled: !!token, retry: false }
  });

  const submitSurvey = useSubmitSurveyResponse();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!survey) return;

    const formattedAnswers = Object.entries(answers).map(([questionId, value]) => ({
      questionId,
      value
    }));

    submitSurvey.mutate(
      { token, data: { answers: formattedAnswers, demographics: {} } },
      {
        onSuccess: () => {
          setSubmitted(true);
        },
        onError: () => {
          toast({ variant: "destructive", title: "Submission failed", description: "Please try again." });
        }
      }
    );
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <Card className="w-full max-w-2xl">
          <CardHeader>
            <Skeleton className="h-8 w-1/2 mb-2" />
            <Skeleton className="h-4 w-1/3" />
          </CardHeader>
          <CardContent className="space-y-8">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error || !survey) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <Card className="w-full max-w-md text-center p-8 border-destructive/20">
          <CardTitle className="text-destructive mb-2">Invalid or Expired Link</CardTitle>
          <p className="text-muted-foreground">This survey link is no longer active.</p>
        </Card>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
        <div className="mb-8 flex items-center gap-2 text-2xl font-bold text-slate-800">
          <Activity className="h-6 w-6 text-primary" />
          Pulse
        </div>
        <Card className="w-full max-w-md text-center p-8">
          <CheckCircle2 className="h-16 w-16 mx-auto text-green-500 mb-4" />
          <CardTitle className="text-2xl mb-2">Thank You</CardTitle>
          <p className="text-muted-foreground">Your responses have been recorded securely and anonymously.</p>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8 lg:py-12">
      <div className="max-w-3xl mx-auto mb-8 flex items-center gap-2 text-2xl font-bold text-slate-800">
        <Activity className="h-6 w-6 text-primary" />
        Pulse Survey
      </div>
      
      <Card className="max-w-3xl mx-auto shadow-md border-0 ring-1 ring-slate-200">
        <CardHeader className="bg-white border-b px-8 py-6 rounded-t-xl">
          <CardTitle className="text-3xl text-slate-900">Engineering Assessment</CardTitle>
          <CardDescription className="text-base text-slate-600 mt-2">
            For {survey.engagementClient}. Your honest feedback helps us identify bottlenecks and improvement areas. All responses are aggregated.
          </CardDescription>
        </CardHeader>
        
        <form onSubmit={handleSubmit}>
          <CardContent className="p-0">
            {survey.questions.map((q, idx) => (
              <div key={q.id} className="p-8 border-b bg-white last:border-b-0">
                <div className="mb-4">
                  <span className="text-sm font-semibold text-primary uppercase tracking-wider mb-2 block">{q.section.replace('_', ' ')}</span>
                  <Label className="text-lg font-medium text-slate-900 leading-snug">
                    {idx + 1}. {q.prompt}
                  </Label>
                </div>
                
                <div className="mt-4">
                  {q.type === 'likert' ? (
                    <RadioGroup 
                      className="flex justify-between max-w-xl mx-auto pt-2"
                      value={answers[q.id]?.toString()} 
                      onValueChange={(val) => setAnswers(prev => ({ ...prev, [q.id]: parseInt(val) }))}
                    >
                      {[1, 2, 3, 4, 5].map((val) => (
                        <div key={val} className="flex flex-col items-center gap-2">
                          <RadioGroupItem value={val.toString()} id={`${q.id}-${val}`} className="h-6 w-6" />
                          <Label htmlFor={`${q.id}-${val}`} className="text-xs font-mono text-slate-500 cursor-pointer">{val}</Label>
                        </div>
                      ))}
                    </RadioGroup>
                  ) : q.type === 'single_select' && q.options ? (
                    <RadioGroup 
                      className="space-y-3"
                      value={answers[q.id]?.toString()} 
                      onValueChange={(val) => setAnswers(prev => ({ ...prev, [q.id]: val }))}
                    >
                      {q.options.map((opt) => (
                        <div key={opt} className="flex items-center space-x-3 border p-3 rounded-md hover:bg-slate-50 transition-colors">
                          <RadioGroupItem value={opt} id={`${q.id}-${opt}`} />
                          <Label htmlFor={`${q.id}-${opt}`} className="flex-1 cursor-pointer">{opt}</Label>
                        </div>
                      ))}
                    </RadioGroup>
                  ) : (
                    <Input 
                      className="max-w-md bg-slate-50"
                      value={answers[q.id]?.toString() || ""}
                      onChange={(e) => setAnswers(prev => ({ ...prev, [q.id]: e.target.value }))}
                      placeholder="Your answer..."
                    />
                  )}
                </div>
              </div>
            ))}
          </CardContent>
          <CardFooter className="bg-slate-50 p-8 rounded-b-xl border-t flex justify-end">
            <Button 
              type="submit" 
              size="lg" 
              className="px-8 text-base shadow-sm"
              disabled={submitSurvey.isPending || Object.keys(answers).length < survey.questions.length}
            >
              {submitSurvey.isPending ? "Submitting..." : "Submit Responses"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
