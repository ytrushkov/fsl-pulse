import { useState, useEffect, useMemo, useRef } from "react";
import { useParams } from "wouter";
import {
  useGetSurveyByToken,
  useSubmitSurveyResponse,
  useSaveSurveyDraft,
  getGetSurveyByTokenQueryKey,
} from "@workspace/api-client-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Activity, CheckCircle2, Clock, Lock } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

type AnswerValue = string | number;

export default function PublicSurveyForm() {
  const params = useParams();
  const token = params.token as string;
  const { toast } = useToast();

  const [answers, setAnswers] = useState<Record<string, AnswerValue>>({});
  const [submitted, setSubmitted] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);

  const { data: survey, isLoading, error } = useGetSurveyByToken(token, {
    query: {
      enabled: !!token,
      retry: false,
      queryKey: getGetSurveyByTokenQueryKey(token),
    },
  });

  const submitSurvey = useSubmitSurveyResponse();
  const saveDraft = useSaveSurveyDraft();

  // Hydrate state from server-side draft exactly once after the first
  // successful fetch. Subsequent re-renders must not stomp local edits.
  useEffect(() => {
    if (!survey || hydrated) return;
    const saved = survey.savedAnswers ?? [];
    if (saved.length > 0) {
      const next: Record<string, AnswerValue> = {};
      for (const a of saved) {
        if (typeof a.value === "string" || typeof a.value === "number") {
          next[a.questionId] = a.value;
        }
      }
      setAnswers(next);
    }
    setHydrated(true);
  }, [survey, hydrated]);

  // Debounced autosave. We only POST a draft when the user has actually
  // changed something (hydrated && answers populated) and the survey is open.
  const lastSentRef = useRef<string>("");
  useEffect(() => {
    if (!hydrated || !survey || survey.status !== "open") return;
    const payload = JSON.stringify(answers);
    if (payload === lastSentRef.current) return;
    if (Object.keys(answers).length === 0) return;
    const t = setTimeout(() => {
      const formatted = Object.entries(answers).map(([questionId, value]) => ({
        questionId,
        value,
      }));
      saveDraft.mutate(
        { token, data: { answers: formatted } },
        {
          onSuccess: () => {
            lastSentRef.current = payload;
            setLastSavedAt(new Date());
          },
        },
      );
    }, 1500);
    return () => clearTimeout(t);
    // saveDraft is a stable mutation handle from react-query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers, hydrated, survey?.status, token]);

  const totalQuestions = survey?.questions.length ?? 0;
  const answeredCount = useMemo(
    () =>
      survey
        ? survey.questions.filter((q) => answers[q.id] !== undefined).length
        : 0,
    [answers, survey],
  );
  const progressPct = totalQuestions
    ? Math.round((answeredCount / totalQuestions) * 100)
    : 0;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!survey) return;
    const formatted = Object.entries(answers).map(([questionId, value]) => ({
      questionId,
      value,
    }));
    submitSurvey.mutate(
      { token, data: { answers: formatted, demographics: {} } },
      {
        onSuccess: () => setSubmitted(true),
        onError: (err: unknown) => {
          const status =
            err && typeof err === "object" && "status" in err
              ? Number((err as { status: unknown }).status)
              : 0;
          if (status === 409) {
            // Server says this invite is already submitted — treat as a
            // friendly already-submitted state rather than a generic error.
            setSubmitted(true);
            return;
          }
          if (status === 410) {
            toast({
              variant: "destructive",
              title: "Survey closed",
              description:
                "The assessor has closed this survey. No new responses are being accepted.",
            });
            return;
          }
          toast({
            variant: "destructive",
            title: "Submission failed",
            description: "Please try again.",
          });
        },
      },
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
      <CenteredMessage
        icon={<Clock className="h-12 w-12 text-muted-foreground" />}
        title="Invalid or Expired Link"
        body="This survey link is no longer active. If you think this is a mistake, please contact the assessor who sent it."
      />
    );
  }

  if (survey.status === "completed" || submitted) {
    return (
      <CenteredMessage
        icon={<CheckCircle2 className="h-16 w-16 text-green-500" />}
        title={submitted ? "Thank You" : "Already Submitted"}
        body={
          submitted
            ? "Your responses have been recorded securely and anonymously."
            : "Our records show this link has already been used to submit a response. Each link can only be used once."
        }
      />
    );
  }

  if (survey.status === "closed") {
    return (
      <CenteredMessage
        icon={<Lock className="h-12 w-12 text-muted-foreground" />}
        title="Survey Closed"
        body="The assessor has closed this survey. No new responses are being accepted."
      />
    );
  }

  if (survey.status === "expired") {
    return (
      <CenteredMessage
        icon={<Clock className="h-12 w-12 text-muted-foreground" />}
        title="Link Expired"
        body="This magic link has expired. Please contact the assessor for a new one."
      />
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 p-4 md:p-8 lg:py-12">
      <div className="max-w-3xl mx-auto mb-8 flex items-center gap-2 text-2xl font-bold text-slate-800">
        <Activity className="h-6 w-6 text-primary" />
        Pulse Survey
      </div>

      {/* Sticky progress bar so respondents always see how far they've come.
          Save-and-resume is implicit: the draft is autosaved and the same
          magic link rehydrates it on the next visit. */}
      <div className="max-w-3xl mx-auto mb-4 sticky top-0 z-10 bg-slate-50 py-3">
        <div className="flex items-center justify-between text-sm text-slate-600 mb-1">
          <span data-testid="text-progress-count">
            {answeredCount} of {totalQuestions} answered
          </span>
          <span className="text-xs">
            {lastSavedAt
              ? `Saved ${lastSavedAt.toLocaleTimeString()}`
              : "Your progress will autosave"}
          </span>
        </div>
        <Progress value={progressPct} data-testid="progress-survey" />
      </div>

      <Card className="max-w-3xl mx-auto shadow-md border-0 ring-1 ring-slate-200">
        <CardHeader className="bg-white border-b px-8 py-6 rounded-t-xl">
          <CardTitle className="text-3xl text-slate-900">
            Engineering Assessment
          </CardTitle>
          <CardDescription className="text-base text-slate-600 mt-2">
            For {survey.engagementClient}. Your honest feedback helps us
            identify bottlenecks and improvement areas. All responses are
            aggregated.
          </CardDescription>
        </CardHeader>

        <form onSubmit={handleSubmit}>
          <CardContent className="p-0">
            {survey.questions.map((q, idx) => (
              <div
                key={q.id}
                className="p-8 border-b bg-white last:border-b-0"
              >
                <div className="mb-4">
                  <span className="text-sm font-semibold text-primary uppercase tracking-wider mb-2 block">
                    {q.section.replace("_", " ")}
                  </span>
                  <Label className="text-lg font-medium text-slate-900 leading-snug">
                    {idx + 1}. {q.prompt}
                  </Label>
                </div>

                <div className="mt-4">
                  {q.type === "likert" ? (
                    <RadioGroup
                      className="flex justify-between max-w-xl mx-auto pt-2"
                      value={answers[q.id]?.toString()}
                      onValueChange={(val) =>
                        setAnswers((prev) => ({
                          ...prev,
                          [q.id]: parseInt(val),
                        }))
                      }
                    >
                      {[1, 2, 3, 4, 5].map((val) => (
                        <div
                          key={val}
                          className="flex flex-col items-center gap-2"
                        >
                          <RadioGroupItem
                            value={val.toString()}
                            id={`${q.id}-${val}`}
                            className="h-6 w-6"
                          />
                          <Label
                            htmlFor={`${q.id}-${val}`}
                            className="text-xs font-mono text-slate-500 cursor-pointer"
                          >
                            {val}
                          </Label>
                        </div>
                      ))}
                    </RadioGroup>
                  ) : q.type === "single_select" && q.options ? (
                    <RadioGroup
                      className="space-y-3"
                      value={answers[q.id]?.toString()}
                      onValueChange={(val) =>
                        setAnswers((prev) => ({ ...prev, [q.id]: val }))
                      }
                    >
                      {q.options.map((opt) => (
                        <div
                          key={opt}
                          className="flex items-center space-x-3 border p-3 rounded-md hover:bg-slate-50 transition-colors"
                        >
                          <RadioGroupItem value={opt} id={`${q.id}-${opt}`} />
                          <Label
                            htmlFor={`${q.id}-${opt}`}
                            className="flex-1 cursor-pointer"
                          >
                            {opt}
                          </Label>
                        </div>
                      ))}
                    </RadioGroup>
                  ) : (
                    <Input
                      className="max-w-md bg-slate-50"
                      value={answers[q.id]?.toString() || ""}
                      onChange={(e) =>
                        setAnswers((prev) => ({
                          ...prev,
                          [q.id]: e.target.value,
                        }))
                      }
                      placeholder="Your answer..."
                    />
                  )}
                </div>
              </div>
            ))}
          </CardContent>
          <CardFooter className="bg-slate-50 p-8 rounded-b-xl border-t flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              You can close this tab and return later — your answers are saved.
            </p>
            <Button
              type="submit"
              size="lg"
              className="px-8 text-base shadow-sm"
              disabled={
                submitSurvey.isPending || answeredCount < totalQuestions
              }
              data-testid="button-submit-survey"
            >
              {submitSurvey.isPending ? "Submitting..." : "Submit Responses"}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}

function CenteredMessage({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="min-h-screen bg-slate-50 flex flex-col items-center justify-center p-4">
      <div className="mb-8 flex items-center gap-2 text-2xl font-bold text-slate-800">
        <Activity className="h-6 w-6 text-primary" />
        Pulse
      </div>
      <Card className="w-full max-w-md text-center p-8">
        <div className="flex justify-center mb-4">{icon}</div>
        <CardTitle className="text-2xl mb-2">{title}</CardTitle>
        <p className="text-muted-foreground">{body}</p>
      </Card>
    </div>
  );
}
