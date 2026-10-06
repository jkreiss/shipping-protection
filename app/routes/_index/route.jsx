import { redirect } from "react-router";
import styles from "./styles.module.css";

export const loader = async ({ request }) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

// Merchants install and open the app from Shopify. The App Store forbids
// asking them to type a shop domain (requirement 2.3.1).
export default function App() {
  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Shipping protection</h1>
        <p className={styles.text}>
          Open this app from your Shopify admin.
        </p>
      </div>
    </div>
  );
}
