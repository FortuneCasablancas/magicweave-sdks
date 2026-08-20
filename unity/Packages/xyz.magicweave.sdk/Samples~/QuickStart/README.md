# Quick Start

1. `Window → Magicweave → Setup`, then paste the client id and secret from your project's
   **Environments** page in the console.
2. Create an empty scene, add a GameObject, and attach `QuickStartDemo`.
3. Add two `InputField`s (email, code) and two `Text`s (status, wallet), and wire them in the
   inspector. Hook four buttons to `OnRequestCode`, `OnVerifyCode`, `OnSubmitScore` and `OnFlush`.
4. Press play, sign in with a one-time code, and submit a score.

**Then do the interesting bit.** Turn off your wifi and press *Submit score* a few times. Nothing
is lost: each write is persisted before it is sent, the status line says "will sync when you're
back online", and the moment the connection returns — or the next time the app comes back to the
foreground — the queue drains in order, each write carrying the idempotency key it was born with.
So a score cannot be recorded twice, even if the app died mid-request.
