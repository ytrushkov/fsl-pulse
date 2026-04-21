import { useEffect, useRef } from "react";
import {
  ClerkProvider,
  SignIn,
  SignUp,
  Show,
  useAuth,
  useClerk,
} from "@clerk/react";
import { setAuthTokenGetter } from "@workspace/api-client-react";
import {
  Switch,
  Route,
  Redirect,
  useLocation,
  Router as WouterRouter,
} from "wouter";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import EngagementsList from "@/pages/engagements/index";
import EngagementOverview from "@/pages/engagements/overview";
import ConnectorsList from "@/pages/engagements/connectors";
import ArtifactsView from "@/pages/engagements/artifacts";
import ScoringView from "@/pages/engagements/scoring";
import SurveyView from "@/pages/engagements/survey";
import InterviewsView from "@/pages/engagements/interviews";
import InterviewDetailView from "@/pages/engagements/interview-detail";
import ResultsView from "@/pages/engagements/results";
import ExportsView from "@/pages/engagements/exports";
import RubricsPage from "@/pages/rubrics";
import PortfolioPage from "@/pages/portfolio";
import PublicSurveyForm from "@/pages/survey/public-survey";

const clerkPubKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as
  | string
  | undefined;
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL as
  | string
  | undefined;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in env");
}

const clerkAppearance = {
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "hsl(243, 100%, 62%)",
    colorBackground: "hsl(232, 47%, 7%)",
    colorInputBackground: "hsl(232, 40%, 12%)",
    colorText: "hsl(210, 40%, 98%)",
    colorTextSecondary: "hsl(215, 20%, 70%)",
    colorInputText: "hsl(210, 40%, 98%)",
    colorNeutral: "hsl(215, 20%, 65%)",
    borderRadius: "0.625rem",
    fontFamily: "'Inter', system-ui, sans-serif",
    fontFamilyButtons: "'Inter', system-ui, sans-serif",
    fontSize: "0.95rem",
  },
  elements: {
    rootBox: "w-full",
    cardBox:
      "rounded-2xl w-full overflow-hidden border border-white/10 bg-[hsl(232,40%,9%)] shadow-2xl",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none px-2",
    footer:
      "!shadow-none !border-0 !bg-transparent !rounded-none px-6 py-4",
    headerTitle: "",
    headerSubtitle: "",
    socialButtonsBlockButton:
      "border border-white/10 bg-white/5 hover:bg-white/10 transition-colors",
    socialButtonsBlockButtonText: "",
    formFieldLabel: "",
    formFieldInput:
      "bg-[hsl(232,40%,12%)] border border-white/10 focus:border-[hsl(243,100%,62%)] text-foreground",
    formButtonPrimary:
      "bg-[hsl(72,100%,50%)] hover:bg-[hsl(72,100%,55%)] text-[hsl(232,47%,7%)] font-bold shadow-lg shadow-[hsl(72,100%,50%)]/20 transition-colors",
    footerAction: "",
    footerActionLink: "",
    footerActionText: "",
    dividerLine: "bg-white/10",
    dividerText: "",
    identityPreviewEditButton: "",
    formFieldSuccessText: "",
    alert: "border border-white/10 bg-[hsl(232,40%,12%)]",
    alertText: "",
    otpCodeFieldInput: "bg-[hsl(232,40%,12%)] border border-white/10",
    formFieldRow: "",
    main: "",
    logoBox: "",
    logoImage: "max-h-10",
  },
} as const;

const TEXT_COLOR_OVERRIDES: Record<string, React.CSSProperties> = {
  headerTitle: { color: "hsl(210, 40%, 98%)" },
  headerSubtitle: { color: "hsl(215, 20%, 70%)" },
  socialButtonsBlockButtonText: { color: "hsl(210, 40%, 98%)" },
  formFieldLabel: { color: "hsl(210, 40%, 98%)" },
  footerActionLink: { color: "hsl(72, 100%, 55%)" },
  footerActionText: { color: "hsl(215, 20%, 70%)" },
  dividerText: { color: "hsl(215, 20%, 70%)" },
  identityPreviewEditButton: { color: "hsl(72, 100%, 55%)" },
  formFieldSuccessText: { color: "hsl(72, 100%, 60%)" },
  alertText: { color: "hsl(210, 40%, 98%)" },
};

const styledAppearance = {
  ...clerkAppearance,
  elements: Object.fromEntries(
    Object.entries(clerkAppearance.elements).map(([k, v]) => {
      const inline = TEXT_COLOR_OVERRIDES[k];
      return inline ? [k, { className: v as string, style: inline }] : [k, v];
    }),
  ),
};

function SignInPage() {
  // To update login providers, app branding, or OAuth settings use the Auth
  // pane in the workspace toolbar. More information can be found in the Replit docs.
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
      />
    </div>
  );
}

function SignUpPage() {
  // To update login providers, app branding, or OAuth settings use the Auth
  // pane in the workspace toolbar. More information can be found in the Replit docs.
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
      />
    </div>
  );
}

/**
 * Wire Clerk's session token into the API client so every request carries
 * `Authorization: Bearer <jwt>`. This makes auth work even when third-party
 * cookies are blocked (e.g. Pulse rendered inside the workspace iframe).
 * Cookies still work as a fallback when the browser allows them.
 */
function ClerkApiAuthBridge() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn) {
      setAuthTokenGetter(async () => {
        try {
          return await getToken();
        } catch {
          return null;
        }
      });
    } else {
      setAuthTokenGetter(null);
    }
    return () => {
      setAuthTokenGetter(null);
    };
  }, [isLoaded, isSignedIn, getToken]);
  return null;
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Show when="signed-in">{children}</Show>
      <Show when="signed-out">
        <Redirect to="/sign-in" />
      </Show>
    </>
  );
}

function AppRouter() {
  return (
    <Switch>
      {/* Public — magic-link respondent flow */}
      <Route path="/survey/respond/:token" component={PublicSurveyForm} />

      {/* Auth pages */}
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />

      {/* Protected assessor workspace */}
      <Route path="/">
        <ProtectedRoute>
          <EngagementsList />
        </ProtectedRoute>
      </Route>
      <Route path="/engagements">
        <ProtectedRoute>
          <EngagementsList />
        </ProtectedRoute>
      </Route>
      <Route path="/rubrics">
        <ProtectedRoute>
          <RubricsPage />
        </ProtectedRoute>
      </Route>
      <Route path="/portfolio">
        <ProtectedRoute>
          <PortfolioPage />
        </ProtectedRoute>
      </Route>
      <Route path="/engagements/:id">
        {(params) => (
          <ProtectedRoute>
            <EngagementOverview key={params.id} />
          </ProtectedRoute>
        )}
      </Route>
      <Route path="/engagements/:id/connectors">
        {(params) => (
          <ProtectedRoute>
            <ConnectorsList key={params.id} />
          </ProtectedRoute>
        )}
      </Route>
      <Route path="/engagements/:id/artifacts">
        {(params) => (
          <ProtectedRoute>
            <ArtifactsView key={params.id} />
          </ProtectedRoute>
        )}
      </Route>
      <Route path="/engagements/:id/scoring">
        {(params) => (
          <ProtectedRoute>
            <ScoringView key={params.id} />
          </ProtectedRoute>
        )}
      </Route>
      <Route path="/engagements/:id/survey">
        {(params) => (
          <ProtectedRoute>
            <SurveyView key={params.id} />
          </ProtectedRoute>
        )}
      </Route>
      <Route path="/engagements/:id/interviews">
        {(params) => (
          <ProtectedRoute>
            <InterviewsView key={params.id} />
          </ProtectedRoute>
        )}
      </Route>
      <Route path="/engagements/:id/interviews/:interviewId">
        {(params) => (
          <ProtectedRoute>
            <InterviewDetailView key={params.interviewId} />
          </ProtectedRoute>
        )}
      </Route>
      <Route path="/engagements/:id/results/*">
        {(params) => (
          <ProtectedRoute>
            <ResultsView key={params.id} />
          </ProtectedRoute>
        )}
      </Route>
      <Route path="/engagements/:id/results">
        {(params) => (
          <ProtectedRoute>
            <ResultsView key={params.id} />
          </ProtectedRoute>
        )}
      </Route>
      <Route path="/engagements/:id/exports">
        {(params) => (
          <ProtectedRoute>
            <ExportsView key={params.id} />
          </ProtectedRoute>
        )}
      </Route>

      <Route component={NotFound} />
    </Switch>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPubKey!}
      proxyUrl={clerkProxyUrl}
      appearance={styledAppearance as never}
      localization={{
        signIn: {
          start: {
            title: "Sign in to Pulse",
            subtitle: "FullStack's agentic maturity assessment workspace",
          },
        },
        signUp: {
          start: {
            title: "Join your assessor team",
            subtitle: "Create your Pulse account to start running diagnostics",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkApiAuthBridge />
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <AppRouter />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkProviderWithRoutes />
    </WouterRouter>
  );
}

export default App;
