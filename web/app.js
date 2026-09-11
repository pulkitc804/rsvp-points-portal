/**
 * RSVP Points Portal — front end.
 *
 * The only thing this file knows about identity is the token Google hands it.
 * It never sends an email, a member id, or any other identifier to the Worker,
 * because the Worker would not trust one anyway. Anything a member could edit
 * in devtools has no effect on which row comes back.
 */
(function () {
  "use strict";

  var config = window.RSVP_CONFIG || {};

  // The ID token lives in a closure variable, not localStorage. A token in
  // localStorage survives until it expires and is readable by any script on
  // the page; this one disappears with the tab, and Google silently re-issues
  // it on the next visit.
  var idToken = null;

  // If Google's script never loads (offline, accounts.google.com blocked, a
  // CSP directive that needs widening), onGoogleLibraryLoad never fires and
  // the member is left staring at sign-in copy above an empty button slot
  // with no explanation. Fail visibly instead.
  var GOOGLE_LOAD_TIMEOUT_MS = 8000;
  var googleReady = false;
  var currentErrorCode = null;

  var byId = function (id) { return document.getElementById(id); };

  var el = {
    foot: byId("foot"),
    signin: byId("state-signin"),
    loading: byId("state-loading"),
    dashboard: byId("state-dashboard"),
    error: byId("state-error"),
    googleButton: byId("google-button"),
    firstName: byId("first-name"),
    points: byId("points-value"),
    standing: byId("standing-pill"),
    standingMessage: byId("standing-message"),
    nextStep: byId("next-step"),
    memberName: byId("member-name"),
    signedInAs: byId("signed-in-as"),
    signOut: byId("signout"),
    errorTitle: byId("error-title"),
    errorMessage: byId("error-message"),
    errorRetry: byId("error-retry"),
    errorSignOut: byId("error-signout")
  };

  function show(state) {
    [el.signin, el.loading, el.dashboard, el.error].forEach(function (panel) {
      panel.hidden = panel !== state;
    });
    // Sign out is only meaningful once there is a session to end.
    el.foot.hidden = state !== el.dashboard;
  }

  /**
   * Error copy lives here so every failure a member can see says what
   * happened and what to do next. The Worker sends its own message too; we
   * prefer ours when we recognise the code, since we can phrase it for the
   * screen it appears on.
   */
  var ERRORS = {
    domain_not_allowed: {
      title: "Use your Rutgers account",
      message:
        "That looks like a personal Google account. Choose your scarletmail.rutgers.edu or rutgers.edu account instead.",
      reauth: true
    },
    not_a_member: {
      title: "You're not on the list yet",
      message:
        "You signed in successfully, but your Rutgers email isn't on the RSVP member list. Reach out to the E-Board and ask to be added.",
      reauth: true
    },
    invalid_token: {
      title: "Please sign in again",
      message: "We couldn't verify your sign-in. Signing in again usually fixes it.",
      reauth: true
    },
    expired_token: {
      title: "Your sign-in expired",
      message: "Sign in again to see your current points.",
      reauth: true
    },
    roster_unavailable: {
      title: "Can't reach the member list",
      message: "The member list didn't load. This is usually temporary — try again in a moment.",
      retry: true
    },
    verification_unavailable: {
      title: "Google is unreachable",
      message: "We couldn't reach Google to verify your sign-in. Try again in a moment.",
      retry: true
    },
    roster_invalid: {
      title: "Your record needs a fix",
      message:
        "Your row in the member list can't be read correctly. Let the E-Board know so they can correct it.",
      retry: false
    },
    server_misconfigured: {
      title: "The portal isn't ready",
      message: "The portal is still being set up. Please contact the E-Board.",
      retry: false
    },
    internal_error: {
      title: "Something went wrong",
      message: "That's on our end, not yours. Try again in a moment.",
      retry: true
    },
    google_unavailable: {
      title: "Google sign-in didn't load",
      message:
        "We couldn't load Google's sign-in. Check your connection and reload the page.",
      retry: true
    },
    network: {
      title: "No connection",
      message: "We couldn't reach the portal. Check your connection and try again.",
      retry: true
    }
  };

  function showError(code, fallbackMessage) {
    var spec = ERRORS[code] || {
      title: "Something went wrong",
      message: fallbackMessage || "Please try again in a moment.",
      retry: true
    };

    currentErrorCode = code;
    el.errorTitle.textContent = spec.title;
    el.errorMessage.textContent = spec.message;
    el.errorRetry.hidden = !spec.retry;
    // "Use a different account" only helps when the problem is which account
    // they signed in with.
    el.errorSignOut.hidden = !spec.reauth;
    show(el.error);
  }

  /**
   * Answers the obvious follow-up question to a points total: how many more
   * do I need? Compares the member only against RSVP's thresholds, never
   * against another member.
   */
  function renderNextStep(member, thresholds) {
    if (!thresholds || member.standing === "good") {
      el.nextStep.hidden = true;
      return;
    }

    var target = member.standing === "okay" ? thresholds.good : thresholds.okay;
    var nextLabel = member.standing === "okay" ? "Good Standing" : "Okay Standing";
    var remaining = Math.max(0, target - member.points);

    el.nextStep.textContent =
      remaining === 1
        ? "1 more point reaches " + nextLabel + "."
        : remaining + " more points reach " + nextLabel + ".";
    el.nextStep.hidden = false;
  }

  function renderDashboard(data) {
    var member = data.member;

    el.firstName.textContent = member.firstName || member.name;
    el.points.textContent = String(member.points);
    el.standing.textContent = member.standingLabel;
    el.standing.setAttribute("data-standing", member.standing);
    el.standingMessage.textContent = member.standingMessage;
    el.memberName.textContent = member.name;
    el.signedInAs.textContent = member.email;

    renderNextStep(member, data.thresholds);
    show(el.dashboard);
  }

  function loadPoints() {
    if (!idToken) {
      show(el.signin);
      return;
    }

    show(el.loading);

    fetch(config.WORKER_URL.replace(/\/+$/, "") + "/api/me", {
      method: "GET",
      headers: { Authorization: "Bearer " + idToken }
    })
      .then(function (response) {
        return response
          .json()
          .catch(function () { return {}; })
          .then(function (body) {
            return { ok: response.ok, status: response.status, body: body };
          });
      })
      .then(function (result) {
        if (result.ok) {
          renderDashboard(result.body);
        } else {
          if (result.status === 401) idToken = null;
          showError(result.body.error, result.body.message);
        }
      })
      .catch(function () {
        showError("network");
      });
  }

  function onCredential(response) {
    idToken = response && response.credential;
    loadPoints();
  }

  function signOut() {
    idToken = null;
    el.memberName.textContent = "";
    el.signedInAs.textContent = "";
    if (window.google && google.accounts && google.accounts.id) {
      // Stops Google from silently signing the same account straight back in.
      google.accounts.id.disableAutoSelect();
    }
    show(el.signin);
  }

  el.signOut.addEventListener("click", signOut);
  el.errorSignOut.addEventListener("click", signOut);
  el.errorRetry.addEventListener("click", function () {
    // Retrying a failed script load means reloading the page; retrying a
    // failed lookup means asking the Worker again.
    if (currentErrorCode === "google_unavailable") {
      window.location.reload();
      return;
    }
    loadPoints();
  });

  function setupNeeded(missing) {
    el.errorTitle.textContent = "Setup incomplete";
    el.errorMessage.textContent =
      "web/config.js is missing " + missing.join(" and ") + ". Fill it in, then reload.";
    el.errorRetry.hidden = true;
    el.errorSignOut.hidden = true;
    show(el.error);
  }

  // Google's script is loaded async and calls this when it is ready.
  window.onGoogleLibraryLoad = function () {
    googleReady = true;
    var missing = [];
    if (!config.GOOGLE_CLIENT_ID) missing.push("GOOGLE_CLIENT_ID");
    if (!config.WORKER_URL) missing.push("WORKER_URL");
    if (missing.length > 0) {
      setupNeeded(missing);
      return;
    }

    google.accounts.id.initialize({
      client_id: config.GOOGLE_CLIENT_ID,
      callback: onCredential,
      auto_select: true,
      cancel_on_tap_outside: false
    });

    google.accounts.id.renderButton(el.googleButton, {
      theme: "outline",
      size: "large",
      text: "signin_with",
      shape: "rectangular",
      width: 320,
      logo_alignment: "left"
    });

    show(el.signin);
    // If this member signed in recently, Google returns a token without a
    // click and the credential appears directly.
    google.accounts.id.prompt();
  };

  show(el.signin);

  setTimeout(function () {
    if (!googleReady) showError("google_unavailable");
  }, GOOGLE_LOAD_TIMEOUT_MS);
})();
