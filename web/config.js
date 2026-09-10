/**
 * Public front-end configuration.
 *
 * Both values below are safe to commit: a Google client ID and a Worker URL
 * are public by design. Nothing secret belongs in this file, or anywhere else
 * in web/ — everything here ships to the browser.
 */
window.RSVP_CONFIG = {
  // Google Cloud console -> Credentials -> OAuth 2.0 Client ID (Web application)
  GOOGLE_CLIENT_ID: "32532424958-umer4n322a63nphfbnl0gkcqtrq92ms8.apps.googleusercontent.com",

  // Your deployed Worker. Set to the local dev Worker for now; change this
  // to the https://rsvp-points-worker.<subdomain>.workers.dev URL that
  // `wrangler deploy` prints, then redeploy the frontend.
  WORKER_URL: "http://localhost:8787",
};
