# Live checks

Verification that only a real call, the human's own Chrome, or a real file on disk can provide. Each entry has a **Trigger**, exact **Steps**, **Success criteria** and **On failure**. Run entries whose trigger has fired; remove them when they pass; fix forward when they fail.

Agents queue entries here when their PR's behaviour cannot be exercised by the e2e harness (fake devices, no Meet). This is the project's counterpart to a post-deploy verification list.

---

### Calibrate the Meet adapter

**Trigger**: the human is in a Google Meet call with at least one other participant, with an agent session open.
**Steps**:
1. On the Meet tab, open DevTools → Console, run `__rescribeCalibrate(60)`.
2. Over the next 60 seconds, have at least two different people speak, with pauses.
3. Copy the console summary (it lists the participant tiles found, the names guessed, and every attribute/class that toggled per tile with its toggle count and timing) and paste it to the agent.
**Success criteria**: the agent can name one selector per tile that toggles exactly when that participant speaks, writes it into `src/content/meet.ts`, and a second `__rescribeCalibrate(30)` shows the adapter's own `speaking` events matching who talked.
**On failure**: the adapter stays in calibration-only mode (emits roster, no speaking events) and the transcript falls back to channel identity ("Me" / "Speaker").
