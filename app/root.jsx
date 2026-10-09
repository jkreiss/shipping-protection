import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
  useRouteError,
} from "react-router";

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

// Last resort for errors above the app route (including the app route's own
// render failing before its boundary can, and URLs no route matches). It renders
// a minimal document with no Polaris, App Bridge or scripts, and nothing from
// the error itself. Links keep the query string: inside the Admin it carries
// the shop and host that authentication needs.
export function ErrorBoundary() {
  const error = useRouteError();
  const { pathname, search } = useLocation();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const heading = notFound ? "Page not found" : "Something went wrong";

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{heading}</title>
      </head>
      <body
        style={{ fontFamily: "Inter, system-ui, sans-serif", padding: "2rem" }}
      >
        <h1 style={{ fontSize: "1.25rem" }}>{heading}</h1>
        {notFound ? (
          <>
            <p>This page doesn&apos;t exist.</p>
            <a href={`/app${search}`}>Go to the app</a>
          </>
        ) : (
          <>
            <p>The page couldn&apos;t load. Try again in a moment.</p>
            <a href={`${pathname}${search}`}>Try again</a>
          </>
        )}
      </body>
    </html>
  );
}
