import {
  isRouteErrorResponse,
  Outlet,
  useLoaderData,
  useRouteError,
  useRouteLoaderData,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { claimsPageAvailable } from "../merchant/resolve-configuration";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

function AppNav() {
  return (
    <s-app-nav>
      <s-link href="/app" rel="home">
        Overview
      </s-link>
      <s-link href="/app/overview">Overview</s-link>
      {claimsPageAvailable() && (
        <s-link href="/app/claims">Claims &amp; Returns</s-link>
      )}
      <s-link href="/app/settings">Settings</s-link>
    </s-app-nav>
  );
}

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <AppNav />
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their
// headers are included in the response; boundary.error renders those. Anything
// else (a Shopify GraphQL throttle or timeout, a database error) gets a plain
// retry page instead of React Router's default error page inside the Admin
// iframe. The error is not shown: its
// message may hold Shopify or database details, and React Router sanitizes
// errors in production anyway. entry.server.jsx handleError already reports
// the failure, so this does not report it again.
export function ErrorBoundary() {
  const error = useRouteError();
  // The app route's own loader may be what failed, leaving no API key.
  const apiKey = useRouteLoaderData("routes/app")?.apiKey;

  // Shopify's auth responses (reauthorize, redirects) are below 500; a thrown
  // 5xx, such as a failed token refresh, gets the retry page.
  if (isRouteErrorResponse(error) && error.status < 500)
    return boundary.error(error);
  return (
    <AppProvider embedded={Boolean(apiKey)} apiKey={apiKey}>
      <AppNav />
      <s-page heading="Something went wrong">
        <s-banner heading="This page couldn't load" tone="critical">
          Shopify or the app was briefly unavailable. Reload to try again. If it
          keeps happening, contact support.
        </s-banner>
        <s-section>
          <s-button variant="primary" onClick={() => window.location.reload()}>
            Reload
          </s-button>
        </s-section>
      </s-page>
    </AppProvider>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
