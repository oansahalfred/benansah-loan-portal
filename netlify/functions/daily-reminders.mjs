// Benansah Loan Manager — runs the automatic SMS reminders every morning.
// 8:00 AM Ghana time (Ghana uses UTC). Switch it on or off on the app's SMS tab.
import { runReminders, robotToken } from "./reminders.mjs";

export default async () => {
  try {
    const token = await robotToken();
    const out = await runReminders({token, dryRun: false, trigger: "schedule"});
    console.log(out.skipped || out.summary);
  } catch (e) {
    console.error("Automatic reminders failed:", e.message);
  }
  return new Response("done");
};

export const config = { schedule: "0 8 * * *" };
