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
  // the page; this one disappears when the tab closes, and Google silently
  // re-issues it on the next visit.
  var idToken = null;

  var el = {
    signin: document.getElementById("state-signin"),
    loading: document.getElementById("state-loading"),
    dashboard: document.getElementById("state-dashboard"),
    error: document.getElementById("state-error"),
    googleButton: document.getElementById("google-button"),
    firstName: document.getElementById("first-name"),
    points: document.getElementById("points-value"),
    standing: document.getElementById("standing-pill"),
    standingMessage: document.getElementById("standing-message"),
    progressWrap: document.getElementById("progress-wrap"),
    progressFill: document.getElementById("progress-fill"),
    progressNote: document.getElementById("progress-note"),
    signedInAs: document.getElementById("signed-in-as"),
    signOut: document.getElementById("signout"),
    errorTitle: document.getElementById("error-title"),
    errorMessage: document.getElementById("error-message"),
    errorRetry: document.getElementById("error-retry"),
    errorSignOut: document.getElementById("error-signout")
  };

  function show(state) {
    [el.signin, el.loading, el.dashboard, el.error].forEach(function (section) {
      section.hidden = section !== state;
    });
  }

  /**
   * Error copy lives here so that every failure a member can see says what
   * happened and what to do next. The Worker sends its own message too; we
   * prefer ours when we recognise the code, since we can phrase it for the
   * screen it appears on.
   */
  var ERRORS = {
    domain_not_allowed: {
      title: "Use your Rutgers account",
      message:
        "That looks like a personal Google account. Sign out and choose your @scarletmail.rutgers.edu or @rutgers.edu account instead.",
      retry: false
    },
    not_a_member: {
      title: "You're not on the list yet",
      message:
        "You signed in successfully, but your Rutgers email isn't on the RSVP member list. Reach out to the E-Board and ask to be added.",
      retry: false
    },
    invalid_token: {
      title: "Please sign in again",
      message: "We couldn't verify your sign-in. Signing in again usually fixes it.",
      retry: false,
      reauth: true
    },
    expired_token: {
      title: "Your sign-in expired",
      message: "Sign in again to see your current points.",
      retry: false,
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

    el.errorTitle.textContent = spec.title;
    el.errorMessage.textContent = spec.message;
    el.errorRetry.hidden = !spec.retry;
    // "Sign in with a different account" only helps when the problem is which
    // account they used.
    el.errorSignOut.hidden = !(spec.reauth || code === "domain_not_allowed" || code === "not_a_member");
    show(el.error);
  }

  function renderDashboard(data) {
    var member = data.member;

    el.firstName.textContent = member.firstName || member.name;
    el.points.textContent = String(member.points);
    el.standing.textContent = member.standingLabel;
    el.standing.setAttribute("data-standing", member.standing);
    el.standingMessage.textContent = member.standingMessage;
    el.signedInAs.textContent = "Signed in as " + member.email;

    renderProgress(member, data.thresholds);
    show(el.dashboard);
  }

  /**
   * Not a leaderboard — it compares a member only against the threshold, and
   * never against other members. It exists so "6 points" answers the obvious
   * follow-up question: how many more do I need?
   */
  function renderProgress(member, thresholds) {
    if (!thresholds || member.standing === "good") {
      el.progressWrap.hidden = true;
      return;
    }

    var target = member.standing === "okay" ? thresholds.good : thresholds.okay;
    var nextLabel = member.standing === "okay" ? "Good Standing" : "Okay Standing";
    var remaining = Math.max(0, target - member.points);
    var percent = target > 0 ? Math.min(100, Math.round((member.points / target) * 100)) : 0;

    el.progressFill.style.width = percent + "%";
    el.progressNote.textContent =
      remaining === 1
        ? "1 more point reaches " + nextLabel + "."
        : remaining + " more points reach " + nextLabel + ".";
    el.progressWrap.hidden = false;
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
          .catch(function () {
            return {};
          })
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
    if (window.google && google.accounts && google.accounts.id) {
      // Stops Google from silently signing the same account straight back in.
      google.accounts.id.disableAutoSelect();
    }
    show(el.signin);
  }

  el.signOut.addEventListener("click", signOut);
  el.errorSignOut.addEventListener("click", signOut);
  el.errorRetry.addEventListener("click", loadPoints);

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
      shape: "pill",
      logo_alignment: "left"
    });

    show(el.signin);
    // If this member signed in recently, Google returns a token without a
    // click and the dashboard appears directly.
    google.accounts.id.prompt();
  };

  show(el.signin);
})();
